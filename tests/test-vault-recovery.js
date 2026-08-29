// Tests for recovery files.
//
// This is the code nobody exercises until the day it is the only thing standing
// between an operator and thirty lost credentials, so it is tested the way it
// will be used: write on one "machine", lose the key, read on another.
//
// The scenario in the middle is the one that matters and the one that used to
// fail silently — a vault whose key is gone. A fresh key was minted, the store
// carried on, `vault list` reported everything fine, and the secrets were
// unreadable. Now it refuses and says so.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeRecoveryFile, readRecoveryFile, describeRecoveryFile } from '../src/vault-recovery.js';
import { SecretStore } from '../src/secret-store.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-'));
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
process.env.SSH_MANAGER_HOME = scratch;

const SERVERS = {
  prod: { host: 'prod.example.com', user: 'deploy', password: 'hunter2', port: 22, defaultDir: '/var/www' },
  db: { host: 'db.example.com', user: 'root', keyPath: '~/.ssh/id_ed25519',
    passphrase: 'key passphrase', sudoPassword: 'sudo secret', port: 2222 },
  bastion: { host: 'bastion.example.com', user: 'jump', keyPath: '~/.ssh/bastion' },
};

const PASSPHRASE = 'correct horse battery staple';

function testRoundTrip() {
  const file = path.join(scratch, 'recovery.json');
  const result = writeRecoveryFile(SERVERS, PASSPHRASE, file);
  assert.strictEqual(result.servers, 3);
  assert.strictEqual(result.secrets, 3, 'password, passphrase and sudoPassword should all count');

  const back = readRecoveryFile(file, PASSPHRASE);
  assert.deepStrictEqual(back, SERVERS, 'what comes back must be what went in, secrets included');
  ok('a recovery file round-trips every server and every secret');
}

function testNothingReadableWithoutThePassphrase() {
  const file = path.join(scratch, 'recovery.json');
  const raw = fs.readFileSync(file, 'utf8');

  // The whole point: the file can be stored anywhere, so it must give up
  // nothing to whoever finds it.
  for (const secret of ['hunter2', 'key passphrase', 'sudo secret']) {
    assert.ok(!raw.includes(secret), `${secret} must not appear in the file`);
  }
  // Hosts and users are secrets too here — unlike in the vault, where they stay
  // readable on purpose so the file can be inspected and diffed.
  for (const value of ['prod.example.com', 'deploy', 'bastion.example.com']) {
    assert.ok(!raw.includes(value), `${value} must not appear in the file either`);
  }
  assert.throws(() => readRecoveryFile(file, 'wrong passphrase'), /Wrong passphrase/,
    'a wrong passphrase must fail plainly, not return partial data');
  ok('the file reveals nothing without the passphrase — not even hostnames');
}

function testTamperingIsDetected() {
  const file = path.join(scratch, 'tampered.json');
  writeRecoveryFile(SERVERS, PASSPHRASE, file);
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Flip one byte of ciphertext. GCM must catch it rather than hand back
  // plausible-looking garbage.
  const data = Buffer.from(content.data, 'base64');
  data[10] ^= 0x01;
  content.data = data.toString('base64');
  fs.writeFileSync(file, JSON.stringify(content));

  assert.throws(() => readRecoveryFile(file, PASSPHRASE), /Wrong passphrase, or the file has been altered/,
    'an altered file must be refused, not partially decrypted');
  ok('a single flipped byte is detected — authenticated encryption, not just encryption');
}

function testItSaysWhatItHoldsWithoutOpening() {
  const file = path.join(scratch, 'recovery.json');
  const described = describeRecoveryFile(file);
  assert.strictEqual(described.servers, 3);
  assert.strictEqual(described.secrets, 3);
  assert.ok(Date.parse(described.createdAt) > 0, 'the date must be readable to tell two files apart');
  ok('a file can be identified before typing a passphrase into it');
}

function testWeakPassphrasesAreRefused() {
  // The passphrase is the only thing protecting the file; accepting "1234"
  // would be offering a guarantee that is not there.
  for (const weak of ['', 'short', '1234567']) {
    assert.throws(() => writeRecoveryFile(SERVERS, weak, path.join(scratch, 'weak.json')),
      /at least 8/, `"${weak}" must be refused`);
  }
  assert.ok(!fs.existsSync(path.join(scratch, 'weak.json')), 'and nothing must be written');
  ok('a passphrase too short to protect anything is refused');
}

function testTheFileSurvivesLosingTheKey() {
  // The scenario this exists for, played out: a vault on one machine, a
  // recovery file, then the key is gone.
  const vaultPath = path.join(scratch, 'machine-a', 'vault.json');
  const keyPath = path.join(scratch, 'vault.key');
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });

  const store = new SecretStore(vaultPath);
  for (const [name, config] of Object.entries(SERVERS)) store.setServer(name, config);

  const file = path.join(scratch, 'survives.json');
  writeRecoveryFile(store.getAllDecrypted(), PASSPHRASE, file);

  // The new machine: same vault file, no key.
  fs.rmSync(keyPath, { force: true });
  const onNewMachine = new SecretStore(vaultPath);
  assert.throws(() => onNewMachine.getAllDecrypted(), /no longer has/,
    'a vault whose key is gone must say so, not mint a new key and pretend');
  ok('a vault whose key is gone refuses loudly instead of failing silently');

  // And the recovery file still opens.
  const rescued = readRecoveryFile(file, PASSPHRASE);
  assert.deepStrictEqual(rescued, SERVERS, 'the recovery file must not depend on the machine key');
  ok('the recovery file opens on a machine that never had the vault key');

  // Restoring rebuilds a working vault.
  fs.rmSync(vaultPath);
  const rebuilt = new SecretStore(vaultPath);
  for (const [name, config] of Object.entries(rescued)) rebuilt.setServer(name, config);
  assert.strictEqual(rebuilt.getAllDecrypted().prod.password, 'hunter2',
    'and the restored vault must actually work');
  ok('restoring produces a vault that decrypts again');
}

function main() {
  try {
    testRoundTrip();
    testNothingReadableWithoutThePassphrase();
    testTamperingIsDetected();
    testItSaysWhatItHoldsWithoutOpening();
    testWeakPassphrasesAreRefused();
    testTheFileSurvivesLosingTheKey();
    console.log(`\n✅ vault recovery tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
