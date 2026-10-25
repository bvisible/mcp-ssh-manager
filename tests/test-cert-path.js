// Behavioural test for per-server OpenSSH user certificates (CERTPATH / cert_path).
// SSHManager.connect() must pass the certificate file to ssh2 as `publicKey`
// (identity sent to the server) while `privateKey` keeps signing, re-read it on
// every connect (short-lived certificates get renewed on disk), fail closed when
// the configured file is missing, and change nothing when certPath is unset.
// We drive connect() with a stubbed ssh2 client that captures the connConfig.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import SSHManager from '../src/ssh-manager.js';
import { ConfigLoader } from '../src/config-loader.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-certpath-'));
const keyFile = path.join(dir, 'id_test');
const certFile = path.join(dir, 'id_test-cert.pub');
// Contents are opaque to SSHManager: it reads and forwards bytes, ssh2 parses them.
fs.writeFileSync(keyFile, 'PRIVATE-KEY-PLACEHOLDER\n');
fs.writeFileSync(certFile, 'ssh-ed25519-cert-v01@openssh.com AAAACERTONE test\n');

// Returns { cfg, error } for one connect() call with a fake ssh2 client.
async function capture(config) {
  const hadSock = Object.prototype.hasOwnProperty.call(process.env, 'SSH_AUTH_SOCK');
  const prevSock = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  try {
    const mgr = new SSHManager({ hostKeyVerification: false, ...config });
    let cfg = null;
    mgr.client = { on: () => {}, once: () => {}, connect: (c) => { cfg = c; } };
    let error = null;
    const pending = mgr.connect().catch((e) => { error = e; });
    // connect() builds connConfig synchronously; a read error rejects at once.
    await Promise.race([pending, new Promise((r) => setTimeout(r, 50))]);
    return { cfg, error };
  } finally {
    if (hadSock) process.env.SSH_AUTH_SOCK = prevSock;
    else delete process.env.SSH_AUTH_SOCK;
  }
}

const base = { host: 'example.com', user: 'demo', keyPath: keyFile };

async function testCertPassedAsPublicKey() {
  const { cfg, error } = await capture({ ...base, certPath: certFile });
  assert.strictEqual(error, null, `connect must not fail: ${error}`);
  assert.ok(Buffer.isBuffer(cfg.privateKey), 'privateKey still read from keyPath');
  assert.ok(Buffer.isBuffer(cfg.publicKey), 'publicKey set from certPath');
  assert.strictEqual(cfg.publicKey.toString(), fs.readFileSync(certFile, 'utf8'), 'publicKey is the certificate file content');
  ok('certPath is passed to ssh2 as publicKey alongside privateKey');
}

async function testNoCertPathUnchanged() {
  const { cfg, error } = await capture({ ...base });
  assert.strictEqual(error, null);
  assert.ok(Buffer.isBuffer(cfg.privateKey), 'privateKey read');
  assert.strictEqual(cfg.publicKey, undefined, 'publicKey must stay unset without certPath');
  ok('no certPath → connConfig unchanged (no publicKey)');
}

async function testCertWithoutKeyIgnored() {
  const { cfg, error } = await capture({ host: 'example.com', user: 'demo', certPath: certFile, password: 'pw' });
  assert.strictEqual(error, null);
  assert.strictEqual(cfg.publicKey, undefined, 'a certificate without its private key is never sent');
  ok('certPath without keyPath is ignored (certificate needs its private key)');
}

async function testRenewalPickedUpOnNextConnect() {
  const first = await capture({ ...base, certPath: certFile });
  fs.writeFileSync(certFile, 'ssh-ed25519-cert-v01@openssh.com AAAACERTTWO test\n');
  const second = await capture({ ...base, certPath: certFile });
  assert.ok(first.cfg.publicKey.toString().includes('CERTONE'), 'first connect used the original certificate');
  assert.ok(second.cfg.publicKey.toString().includes('CERTTWO'), 'second connect read the renewed certificate');
  ok('a certificate renewed on disk is used on the next connect (no restart)');
}

async function testMissingCertFailsClosed() {
  const { cfg, error } = await capture({ ...base, certPath: path.join(dir, 'missing-cert.pub') });
  assert.ok(error, 'connect must reject when the configured certificate is missing');
  assert.strictEqual(error.code, 'ENOENT', `expected ENOENT, got ${error && error.code}`);
  assert.strictEqual(cfg, null, 'ssh2 connect must not be called without the certificate');
  ok('missing certificate file fails closed (ENOENT) instead of silently using the bare key');
}

async function testTildeExpansion() {
  const homeCert = path.join(os.homedir(), `.ssh-mgr-certpath-test-${process.pid}.pub`);
  fs.writeFileSync(homeCert, 'ssh-ed25519-cert-v01@openssh.com AAAACERTHOME test\n');
  try {
    const { cfg, error } = await capture({ ...base, certPath: `~/${path.basename(homeCert)}` });
    assert.strictEqual(error, null);
    assert.ok(cfg.publicKey.toString().includes('CERTHOME'), '~ expands to the home directory');
    ok('certPath supports a leading ~ like keyPath');
  } finally {
    fs.rmSync(homeCert, { force: true });
  }
}

async function testExportRoundTrip() {
  const envPath = path.join(dir, 'in.env');
  fs.writeFileSync(envPath, [
    'SSH_SERVER_CERT_RT_HOST=h', 'SSH_SERVER_CERT_RT_USER=u',
    'SSH_SERVER_CERT_RT_KEYPATH=~/.ssh/id_rt', 'SSH_SERVER_CERT_RT_CERTPATH=~/.ssh/id_rt-cert.pub',
    'SSH_SERVER_CERT_NONE_HOST=h', 'SSH_SERVER_CERT_NONE_USER=u',
    ''
  ].join('\n'));
  try {
    const loader = new ConfigLoader();
    const servers = await loader.load({ envPath, tomlPath: path.join(dir, 'absent.toml') });
    assert.strictEqual(servers.get('cert_rt').certPath, '~/.ssh/id_rt-cert.pub');
    assert.strictEqual(servers.get('cert_none').certPath, undefined);
    const toml = loader.exportToToml();
    const env = loader.exportToEnv();
    assert.ok(toml.includes('cert_path = "~/.ssh/id_rt-cert.pub"'), 'exportToToml emits cert_path');
    assert.ok(env.includes('SSH_SERVER_CERT_RT_CERTPATH=~/.ssh/id_rt-cert.pub'), 'exportToEnv emits CERTPATH');
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SSH_SERVER_CERT_')) delete process.env[key];
    }
    const tomlPath = path.join(dir, 'roundtrip.toml');
    fs.writeFileSync(tomlPath, toml);
    const reloaded = await new ConfigLoader().load({ envPath: path.join(dir, 'absent.env'), tomlPath });
    assert.strictEqual(reloaded.get('cert_rt').certPath, '~/.ssh/id_rt-cert.pub', 'TOML round-trip keeps certPath');
    assert.strictEqual(reloaded.get('cert_none').certPath, undefined, 'server without certificate stays without');
    ok('certPath survives .env → TOML export → reload; unset stays unset');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SSH_SERVER_CERT_')) delete process.env[key];
    }
  }
}

async function main() {
  try {
    await testCertPassedAsPublicKey();
    await testNoCertPathUnchanged();
    await testCertWithoutKeyIgnored();
    await testRenewalPickedUpOnNextConnect();
    await testMissingCertFailsClosed();
    await testTildeExpansion();
    await testExportRoundTrip();
    console.log(`\n✅ certificate path tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
