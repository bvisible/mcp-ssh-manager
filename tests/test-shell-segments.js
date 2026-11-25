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
import { commandWordProblem, readSegments, splitShellCommand } from '../src/shell-segments.js';

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

// ── 3. A deny pattern is tested on the command the shell runs ───────────────────
// A shell does not run the text it was given. `r""m`, `r\m`, `r${x}m` and a backslash and
// a newline inside the name are all `rm`, so a pattern tested on the typed text alone lets
// an allowed launcher (`find -exec`, `xargs`, `env`, …) start the command it denies
// (GHSA-4fp4-fggm-cf5c).
const guarded = { name: 'fixture', mode: 'restricted', allowPatterns: ['^find', '^echo', '^ls', '^xargs', '^env'], denyPatterns: ['\\brm\\b', '^rm\\s'] };
const guardedVerdict = line => evaluatePolicy(guarded, 'ssh_execute', line);
const launched = word => `find . -maxdepth 0 -exec ${word} -rf victim {} +`;

assert.equal(guardedVerdict('rm -rf victim').allowed, false);
assert.equal(guardedVerdict(launched('rm')).allowed, false);
ok('the control cases hold: a plain rm, and rm behind an allowed find, are denied');

const SPELLINGS_OF_RM = {
  'a backslash and a newline (the advisory)': 'r\\\nm',
  'an unset name (the advisory)': 'r${x}m',
  'an unset name without braces': 'r$x""m',
  'a name glued to quotes': 'r$x\'\'m',
  'a name hidden behind a line continuation': 'r$\\\n{x}m',
  'a bare name that stands for nothing': 'r$@m',
  'a positional parameter': 'r${1}m',
  'an empty quote': 'r""m',
  'an empty single quote': "r''m",
  'a backslash': 'r\\m',
  'a quoted letter': '"r"m',
  'a backslash before the name': '\\rm',
  'an empty command substitution': 'r$(true)m',
  'an empty backtick pair': 'r`true`m',
  'a default value': 'r${x:-}m',
  'a default value with a word': 'r${x:-m}',
  'a brace expansion': '{r,}m',
  'a brace expansion at the end': 'r{m,}',
  'braces that give two letters': '{r,x}m',
  'ANSI-C quoting': "$'r\\x6d'",
  'a backslash that ends the line': 'rm\\',
  'the last argument of the line before': 'r$_',
  'a name that holds blanks': 'rm${IFS}-rf',
  'a path to it': '/bin/rm',
};
for (const [label, word] of Object.entries(SPELLINGS_OF_RM)) {
  for (const line of [launched(word), `echo x | xargs ${word}`, `echo m; env ${word} x`]) {
    assert.equal(guardedVerdict(line).allowed, false, `restricted must refuse ${label}: ${JSON.stringify(line)}`);
  }
}
ok(`${Object.keys(SPELLINGS_OF_RM).length} ways of writing rm, behind find, xargs and env, are refused in restricted mode`);

// readonly has no allowlist: its built-in list is tested on the same readings.
const READONLY_SPELLINGS = { ...SPELLINGS_OF_RM };
delete READONLY_SPELLINGS['the last argument of the line before'];
for (const [label, word] of Object.entries(READONLY_SPELLINGS)) {
  for (const line of [launched(word), `echo x | xargs ${word}`, `env ${word} x`]) {
    assert.equal(evaluatePolicy(readonly, 'ssh_execute', line).allowed, false, `readonly must refuse ${label}: ${JSON.stringify(line)}`);
  }
}
assert.equal(evaluatePolicy(readonly, 'ssh_execute', 'echo m; find . -exec r$_ x {} +').allowed, false, 'readonly must refuse $_');
assert.match(evaluatePolicy(readonly, 'ssh_execute', 'echo m; find . -exec r$_ x {} +').reason, /\$_/);
assert.equal(evaluatePolicy(readonly, 'ssh_execute', '/bin/rm -rf x').allowed, false, 'readonly must read the name of /bin/rm');
for (const line of ['"rm" -rf x', "'rm' -rf x", 'find . -exec "rm" x {} +', 'echo x | xargs \'rm\'', 'env "rm" x']) {
  assert.equal(evaluatePolicy(readonly, 'ssh_execute', line).allowed, false, `readonly must refuse a quoted command name: ${JSON.stringify(line)}`);
  assert.equal(guardedVerdict(line).allowed, false, `restricted must refuse a quoted command name: ${JSON.stringify(line)}`);
}
// A quoted string that is an argument stays an argument.
for (const line of ['grep "kill -9" /var/log/syslog', "grep 'service nginx restart' /var/log/syslog", 'grep -E "error|killed|oom" /var/log/syslog', 'echo "rm -rf x"', 'journalctl -u nginx | grep "systemctl restart"']) {
  assert.equal(evaluatePolicy(readonly, 'ssh_execute', line).allowed, true, `readonly must keep allowing a quoted argument: ${JSON.stringify(line)}`);
}
ok('readonly mode refuses the same spellings, and $_, and a command named by its path, and keeps a quoted argument an argument');

// What the shell cannot make into a command stays possible.
const guardedStillAllowed = [
  'ls "/var/log"',
  'ls -l \'/var/log\'',
  'echo "a b" c',
  'echo $HOME ${HOME} "$HOME/x" $?',
  'echo $1 $@ $*',
  'find . -name "*.log" -exec echo {} +',
  'find /var/log -type f -name \'*.gz\' -exec ls -l {} \;',
  'echo "it\'s"',
  'echo a\\ b',
];
for (const line of guardedStillAllowed) {
  const result = guardedVerdict(line);
  assert.equal(result.allowed, true, `must stay allowed: ${JSON.stringify(line)} (${result.reason})`);
}
for (const line of ['echo {a,b}', 'ls {1..3}', 'echo ${x:-a}', 'echo $_', 'echo ${_}']) {
  assert.equal(guardedVerdict(line).allowed, false, `restricted must refuse ${JSON.stringify(line)}: a line can make it spell a name`);
}
for (const line of ['echo {a,b}', 'ls /var/log/{syslog,auth.log}', 'echo ${x:-a}']) {
  assert.equal(evaluatePolicy(readonly, 'ssh_execute', line).allowed, true, `readonly must keep allowing ${JSON.stringify(line)}`);
}
ok('quoted arguments, plain names and the find placeholder still work; what can spell a name is refused in restricted mode only');

// The name of a command is matched as typed, so it must be the name the shell runs.
const lister = { name: 'fixture', mode: 'restricted', allowPatterns: ['^ls\\b', '^cat\\b'], denyPatterns: [] };
for (const line of ['ls""x', 'ls\\x', 'ls${x}x', '"ls" -l', '\\ls', '/bin/l? -l', '$x ls', 'FOO=1 l"s"']) {
  assert.equal(evaluatePolicy(lister, 'ssh_execute', line).allowed, false, `the name must be as typed: ${JSON.stringify(line)}`);
}
for (const line of ['ls -l "/var/log"', 'cat /etc/hostname 2>/dev/null', 'ls /var/l?g']) {
  assert.equal(evaluatePolicy(lister, 'ssh_execute', line).allowed, true, `must stay allowed: ${JSON.stringify(line)}`);
}
assert.equal(commandWordProblem('[ -f x ]'), null);
assert.equal(commandWordProblem('ls -l'), null);
assert.equal(commandWordProblem('FOO=1 ls'), null);
assert.match(commandWordProblem('FOO=1 l"s"'), /name of the command/);
assert.match(commandWordProblem('l"s" -l'), /name of the command/);
ok('a command named with a quote, a backslash, a variable or a glob is refused; an argument may use them');

// The readings themselves.
const { texts, unreadable, guessed } = readSegments(['r""m x', 'echo ${y}z']);
assert.ok(texts.includes('rm x') && texts.includes('echo z') && texts.includes('echo  z'.trim().replace(/ +/, ' ')), JSON.stringify(texts));
assert.equal(unreadable, null);
assert.equal(guessed, null);
assert.match(readSegments(['echo $_']).unreadable, /\$_/);
assert.match(readSegments(['echo {a,b}']).guessed, /brace/);
assert.equal(readSegments(['echo \'{a,b}\' "{a,b}" \\{a,b}']).guessed, null, 'quoted braces are text');
assert.equal(readSegments(['echo {} +']).guessed, null, 'the find placeholder is not a brace expansion');
assert.ok(readSegments(['{r,}m x']).texts.includes('rm x'));
assert.ok(readSegments(['r$\\\n{x}m']).texts.includes('rm'), 'a continuation inside ${name} is joined first');
assert.ok(readSegments(['/usr/bin/rm x']).texts.includes('rm x'));
assert.ok(!readSegments(['cat /etc/pam.d/su']).texts.includes('cat su'), 'only the command is read without its directory');
// A line made to make a regular expression back off must not hold the policy up.
for (const hostile of ['echo {' + 'a,'.repeat(40000), 'echo ' + '{a,'.repeat(20000), 'echo ' + '${x:-'.repeat(8000), 'echo ' + '$('.repeat(4000)]) {
  const started = Date.now();
  readSegments(splitShellCommand(hostile).segments);
  evaluatePolicy(guarded, 'ssh_execute', hostile);
  assert.ok(Date.now() - started < 3000, `a hostile line took ${Date.now() - started} ms`);
}
ok('readSegments gives the typed text first, then what the shell makes of it');

if (shells.length) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-deny-'));
  fs.mkdirSync(path.join(home, 'bin'));
  const mark = path.join(home, 'mark');
  // A stand-in for rm that leaves a mark, found by find -exec, xargs and env through PATH.
  fs.writeFileSync(path.join(home, 'bin', 'rm'), `#!/bin/sh\necho T >> "${mark}"\n`, { mode: 0o755 });
  const env = { PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`, HOME: home };
  let seed = 20261125;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 10) % n; };
  const choose = list => list[next(list.length)];
  const INSERTS = ['""', "''", '\\\n', '${u}', '$u""', '${u:-}', '$@', '${@}', '$1', '${1}', '$*', '"$u"', '"${u}"', '$u', '${#u}', '$IFS', '${IFS}', '"$@"', '$_', '${_}', '$-', '$?', '$$', '$!', '$(true)', '`true`', '$(:)'];
  const WRAPS = [c => `"${c}"`, c => `'${c}'`, c => `\\${c}`, c => c, c => c];
  const spelling = () => {
    if (next(10) === 0) return choose(['{r,}m', 'r{m,}', '{r,x}m', 'r{,m}', '{r,}{m,}', '{rm,}', '{,rm}', 'r{m,m}', '{r,r}m', "$'rm'", "$'r\\x6d'", "$'\\x72m'", '$"rm"']);
    let word = choose(WRAPS)('r') + choose(WRAPS)('m');
    for (let k = 0, n = 1 + next(3); k < n; k++) {
      const at = next(word.length + 1);
      word = word.slice(0, at) + choose(INSERTS) + word.slice(at);
    }
    return word;
  };
  const LAUNCHERS = [w => `find . -maxdepth 0 -exec ${w} x {} +`, w => `echo x | xargs ${w}`, w => `env ${w} x`, w => `find . -maxdepth 0 -exec ${w} x \;`];
  const slips = [];
  let spawned = 0;
  let lines = 0;
  for (let n = 0; n < 1500; n++) {
    const line = (next(4) === 0 ? 'echo m; ' : '') + choose(LAUNCHERS)(spelling());
    lines++;
    const verdicts = { restricted: guardedVerdict(line).allowed, readonly: evaluatePolicy(readonly, 'ssh_execute', line).allowed };
    if (!verdicts.restricted && !verdicts.readonly) continue;
    for (const shell of shells) {
      fs.rmSync(mark, { force: true });
      spawned++;
      spawnSync(shell, ['-c', line], { cwd: home, env, timeout: 3000, input: '' });
      if (fs.existsSync(mark)) slips.push(`${path.basename(shell)} (${Object.keys(verdicts).filter(k => verdicts[k]).join(', ')} allowed it): ${JSON.stringify(line)}`);
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
  assert.deepEqual(slips, [], 'a line the policy allowed ran the command its deny pattern names');
  ok(`${lines} random spellings of rm behind find, xargs and env: no line was allowed that ${shells.length} shells then ran as rm (${spawned} runs)`);
}

console.log(`\n✅ shell segment tests passed (${passed} checks)`);
