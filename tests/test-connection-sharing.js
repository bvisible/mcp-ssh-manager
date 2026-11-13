// Regression test: simultaneous calls on a cold engine must share the one SSH
// connection being established, not open one each. Six parallel ssh_execute
// calls used to open six connections, all kept open and five of them
// unreachable once the last was stored: a burst of logins that a server's
// MaxStartups or fail2ban refuses.
//
// Drives the real stdio entry point against local ssh2 servers that count the
// connections they receive.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-sharing-'));
// Readers that use the OS home must see the scratch folder, not the developer's tool settings.
const preload = path.join(scratch, 'isolated-home.mjs');
fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const home = process.env.SSH_TEST_HOME; if (!home) throw new Error('SSH_TEST_HOME is not set'); os.homedir = () => home; syncBuiltinESMExports();");
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const sockets = new Set();

/** A server that counts connections; `accept` false refuses every login. */
async function host({ accept }) {
  const seen = { connections: 0 };
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    seen.connections++;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    client.on('authentication', context => (accept ? context.accept() : context.reject()));
    client.on('ready', () => client.on('session', open => open().on('exec', (start, _reject, info) => {
      // Slow enough that every caller is waiting before the first answer. The
      // engine checks a pooled connection with `echo ping`: answer it like a shell.
      const stream = start();
      const answer = /echo ping/.test(info.command) ? 'ping\n' : 'shared\n';
      setTimeout(() => { stream.write(answer); stream.exit(0); stream.end(); }, 150);
    })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, port: server.address().port };
}

const good = await host({ accept: true });
const bad = await host({ accept: false });
const envFile = path.join(scratch, 'servers.env');
fs.writeFileSync(envFile, [
  'SSH_SERVER_GOOD_HOST=127.0.0.1', `SSH_SERVER_GOOD_PORT=${good.port}`, 'SSH_SERVER_GOOD_USER=fixture', 'SSH_SERVER_GOOD_PASSWORD=fixture',
  'SSH_SERVER_BAD_HOST=127.0.0.1', `SSH_SERVER_BAD_PORT=${bad.port}`, 'SSH_SERVER_BAD_USER=fixture', 'SSH_SERVER_BAD_PASSWORD=wrong',
  '',
].join('\n'));

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
Object.assign(env, {
  SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
  SSH_MANAGER_HOME: path.join(scratch, 'state'), SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
  SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'),
  SSH_LOG_LEVEL: 'ERROR', SSH_TEST_HOME: scratch,
});
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['--import', preload, path.join(repo, 'src/index.js')], cwd: repo, env, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'connection-sharing', version: '1.0' });
const run = (server, command = 'echo shared') => client.callTool({ name: 'ssh_execute', arguments: { server, command } });
const text = result => result.content.map(item => item.text || '').join('\n');

try {
  await client.connect(transport);

  const results = await Promise.all(Array.from({ length: 6 }, () => run('good')));
  assert.equal(results.filter(result => !result.isError && /shared/.test(text(result))).length, 6, results.map(text).join('\n'));
  assert.equal(good.seen.connections, 1, `six simultaneous calls opened ${good.seen.connections} connections`);
  ok('six simultaneous calls on a cold engine share one SSH connection');

  await run('good');
  assert.equal(good.seen.connections, 1);
  ok('a later call keeps reusing it');

  const refused = await Promise.all(Array.from({ length: 6 }, () => run('bad')));
  assert.equal(refused.filter(result => /Failed to connect to bad/.test(text(result))).length, 6, refused.map(text).join('\n'));
  assert.equal(bad.seen.connections, 1, `six calls on a refused login made ${bad.seen.connections} attempts`);
  ok('six simultaneous calls on a server that refuses the login make one attempt and all see the error');

  await run('bad');
  assert.equal(bad.seen.connections, 2);
  ok('a failed attempt is not remembered: the next call tries again');

  console.log(`\n✅ connection sharing tests passed (${passed} checks)`);
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) { socket.end(); socket.destroy?.(); }
  await new Promise(resolve => good.server.close(resolve));
  await new Promise(resolve => bad.server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
