import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

/**
 * The directory that holds this user's settings and state: SSH_MANAGER_HOME,
 * or ~/.ssh-manager. Read at call time so a test or a host that sets the
 * variable after import still gets its own directory.
 * @returns {string}
 */
export function managerHome() {
  return process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
}

/**
 * Expand a leading `~` (alone or followed by a separator) to the home
 * directory, as a shell would. `keyPath.replace('~', home)` replaced the first
 * tilde anywhere, so `/srv/keys/~old/id` and `~user/id` came out wrong
 * (issue #89). Any other path is returned as written.
 * @param {string} value
 * @returns {string}
 */
export function expandHomePath(value) {
  const text = String(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || (path.sep === '\\' && text.startsWith('~\\'))) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

/** @param {unknown} value */
function isOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/**
 * True when both names lead to the same file, links followed. A file that does
 * not exist is the same as nothing.
 * @param {string} first
 * @param {string} second
 */
function sameFile(first, second) {
  try { return fs.realpathSync(first) === fs.realpathSync(second); } catch { return false; }
}

/**
 * True when a .env sets up the SSH manager: a server, or a TOML to read. Any
 * repository has a .env of its own, so only one that does is worth a word.
 * @param {string} file
 */
function configuresServers(file) {
  try {
    return Object.keys(dotenv.parse(fs.readFileSync(file)))
      .some(key => key === 'SSH_CONFIG_PATH' || /^SSH_SERVER_[A-Z0-9_]+_HOST$/.test(key));
  } catch { return false; }
}

/**
 * Which .env the engine reads, and why.
 *
 * The same .env must be used by the MCP engine, CLI and optional control plane.
 * Keep the published engine's discovery order; SSH_MANAGER_ENV is the CLI's
 * existing explicit override and is accepted when SSH_ENV_PATH is absent.
 *
 * 3.8.5's engine never read SSH_MANAGER_ENV (only the CLI did), so a profile
 * that still exported it towards a file since deleted cost nothing until 4.0
 * honoured it, and then loaded zero servers without a word (issue #90). A
 * missing file named by SSH_MANAGER_ENV is therefore skipped, as 3.8.5 skipped
 * the variable, and reported in `ignored`. SSH_ENV_PATH was always the
 * engine's own override: a missing file there stays the choice, reported as
 * `missing`, so nothing is silently read in place of what was asked for.
 *
 * The `.env` of the working directory is the one file in the list that nobody
 * chose: it belongs to whatever project the MCP client was started in. A
 * server entry can carry a command that runs on this machine when it connects
 * (PROXYCOMMAND, or one in the TOML that SSH_CONFIG_PATH points to), so a
 * repository that ships a `.env` could make the engine run its commands, with
 * no SSH host and no approval involved. That file is therefore read only when
 * it is also the file the user placed (the manager home, the home directory or
 * the install directory, which is the case when the engine runs from a
 * checkout), or when the process environment says SSH_MANAGER_TRUST_PROJECT_ENV.
 * It is never read from a file: the project's own `.env` cannot vouch for itself.
 * Otherwise it is left unread and named in `skippedProject`, and where a file is
 * wanted but none exists the manager home is used, so that a `.env` an agent
 * writes into the project later is not picked up by a running engine either.
 * @param {{ projectRoot?: string }} [options]
 * @returns {{path: string, variable: string|null, missing: boolean,
 *   ignored: {variable: string, path: string}|null, skippedProject: string|null}}
 */
export function envFileChoice({
  projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
} = {}) {
  if (process.env.SSH_ENV_PATH) {
    const file = process.env.SSH_ENV_PATH;
    return { path: file, variable: 'SSH_ENV_PATH', missing: !fs.existsSync(file), ignored: null, skippedProject: null };
  }
  let ignored = null;
  if (process.env.SSH_MANAGER_ENV) {
    const file = process.env.SSH_MANAGER_ENV;
    if (fs.existsSync(file)) {
      return { path: file, variable: 'SSH_MANAGER_ENV', missing: false, ignored: null, skippedProject: null };
    }
    ignored = { variable: 'SSH_MANAGER_ENV', path: file };
  }
  const managerEnv = path.join(managerHome(), '.env');
  const homeEnv = path.join(os.homedir(), '.env');
  const installEnv = path.join(projectRoot, '.env');
  const projectEnv = path.join(process.cwd(), '.env');
  const trustProject = isOn(process.env.SSH_MANAGER_TRUST_PROJECT_ENV)
    || [managerEnv, homeEnv, installEnv].some(file => sameFile(file, projectEnv));
  const candidates = [managerEnv, ...(trustProject ? [projectEnv] : []), homeEnv, installEnv];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  // Said only when it would have been read before: with a file in the manager home
  // the project's was never looked at, and a project .env that sets up no server
  // (most of them) has nothing to be missed.
  const skippedProject = !trustProject && !fs.existsSync(managerEnv) && configuresServers(projectEnv)
    ? projectEnv : null;
  // No file at all is a valid setup (servers from the environment or TOML).
  return {
    path: found || (trustProject ? projectEnv : managerEnv),
    variable: null,
    missing: false,
    ignored,
    skippedProject
  };
}

/**
 * The .env path alone; see envFileChoice for the rules.
 * @param {{ projectRoot?: string }} [options]
 * @returns {string}
 */
export function resolveEnvFilePath(options) {
  return envFileChoice(options).path;
}

/**
 * A sentence for the operator when the configuration file was not what the
 * environment asked for, or null when it was.
 * @param {ReturnType<typeof envFileChoice>} choice
 * @returns {string|null}
 */
export function envFileProblem(choice) {
  if (choice.missing) {
    return `${choice.variable} names ${choice.path}, which does not exist: no server is loaded from a .env file`;
  }
  const problems = [];
  if (choice.ignored) {
    problems.push(`${choice.ignored.variable} names ${choice.ignored.path}, which does not exist; using ${choice.path} instead`);
  }
  if (choice.skippedProject) {
    problems.push(projectEnvNotice(choice.skippedProject));
  }
  return problems.length ? problems.join('; ') : null;
}

/**
 * What to tell the operator when the .env of the working directory was left
 * unread, and the three ways to have it read.
 * @param {string} file
 * @returns {string}
 */
export function projectEnvNotice(file) {
  return `${file} was not read: a project file is not trusted to start commands on this machine. `
    + `Move it to ${path.join(managerHome(), '.env')}, name it with SSH_ENV_PATH, `
    + 'or set SSH_MANAGER_TRUST_PROJECT_ENV=1 in the environment of the MCP server';
}

/** Read file-selected TOML settings just as the MCP entry point does.
 * @param {string} [envPath]
 */
export function resolveConfigOptions(envPath = resolveEnvFilePath()) {
  let values = {};
  try { values = dotenv.parse(fs.readFileSync(envPath)); } catch { /* The loader reports unreadable files. */ }
  return {
    envPath,
    tomlPath: process.env.SSH_CONFIG_PATH ?? values.SSH_CONFIG_PATH
      ?? path.join(os.homedir(), '.codex', 'ssh-config.toml'),
    preferToml: (process.env.PREFER_TOML_CONFIG ?? values.PREFER_TOML_CONFIG) === 'true',
  };
}
