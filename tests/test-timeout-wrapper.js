// Regression test for the macOS timeout-wrapping bug: execCommandWithTimeout
// wraps commands in the system's timeout binary so a hung remote command gets
// killed after timeoutMs. That wrapper used to call bare `timeout`, which does
// not exist on stock macOS (only Linux ships GNU coreutils' `timeout` by
// default) — every wrapped command on a Mac target failed with exit 127
// ("timeout: command not found") regardless of what the command itself would
// have done. A later local workaround hardcoded the wrapper to
// `/opt/homebrew/bin/gtimeout`, which "fixed" that one Mac but then broke
// every non-Homebrew target (Linux, or a Mac without Homebrew coreutils) the
// same way, just with a different missing path.
//
// The fix resolves `timeout` or `gtimeout` on the remote host at execution
// time and, if neither exists, degrades to running the command without a
// timeout wrapper instead of failing outright. This test extracts the actual
// wrappedCommand template shipped in src/index.js (not a hand-copied stand-in)
// and executes it locally under three synthetic PATHs — timeout-only,
// gtimeout-only, neither — to lock the resolution and fallback behavior, and
// separately asserts no source file reintroduces a hardcoded interpreter path.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');
const INDEX_SRC = fs.readFileSync(path.join(SRC_DIR, 'index.js'), 'utf8');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// --- Extract the real wrappedCommand template from source -----------------

const templateMatch = INDEX_SRC.match(
  /const wrappedCommand = `(_t=\$\(command -v timeout[\s\S]*?fi)`;/
);
assert.ok(templateMatch, 'expected to find the timeout-wrapper template literal in src/index.js');
ok('wrappedCommand template found in source');

function buildWrapped(seconds, command) {
  const escapedCommand = command.replace(/'/g, '\'\\\'\'');
  return templateMatch[1]
    .replaceAll('${timeoutSeconds}', String(seconds))
    .replaceAll('${escapedCommand}', escapedCommand);
}

// --- No hardcoded interpreter path anywhere in the source ------------------

for (const file of fs.readdirSync(SRC_DIR)) {
  if (!file.endsWith('.js')) continue;
  const contents = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  assert.ok(
    !/\/opt\/homebrew\/bin\/g?timeout/.test(contents),
    `${file} must not hardcode a Homebrew timeout path`
  );
}
ok('no source file hardcodes /opt/homebrew/bin/(g)timeout');

// --- Synthetic PATH harness --------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-timeoutwrap-'));

// A stub that behaves enough like (g)timeout for this test: records that it
// ran, drops the leading seconds argument, and execs the rest (`sh -c '...'`).
function makeStub(dir, name) {
  const binPath = path.join(dir, name);
  fs.writeFileSync(
    binPath,
    `#!/bin/sh\necho "${name}" >> "${path.join(tmpDir, 'invoked.log')}"\nshift 1\nexec "$@"\n`
  );
  fs.chmodSync(binPath, 0o755);
}

// A minimal PATH entry carrying only `sh` (needed to resolve the bare `sh`
// inside the wrapped command) so the real system `timeout`/`gtimeout` never
// leaks into the "only gtimeout" / "neither" scenarios below — unlike
// /usr/bin or /bin, which would defeat the simulation on any host (Linux or
// Homebrew-coreutils macOS) that actually has one installed.
const shOnlyDir = path.join(tmpDir, 'sh-only');
fs.mkdirSync(shOnlyDir);
fs.symlinkSync(fs.realpathSync('/bin/sh'), path.join(shOnlyDir, 'sh'));

const scenarioDirs = new Map();
function runWrapped(binDirName, seconds, command) {
  let dir = scenarioDirs.get(binDirName);
  if (!dir) {
    dir = fs.mkdtempSync(path.join(tmpDir, `${binDirName}-`));
    if (binDirName === 'timeout-only') makeStub(dir, 'timeout');
    if (binDirName === 'gtimeout-only') makeStub(dir, 'gtimeout');
    // 'neither' gets no stubs at all.
    scenarioDirs.set(binDirName, dir);
  }

  const wrapped = buildWrapped(seconds, command);
  const stdout = execFileSync('sh', ['-c', wrapped], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${shOnlyDir}` }
  });
  const invokedLog = path.join(tmpDir, 'invoked.log');
  const invoked = fs.existsSync(invokedLog) ? fs.readFileSync(invokedLog, 'utf8').trim() : '';
  fs.rmSync(invokedLog, { force: true });
  return { stdout, invoked };
}

// Linux target: only `timeout` on PATH.
{
  const { stdout, invoked } = runWrapped('timeout-only', 5, 'echo hello-linux');
  assert.strictEqual(stdout, 'hello-linux\n');
  assert.strictEqual(invoked, 'timeout');
}
ok('resolves and uses `timeout` when only it is on PATH (stock Linux)');

// macOS-with-Homebrew-coreutils target: only `gtimeout` on PATH.
{
  const { stdout, invoked } = runWrapped('gtimeout-only', 5, 'echo hello-mac');
  assert.strictEqual(stdout, 'hello-mac\n');
  assert.strictEqual(invoked, 'gtimeout');
}
ok('falls back to `gtimeout` when `timeout` is absent (macOS + Homebrew coreutils)');

// Bare macOS target: neither exists — must still run the command, not exit 127.
{
  const { stdout, invoked } = runWrapped('neither', 5, 'echo hello-bare');
  assert.strictEqual(stdout, 'hello-bare\n');
  assert.strictEqual(invoked, '');
}
ok('runs the command with no timeout wrapper when neither binary exists, instead of failing');

// Quoting: a command containing single quotes must still round-trip correctly
// regardless of which resolution path is taken. (The command itself must be
// valid shell on its own merits — `'%s'` is single-quoted the way a real
// command would need to be; the surrounding double quotes just carry a
// literal apostrophe through to the output.)
{
  const { stdout } = runWrapped('timeout-only', 5, 'printf \'%s\' "it\'s fine"');
  assert.strictEqual(stdout, "it's fine");
}
ok('preserves commands containing single quotes');

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed`);
