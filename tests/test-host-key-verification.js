// Handshake verification and OpenSSH trust-store regressions. Every key and
// server here is a local fixture; no developer known_hosts or SSH agent is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-trust-'));
process.env.SSH_MANAGER_KNOWN_HOSTS = path.join(scratch, 'known_hosts');
process.env.SSH_LOG_FILE = path.join(scratch, 'log');
process.env.SSH_HISTORY_FILE = path.join(scratch, 'history');
delete process.env.SSH_AUTH_SOCK;
const { verifyHostKey, isHostKnown, getCurrentHostKey, trustedHostKeyAlgorithms } = await import('../src/ssh-key-manager.js');
const { default: SSHManager } = await import('../src/ssh-manager.js');
const file = process.env.SSH_MANAGER_KNOWN_HOSTS;
const keyPair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const keyA = keyPair();
const keyB = keyPair();
const publicA = ssh2.utils.parseKey(keyA).getPublicSSH();
const publicB = ssh2.utils.parseKey(keyB).getPublicSSH();
const entry = (host, key = publicA) => `${host} ssh-rsa ${key.toString('base64')}`;
let passed = 0;
const ok = label => { passed++; console.log(`✓ ${label}`); };
const sockets = new Set();
let server;

try {
  assert.equal(verifyHostKey('first.test', 22, publicA), true);
  assert.match(fs.readFileSync(file, 'utf8'), /first\.test ssh-rsa/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(verifyHostKey('first.test', 22, publicA), true);
  const pinned = fs.readFileSync(file, 'utf8');
  assert.throws(() => verifyHostKey('first.test', 22, publicB), /changed or is not trusted/);
  assert.equal(fs.readFileSync(file, 'utf8'), pinned);
  ok('first contact pins the handshake key; repeat succeeds; changed key cannot replace it');

  fs.writeFileSync(file, `${entry('other.test,shared.test')}\n${entry('!excluded.test,*.example.test')}\n`);
  assert.equal(isHostKnown('shared.test'), true);
  assert.equal(isHostKnown('other'), false);
  assert.equal(isHostKnown('www.example.test'), true);
  assert.equal(isHostKnown('excluded.test'), false);
  assert.equal(verifyHostKey('shared.test', 22, publicA), true);
  ok('aliases, patterns and exact hostname matching follow OpenSSH field boundaries');

  const salt = crypto.randomBytes(20);
  const hash = crypto.createHmac('sha1', salt).update('[hashed.test]:2222').digest('base64');
  fs.writeFileSync(file, `${entry(`|1|${salt.toString('base64')}|${hash}`)}\n`);
  assert.equal(isHostKnown('hashed.test', 2222), true);
  assert.equal(isHostKnown('hashed.test', 22), false);
  assert.equal(getCurrentHostKey('hashed.test', 2222).length, 1);
  assert.equal(verifyHostKey('hashed.test', 2222, publicA), true);
  assert.throws(() => verifyHostKey('hashed.test', 2222, publicB), /not trusted/);
  assert.deepEqual(trustedHostKeyAlgorithms('hashed.test', 2222), ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
  ok('hashed hostnames and nonstandard ports verify the stored key and prefer its algorithms');

  fs.writeFileSync(file, `${entry('revoked.test')}\n@revoked ${entry('revoked.test')}\n`);
  assert.throws(() => verifyHostKey('revoked.test', 22, publicA), /revoked/);
  assert.throws(() => verifyHostKey('bad.test', 22, Buffer.alloc(1)), /Invalid SSH host key/);
  fs.writeFileSync(file, entry('unrelated.test'));
  verifyHostKey('new.test', 22, publicA);
  assert.equal(getCurrentHostKey('unrelated.test').length, 1);
  assert.equal(getCurrentHostKey('new.test').length, 1);
  ok('revocations and malformed keys fail closed; appending preserves a file without a trailing newline');

  let authentications = 0;
  server = new ssh2.Server({ hostKeys: [keyA] }, client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    client.on('authentication', ctx => { authentications++; ctx.accept(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(file, `${entry(`[127.0.0.1]:${port}`, publicB)}\n`);
  const rejected = new SSHManager({ host: '127.0.0.1', port, user: 'fixture', password: 'fixture' });
  await assert.rejects(rejected.connect(), /changed or is not trusted/);
  rejected.dispose();
  assert.equal(authentications, 0);
  fs.writeFileSync(file, `${entry(`[127.0.0.1]:${port}`)}\n`);
  const accepted = new SSHManager({ host: '127.0.0.1', port, user: 'fixture', password: 'fixture' });
  await accepted.connect();
  assert.ok(authentications > 0);
  accepted.dispose();
  ok('a real local ssh2 handshake refuses a changed key before authentication and accepts the pinned key');
  console.log(`\nHost key verification: ${passed} checks passed`);
} finally {
  for (const socket of sockets) socket.end();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
