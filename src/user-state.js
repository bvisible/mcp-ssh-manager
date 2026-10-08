/**
 * Settings a user changes while the server runs: hooks, command and server
 * aliases, the active profile.
 *
 * Up to 3.8.5 they were written inside the installed package. Every upgrade
 * replaced that directory, so a change made through a tool vanished on the
 * next `npm install -g`, and the server needed write access to its own
 * install directory (issue #87). They now live beside the .env, in
 * SSH_MANAGER_HOME (~/.ssh-manager by default), readable by their owner only.
 *
 * The old file is still read while the new one does not exist, so a source
 * checkout keeps what it had until its next change writes the new file.
 */

import fs from 'fs';
import path from 'path';
import { managerHome } from './config-paths.js';

/**
 * @param {string} name - File name inside the manager home
 * @returns {string}
 */
function userStatePath(name) {
  return path.join(managerHome(), name);
}

/**
 * Read a state file, falling back to its pre-4.0 location inside the package.
 * @param {string} name - File name inside the manager home
 * @param {string} [legacyFile] - Absolute path of the old file, if any
 * @returns {{file: string, text: string}|null} null when neither exists
 */
export function readUserState(name, legacyFile) {
  for (const file of [userStatePath(name), legacyFile]) {
    if (!file) continue;
    try {
      return { file, text: fs.readFileSync(file, 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

/**
 * Replace a state file atomically, creating the manager home if needed. The
 * directory is created 0700 and the file 0600: these files name servers and
 * commands, which are nobody else's business on a shared machine.
 * @param {string} name - File name inside the manager home
 * @param {string} text - Complete new contents
 * @returns {string} The path written
 */
export function writeUserState(name, text) {
  const file = userStatePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}
