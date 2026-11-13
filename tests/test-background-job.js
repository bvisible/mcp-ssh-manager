// ssh_execute with background: true starts the command detached and returns its
// pid and a log file at once (idea from SEU-zhc's fork).
//
// Three properties are asserted, the last two the reason it is built as it is:
//  - the launcher survives every login shell, csh and tcsh included (the SSH
//    server hands a command to the account's login shell), and the job keeps
//    running after the launcher returned;
//  - the log file is private and chosen by the engine, never by the caller: a
//    free path would let a command that passes the readonly policy overwrite any
//    file the SSH user can write;
//  - the policy still sees the command: readonly refuses a destructive one.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildBackgroundCommand, parseBackgroundStart } from '../src/background-job.js';

if (process.platform === 'win32') {
  console.log('Skipped: the launcher runs under POSIX shells.');
  process.exit(0);
}

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-background-'));
const jobTmp = path.join(scratch, 'tmp');
fs.mkdirSync(jobTmp);
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(predicate, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

// ── the launcher is one simple command of single-quoted words ───────────────
{
  const wrapped = buildBackgroundCommand("echo 'it''s'; rm -rf \"$HOME\" `reboot` $(reboot)");
  assert.match(wrapped, /^sh -c '(?:[^']|'\\'')*' sh '(?:[^']|'\\'')*'$/);
  assert.equal(parseBackgroundStart('4242 /tmp/ssh-manager-bg-AbC123\n')?.pid, 4242);
  assert.equal(parseBackgroundStart('noise\n77 /var/tmp/x y\n')?.logFile, '/var/tmp/x y');
  assert.equal(parseBackgroundStart('mktemp: failed\n'), null);
  assert.equal(parseBackgroundStart(''), null);
  ok('the launcher is a simple command of single-quoted words, and its answer is parsed strictly');
}

// ── under every login shell this machine has ────────────────────────────────
const shells = ['sh', 'bash', 'dash', 'zsh', 'ksh', 'tcsh', 'csh'].filter(name => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0);
for (const shell of shells) {
  const job = `echo "out: it's $((1 + 1))"; sleep 2; echo finished`;
  const launched = spawnSync(shell, ['-c', buildBackgroundCommand(job)], { encoding: 'utf8', env: { ...process.env, TMPDIR: jobTmp } });
  assert.equal(launched.status, 0, `${shell}: ${launched.stderr}`);
  const started = parseBackgroundStart(launched.stdout);
  assert.ok(started, `${shell}: no pid in ${JSON.stringify(launched.stdout)}`);
  assert.ok(alive(started.pid), `${shell}: the job must still be running when the launcher returns`);
  // One descriptor for the check and the reads: the file is looked at, not looked up twice.
  const log = fs.openSync(started.logFile, 'r');
  try {
    assert.equal(fs.fstatSync(log).mode & 0o777, 0o600, `${shell}: the log file is private`);
    let output = '';
    assert.ok(await waitFor(() => { output += fs.readFileSync(log, 'utf8'); return output.includes('finished'); }), `${shell}: the job finishes`);
    assert.equal(output, "out: it's 2\nfinished\n");
  } finally {
    fs.closeSync(log);
  }
}
ok(`the job starts detached, keeps running and logs privately under ${shells.join(', ')}`);

// ── through the engine, against a local ssh2 server that really runs commands ─
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const sockets = new Set();
const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => {});
  client.on('authentication', context => context.accept());
  client.on('ready', () => client.on('session', open => open().on('exec', (start, _reject, info) => {
    const stream = start();
    const child = spawn('/bin/sh', ['-c', info.command], { env: { ...process.env, TMPDIR: jobTmp }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => stream.write(chunk));
    child.stderr.on('data', chunk => stream.stderr.write(chunk));
    child.on('close', code => { stream.exit(code ?? 1); stream.end(); });
  })));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const auditFile = path.join(scratch, 'audit.jsonl');
const envFile = path.join(scratch, 'servers.env');
const entry = (name, extra = []) => [`SSH_SERVER_${name}_HOST=127.0.0.1`, `SSH_SERVER_${name}_PORT=${server.address().port}`,
  `SSH_SERVER_${name}_USER=fixture`, `SSH_SERVER_${name}_PASSWORD=fixture`, ...extra];
fs.writeFileSync(envFile, [
  ...entry('PROD', [`SSH_SERVER_PROD_AUDIT_LOG=${auditFile}`]),
  ...entry('RO', ['SSH_SERVER_RO_MODE=readonly']),
  ...entry('WIN', ['SSH_SERVER_WIN_PLATFORM=windows']),
  '',
].join('\n'));
const preload = path.join(scratch, 'isolated-home.mjs');
fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const home = process.env.SSH_TEST_HOME; if (!home) throw new Error('SSH_TEST_HOME is not set'); os.homedir = () => home; syncBuiltinESMExports();");
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
const client = new Client({ name: 'background-job', version: '1.0' });
const call = (name, args) => client.callTool({ name, arguments: args });
const json = result => JSON.parse(result.content.map(item => item.text || '').join(''));

try {
  await client.connect(transport);

  const evil = path.join(scratch, 'authorized_keys');
  const started = await call('ssh_execute', { server: 'prod', command: 'echo begin; sleep 2; echo end', background: true, logFile: evil });
  const answer = json(started);
  assert.equal(started.isError, undefined, JSON.stringify(answer));
  assert.equal(answer.success, true);
  assert.equal(answer.background, true);
  assert.ok(Number.isInteger(answer.pid) && alive(answer.pid), 'the job is running when the call returns');
  assert.ok(answer.logFile.startsWith(jobTmp + path.sep), `the log is the engine's own file, not ${answer.logFile}`);
  assert.ok(!fs.existsSync(evil), 'a log path chosen by the caller is ignored');
  ok('ssh_execute with background returns the pid at once, and the caller cannot choose the log file');

  assert.ok(await waitFor(() => fs.readFileSync(answer.logFile, 'utf8').includes('end')));
  assert.equal(fs.readFileSync(answer.logFile, 'utf8'), 'begin\nend\n');
  const line = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text)).find(entry => entry.args?.background);
  assert.equal(line.tool, 'ssh_execute');
  assert.equal(line.success, true);
  ok('the job output reaches its log and the start is audited with background: true');

  const denied = await call('ssh_execute', { server: 'ro', command: 'rm -rf /tmp/does-not-exist', background: true });
  assert.equal(denied.isError, true);
  assert.match(json(denied).error, /Policy denied/);
  ok('a destructive command is still refused on a readonly server, in the background too');

  const windows = await call('ssh_execute', { server: 'win', command: 'Get-Date', background: true });
  assert.match(json(windows).error, /not supported on Windows/);
  ok('a Windows target gets a clear refusal');

  const plain = json(await call('ssh_execute', { server: 'prod', command: 'echo plain' }));
  assert.equal(plain.stdout.trim(), 'plain');
  assert.equal(plain.background, undefined);
  ok('without background, ssh_execute answers exactly as before');

  console.log(`\n✅ background job tests passed (${passed} checks)`);
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) { socket.end(); socket.destroy?.(); }
  await new Promise(resolve => server.close(resolve));
  await sleep(2200); // let a job still sleeping finish before its folder goes
  fs.rmSync(scratch, { recursive: true, force: true });
}
