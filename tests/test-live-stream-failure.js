// Regression test: a command that fails to finish must not stay "running" on the
// Live page. ssh_execute opens a stream to the control plane and used to close it
// only when the call returned. A timeout or a dropped connection throws instead,
// so the entry kept code null (the page's "running") until the control plane
// restarted, and the stream's socket stayed open. The same happened when the
// engine itself disappeared mid-command.
//
// Drives the real stdio entry point against a local ssh2 server, with the real
// control-plane side of the stream (StreamRegistry + listenForStreams) in this process.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamRegistry, listenForStreams } from '../src/live-stream.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Short path: sun_path caps Unix sockets at 104 bytes.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lsf-'));
process.env.SSH_MANAGER_APPROVAL_SOCKET = path.join(scratch, 'approval.sock');

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const sockets = new Set();

// A host that behaves like a shell for a few commands:
//   `echo ping` (the pool's health check) and anything else: answers and exits 0
//   a command with "slow": prints a line, then exits 124, which is what the remote
//     `timeout` does when it kills a command (the engine reports that as a timeout)
//   a command with "hang": never answers
const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => {});
  client.on('authentication', context => context.accept());
  client.on('ready', () => client.on('session', open => open().on('exec', (start, _reject, info) => {
    const stream = start();
    if (/echo ping/.test(info.command)) { stream.write('ping\n'); stream.exit(0); stream.end(); return; }
    if (/hang/.test(info.command)) return;
    if (/slow/.test(info.command)) { stream.write('partial output\n'); stream.exit(124); stream.end(); return; }
    stream.write('fine\n'); stream.exit(0); stream.end();
  })));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const registry = new StreamRegistry();
const events = [];
registry.subscribe(event => events.push(event));
const streamServer = await listenForStreams(registry);

const envFile = path.join(scratch, 'servers.env');
fs.writeFileSync(envFile, [
  'SSH_SERVER_FIXTURE_HOST=127.0.0.1', `SSH_SERVER_FIXTURE_PORT=${server.address().port}`,
  'SSH_SERVER_FIXTURE_USER=fixture', 'SSH_SERVER_FIXTURE_PASSWORD=fixture', '',
].join('\n'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
Object.assign(env, {
  HOME: scratch, SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
  SSH_MANAGER_HOME: path.join(scratch, 'state'), SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
  SSH_MANAGER_APPROVAL_SOCKET: process.env.SSH_MANAGER_APPROVAL_SOCKET,
  SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'),
  SSH_LOG_LEVEL: 'ERROR',
});

async function startEngine() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'src/index.js')], cwd: repo, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'live-failure-test', version: '1' });
  await client.connect(transport);
  return { client, transport };
}
const entry = fragment => [...registry.streams.values()].find(stream => stream.command.includes(fragment));
const text = result => result.content.map(item => item.text || '').join(' ');

const first = await startEngine();
try {
  // 1. The control: a command that finishes is closed with its own exit code.
  await first.client.callTool({ name: 'ssh_execute', arguments: { server: 'fixture', command: 'echo fine' } });
  await until(() => entry('echo fine')?.code === 0, 'a finished command to read exit 0');
  ok('a command that finishes is closed with its exit code');

  // 2. The reported case: the call throws (a timeout). The entry must still end.
  const slow = await first.client.callTool({ name: 'ssh_execute', arguments: { server: 'fixture', command: 'slow job', timeout: 3000 } });
  assert.equal(slow.isError, true, 'a timeout is an error for the agent');
  assert.match(text(slow), /timeout/i);
  assert.match(text(slow), /"code":\s*-1/, 'the reply to the agent carries -1');
  await until(() => entry('slow job')?.code !== null && entry('slow job')?.code !== undefined, 'the timed-out command to be closed');
  assert.equal(entry('slow job').code, -1, 'the page shows exit -1, not "running"');
  assert.match(entry('slow job').scrollback, /partial output/, 'what it printed before failing is kept');
  assert.equal(events.filter(event => event.type === 'end' && event.id === entry('slow job').id).length, 1, 'closed once');
  ok('a command whose call throws is closed with -1, and no longer reads as running');
} finally { await first.client.close().catch(() => {}); }

// 3. The engine disappears in the middle of a command: nothing would ever end it.
const second = await startEngine();
second.client.callTool({ name: 'ssh_execute', arguments: { server: 'fixture', command: 'hang forever' } }).catch(() => {});
await until(() => entry('hang forever'), 'the hanging command to appear');
assert.equal(entry('hang forever').code, null, 'while the engine is alive it is rightly running');
process.kill(second.transport.pid, 'SIGKILL');
await until(() => entry('hang forever').code !== null, 'the killed engine\'s command to be closed');
assert.equal(entry('hang forever').code, -1);
ok('a command whose engine vanished is closed by the control plane, with -1');

// 4. Everything settled: no entry is left running.
assert.deepEqual([...registry.streams.values()].filter(stream => stream.code === null), [], 'nothing is left running');
ok('no entry is left running');

for (const client of sockets) client.end();
await new Promise(resolve => streamServer.close(resolve));
server.close();
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n✅ live stream failure tests passed (${passed} checks)`);
process.exit(0);
