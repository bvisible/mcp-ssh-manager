// A command sent into a session shows on the Live page and in the history, as
// one run with ssh_execute does (#163).
//
// Only ssh_execute opened a stream to the control plane. A command sent with
// ssh_session_send ran, was checked by the policy and audited, but did not
// appear to the person watching, nor in the history built from those streams.
//
// This drives the real stdio MCP entry point against a test SSH server whose
// shell echoes its input and keeps a prompt (the kind that broke sessions), with
// a real control plane listening, and reads what the plane received.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FakeShell } from './helpers/fake-shell.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Short: a Unix socket path is capped at 104 bytes.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
const socket = path.join(scratch, 'a.sock');
process.env.SSH_MANAGER_HOME = scratch;
process.env.SSH_MANAGER_APPROVAL_SOCKET = socket;
const { ControlPlane } = await import('../src/control-plane.js');
const { readCommandLog } = await import('../src/command-log.js');

// The engine runs from a copy of the sources: a `.env` at the repository root
// (CI writes one) would otherwise be read as the install directory's.
const engine = path.join(scratch, 'engine');
fs.mkdirSync(engine);
fs.cpSync(path.join(repo, 'src'), path.join(engine, 'src'), { recursive: true });
fs.copyFileSync(path.join(repo, 'package.json'), path.join(engine, 'package.json'));
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(engine, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
// Readers that use the OS home (the tools configuration) must see the fixture,
// not the developer's files.
const preload = path.join(scratch, 'isolated-home.mjs');
// Constant code: the directory arrives in SSH_TEST_HOME, never spliced into the source.
fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const home = process.env.SSH_TEST_HOME; if (!home) throw new Error('SSH_TEST_HOME is not set'); os.homedir = () => home; syncBuiltinESMExports();");
const envFile = path.join(scratch, 'servers.env');
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await wait(25);
  }
  return null;
}

const connections = new Set();
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
      // A bastion: it echoes, ignores stty and PS1, and prints a prompt.
      const shell = new FakeShell(
        { echo: true, honorsStty: false, honorsPrompt: false, prompt: '$ ', escapes: true },
        text => stream.write(text)
      );
      stream.on('data', data => {
        const input = data.toString();
        if (input === 'exit\n') return stream.end();
        shell.input(input);
      });
    });
  }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
fs.writeFileSync(envFile, [
  'SSH_SERVER_PROD_HOST=127.0.0.1', `SSH_SERVER_PROD_PORT=${port}`,
  'SSH_SERVER_PROD_USER=fixture', 'SSH_SERVER_PROD_PASSWORD=fixture', '',
].join('\n'));

const text = result => result.content.map(item => item.text || '').join('\n');

const plane = new ControlPlane({ socketPath: path.join(scratch, 'plane.sock'), port: 0 });
await plane.start();

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
Object.assign(env, {
  SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
  SSH_MANAGER_HOME: scratch, SSH_MANAGER_APPROVAL_SOCKET: socket,
  SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
  SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'),
  SSH_LOG_LEVEL: 'ERROR', SSH_TEST_HOME: scratch,
});
const transport = new StdioClientTransport({
  command: process.execPath, args: ['--import', preload, path.join(engine, 'src/index.js')], cwd: engine, env, stderr: 'pipe'
});
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'session-live', version: '1.0' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args });

let failure;
try {
  let result = await call('ssh_session_start', { server: 'prod' });
  assert.notEqual(result.isError, true, text(result));
  const sessionId = text(result).match(/Session ID: (\S+)/)[1];
  assert.match(text(result), /Working Directory: \/home\/user\b/);
  ok('a session starts on a shell that echoes and keeps a prompt, with its directory read');

  result = await call('ssh_session_send', { session: sessionId, command: 'echo from the session' });
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /✅ Output:\nfrom the session\n/, 'the agent sees the clean output');
  assert.ok(!/\$ |printf|__mcp_status|start_|cmd_/.test(text(result).split('Output:')[1]), 'no echo, prompt or marker in what the agent reads');
  ok('the agent reads the output of a session command, without echo, prompt or markers');

  const first = await until(() => plane.streams.list().find(s => s.command === 'echo from the session' && s.code !== null));
  assert.ok(first, 'the command must reach the Live page');
  assert.equal(first.server, 'prod');
  assert.equal(first.code, 0);
  assert.equal(first.scrollback, 'from the session', 'the Live page shows the output, clean');
  ok('the command and its output appear on the Live page');

  result = await call('ssh_session_send', { session: sessionId, command: 'false' });
  assert.match(text(result), /❌ Error:/, 'a failing command is reported as failed');
  const failed = await until(() => plane.streams.list().find(s => s.command === 'false' && s.code !== null));
  assert.ok(failed, 'a failing command reaches the Live page too');
  assert.equal(failed.code, 1, 'with the status the shell reported');
  ok('a failing command shows its exit status');

  const logged = await until(() => {
    const entries = readCommandLog();
    return entries.some(e => e.command === 'echo from the session') && entries.some(e => e.command === 'false') ? entries : null;
  });
  assert.ok(logged, 'both commands must be in the history');
  const entry = logged.find(e => e.command === 'echo from the session');
  assert.equal(entry.server, 'prod');
  assert.equal(entry.code, 0);
  assert.equal(logged.find(e => e.command === 'false').code, 1);
  ok('both commands are in the history, with server and exit status');

  // Nothing watching: the command must run exactly the same.
  await plane.stop();
  result = await call('ssh_session_send', { session: sessionId, command: 'echo nobody watches' });
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /✅ Output:\nnobody watches\n/);
  ok('with no control plane running, a session command runs as before');

  await call('ssh_session_close', { session: sessionId });
} catch (error) {
  failure = error;
} finally {
  await client.close().catch(() => {});
  await plane.stop().catch(() => {});
  for (const connection of connections) connection.end();
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`\n✅ session live tests passed (${passed} checks)`);
process.exit(0);
