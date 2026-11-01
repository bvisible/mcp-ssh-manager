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

// ── through the real engine, over SSH ───────────────────────────────────────
// An inert ssh2 fixture records what the engine sends and runs nothing. The
// "hang" command is never answered, as on a target with no timeout binary,
// where the client-side limit (the timeout plus a grace period) stops it.
{
  const repo = path.dirname(SRC_DIR);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-timeoutwrap-e2e-'));
  const { default: ssh2 } = await import('ssh2');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const crypto = await import('crypto');
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const seen = [];
  const server = new ssh2.Server({ hostKeys: [hostKey] }, connection => {
    connection.on('error', () => {});
    connection.on('authentication', ctx => ctx.accept());
    connection.on('ready', () => connection.on('session', accept => {
      accept().on('exec', (acceptExec, reject, info) => {
        const stream = acceptExec();
        seen.push(info.command);
        if (info.command.includes('hang-forever')) return; // never answers
        stream.write(info.command.includes('ping') ? 'ping\n' : 'fixture\n');
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Readers that use the OS home must see the scratch directory, not the
  // developer's files. Constant code: the directory arrives in an env var.
  const preload = path.join(home, 'isolated-home.mjs');
  fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.homedir = () => process.env.SSH_TEST_HOME; syncBuiltinESMExports();");
  const envFile = path.join(home, 'servers.env');
  fs.writeFileSync(envFile, `SSH_SERVER_TARGET_HOST=127.0.0.1\nSSH_SERVER_TARGET_PORT=${server.address().port}\nSSH_SERVER_TARGET_USER=fixture\nSSH_SERVER_TARGET_PASSWORD=fixture\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
  Object.assign(env, { SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(home, 'absent.toml'), SSH_MANAGER_HOME: home,
    SSH_MANAGER_KEY_SOURCE: 'file', SSH_MANAGER_VAULT: path.join(home, 'vault.json'), SSH_MANAGER_KNOWN_HOSTS: path.join(home, 'known_hosts'),
    SSH_LOG_FILE: path.join(home, 'engine.log'), SSH_HISTORY_FILE: path.join(home, 'history.json'), SSH_LOG_LEVEL: 'ERROR', SSH_TEST_HOME: home });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, path.join(repo, 'src', 'index.js')], cwd: home, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'timeout-wrapper', version: '1.0' });
  try {
    await client.connect(transport);
    const text = result => result.content.map(item => item.text || '').join('\n');

    let result = await client.callTool({ name: 'ssh_execute', arguments: { server: 'target', command: "printf '%s' \"it's fine\"", timeout: 30000 } });
    assert.ok(!result.isError, text(result));
    assert.ok(seen.includes(withRemoteTimeout("printf '%s' \"it's fine\"", 30)), `the engine sends the wrapper over SSH (saw ${JSON.stringify(seen)})`);
    ok('ssh_execute sends exactly withRemoteTimeout(command, seconds) over SSH');

    const started = Date.now();
    result = await client.callTool({ name: 'ssh_execute', arguments: { server: 'target', command: 'hang-forever', timeout: 1000 } });
    const message = text(result);
    assert.ok(result.isError || /timeout/i.test(message), message);
    assert.match(message, /Command timeout after 1000ms: hang-forever/, 'the error names the command and the limit the caller asked for');
    assert.doesNotMatch(message, /sh -c|command -v/, 'not the wrapper');
    assert.ok(Date.now() - started < 15000);
    ok('without a remote timeout, the client-side limit stops it and the error names the caller\'s command and limit');
  } finally {
    await client.close().catch(() => {});
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n✅ remote timeout wrapper tests passed (${passed} checks)`);
