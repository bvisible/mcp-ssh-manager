// Single POSIX shell-word quoting, shared by every builder that hands a string
// to a remote shell.
//
// It lived in database-manager.js after the v3.6.7 fix (CVE-2026-77383), and
// that is exactly why the same class of bug survived elsewhere: backup-manager,
// health-monitor and several inline commands in index.js never imported it and
// kept interpolating caller-controlled values raw. Keeping it in one module
// makes "did this builder quote its inputs?" a question with one answer.

const SQ = '\'';

/**
 * Quote a value for safe inclusion as a single POSIX shell word.
 *
 * Wraps the value in single quotes and escapes any embedded single quote as
 * '\'' so the remote shell treats it literally — it never interprets $(...),
 * backticks, $VAR, ;, |, &, redirects, spaces, or newlines inside the value.
 * EVERY caller-controlled value interpolated into a command string MUST go
 * through this. Numbers are coerced to string; null/undefined become an empty
 * quoted word.
 *
 * @param {any} value - Value to quote
 * @returns {string} The value as one safely quoted shell word
 */
export function shellQuote(value) {
  if (value === null || value === undefined) return SQ + SQ;
  // Replace every ' with '\'' (close quote, escaped quote, reopen), then wrap.
  return SQ + String(value).replace(/'/g, SQ + '\\' + SQ + SQ) + SQ;
}

/** Quote a POSIX path while preserving the documented ~/ home shorthand. */
export function shellPath(value) {
  const text = String(value);
  if (text === '~') return '"$HOME"';
  if (text.startsWith('~/')) return `"$HOME"/${shellQuote(text.slice(2))}`;
  return shellQuote(text);
}

// Finds the timeout binary on the target, then runs the command under it. Run by
// `sh` with the seconds as $1 and the command as $2, so neither is ever spliced
// into this text. Stock Linux has `timeout`; macOS has neither unless Homebrew's
// coreutils adds `gtimeout`; with neither, the command still runs (the local SSH
// exec timeout bounds it) instead of failing with exit 127 (#115).
const REMOTE_TIMEOUT_SCRIPT = 'if t=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null);'
  + ' then exec "$t" "$1" sh -c "$2"; else exec sh -c "$2"; fi';

/**
 * Wrap a command so the remote host kills it after `seconds`.
 *
 * The result is a single simple command made only of single-quoted words
 * (`sh -c '<script>' sh <seconds> '<command>'`), because the SSH server hands it
 * to the account's login shell, which is not always a POSIX one: csh and tcsh
 * (FreeBSD's root, some old accounts) reject `$(...)` and `if ... fi` written at
 * the top level, and a wrapper that resolves the binary there failed on them
 * where the old bare `timeout ...` worked. The probing happens inside `sh`.
 *
 * @param {string} command - The command as the user wrote it, run by `sh -c`
 * @param {number} seconds - Whole seconds before the remote side kills it
 * @returns {string} The wrapped command
 */
export function withRemoteTimeout(command, seconds) {
  return `sh -c ${shellQuote(REMOTE_TIMEOUT_SCRIPT)} sh ${safeInteger(seconds, 1)} ${shellQuote(command)}`;
}

/**
 * Coerce a value to a safe non-negative integer for use in a command.
 *
 * Numeric tool arguments (line counts, ports, retention days) are declared as
 * z.number() but still land inside command strings, where a non-finite or
 * fractional value would serialise into something the shell reads oddly.
 *
 * @param {any} value - Value to coerce
 * @param {number} fallback - Value used when the input is not a finite number
 * @returns {number} A non-negative integer
 */
export function safeInteger(value, fallback) {
  let n;
  try {
    n = Number(value);
  } catch {
    return fallback; // an object that cannot become a number at all (found by the property test)
  }
  if (!Number.isFinite(n)) return fallback;
  // Capped: above 2^53 a number is no longer exact, and from 1e21 up it prints
  // as "1e+21", which no command reads as a count (found by the property test).
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(n)));
}
