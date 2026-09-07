/**
 * What your agents ran, kept on this machine.
 *
 * ## Why this exists next to the audit log
 *
 * `audit.js` writes a per-server JSONL file, and only when that server has
 * `AUDIT_LOG` set. That is the right shape for shipping to a log collector, and
 * the wrong shape for the question an operator actually asks — *what has my
 * agent been doing?* — because answering it means having remembered to
 * configure every server first, and nobody has.
 *
 * The control plane already sees every command: the engine streams them here as
 * they run. Writing them down costs one append per command and needs nothing
 * configured anywhere.
 *
 * ## What is written, and what is not
 *
 * The command, the server, when, how long, and the exit code. **Not the
 * output.** A stream carries whatever the program printed — a config being
 * catted, a token echoed by a deploy script, a database row — and a file of
 * that sitting in a home directory is a liability nobody asked for. The output
 * stays in memory, capped, and disappears with the window.
 *
 * `SSH_MANAGER_LOG_OUTPUT=1` includes it, truncated, for someone who has
 * decided they want that on their own machine. Off by default, and the setting
 * says what it does rather than being buried in a config file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

/** How much output is kept per command when it is kept at all. */
const OUTPUT_LIMIT = 4096;

/** Entries kept before the oldest are dropped. Roughly a month of ordinary use. */
const MAX_ENTRIES = 5000;

/** @returns {string} The log file, beside the vault. */
export function commandLogPath() {
  const home = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
  return path.join(home, 'commands.log.jsonl');
}

/** @returns {boolean} Whether output is recorded as well as the command. */
export function recordsOutput() {
  return process.env.SSH_MANAGER_LOG_OUTPUT === '1';
}

/**
 * @typedef {object} CommandLogEntry
 * @property {string} ts - When it finished, ISO 8601
 * @property {string} server
 * @property {string} command
 * @property {number|null} code - Exit code, null if it never reported one
 * @property {number} [durationMs]
 * @property {string} [output] - Only when SSH_MANAGER_LOG_OUTPUT=1
 */

/**
 * Append one finished command.
 *
 * Failures are logged and swallowed: a log that cannot be written must never
 * take down the thing it is recording.
 *
 * @param {CommandLogEntry} entry - The command that just finished
 */
export function appendCommand(entry) {
  try {
    const file = commandLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

    /** @type {CommandLogEntry} */
    const line = {
      ts: entry.ts,
      server: entry.server,
      command: entry.command,
      code: entry.code,
    };
    if (typeof entry.durationMs === 'number') line.durationMs = entry.durationMs;
    if (recordsOutput() && entry.output) {
      line.output = entry.output.length > OUTPUT_LIMIT
        ? `${entry.output.slice(-OUTPUT_LIMIT)}\n[… truncated, kept the last ${OUTPUT_LIMIT} bytes]`
        : entry.output;
    }

    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (error) {
    logger.warn('Cannot append to the command log', { error: error.message });
  }
}

/**
 * Read the log back, newest first.
 *
 * @param {number} [limit] - How many to return
 * @returns {CommandLogEntry[]}
 */
export function readCommandLog(limit = 500) {
  const file = commandLogPath();
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          // One bad line does not invalidate the file; skip it.
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch (error) {
    logger.warn('Cannot read the command log', { error: error.message });
    return [];
  }
}

/**
 * Drop the oldest entries when the file has grown past MAX_ENTRIES.
 *
 * Called on startup rather than on every append: rewriting a file to add one
 * line would turn an append into an O(n) operation, and the growth this guards
 * against takes weeks.
 */
export function trimCommandLog() {
  const file = commandLogPath();
  if (!fs.existsSync(file)) return;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_ENTRIES) return;
    fs.writeFileSync(file, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, { mode: 0o600 });
    logger.info('Command log trimmed', { kept: MAX_ENTRIES, dropped: lines.length - MAX_ENTRIES });
  } catch (error) {
    logger.warn('Cannot trim the command log', { error: error.message });
  }
}

/** Delete the log. Offered because it is the operator's machine and their record. */
export function clearCommandLog() {
  try {
    fs.rmSync(commandLogPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
