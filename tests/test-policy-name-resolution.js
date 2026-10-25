// Security regression test for GHSA-mq9f-5385-rjf4.
//
// The policy layer looked a server up by its exact name; the connection layer
// resolved aliases, case, a unique part of a name and host matches. So "p", an
// alias the client had just created with ssh_alias, or the host itself found
// no configuration in the policy layer — unrestricted — and the connection
// then ran the command on the readonly or restricted server anyway.
//
// This drives the real stdio MCP entry point against an inert SSH fixture that
// records what reaches it and never runs any of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-names-'));
const engine = path.join(scratch, 'engine');
fs.mkdirSync(engine);
fs.cpSync(path.join(repo, 'src'), path.join(engine, 'src'), { recursive: true });
fs.copyFileSync(path.join(repo, 'package.json'), path.join(engine, 'package.json'));
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(engine, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
// Readers that use the OS home must see the fixture, not the developer's files.
const preload = path.join(scratch, 'isolated-home.mjs');
// Constant code: the directory arrives in SSH_TEST_HOME, never spliced into the source.
fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const home = process.env.SSH_TEST_HOME; if (!home) throw new Error('SSH_TEST_HOME is not set'); os.homedir = () => home; syncBuiltinESMExports();");
const envFile = path.join(scratch, 'servers.env');
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const seen = [];
const connections = new Set();

// Accepts exec and shell requests, records their text, runs nothing.
const server = new ssh2.Server({ hostKeys: [privateKey] }, connection => {
  connections.add(connection);
  connection.on('close', () => connections.delete(connection));
  connection.on('error', () => {});
  connection.on('authentication', ctx => ctx.accept());
  connection.on('ready', () => connection.on('session', accept => {
    const session = accept();
    session.on('pty', acceptPty => acceptPty());
    session.on('shell', acceptShell => {
      const stream = acceptShell();
      stream.on('data', data => {
        const input = data.toString();
        seen.push(`shell:${input}`);
        // Answer the session protocol's markers without executing its text.
        const ready = input.match(/ready_[a-f0-9]+/);
        const marker = input.match(/cmd_[a-f0-9]+/);
        if (ready) stream.write(`${ready[0]}\n`);
        if (marker) stream.write(`/fixture\n${marker[0]}:0\n`);
        if (input === 'exit\n') stream.end();
      });
    });
    session.on('exec', (acceptExec, _reject, info) => {
      const stream = acceptExec();
      seen.push(info.command);
      stream.write('fixture\n');
      stream.exit(0);
      stream.end();
    });
  }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const writeEnv = extra => fs.writeFileSync(envFile, [
  'SSH_SERVER_PROD_HOST=127.0.0.1', `SSH_SERVER_PROD_PORT=${port}`,
  'SSH_SERVER_PROD_USER=fixture', 'SSH_SERVER_PROD_PASSWORD=fixture', ...extra, '',
].join('\n'));

const text = result => result.content.map(item => item.text || '').join('\n');
const reached = fragment => seen.some(command => command.includes(fragment));

/** One engine per configuration: the .env is read at start. */
async function engineWith(extra) {
  writeEnv(extra);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
  Object.assign(env, {
    SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
    SSH_MANAGER_HOME: path.join(scratch, 'state'), SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
    SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'),
    SSH_LOG_LEVEL: 'ERROR', SSH_TEST_HOME: scratch,
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', preload, path.join(engine, 'src/index.js')], cwd: engine, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'name-resolution-regression', version: '1.0' });
  await client.connect(transport);
  return { call: (name, args) => client.callTool({ name, arguments: args }), close: () => client.close() };
}

let engineHandle;
try {
  // ── readonly ────────────────────────────────────────────────────────────
  engineHandle = await engineWith(['SSH_SERVER_PROD_MODE=readonly']);
  const { call } = engineHandle;

  for (const name of ['prod', 'PROD', 'p', 'ro', '127.0.0.1']) {
    const result = await call('ssh_execute', { server: name, command: `rm -f /tmp/marker-${name}` });
    assert.equal(result.isError, true, `${name}: a destructive command must be refused`);
    assert.match(text(result), /Policy denied/, name);
    assert.ok(!reached(`marker-${name}`), `${name}: the refused command reached the server`);
  }
  ok('readonly refuses by exact name, other case, partial name and host alike');

  let result = await call('ssh_alias', { action: 'add', alias: 'xx', server: 'prod' });
  assert.notEqual(result.isError, true, text(result));
  result = await call('ssh_execute', { server: 'xx', command: 'rm -f /tmp/marker-alias' });
  assert.match(text(result), /Policy denied/);
  assert.ok(!reached('marker-alias'), 'an alias created by the client bypassed readonly');
  ok('an alias the client creates itself is held to the same policy');

  result = await call('ssh_upload', { server: 'p', localPath: envFile, remotePath: '/tmp/marker-upload' });
  assert.match(text(result), /Policy denied/);
  assert.ok(!reached('marker-upload'));
  ok('a tool readonly blocks stays blocked under a partial name');

  result = await call('ssh_execute', { server: 'p', command: 'cat /etc/hostname' });
  assert.notEqual(result.isError, true, text(result));
  assert.ok(reached('cat /etc/hostname'), 'a read command must still run');
  ok('a read command still runs through a partial name');

  result = await call('ssh_session_start', { server: 'p' });
  const sessionId = /"?(?:session_id|sessionId|id)"?\s*[:=]\s*"?([\w-]+)/i.exec(text(result))?.[1]
    ?? /([a-f0-9-]{8,})/i.exec(text(result))?.[1];
  assert.ok(sessionId, `no session id in ${text(result)}`);
  result = await call('ssh_session_send', { session: sessionId, command: 'rm -f /tmp/marker-session' });
  assert.match(text(result), /Policy denied/);
  assert.ok(!reached('marker-session'), 'a session opened under a partial name bypassed readonly');
  result = await call('ssh_session_list', {});
  assert.match(text(result), /prod/, 'the session must record the server\'s own name');
  await call('ssh_session_close', { session: sessionId });
  ok('a session opened under a partial name keeps the server\'s own name and its policy');
  await engineHandle.close();

  // ── restricted ──────────────────────────────────────────────────────────
  engineHandle = await engineWith(['SSH_SERVER_PROD_MODE=restricted', 'SSH_SERVER_PROD_ALLOW_PATTERNS=^cat ']);
  result = await engineHandle.call('ssh_execute', { server: 'p', command: 'touch /tmp/marker-restricted' });
  assert.match(text(result), /Policy denied/);
  assert.ok(!reached('marker-restricted'), 'a partial name bypassed the restricted allowlist');
  result = await engineHandle.call('ssh_execute', { server: 'p', command: 'cat /etc/os-release' });
  assert.notEqual(result.isError, true, text(result));
  assert.ok(reached('cat /etc/os-release'));
  ok('restricted applies its allowlist under a partial name, and allows what it lists');
  await engineHandle.close();

  // ── ambiguity ───────────────────────────────────────────────────────────
  engineHandle = await engineWith(['SSH_SERVER_PROD_MODE=readonly',
    'SSH_SERVER_PRODTWO_HOST=127.0.0.1', `SSH_SERVER_PRODTWO_PORT=${port}`,
    'SSH_SERVER_PRODTWO_USER=fixture', 'SSH_SERVER_PRODTWO_PASSWORD=fixture']);
  result = await engineHandle.call('ssh_execute', { server: 'pro', command: 'touch /tmp/marker-ambiguous' });
  assert.equal(result.isError, true);
  assert.ok(!reached('marker-ambiguous'), 'an ambiguous name reached a server');
  ok('an ambiguous name is refused and reaches nothing');

  console.log(`\n✅ policy name resolution tests passed (${passed} checks)`);
} finally {
  await engineHandle?.close().catch(() => {});
  for (const connection of connections) connection.end();
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
