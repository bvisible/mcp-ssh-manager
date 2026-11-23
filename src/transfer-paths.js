/**
 * Where the file tools may touch the local disk.
 *
 * `ssh_download` writes a local file, `ssh_upload` reads one, `ssh_sync` does
 * either. None of them looked at the local path, so an agent that could not run
 * a single command on a `readonly` server could still have `ssh_download` write
 * `~/.zshrc` or `~/.ssh/authorized_keys` on this machine, with content it had
 * just put on the server (`printf … > /tmp/x` is allowed in `readonly`).
 *
 * A transfer root is the one directory the local side of a transfer may use:
 *
 *   - `transferRoot` on a server (`SSH_SERVER_<NAME>_TRANSFER_ROOT`,
 *     `transfer_root` in TOML) turns it on for that server, in every mode, for
 *     all three tools;
 *   - a server in `readonly` or `restricted` mode has one even when none is set,
 *     for `ssh_download` (the other two are refused there already): the
 *     `transfers` folder of the manager home (`~/.ssh-manager/transfers`). It is
 *     created, private to the user, the first time a download needs it;
 *   - a server in `unrestricted` mode with no `transferRoot` is exactly what it
 *     was: no filter at all, by design.
 *
 * A path is accepted when its real location, after following every link, is
 * inside the root. A relative path is read from the root. A link as the file
 * itself is refused, in either direction, and so is a link directory that leads
 * out. The checks run just before the transfer; they do not stop somebody who
 * can already change files in the root while it runs.
 */

import fs from 'fs';
import path from 'path';
import { expandHomePath, managerHome } from './config-paths.js';

const CONFINED_MODES = new Set(['readonly', 'restricted']);

/**
 * @typedef {object} TransferPolicy
 * @property {string} root - Where the local side of a transfer must stay
 * @property {boolean} explicit - The server names its own root
 */

/**
 * The transfer policy of a server for a tool, or null when its local paths are
 * not filtered.
 *
 * @param {{mode?: string, transferRoot?: string}|null|undefined} serverConfig
 * @param {string} toolName - ssh_download, ssh_upload or ssh_sync
 * @returns {TransferPolicy|null}
 */
export function transferPolicy(serverConfig, toolName) {
  const configured = typeof serverConfig?.transferRoot === 'string' ? serverConfig.transferRoot.trim() : '';
  if (configured) return { root: path.resolve(expandHomePath(configured)), explicit: true };
  // Without a named root only the download is held to the default one: the
  // upload and the sync cannot run at all in these two modes.
  if (toolName === 'ssh_download' && CONFINED_MODES.has(String(serverConfig?.mode ?? '').toLowerCase())) {
    return { root: path.join(managerHome(), 'transfers'), explicit: false };
  }
  return null;
}

/**
 * True when `candidate` is `root` or below it.
 * @param {string} root
 * @param {string} candidate
 * @param {boolean} allowRoot
 */
function within(root, candidate, allowRoot) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** @param {string} target */
function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch { return null; }
}

/**
 * Where `target` really is: the part that exists with every link followed, then
 * the part that does not exist yet as written.
 * @param {string} target - Absolute path
 * @returns {string}
 */
function realLocation(target) {
  const missing = [];
  let current = target;
  while (!lstatOrNull(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...missing);
}

/**
 * Resolve the local side of a transfer to the path the tool must use, or throw
 * with the reason it may not.
 *
 * @param {TransferPolicy} policy
 * @param {string} localPath - As the caller gave it
 * @param {{direction: 'read'|'write', allowRoot?: boolean}} options
 *   `read`: the path must exist. `write`: its folder is made inside the root when missing.
 *   `allowRoot`: the root itself is acceptable (a folder for a sync).
 * @returns {string} An absolute path under the real root; a trailing separator is kept
 */
export function confineLocalPath(policy, localPath, { direction, allowRoot = false }) {
  const given = String(localPath);
  if (!given || given.includes('\0')) throw new Error('The local path is empty or not a valid path');
  const hint = policy.explicit
    ? 'the transfer root set for this server (transferRoot)'
    : 'the transfer folder of a server in readonly or restricted mode (~/.ssh-manager/transfers, or set transferRoot on the server)';
  const outside = () => new Error(`Local path "${given}" is outside ${hint}: ${policy.root}`);

  fs.mkdirSync(policy.root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync.native(policy.root);
  const trailing = /[\\/]$/.test(given) ? path.sep : '';

  // A relative path is read from the root; an absolute one is taken as written. Either
  // way what counts is where it really is: its folder with every link followed (so
  // /tmp/x and /private/tmp/x, or the root by another name, are the same place, and a
  // link folder that leads out is out). The file itself is looked at below.
  const absolute = path.isAbsolute(given) ? path.resolve(given) : path.resolve(realRoot, given);
  const target = path.join(realLocation(path.dirname(absolute)), path.basename(absolute));
  if (!within(realRoot, target, allowRoot)) throw outside();

  const existing = lstatOrNull(target);
  if (existing?.isSymbolicLink()) throw new Error(`Local path "${given}" is a link; a transfer does not follow links`);
  if (direction === 'read' && !existing) throw new Error(`Local path does not exist: ${given}`);
  if (direction === 'write' && existing?.isDirectory() && !allowRoot) throw new Error(`Local path "${given}" is a folder`);
  if (direction === 'write' && !existing) {
    fs.mkdirSync(trailing ? target : path.dirname(target), { recursive: true, mode: 0o700 });
  }
  return trailing && !target.endsWith(path.sep) ? target + trailing : target;
}
