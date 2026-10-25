// Property-based tests of the quoting every remote command depends on.
//
// The injection fixes of 3.6.5, 3.6.7, 3.8.5 and 3.8.7 all end in the same
// promise: a caller's value goes through shellQuote() and the shell reads it as
// one literal word. The example-based tests check the strings someone thought
// of. These let fast-check generate the strings, thousands of them, weighted
// towards quotes, dollars, backticks, backslashes, newlines and non-ASCII
// text, and hand each one to a real /bin/sh: what comes back must be exactly
// what went in, one argument per value, nothing executed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fc from 'fast-check';
import { shellQuote, shellPath, safeInteger } from '../src/shell-quote.js';

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

// Everything a shell gives a meaning to, plus text no shell should touch.
const hostile = fc.string({
  unit: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom('\'', '"', '`', '$', '\\', '(', ')', '{', '}', '[', ']', ';', '|', '&',
      '<', '>', '*', '?', '~', '#', '!', '=', '%', '^', ' ', '\t', '\n', '\r', '-', ':') },
    { weight: 2, arbitrary: fc.constantFrom('$(id)', '`id`', '$HOME', '${IFS}', '\'\\\'\'', '"$(', '&&', '||', '\\n', '\'\'') },
    { weight: 2, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }) },
  ),
  maxLength: 60,
}).filter(text => !text.includes('\0')); // no argument a process receives can hold NUL

/**
 * Run `printf '%s\0' <words>` in a real shell and return what it printed,
 * split back into the arguments it saw.
 * @param {string} words - A command-line fragment
 * @param {NodeJS.ProcessEnv} [env]
 */
function shellArgs(words, env = { PATH: process.env.PATH }) {
  const result = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${words}`], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').slice(0, -1);
}

if (process.platform === 'win32') {
  console.log('Skipped on Windows: the quoting targets the POSIX shell of the remote host.');
  process.exit(0);
}

// One shell per run, many values per shell: 300 runs check a few thousand strings.
fc.assert(fc.property(fc.array(hostile, { minLength: 1, maxLength: 20 }), values => {
  assert.deepEqual(shellArgs(values.map(shellQuote).join(' ')), values);
}), { numRuns: 300 });
ok('shellQuote: any string comes back from /bin/sh unchanged, one argument per value, nothing expanded or run');

fc.assert(fc.property(hostile, hostile, (before, after) => {
  // Quoted words glued to other quoted words stay separate values only where
  // a space separates them: the quoting never ends early.
  assert.deepEqual(shellArgs(`${shellQuote(before)}${shellQuote(after)}`), [before + after]);
}), { numRuns: 300 });
ok('shellQuote: two quoted words written together are read as their exact concatenation (no quote closes early)');

fc.assert(fc.property(fc.oneof(fc.integer(), fc.double(), fc.constantFrom(null, undefined, true, false)), value => {
  const expected = value === null || value === undefined ? '' : String(value);
  assert.deepEqual(shellArgs(shellQuote(value)), [expected]);
}), { numRuns: 200 });
ok('shellQuote: numbers, booleans, null and undefined become exactly one word');

const home = '/home/fixture user';
fc.assert(fc.property(hostile, rest => {
  const env = { PATH: process.env.PATH, HOME: home };
  assert.deepEqual(shellArgs(shellPath(`~/${rest}`), env), [`${home}/${rest}`]);
  if (!rest.startsWith('~')) assert.deepEqual(shellArgs(shellPath(rest), env), [rest]);
}), { numRuns: 300 });
ok('shellPath: ~/ becomes $HOME (even with a space in it) and the rest stays literal; other paths are not expanded');

// fc.double() reaches the values that broke it: 1e21 and up printed as "1e+21".
fc.assert(fc.property(fc.oneof(fc.anything(), fc.double(), fc.string()), fc.nat(), (value, fallback) => {
  const n = safeInteger(value, fallback);
  assert.ok(Number.isSafeInteger(n) && n >= 0, String(n));
  assert.match(String(n), /^\d+$/, 'it must print as plain digits inside a command');
}), { numRuns: 2000 });
ok('safeInteger: whatever it is given, the result is a non-negative integer that prints as digits');

console.log(`\n✅ Shell quoting property tests passed (${passed} properties)`);
