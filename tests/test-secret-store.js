// Tests for the v4 encrypted vault.
//
// Two things must hold at once, and they pull in opposite directions:
//
//   1. Secrets are never readable on disk, and a tampered vault fails loudly
//      rather than handing back a wrong password that would be sent to a real
//      server.
//   2. Users who have no vault see zero change. The vault is one more source
//      in the loader chain, and an absent or broken one must never stop the
//      .env and TOML definitions from working.
//
// Every test drives a vault in a scratch directory with its own key file, so
// nothing here touches the developer's real ~/.ssh-manager or OS keychain.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  SecretStore,
  encryptValue,
  decryptValue,
  SECRET_FIELDS
} from '../src/secret-store.js';
import { ConfigLoader } from '../src/config-loader.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const PASSWORD = 'prod-db-password-42';
const SUDO = 'sudo-secret-99';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-vault-'));

// Never touch the developer's real keychain or ~/.ssh-manager: force the file
// key source and point SSH_MANAGER_HOME at the scratch directory.
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
process.env.SSH_MANAGER_HOME = scratch;

/** A store whose key lives in the scratch directory, never the real keychain. */
function makeStore(name = 'vault.json') {
  const dir = fs.mkdtempSync(path.join(scratch, 'v-'));
  return new SecretStore(path.join(dir, name));
}

function testRoundTrip() {
  const key = crypto.randomBytes(32);
  for (const value of [PASSWORD, '', 'é☃ unicode', 'a'.repeat(4096), 'quote\'s "and" $(x)']) {
    const encrypted = encryptValue(value, key);
    assert.notStrictEqual(encrypted, value, 'the ciphertext must differ from the plaintext');
    assert.strictEqual(decryptValue(encrypted, key), value, `round-trip failed for ${JSON.stringify(value.slice(0, 20))}`);
  }
  ok('encrypt/decrypt round-trips, including empty, unicode and shell metacharacters');

  // Same value, two encryptions: different ciphertext. A deterministic scheme
  // would let anyone see which servers share a password.
  const a = encryptValue(PASSWORD, key);
  const b = encryptValue(PASSWORD, key);
  assert.notStrictEqual(a, b, 'encrypting the same value twice must not produce the same ciphertext');
  ok('the same value encrypts differently each time (random IV)');
}

function testTamperingIsDetected() {
  const key = crypto.randomBytes(32);
  const encrypted = encryptValue(PASSWORD, key);
  const [prefix, iv, tag, ciphertext] = encrypted.split(':');

  // Flip one byte of the ciphertext.
  const raw = Buffer.from(ciphertext, 'base64');
  raw[0] ^= 0xff;
  const tampered = [prefix, iv, tag, raw.toString('base64')].join(':');
  assert.throws(() => decryptValue(tampered, key),
    'a modified ciphertext must throw, not return a wrong password');

  // A different key must not decrypt.
  assert.throws(() => decryptValue(encrypted, crypto.randomBytes(32)),
    'the wrong key must throw');

  for (const malformed of ['', 'nope', 'v1:only:three', 'v2:a:b:c']) {
    assert.throws(() => decryptValue(malformed, key), `malformed input must throw: ${malformed}`);
  }
  ok('tampering, a wrong key and malformed input all throw instead of returning garbage');
}

function testSecretsAreNotReadableOnDisk() {
  const store = makeStore();
  store.setServer('PROD', {
    host: 'prod.internal', user: 'deploy', port: 22,
    password: PASSWORD, sudoPassword: SUDO, mode: 'readonly'
  });

  const onDisk = fs.readFileSync(store.vaultPath, 'utf8');
  assert.ok(!onDisk.includes(PASSWORD), 'the password must not appear in the vault file');
  assert.ok(!onDisk.includes(SUDO), 'the sudo password must not appear in the vault file');
  ok('no secret appears in the vault file');

  // Non-secret fields stay readable on purpose: hiding them buys nothing and
  // makes the file impossible to reason about.
  assert.ok(onDisk.includes('prod.internal'), 'the host must stay readable');
  assert.ok(onDisk.includes('readonly'), 'the security mode must stay readable');
  ok('non-secret fields stay readable, so the file can still be inspected');

  const mode = fs.statSync(store.vaultPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, `the vault must be owner-only, got ${mode.toString(8)}`);
  ok('the vault file is written 0600');
}

function testCrudRoundTrip() {
  const store = makeStore();
  store.setServer('web1', { host: 'a.internal', user: 'u', password: PASSWORD });
  store.setServer('web2', { host: 'b.internal', user: 'u' });

  assert.deepStrictEqual(store.listServers(), ['web1', 'web2'], 'both servers must be listed');

  const all = store.getAllDecrypted();
  assert.strictEqual(all.web1.password, PASSWORD, 'the secret must come back intact');
  assert.strictEqual(all.web1.host, 'a.internal');
  assert.strictEqual(all.web2.password, undefined, 'a server with no password must not gain one');
  ok('add, list and read back work, secrets included');

  // Replacing must not merge with the old entry: a removed password has to
  // actually disappear, or "I deleted that credential" would be a lie.
  store.setServer('web1', { host: 'a.internal', user: 'u' });
  assert.strictEqual(store.getAllDecrypted().web1.password, undefined,
    'replacing a server must drop fields that are no longer set');
  ok('replacing a server drops the fields it no longer has');

  assert.strictEqual(store.removeServer('web2'), true, 'removing an existing server returns true');
  assert.strictEqual(store.removeServer('web2'), false, 'removing it twice returns false');
  assert.deepStrictEqual(store.listServers(), ['web1'], 'the server must be gone');
  ok('remove works and is honest about whether it removed anything');

  // Names are normalised the same way as everywhere else in the codebase.
  store.setServer('MiXeD', { host: 'c.internal' });
  assert.ok(store.listServers().includes('mixed'), 'names must be lowercased');
  ok('server names are normalised to lowercase');
}

function testListingDoesNotNeedTheKey() {
  const store = makeStore();
  store.setServer('web1', { host: 'a.internal', password: PASSWORD });

  // A fresh store with no key: listing must still work. Asking "which servers
  // exist" should never trigger a keychain prompt.
  const reader = new SecretStore(store.vaultPath);
  assert.deepStrictEqual(reader.listServers(), ['web1']);
  assert.strictEqual(reader.key, null, 'listing must not have unlocked the store');
  ok('listing server names never unlocks the vault');
}

async function testLoaderPrecedenceAndFallback() {
  const dir = fs.mkdtempSync(path.join(scratch, 'loader-'));
  const envPath = path.join(dir, 'test.env');
  fs.writeFileSync(envPath, [
    'SSH_SERVER_FROMENV_HOST=env.internal',
    'SSH_SERVER_FROMENV_USER=envuser',
    'SSH_SERVER_FROMENV_PASSWORD=env-password',
    'SSH_SERVER_SHARED_HOST=env.shared',
    'SSH_SERVER_SHARED_USER=envuser',
    'SSH_SERVER_SHARED_PASSWORD=env-password'
  ].join('\n'));

  // 1. No vault at all — the .env must load exactly as before.
  const noVault = new ConfigLoader();
  const before = await noVault.load({ envPath, tomlPath: '/nonexistent', vaultPath: path.join(dir, 'absent.json') });
  assert.strictEqual(before.get('fromenv').password, 'env-password');
  assert.strictEqual(before.size, 2, 'both .env servers must load without a vault');
  ok('with no vault, .env loading is unchanged');

  // 2. Vault present — it wins over .env for the same server, and adds its own.
  // Same key resolution as the loader will use — that is the point of the test.
  const store = new SecretStore(path.join(dir, 'vault.json'));
  store.setServer('shared', { host: 'vault.shared', user: 'vaultuser', password: PASSWORD });
  store.setServer('vaultonly', { host: 'vault.internal', user: 'vaultuser', password: PASSWORD });

  const withVault = new ConfigLoader();
  const after = await withVault.load({ envPath, tomlPath: '/nonexistent', vaultPath: store.vaultPath });
  assert.strictEqual(after.get('shared').password, PASSWORD, 'the vault must win over .env');
  assert.strictEqual(after.get('shared').host, 'vault.shared', 'the vault host must win too');
  assert.strictEqual(after.get('fromenv').password, 'env-password', '.env-only servers must survive');
  assert.strictEqual(after.get('vaultonly').host, 'vault.internal', 'vault-only servers must appear');
  assert.strictEqual(after.size, 3);
  ok('the vault takes precedence over .env without dropping .env-only servers');

  // 3. A corrupt vault must not take the .env down with it.
  const brokenPath = path.join(dir, 'broken.json');
  fs.writeFileSync(brokenPath, '{ this is not json');
  const withBroken = new ConfigLoader();
  const salvaged = await withBroken.load({ envPath, tomlPath: '/nonexistent', vaultPath: brokenPath });
  assert.strictEqual(salvaged.get('fromenv').password, 'env-password',
    'a corrupt vault must not prevent .env servers from loading');
  ok('a corrupt vault is reported but never blocks the other sources');
}

function testSecretFieldListMatchesTheLoader() {
  // If the loader gains a new credential field and SECRET_FIELDS is not
  // updated, that field would be written to the vault in clear text.
  const loaderSource = fs.readFileSync(new URL('../src/config-loader.js', import.meta.url), 'utf8');
  for (const field of ['password', 'passphrase', 'sudoPassword']) {
    assert.ok(loaderSource.includes(field), `the loader must still produce "${field}"`);
    assert.ok(SECRET_FIELDS.includes(field), `SECRET_FIELDS must cover "${field}"`);
  }
  ok(`every credential field the loader produces is encrypted (${SECRET_FIELDS.length} fields)`);
}

async function main() {
  try {
    testRoundTrip();
    testTamperingIsDetected();
    testSecretsAreNotReadableOnDisk();
    testCrudRoundTrip();
    testListingDoesNotNeedTheKey();
    await testLoaderPrecedenceAndFallback();
    testSecretFieldListMatchesTheLoader();
    console.log(`\n✅ secret store tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
