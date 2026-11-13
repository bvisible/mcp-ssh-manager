// Regression test: with AUDIT_LOG set, every tool that passes the policy gate
// leaves an outcome line, not only the few that wrote one themselves.
//
// Before, a denial or an approval decision was recorded for every tool but the
// outcome only for ssh_execute and ssh_upload (and, since 4.1.0, sudo, download,
// group and session commands): ssh_tail, ssh_sync, ssh_db_import,
// ssh_backup_restore, ssh_process_manager and most of the others ran and left
// nothing. The shared guard now writes the line for a tool that did not, and
// never a second one for a tool that did.
//
// Drives the real stdio entry point against a local ssh2 server.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-audit-coverage-'));
const preload = path.join(scratch, 'isolated-home.mjs');
fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const home = process.env.SSH_TEST_HOME; if (!home) throw new Error('SSH_TEST_HOME is not set'); os.homedir = () => home; syncBuiltinESMExports();");
const auditFile = path.join(scratch, 'audit.jsonl');
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const sockets = new Set();

const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => {});
  client.on('authentication', context => context.accept());
  client.on('ready', () => client.on('session', open => open().on('exec', (start, _reject, info) => {
    const stream = start();
    stream.write(/echo ping/.test(info.command) ? 'ping\n' : 'line one\n');
    stream.exit(0);
    stream.end();
  })));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

// A port that is already taken, so a tunnel on it fails.
const blocker = net.createServer();
await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
const takenPort = blocker.address().port;

const envFile = path.join(scratch, 'servers.env');
fs.writeFileSync(envFile, ['SSH_SERVER_PROD_HOST=127.0.0.1', `SSH_SERVER_PROD_PORT=${server.address().port}`,
  'SSH_SERVER_PROD_USER=fixture', 'SSH_SERVER_PROD_PASSWORD=fixture', `SSH_SERVER_PROD_AUDIT_LOG=${auditFile}`, ''].join('\n'));
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
const client = new Client({ name: 'audit-coverage', version: '1.0' });
const call = (name, args) => client.callTool({ name, arguments: args });
const readAudit = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
/** The audit lines one call appended. */
async function appended(fn) {
  const before = readAudit().length;
  const result = await fn();
  return { result, lines: readAudit().slice(before) };
}

try {
  await client.connect(transport);

  let { lines } = await appended(() => call('ssh_tail', { server: 'prod', file: '/var/log/app.log', lines: 5, follow: false }));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.deepEqual({ tool: lines[0].tool, allowed: lines[0].allowed, success: lines[0].success }, { tool: 'ssh_tail', allowed: true, success: true });
  ok('a tool that wrote nothing before (ssh_tail) now records its outcome');

  let outcome = await appended(() => call('ssh_tunnel_create', { server: 'prod', type: 'local', localPort: takenPort, remoteHost: '127.0.0.1', remotePort: 1 }));
  assert.equal(outcome.result.isError, true, 'a failed tunnel is flagged isError');
  assert.equal(outcome.lines.length, 1, JSON.stringify(outcome.lines));
  assert.equal(outcome.lines[0].tool, 'ssh_tunnel_create');
  assert.equal(outcome.lines[0].success, false);
  assert.match(outcome.lines[0].error, /Tunnel creation failed/);
  ok('a tool that fails is recorded as a failure, with its error');

  ({ lines } = await appended(() => call('ssh_execute', { server: 'prod', command: 'echo hi' })));
  assert.equal(lines.length, 1, 'a tool that audits itself is not audited twice');
  assert.equal(lines[0].exitCode, 0);
  ok('a tool that records its own exit code still writes exactly one line');

  ({ lines } = await appended(() => call('ssh_db_list', { server: 'prod', type: 'mysql', dbUser: 'app', dbPassword: 'db-secret-4' })));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].tool, 'ssh_db_list');
  assert.ok(!JSON.stringify(lines).includes('db-secret-4'), 'the database password is not in the line');
  ok('the line for a database tool never carries the password');

  ({ lines } = await appended(() => call('ssh_list_servers', {})));
  assert.equal(lines.length, 0);
  ({ lines } = await appended(() => call('ssh_tunnel_list', {})));
  assert.equal(lines.length, 0);
  ok('tools that only read local state still leave no line');

  console.log(`\n✅ audit coverage tests passed (${passed} checks)`);
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) { socket.end(); socket.destroy?.(); }
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => blocker.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
