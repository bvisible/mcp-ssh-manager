// What restricted mode allows must be what the shell runs. The policy reads the
// command line with splitShellCommand and checks every simple command it finds
// against the allowlist; a command the reader does not see is a command nothing
// checks (GHSA-86xm-rv3h-r4f2, after GHSA-rfxw-26h6-7w42).
//
// Two parts:
//   1. cases written out: the advisory's own, the other ways found of making the
//      reader and the shell disagree, and what must keep working;
//   2. a differential check against the shells of this machine: random lines are
//      built from the characters that make the two disagree (quotes, backslashes,
//      comments, here-documents, $'…', ${…}); every line the policy allows with
//      ALLOW_PATTERNS ["^echo"] is run by sh, dash and bash with `touch` defined
//      as a function that leaves a mark. A mark on an allowed line is a command
//      the allowlist never saw. Seeded, so a failure is reproducible.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluatePolicy } from '../src/policy.js';
import { splitShellCommand } from '../src/shell-segments.js';

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const restricted = { name: 'fixture', mode: 'restricted', allowPatterns: ['^echo', '^ls'], denyPatterns: [] };
const verdict = line => evaluatePolicy(restricted, 'ssh_execute', line);
const segments = line => splitShellCommand(line).segments;

// ── 1. The advisory's cases, and the ones found beside them ─────────────────────
const NEVER_ALLOWED = {
  'a quote in a comment swallows the next line (the advisory, 1)': "echo x # it's\ntouch /tmp/pwned # '",
  'a backslash at the end of a comment line (the advisory, 2)': 'echo x # x \\\ntouch /tmp/pwned',
  'the same with the backslash alone': 'echo #\\\ntouch',
  'a line continuation before the comment hides nothing from the shell': "echo x \\\n#'\ntouch\n#'",
  'a comment after an operator': "echo x;# '\ntouch\n# '",
  'ANSI-C quoting ends where dash and bash disagree': "echo $'a\\'b' ; touch #'",
  'a here-document body that opens a quote': "echo <<EOF\necho '\nEOF\ntouch\n'",
  'a here-document with a quoted delimiter': "echo <<'EOF'\necho '\nEOF\ntouch\n'",
  'a here-document with a stripped tab': "echo <<-EOF\necho '\nEOF\ntouch\n'",
  'a parameter expansion with a word': 'echo ${x:-"}"}" ; touch #"',
  'ksh and bash 5.3 run a command in ${ …; }': 'echo ${ touch; }',
  'a # next to a redirection': 'echo x >#c\ntouch',
  "zsh runs the command in =(…) (the login shell reads the line when it is not wrapped in sh -c)": 'echo =(touch /tmp/pwned)',
  'zsh runs the command in a glob qualifier': 'echo *(e:touch:)',
  'fish runs the command in (…)': 'echo (touch /tmp/pwned)',
};
for (const [label, line] of Object.entries(NEVER_ALLOWED)) {
  assert.equal(verdict(line).allowed, false, `must be refused: ${label}`);
}
ok(`${Object.keys(NEVER_ALLOWED).length} lines in which a command could hide are refused`);

// The commands that were hidden are now seen, as segments of their own.
assert.deepEqual(segments("echo x # it's\ntouch /tmp/pwned # '"), ['echo x', 'touch /tmp/pwned']);
assert.deepEqual(segments('echo x # x \\\ntouch /tmp/pwned'), ['echo x', 'touch /tmp/pwned']);
assert.deepEqual(segments("echo x \\\n#'\ntouch\n#'"), ['echo x \\', 'touch']);
ok('a comment ends at its newline, whatever it holds, and the line after it is read');

// ── What keeps working ──────────────────────────────────────────────────────────
const STILL_ALLOWED = {
  'a trailing comment': 'echo x # a note',
  'an apostrophe in a comment': "echo x # it's fine",
  'a double quote and a backtick in a comment': 'echo x # say "hi" and `ls`',
  'a ; in a comment': 'ls -l # list; all',
  'a comment on every line': 'echo a # one\necho b # two',
  'a # inside a word': 'echo a#b',
  'the # of $#': 'echo $#',
  'a # inside quotes': "echo 'not # a comment' \"nor # this\"",
  'a plain ${name}': 'echo ${HOME}/x ${#HOME} ${1}',
  'a here-string': 'echo <<< hello',
  'an escaped #': 'echo \\# not a comment',
  'parentheses that are escaped, quoted or in a word': "ls \\( -x \\) '(a)' \"(b)\" c\\(d",
};
for (const [label, line] of Object.entries(STILL_ALLOWED)) {
  const result = verdict(line);
  assert.equal(result.allowed, true, `must stay allowed: ${label} (${result.reason})`);
}
ok(`${Object.keys(STILL_ALLOWED).length} ordinary lines are still allowed`);

// A comment is not part of the command it follows.
assert.deepEqual(segments('ls -l # list; all'), ['ls -l']);
assert.equal(evaluatePolicy({ ...restricted, allowPatterns: ['^ls -l$'] }, 'ssh_execute', 'ls -l # list').allowed, true);
// But a deny pattern still sees the whole line, comment included: it can only refuse more.
assert.equal(evaluatePolicy({ ...restricted, denyPatterns: ['secret'] }, 'ssh_execute', 'echo x # secret').allowed, false);
ok('a comment is left out of the command it follows, and a deny pattern still sees it');

// Readonly mode tests the whole line as well as each command, so it keeps catching what it caught.
const readonly = { name: 'fixture', mode: 'readonly' };
for (const line of ['echo x # it\'s\nrm -rf /tmp/x # \'', 'echo $(rm -rf x)', "echo $'a' ; rm -rf x", 'echo <<EOF\nrm -rf x\nEOF']) {
  assert.equal(evaluatePolicy(readonly, 'ssh_execute', line).allowed, false, `readonly must refuse ${JSON.stringify(line)}`);
}
ok('readonly mode still refuses a destructive command in every one of these');

// A refusal reaches the person with a reason, not a stack trace.
assert.match(verdict("echo $'x'").reason, /ANSI-C quoting/);
assert.match(verdict('echo <<EOF\nEOF').reason, /here-document/);
assert.match(verdict('echo ${x:-a}').reason, /\$\{…\}/);
ok('each refusal says what it could not check');

// ── 2. Differential check against real shells ───────────────────────────────────
// sh, dash and bash are what `sh -c` is on the hosts we know; zsh is what a macOS login shell is, and reads the line when it is not wrapped.
const shells = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh']
  .filter((shell, index, all) => process.platform !== 'win32' && fs.existsSync(shell) && all.findIndex(other => fs.existsSync(other) && fs.realpathSync(other) === fs.realpathSync(shell)) === index);
if (!shells.length) {
  console.log('\x1b[33m-\x1b[0m no POSIX shell on this machine: the differential check is skipped');
} else {
  let state = 20261121;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const pick = list => list[Math.floor(random() * list.length)];
  const TOKENS = ['echo', 'echo', 'touch', 'touch', 'x', ' ', ' ', ' ', '\n', '\n', ';', '&&', '||', '|', "'", "'", '"', '"', '\\', '\\', '#', '#',
    '$(', ')', '`', '`', "$'", '(', '{ ', ' }', '${', '}', '$#', '$', '\\\n', '\\\n#', '<<EOF', "<<'EOF'", '\nEOF\n', '<<<', '${x:-', '${ ', "$'a\\'b'", ';#', '${x#', '=(', '*(e:'];
  const JUNK = ["'", '"', '\\', '#', ';', '(', ')', '`', '$', '{', '}', ' ', 'x', '&', '|', '$(', "\\'", '\\\n', '<<EOF', '\nEOF\n', "$'", '${'];
  const junk = n => Array.from({ length: n }, () => pick(JUNK)).join('');
  const freeform = () => {
    let text = random() < 0.7 ? 'echo ' : '';
    for (let i = 0, n = 3 + Math.floor(random() * 12); i < n; i++) text += pick(TOKENS);
    return text;
  };
  // The shape the attacks have: an allowed command, then a comment or a construct full of punctuation, then the payload.
  const structured = () => Array.from({ length: 2 + Math.floor(random() * 3) }, () =>
    pick(['echo x', 'echo', 'touch', 'echo "a"', "echo 'a'", 'echo $x', 'x', "echo $'a\\'b'", 'echo <<EOF', '']) + pick([' # ', ' #', ' ', ';# ', '#', ' && # ']) + junk(Math.floor(random() * 6)),
  ).join(pick(['\n', '\n', ' \\\n']));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-seg-'));
  const LINES = 7000;
  let checked = 0;
  let allowedLines = 0;
  const bypasses = [];
  for (let i = 0; i < LINES; i++) {
    const line = random() < 0.5 ? structured() : freeform();
    if (!verdict(line).allowed) continue;
    allowedLines++;
    for (const shell of shells) {
      const mark = path.join(scratch, `m${checked++}`);
      spawnSync(shell, ['-c', `touch() { echo T >> "${mark}"; }\n${line}`], { cwd: scratch, env: { PATH: '/nonexistent', HOME: scratch }, timeout: 3000, input: '' });
      if (fs.existsSync(mark)) bypasses.push(`${shell}: ${JSON.stringify(line)}`);
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.ok(allowedLines > 200, `the generator must produce lines the policy allows (${allowedLines})`);
  assert.deepEqual(bypasses, [], 'a line the policy allowed ran a command it never checked');
  ok(`${allowedLines} random lines allowed by the policy, run by ${shells.join(', ')}: no command ran that the allowlist had not seen`);
}

console.log(`\n✅ shell segment tests passed (${passed} checks)`);
