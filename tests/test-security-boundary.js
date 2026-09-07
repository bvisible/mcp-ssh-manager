// Exercise the actual stdio MCP entry point against inert SSH fixtures. The
// fixture accepts exec requests but never invokes a shell or runs their text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-gate-'));
const engine = path.join(scratch, 'engine');
fs.mkdirSync(engine);
fs.cpSync(path.join(repo, 'src'), path.join(engine, 'src'), { recursive: true });
fs.copyFileSync(path.join(repo, 'package.json'), path.join(engine, 'package.json'));
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(engine, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const preload = path.join(scratch, 'isolated-home.mjs');
// Config readers that use the OS home (including older local tool settings)
// must see the fixture, not the developer's real files. No HOME env mutation.
fs.writeFileSync(preload, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.homedir=()=>${JSON.stringify(scratch)}; syncBuiltinESMExports();`);
const envFile = path.join(scratch, 'servers.env');
const vaultFile = path.join(scratch, 'vault.json');
const brokerPath = process.platform === 'win32' ? `\\\\.\\pipe\\ssh-gate-${crypto.randomUUID()}` : path.join(scratch, 'gate.sock');
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const resources = [];
const connections = new Set();
const requests = [];
let handler = request => ({ id: request.id, decision: 'allow' });
let passed = 0;
const ok = label => { passed++; console.log(`✓ ${label}`); };
let client;
let broker;

async function fakeServer(label) {
  const seen = [];
  const server = new ssh2.Server({ hostKeys: [privateKey] }, connection => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.on('error', () => {});
    connection.on('authentication', ctx => ctx.accept());
    connection.on('ready', () => connection.on('session', accept => {
      accept().on('exec', (acceptExec, reject, info) => {
        const stream = acceptExec();
        seen.push(info.command);
        stream.write(info.command.includes('ping') ? 'ping\n' : `${label}\n`);
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  resources.push(server);
  return { port: server.address().port, seen };
}
const text = result => result.content.map(item => item.text || '').join('\n');
const call = (name, args) => client.callTool({ name, arguments: args });
const setVault = config => fs.writeFileSync(vaultFile, JSON.stringify({ version: 1, servers: { production: config } }));

try {
  const first = await fakeServer('fixture-one');
  const second = await fakeServer('fixture-two');
  fs.writeFileSync(envFile, `SSH_SERVER_PRODUCTION_HOST=127.0.0.1\nSSH_SERVER_PRODUCTION_PORT=${first.port}\nSSH_SERVER_PRODUCTION_USER=fixture\nSSH_SERVER_PRODUCTION_PASSWORD=fixture\n`);
  fs.writeFileSync(path.join(engine, '.server-aliases.json'), JSON.stringify({ prod: 'production' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
  Object.assign(env, { SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
    SSH_MANAGER_HOME: scratch, SSH_MANAGER_VAULT: vaultFile, SSH_MANAGER_KEY_SOURCE: 'file',
    SSH_MANAGER_APPROVAL_SOCKET: brokerPath, SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
    SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'),
    SSH_LOG_LEVEL: 'ERROR' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', preload, path.join(engine, 'src/index.js')], cwd: engine, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'security-regression', version: '1.0' });
  await client.connect(transport);
  const command = 'printf fixture';
  let result = await call('ssh_execute', { server: 'production', command });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /fixture-one/);
  ok('legacy .env without vault or control plane still executes through stdio MCP');

  const config = { host: '127.0.0.1', port: first.port, user: 'fixture', approval: 'always' };
  setVault(config);
  for (const server of ['production', 'prod', 'duction', '127.0.0.1']) {
    result = await call('ssh_execute', { server, command });
    assert.equal(result.isError, true);
    assert.match(text(result), /Approval denied/);
  }
  assert.equal(first.seen.length, 1);
  ok('enabled approval refuses without a UI for canonical, alias, partial and host names');

  const uncovered = [
    ['ssh_download', { remotePath: '/fixture', localPath: path.join(scratch, 'download') }],
    ['ssh_session_start', {}], ['ssh_health_check', {}], ['ssh_backup_list', {}],
    ['ssh_db_query', { type: 'mysql', database: 'fixture', query: 'SELECT 1' }],
    ['ssh_process_manager', { action: 'list' }], ['ssh_alert_setup', { action: 'get' }],
    ['ssh_key_manage', { action: 'check' }],
    ['ssh_tunnel_create', { type: 'local', localPort: 0, remoteHost: '127.0.0.1', remotePort: 80 }],
  ];
  for (const [name, args] of uncovered) {
    result = await call(name, { server: 'production', ...args });
    assert.match(text(result), /Approval denied/, name);
  }
  assert.equal(first.seen.length, 1);
  assert.equal(fs.existsSync(path.join(scratch, 'download')), false);
  assert.equal((await call('ssh_list_servers', {})).isError, undefined);
  assert.equal((await call('ssh_history', {})).isError, undefined);
  assert.equal((await call('ssh_connection_status', { action: 'disconnect', server: 'production' })).isError, undefined);
  ok('remote tools share the approval gate; local inspection and disconnect remain available');

  broker = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]);
      requests.push(request);
      Promise.resolve(handler(request)).then(reply => socket.end(`${JSON.stringify(reply)}\n`));
    });
  });
  await new Promise(resolve => broker.listen(brokerPath, resolve));
  result = await call('ssh_execute', { server: 'prod', command });
  assert.match(text(result), /fixture-one/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].server, 'production');
  ok('an approved alias asks once and executes on the canonical server');

  setVault({ ...config, mode: 'restricted', allowPatterns: ['^printf allowed$'] });
  result = await call('ssh_execute', { server: 'duction', command });
  assert.equal(result.isError, true);
  assert.match(text(result), /Policy denied/);
  assert.equal(requests.length, 1);
  ok('policy checks also resolve aliases and partial names before applying restrictions');

  setVault(config);
  let release;
  let announced;
  const pending = new Promise(resolve => { announced = resolve; });
  handler = request => { announced(); return new Promise(resolve => { release = () => resolve({ id: request.id, decision: 'allow' }); }); };
  const inflight = call('ssh_execute', { server: 'production', command });
  await pending;
  setVault({ ...config, port: second.port });
  release();
  assert.match(text(await inflight), /fixture-one/);
  handler = request => ({ id: request.id, decision: 'allow' });
  result = await call('ssh_execute', { server: 'production', command });
  assert.match(text(result), /fixture-two/);
  assert.equal(second.seen.length, 1);
  ok('an in-flight approval retains its host; the next invocation reloads config and replaces the pooled connection');
  console.log(`\nSecurity boundary: ${passed} checks passed`);
} finally {
  if (client) await client.close();
  for (const connection of connections) { connection.end(); connection.destroy?.(); }
  if (broker) await new Promise(resolve => broker.close(resolve));
  for (const server of resources) await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
