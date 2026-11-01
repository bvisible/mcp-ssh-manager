// The remote timeout wrapper (#115, contributed by Henrik Tilly).
//
// execCommandWithTimeout wraps every bounded command so the remote host kills it
// after timeoutMs. It used to call bare `timeout`, which stock macOS does not
// have: every wrapped command against a Mac target failed with exit 127
// ("timeout: command not found") whatever the command itself would have done.
// The wrapper now resolves `timeout` or `gtimeout` on the target and, with
// neither, runs the command unwrapped instead of failing.
//
// The SSH server hands the wrapped command to the account's *login* shell, so it
// is run here under every shell this machine has, csh and tcsh included: a first
// version of the fix wrote `$(...)` and `if ... fi` at the top level, which csh
// and tcsh reject. CI runners may not have them, so the property that makes it
// work there is asserted as well: the wrapper is one simple command made only of
// single-quoted words.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { withRemoteTimeout } from '../src/shell-quote.js';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// ── what the wrapper is made of ─────────────────────────────────────────────
{
  const wrapped = withRemoteTimeout("printf '%s' \"it's fine\"", 30);
  // sh -c '<script>' sh 30 '<command>': every argument is a single-quoted word
  // (a '\'' inside one is the POSIX way to carry a quote), nothing else.
  assert.match(wrapped, /^sh -c '(?:[^']|'\\'')*' sh 30 '(?:[^']|'\\'')*'$/);
  const seconds = value => withRemoteTimeout('true', value).match(/' sh (\S+) 'true'$/)?.[1];
  assert.equal(seconds(Number.NaN), '1', 'a bad timeout becomes 1 s, never text in the command');
  assert.equal(seconds('5; reboot'), '1');
  assert.equal(seconds(2.5), '2');
  ok('the wrapper is a simple command of single-quoted words, whatever the command contains');

  const index = fs.readFileSync(path.join(SRC_DIR, 'index.js'), 'utf8');
  assert.match(index, /withRemoteTimeout\(command, Math\.ceil\(timeoutMs \/ 1000\)\)/, 'execCommandWithTimeout uses the shared wrapper');
  for (const file of fs.readdirSync(SRC_DIR).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(!/\/opt\/homebrew\/bin\/g?timeout/.test(source), `${file} must not hardcode a Homebrew timeout path`);
    assert.ok(!/`timeout \$\{/.test(source), `${file} must not wrap a command in a bare \`timeout\` again`);
  }
  ok('execCommandWithTimeout uses it, and no source file hardcodes or assumes a timeout binary');
}

// ── run for real, under each login shell this machine has ──────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-timeoutwrap-'));
try {
  const log = path.join(scratch, 'invoked.log');
  // A stand-in for (g)timeout: records that it ran, drops the seconds, runs the rest.
  const layout = (name, binaries) => {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir);
    // Only `sh`, so a real timeout on this machine cannot leak into "neither".
    fs.symlinkSync(fs.realpathSync('/bin/sh'), path.join(dir, 'sh'));
    for (const binary of binaries) {
      fs.writeFileSync(path.join(dir, binary), `#!/bin/sh\necho ${binary} >> '${log}'\nshift 1\nexec "$@"\n`, { mode: 0o755 });
    }
    return dir;
  };
  const layouts = {
    'timeout only (Linux)': { dir: layout('timeout-only', ['timeout']), uses: 'timeout' },
    'gtimeout only (macOS + Homebrew coreutils)': { dir: layout('gtimeout-only', ['gtimeout']), uses: 'gtimeout' },
    'neither (stock macOS)': { dir: layout('neither', []), uses: '' },
    'both': { dir: layout('both', ['timeout', 'gtimeout']), uses: 'timeout' },
  };
  const commands = [
    ['echo hello', 'hello\n'],
    ["printf '%s' \"it's fine\"", "it's fine"],
    ['printf "%s|" "a b" \'c d\' "$((1 + 2))"', 'a b|c d|3|'],
  ];
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/bin/ksh', '/bin/csh', '/bin/tcsh',
    '/usr/bin/fish', '/opt/homebrew/bin/fish'].filter(shell => fs.existsSync(shell));
  assert.ok(shells.length > 0);

  for (const shell of shells) {
    for (const [label, { dir, uses }] of Object.entries(layouts)) {
      for (const [command, expected] of commands) {
        fs.rmSync(log, { force: true });
        const out = execFileSync(shell, ['-c', withRemoteTimeout(command, 5)], { env: { PATH: dir, HOME: scratch }, encoding: 'utf8' });
        assert.equal(out, expected, `${shell}, ${label}: ${command}`);
        const invoked = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
        assert.equal(invoked, uses, `${shell}, ${label}: ran under ${uses || 'no wrapper'}`);
      }
    }
  }
  ok(`${shells.map(shell => path.basename(shell)).join(', ')}: timeout, gtimeout or none is used as found, and the output is the command's own`);

  // The command's exit code comes through unchanged.
  for (const shell of shells) {
    const result = spawnSync(shell, ['-c', withRemoteTimeout('exit 3', 5)], { env: { PATH: layouts['timeout only (Linux)'].dir, HOME: scratch } });
    assert.equal(result.status, 3, `${shell}: exit status`);
  }
  ok('the command\'s exit status reaches the caller');

  // And the point of it all: with a real timeout binary, a command that hangs
  // is killed with the code execCommandWithTimeout reads as a timeout.
  const real = ['timeout', 'gtimeout'].map(name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()).find(Boolean);
  if (real) {
    const started = Date.now();
    const result = spawnSync('/bin/sh', ['-c', withRemoteTimeout('sleep 10', 1)], { encoding: 'utf8' });
    assert.equal(result.status, 124, `${real} reports the timeout as 124`);
    assert.ok(Date.now() - started < 5000, 'killed after about a second, not after ten');
    ok(`${path.basename(real)} on this machine kills a hung command after its timeout (exit 124)`);
  } else {
    console.log('(no timeout or gtimeout on this machine: the real kill is checked where there is one, e.g. on Linux CI)');
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n✅ remote timeout wrapper tests passed (${passed} checks)`);
