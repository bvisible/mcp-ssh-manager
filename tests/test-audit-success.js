// Regression test: the audit log recorded the outcome of ssh_execute and
// ssh_upload only. ssh_execute_sudo, ssh_download, ssh_session_send and
// ssh_execute_group passed the policy check and ran, then wrote nothing, so the
// most sensitive commands were missing from the audit trail.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-audit-'));
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
const auditFile = path.join(scratch, 'audit.jsonl');
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const connections = new Set();

// Accepts exec and shell requests and runs nothing. Commands containing
// "fail-me" exit 3; SFTP is refused, so a download fails on the client side.
const server = new ssh2.Server({ hostKeys: [privateKey] }, connection => {
  connections.add(connection);
  connection.on('close', () => connections.delete(connection));
  connection.on('error', () => {});
  connection.on('authentication', ctx => ctx.accept());
  connection.on('ready', () => connection.on('session', accept => {
    const session = accept();
    session.on('pty', acceptPty => acceptPty());
    session.on('sftp', (_accept, reject) => reject());
    session.on('shell', acceptShell => {
      const stream = acceptShell();
      stream.on('data', data => {
        const input = data.toString();
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
      // Drain stdin (the sudo password) so the channel can close.
      stream.on('data', () => {});
      stream.write('0\n');
      stream.exit(info.command.includes('fail-me') ? 3 : 0);
      stream.end();
    });
  }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

fs.writeFileSync(envFile, [
  'SSH_SERVER_PROD_HOST=127.0.0.1', `SSH_SERVER_PROD_PORT=${port}`,
  'SSH_SERVER_PROD_USER=fixture', 'SSH_SERVER_PROD_PASSWORD=fixture',
  'SSH_SERVER_PROD_GROUP=web', `SSH_SERVER_PROD_AUDIT_LOG=${auditFile}`, '',
].join('\n'));

const text = result => result.content.map(item => item.text || '').join('\n');
const readAudit = () => fs.existsSync(auditFile)
  ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [];
/** The audit lines a call appended. */
async function appended(fn) {
  const before = readAudit().length;
  const result = await fn();
  return { result, lines: readAudit().slice(before) };
}

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
const client = new Client({ name: 'audit-success-regression', version: '1.0' });
const call = (name, args) => client.callTool({ name, arguments: args });

try {
  await client.connect(transport);

  let { result, lines } = await appended(() => call('ssh_execute', { server: 'prod', command: 'hostname' }));
  assert.equal(lines.length, 1, text(result));
  assert.equal(lines[0].tool, 'ssh_execute');
  ok('ssh_execute appends one line (baseline)');

  ({ result, lines } = await appended(() => call('ssh_execute_sudo', { server: 'prod', command: 'id -u', password: 'hunter2' })));
  assert.match(text(result), /Exit code: 0/, text(result));
  assert.equal(lines.length, 1, 'a successful ssh_execute_sudo must append an audit line');
  assert.deepEqual(
    { tool: lines[0].tool, server: lines[0].server, allowed: lines[0].allowed, exitCode: lines[0].exitCode, success: lines[0].success },
    { tool: 'ssh_execute_sudo', server: 'prod', allowed: true, exitCode: 0, success: true });
  assert.equal(lines[0].args.command, 'id -u');
  assert.ok(!JSON.stringify(lines[0]).includes('hunter2'), 'the sudo password must not reach the audit log');
  ok('a successful ssh_execute_sudo records exitCode 0 and success, without the password');

  ({ result, lines } = await appended(() => call('ssh_execute_sudo', { server: 'prod', command: 'fail-me' })));
  assert.equal(lines.length, 1, text(result));
  assert.equal(lines[0].exitCode, 3);
  assert.equal(lines[0].success, false);
  ok('a failing ssh_execute_sudo records its exit code');

  ({ result, lines } = await appended(() => call('ssh_download', { server: 'prod', remotePath: '/etc/hostname', localPath: path.join(scratch, 'out') })));
  assert.equal(lines.length, 1, text(result));
  assert.equal(lines[0].tool, 'ssh_download');
  assert.equal(lines[0].success, false);
  ok('ssh_download records its outcome');

  ({ result, lines } = await appended(() => call('ssh_execute_group', { group: 'web', command: 'uptime' })));
  assert.equal(lines.length, 1, text(result));
  assert.equal(lines[0].tool, 'ssh_execute_group');
  assert.equal(lines[0].exitCode, 0);
  assert.equal(lines[0].success, true);
  ok('ssh_execute_group records each server\'s outcome');

  result = await call('ssh_session_start', { server: 'prod' });
  const sessionId = /"?(?:session_id|sessionId|id)"?\s*[:=]\s*"?([\w-]+)/i.exec(text(result))?.[1]
    ?? /([a-f0-9-]{8,})/i.exec(text(result))?.[1];
  assert.ok(sessionId, `no session id in ${text(result)}`);
  ({ result, lines } = await appended(() => call('ssh_session_send', { session: sessionId, command: 'whoami' })));
  const sent = lines.filter(line => line.tool === 'ssh_session_send');
  assert.equal(sent.length, 1, text(result));
  assert.equal(sent[0].success, true);
  assert.equal(sent[0].args.command, 'whoami');
  await call('ssh_session_close', { session: sessionId });
  ok('ssh_session_send records its outcome');

  console.log(`\n✅ audit success-path tests passed (${passed} checks)`);
} finally {
  await client.close().catch(() => {});
  for (const connection of connections) connection.end();
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
