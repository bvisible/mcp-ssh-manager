/**
 * Commands you keep, so you stop retyping them.
 *
 * Distinct from `command-aliases.js`, which maps a short word to a longer
 * command line for an *agent* to expand. These are for a person: a named,
 * described command you pick from a list next to a terminal — "restart nginx",
 * "tail the error log", "show me disk usage".
 *
 * The model follows TransHub's `SSHCommand`, because the shape earned its parts:
 *
 * - **`serverNames`** — empty means everywhere. A `systemctl restart nginx`
 *   offered on a database server is a mistake waiting for a tired evening.
 * - **`confirmBeforeRun`** — some of these delete things. The flag lives with
 *   the command rather than being guessed from its text, because whoever wrote
 *   it knows, and a heuristic that misses once is worse than no heuristic.
 * - **`workingDirectory`** — a command that only makes sense in one place
 *   should carry that place with it.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

/**
 * Where the list lives. In the user's own directory rather than the project's:
 * these are personal shortcuts, not repository configuration, and they should
 * survive a reinstall and follow you between checkouts.
 *
 * @returns {string}
 */
export function savedCommandsPath() {
  const home = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
  return path.join(home, 'commands.json');
}

/**
 * @typedef {object} SavedCommand
 * @property {string} id
 * @property {string} name
 * @property {string} command
 * @property {string} [description]
 * @property {string[]} serverNames - Empty means every server
 * @property {boolean} confirmBeforeRun
 * @property {string} [workingDirectory]
 */

/**
 * A starting set, offered when the list is empty rather than written on
 * install. Nothing is created behind the operator's back, and a list they never
 * asked for is a list they have to clean up.
 *
 * @returns {Omit<SavedCommand, 'id'>[]}
 */
export function suggestedCommands() {
  return [
    { name: 'Disk usage', command: 'df -h', description: 'Free space per filesystem', serverNames: [], confirmBeforeRun: false },
    { name: 'Memory', command: 'free -h', description: 'What is used and what is cached', serverNames: [], confirmBeforeRun: false },
    { name: 'Load', command: 'uptime', description: 'How long it has been up, and how busy', serverNames: [], confirmBeforeRun: false },
    { name: 'Biggest directories', command: 'du -sh */ 2>/dev/null | sort -rh | head -20', description: 'What is filling the disk', serverNames: [], confirmBeforeRun: false },
    { name: 'Failed services', command: 'systemctl --failed', description: 'Units that did not come up', serverNames: [], confirmBeforeRun: false },
    { name: 'Recent errors', command: 'journalctl -p err -n 50 --no-pager', description: 'The last 50 error-level log lines', serverNames: [], confirmBeforeRun: false },
    { name: 'Listening ports', command: 'ss -tlnp 2>/dev/null || netstat -tlnp', description: 'What is accepting connections', serverNames: [], confirmBeforeRun: false },
    { name: 'Reload nginx', command: 'systemctl reload nginx', description: 'Pick up a new configuration without dropping connections', serverNames: [], confirmBeforeRun: true },
  ];
}

/**
 * Read the list. A missing file is an empty list, not an error — nobody has
 * saved a command yet.
 *
 * @returns {SavedCommand[]}
 */
export function listSavedCommands() {
  const file = savedCommandsPath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.commands) ? parsed.commands : [];
  } catch {
    // A corrupt file must not take the interface down; the operator can see an
    // empty list and re-save, which beats a screen that will not load.
    return [];
  }
}

/**
 * @param {SavedCommand[]} commands - The full list
 */
function write(commands) {
  const file = savedCommandsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, commands }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Add or replace one. Validated here rather than trusted: this list is edited
 * through an HTTP route, and a command with no command in it would be a row
 * that does nothing and cannot be told apart from one that does.
 *
 * @param {Partial<SavedCommand>} input - What to save
 * @returns {SavedCommand} The stored form
 */
export function saveCommand(input) {
  const name = String(input.name ?? '').trim();
  const command = String(input.command ?? '').trim();
  if (!name) throw new Error('A name is required — it is what you will pick from the list');
  if (!command) throw new Error('A command is required');

  /** @type {SavedCommand} */
  const stored = {
    id: input.id || crypto.randomUUID(),
    name,
    command,
    description: input.description ? String(input.description).trim() : undefined,
    serverNames: Array.isArray(input.serverNames) ? input.serverNames.map(String) : [],
    confirmBeforeRun: Boolean(input.confirmBeforeRun),
    workingDirectory: input.workingDirectory ? String(input.workingDirectory).trim() : undefined,
  };

  const commands = listSavedCommands();
  const at = commands.findIndex(existing => existing.id === stored.id);
  if (at >= 0) commands[at] = stored;
  else commands.push(stored);
  write(commands);
  return stored;
}

/**
 * @param {string} id - Command to remove
 * @returns {boolean} Whether it was there
 */
export function deleteCommand(id) {
  const commands = listSavedCommands();
  const remaining = commands.filter(command => command.id !== id);
  if (remaining.length === commands.length) return false;
  write(remaining);
  return true;
}

/**
 * The commands offered for one server: the global ones plus those that name it.
 *
 * @param {string} serverName - The server in question
 * @returns {SavedCommand[]}
 */
export function commandsForServer(serverName) {
  return listSavedCommands().filter(
    command => command.serverNames.length === 0 || command.serverNames.includes(serverName)
  );
}
