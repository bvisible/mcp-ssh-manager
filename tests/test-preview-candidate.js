// Exercise the preview's real SSH/SFTP fixture and child lifecycle without a GUI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { createCandidatePreview, resolveCandidateApp } from '../scripts/preview-candidate.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const beforeEnv = JSON.stringify({ ...process.env });
const preview = await createCandidatePreview(root);
const client = new ssh2.Client();
try {
  assert.ok(JSON.stringify({ ...process.env }) === beforeEnv, 'the parent environment must not be changed');
  assert.notEqual(preview.home, os.homedir());
  assert.equal(preview.env.SSH_AUTH_SOCK, undefined);
  assert.equal(preview.env.NODE_OPTIONS, undefined);
  assert.equal(preview.env.SSH_MANAGER_HOME, preview.scratch);
  assert.equal(preview.env.SSH_MANAGER_PREVIEW_HOME, preview.scratch);
  assert.equal(preview.env.SSH_MANAGER_APPROVAL_SOCKET, process.platform === 'win32'
    ? `\\\\.\\pipe\\mcp-ssh-${path.basename(preview.scratch)}` : path.join(preview.scratch, 'approval.sock'));
  const parallel = await createCandidatePreview(root);
  try {
    assert.notEqual(parallel.env.SSH_MANAGER_APPROVAL_SOCKET, preview.env.SSH_MANAGER_APPROVAL_SOCKET,
      'concurrent fixtures must never share an approval pipe (or its derived stream pipe)');
  } finally { await parallel.close(); }
  assert.ok(preview.env.SSH_MANAGER_KNOWN_HOSTS.startsWith(preview.home));
  assert.ok(!fs.readFileSync(preview.env.SSH_MANAGER_VAULT, 'utf8').includes(preview.password));
  await new Promise((resolve, reject) => {
    client.once('ready', resolve).once('error', reject);
    client.connect({ host: '127.0.0.1', port: preview.port, username: 'demo', password: preview.password });
  });
  const forbidden = path.join(preview.scratch, 'must-not-exist');
  const output = await new Promise((resolve, reject) => client.exec(`touch ${forbidden}`, (error, stream) => {
    if (error) return reject(error);
    let text = ''; stream.on('data', data => text += data); stream.on('close', () => resolve(text));
  }));
  assert.match(output, /Simulated command/);
  assert.equal(fs.existsSync(forbidden), false, 'remote commands must never execute on the host');
  const sftp = await new Promise((resolve, reject) => client.sftp((error, session) => error ? reject(error) : resolve(session)));
  const write = (file, data) => new Promise((resolve, reject) => sftp.writeFile(file, data, error => error ? reject(error) : resolve()));
  const read = file => new Promise((resolve, reject) => sftp.readFile(file, (error, data) => error ? reject(error) : resolve(data.toString())));
  await write('/srv/uploads/test.txt', 'preview transfer');
  assert.equal(await read('/srv/uploads/test.txt'), 'preview transfer');
  assert.equal(fs.readFileSync(path.join(preview.remote, 'srv/uploads/test.txt'), 'utf8'), 'preview transfer');
  await assert.rejects(read('/../../vault.key'), 'SFTP cannot reach the surrounding profile');
  if (process.platform !== 'win32') {
    fs.symlinkSync(preview.scratch, path.join(preview.remote, 'srv/escape'));
    await assert.rejects(read('/srv/escape/vault.key'), 'SFTP cannot follow a link outside its fixture');
  }
  client.end();
} finally { client.destroy(); await preview.close(); }
assert.equal(fs.existsSync(preview.scratch), false);
console.log('✓ isolated profile, encrypted fixtures, simulated exec, real SFTP and cleanup');

const old = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-old-'));
try {
  fs.mkdirSync(path.join(old, 'resources'));
  const executable = path.join(old, 'candidate'); fs.writeFileSync(executable, '');
  fs.writeFileSync(path.join(old, 'resources/app.asar'), 'old candidate');
  assert.throws(() => resolveCandidateApp(executable), /lacks isolated preview support/);
} finally { fs.rmSync(old, { recursive: true, force: true }); }
console.log('✓ older desktop artifacts are refused before any launch');

const child = spawn(process.execPath, [path.join(root, 'scripts/preview-candidate.mjs'), '--engine', root],
  { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => output += data);
child.stderr.on('data', data => output += data);
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    if (child.exitCode !== null) throw new Error(`Preview stopped unexpectedly: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Preview timed out: ${output}`);
};
const urls = () => [...output.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/g)].map(match => match[0]);
const api = (url, endpoint) => { const target = new URL(url); target.pathname = endpoint; return target; };
let profile;
try {
  await waitFor(() => urls().length > 0);
  profile = output.match(/Candidate preview profile: (.+)/)[1];
  const first = urls()[0];
  const firstList = await fetch(api(first, '/api/servers')).then(response => response.json());
  assert.equal(firstList.servers.length, 2);
  const changed = await fetch(api(first, '/api/servers'), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo_app', host: '127.0.0.1', description: 'persists across preview restart' }) });
  assert.equal(changed.status, 200);
  child.stdin.write('r\n');
  await waitFor(() => urls().length > 1);
  const second = urls().at(-1);
  assert.notEqual(first, second, 'restart must launch a fresh authenticated control plane');
  const secondList = await fetch(api(second, '/api/servers')).then(response => response.json());
  assert.equal(secondList.servers.find(server => server.name === 'demo_app').description, 'persists across preview restart');
  const local = await fetch(api(second, '/api/local/files')).then(response => response.json());
  assert.equal(local.home, path.join(profile, 'home'));
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.stdin.write('q\n');
  await exit;
  assert.equal(child.exitCode, 0, output);
  assert.equal(fs.existsSync(profile), false, 'Quit must remove only the generated profile');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exit;
  }
}
assert.ok(JSON.stringify({ ...process.env }) === beforeEnv, 'the parent environment must not be changed');
console.log('✓ real control-plane launch, same-profile restart, isolated local pane and orderly shutdown');
