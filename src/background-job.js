// Run a command on the target fully detached from the SSH session, for the jobs
// that outlive an ssh_execute call (a training run, a long build): the call
// returns at once with the job's pid and the file its output goes to.
//
// Idea from SEU-zhc's fork, built differently on one point: the log file is
// never chosen by the caller. A free path would let a command that passes the
// readonly policy (`echo "<key>"`) overwrite any file the SSH user can write,
// ~/.ssh/authorized_keys included, so the engine creates its own private file
// with mktemp instead.
import { shellQuote } from './shell-quote.js';

// Run by `sh` with the command as $1, so the command is never spliced into this
// text. nohup keeps the job past the end of the session; stdout and stderr go to
// a fresh private file and stdin to /dev/null, so no descriptor of the SSH
// channel stays open and the call can finish while the job runs on.
const BACKGROUND_SCRIPT = 'log=$(mktemp "${TMPDIR:-/tmp}/ssh-manager-bg-XXXXXX") || exit 1;'
  + ' nohup sh -c "$1" > "$log" 2>&1 < /dev/null & echo "$! $log"';

/**
 * Wrap a command so it starts detached and prints "<pid> <log file>".
 *
 * Like withRemoteTimeout, the result is one simple command made only of
 * single-quoted words: the SSH server hands it to the account's login shell,
 * which may be csh or tcsh and would reject `$(...)` or `if ... fi` at the top
 * level.
 * @param {string} command
 * @returns {string}
 */
export function buildBackgroundCommand(command) {
  return `sh -c ${shellQuote(BACKGROUND_SCRIPT)} sh ${shellQuote(command)}`;
}

/**
 * Read what buildBackgroundCommand printed.
 * @param {string} stdout
 * @returns {{pid: number, logFile: string} | null} null if the job did not start
 */
export function parseBackgroundStart(stdout) {
  for (const line of String(stdout ?? '').split('\n').reverse()) {
    const match = /^(\d+) (\/.+)$/.exec(line.trim());
    if (match) return { pid: Number(match[1]), logFile: match[2] };
  }
  return null;
}
