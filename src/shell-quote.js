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
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}
