// The upgrade guarantee.
//
// Somebody on 3.8.x runs `npm update` without reading a changelog. Nothing they
// have may change: same servers, same fields, same values, same order of
// precedence. The vault is a layer above the files, never a replacement for
// them, and this test is what keeps that true release after release.
//
// It drives the real loader against real files rather than mocking either,
// because every regression this guards against — a renamed field, a new
// precedence rule, a vault that shadows a .env it should not — lives exactly in
// that wiring.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigLoader } from '../src/config-loader.js';
import { SecretStore } from '../src/secret-store.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-'));
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
process.env.SSH_MANAGER_HOME = scratch;

/** A .env as someone running 3.8.x actually has one. */
const ENV = `
SSH_SERVER_PROD_HOST=prod.example.com
SSH_SERVER_PROD_USER=deploy
SSH_SERVER_PROD_PASSWORD=motdepasse-prod
SSH_SERVER_PROD_DEFAULT_DIR=/var/www
SSH_SERVER_PROD_GROUP=production
SSH_SERVER_PROD_MODE=readonly

SSH_SERVER_DB_HOST=db.example.com
SSH_SERVER_DB_USER=root
SSH_SERVER_DB_KEYPATH=~/.ssh/id_ed25519
SSH_SERVER_DB_PASSPHRASE=phrase-de-la-cle
SSH_SERVER_DB_SUDO_PASSWORD=sudo-secret
SSH_SERVER_DB_PORT=2222

SSH_SERVER_BASTION_HOST=bastion.example.com
SSH_SERVER_BASTION_USER=jump
SSH_SERVER_BASTION_KEYPATH=~/.ssh/bastion
`;

const envPath = path.join(scratch, '.env');
fs.writeFileSync(envPath, ENV);

/** @returns {Promise<Record<string, any>>} */
async function load(options = {}) {
  const loaded = await new ConfigLoader().load({ envPath, ...options });
  return loaded instanceof Map ? Object.fromEntries(loaded) : loaded;
}

async function testAEnvOnlyInstallIsUntouched() {
  // No vault anywhere: this is every existing user on the day they upgrade.
  const servers = await load({ vaultPath: path.join(scratch, 'absent.json') });

  assert.deepStrictEqual(Object.keys(servers).sort(), ['bastion', 'db', 'prod']);
  assert.strictEqual(servers.prod.password, 'motdepasse-prod', 'secrets must still come through');
  assert.strictEqual(servers.prod.defaultDir, '/var/www');
  assert.strictEqual(servers.prod.group, 'production');
  assert.strictEqual(servers.prod.mode, 'readonly', 'security modes must survive the upgrade');
  assert.strictEqual(servers.db.passphrase, 'phrase-de-la-cle');
  assert.strictEqual(servers.db.sudoPassword, 'sudo-secret');
  assert.strictEqual(servers.db.port, 2222);
  assert.strictEqual(servers.bastion.keyPath, '~/.ssh/bastion');
  ok('a .env-only install loads exactly as it did before — no vault, no prompt, no change');
}

async function testTheVaultIsNeverCreatedByItself() {
  const vaultPath = path.join(scratch, 'never-created.json');
  await load({ vaultPath });
  assert.ok(!fs.existsSync(vaultPath),
    'loading must never create a vault: a file appearing unasked in someone’s home is a surprise, '
    + 'and this one would look like it holds their credentials');
  ok('nothing is written anywhere unless the operator asks for it');
}

async function testImportingDoesNotTouchTheEnv() {
  const before = fs.readFileSync(envPath, 'utf8');
  const vaultPath = path.join(scratch, 'imported.json');
  const store = new SecretStore(vaultPath);
  for (const [name, config] of Object.entries(await load({ vaultPath }))) {
    store.setServer(name, config);
  }
  assert.strictEqual(fs.readFileSync(envPath, 'utf8'), before,
    'importing must leave the .env byte-for-byte identical — it is still the fallback');
  ok('importing into the vault leaves the .env untouched');
}

async function testTheVaultWinsButOnlyForWhatItHolds() {
  // A half-migrated state, which is the normal state for weeks: some servers in
  // the vault, others still only in the .env.
  const vaultPath = path.join(scratch, 'partial.json');
  const store = new SecretStore(vaultPath);
  store.setServer('prod', {
    host: 'prod-new.example.com', user: 'deploy', password: 'nouveau-mot-de-passe', port: 22,
  });

  const servers = await load({ vaultPath });
  assert.strictEqual(servers.prod.host, 'prod-new.example.com',
    'the vault must win for a server it holds — that is what makes editing in the UI meaningful');
  assert.strictEqual(servers.prod.password, 'nouveau-mot-de-passe');
  assert.strictEqual(servers.db.host, 'db.example.com',
    'and a server only in the .env must still load, or a half-migrated setup breaks');
  assert.strictEqual(servers.bastion.user, 'jump');
  assert.strictEqual(Object.keys(servers).length, 3, 'the union of both, not one or the other');
  ok('a half-migrated setup works: the vault wins per server, the .env fills the rest');
}

async function testTheProcessEnvironmentStillWinsOverEverything() {
  // The documented top of the chain, and what CI relies on to override a
  // checked-in file. A vault that outranked it would break deployments.
  const vaultPath = path.join(scratch, 'partial.json');
  process.env.SSH_SERVER_PROD_HOST = 'from-the-environment.example.com';
  try {
    const servers = await load({ vaultPath });
    assert.strictEqual(servers.prod.host, 'from-the-environment.example.com',
      'process.env must outrank the vault, as it always outranked the .env');
  } finally {
    delete process.env.SSH_SERVER_PROD_HOST;
  }
  ok('the process environment still beats everything, vault included');
}

async function testAnUnreadableVaultDoesNotTakeTheEnvDownWithIt() {
  // The failure that would hurt most: a vault whose key is gone must not stop
  // servers that are perfectly well described in a .env from loading.
  const vaultPath = path.join(scratch, 'corrupt.json');
  fs.writeFileSync(vaultPath, '{ this is not json');
  const servers = await load({ vaultPath });
  assert.strictEqual(Object.keys(servers).length, 3,
    'a broken vault must degrade to the .env, not take everything with it');
  assert.strictEqual(servers.prod.password, 'motdepasse-prod');
  ok('an unreadable vault degrades to the .env instead of failing the whole load');
}

async function testTheOfferIsMadeButNeverActedOn() {
  // The migration route is what the interface uses to tell an operator the
  // vault exists — the one thing missing, since nobody reads a changelog.
  const { ControlPlane } = await import('../src/control-plane.js');
  const vaultPath = path.join(scratch, 'offered.json');
  const plane = new ControlPlane({
    socketPath: path.join(scratch, 'offer.sock'),
    port: 0,
    vaultPath,
  });
  const { url } = await plane.start();
  const base = url.split('/?')[0];
  const q = `token=${plane.token}`;

  try {
    // The loader reads $PWD/.env; point it at ours for the duration.
    const cwd = process.cwd();
    process.chdir(scratch);
    try {
      const before = fs.readFileSync(envPath, 'utf8');
      const state = await fetch(`${base}/api/migration?${q}`).then(r => r.json());

      assert.strictEqual(state.pending.length, 3, 'every server still only in the file must be offered');
      assert.strictEqual(state.hasVault, false);
      const prod = state.pending.find(s => s.name === 'prod');
      assert.strictEqual(prod.secrets, 1, 'the count of secrets travels');
      assert.ok(!JSON.stringify(state).includes('motdepasse-prod'),
        'but never a secret itself — this answer goes to a browser');
      ok('servers still in a file are offered, with counts rather than values');

      // Asking for the state must not have changed anything.
      assert.ok(!fs.existsSync(vaultPath), 'merely looking must not create a vault');
      ok('the offer alone writes nothing');

      // Named servers only.
      const imported = await fetch(`${base}/api/migration?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ servers: ['prod'] }),
      }).then(r => r.json());
      assert.deepStrictEqual(imported.imported, ['prod']);

      const after = await fetch(`${base}/api/migration?${q}`).then(r => r.json());
      assert.strictEqual(after.pending.length, 2, 'only what was named must move');
      assert.strictEqual(fs.readFileSync(envPath, 'utf8'), before,
        'and the file must be byte-for-byte identical afterwards');
      ok('importing moves only the named servers and leaves the file untouched');

      // What landed must be usable, and encrypted.
      const store = new SecretStore(vaultPath);
      assert.strictEqual(store.getAllDecrypted().prod.password, 'motdepasse-prod');
      assert.ok(!fs.readFileSync(vaultPath, 'utf8').includes('motdepasse-prod'),
        'the secret must be encrypted at rest');
      ok('the imported server decrypts, and its secret is not on disk in clear');
    } finally {
      process.chdir(cwd);
    }
  } finally {
    await plane.stop();
  }
}

async function main() {
  try {
    await testAEnvOnlyInstallIsUntouched();
    await testTheVaultIsNeverCreatedByItself();
    await testImportingDoesNotTouchTheEnv();
    await testTheVaultWinsButOnlyForWhatItHolds();
    await testTheProcessEnvironmentStillWinsOverEverything();
    await testAnUnreadableVaultDoesNotTakeTheEnvDownWithIt();
    await testTheOfferIsMadeButNeverActedOn();
    console.log(`\n✅ upgrade tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
