/**
 * Recovery files: one encrypted copy of the vault that does not depend on this
 * machine's keychain.
 *
 * ## Why this exists
 *
 * The vault's master key lives in the OS keychain, which is the right place for
 * it — but it is tied to one machine and one user account. Reinstall the OS,
 * move to a new laptop, or let a Linux keyring get wiped, and the vault is a
 * file of ciphertext nobody can read. The credentials themselves are usually
 * recoverable from elsewhere (a password manager, a colleague, the server's own
 * `authorized_keys`), but "usually" is doing a lot of work in that sentence at
 * the moment you need it.
 *
 * ## Why a passphrase and not a printed key
 *
 * The obvious alternative is what a wallet does: generate a recovery key, print
 * it, tell the user to keep the paper. That works when what is being protected
 * is one secret you re-enter once. It does not work here: what is protected is
 * thirty servers with hosts, ports, users, key paths and modes, and nobody
 * retypes that from a sheet of paper. So the recovery unit is a **file** —
 * something a password manager can hold as an attachment, or a private repo can
 * carry — encrypted under a passphrase the operator chooses and can remember.
 *
 * ## What it is not
 *
 * Not a backup of the key. Handing someone the master key in a file next to the
 * vault would defeat the keychain entirely. The recovery file is encrypted from
 * the plaintext, under a **different** key derived from the passphrase, so
 * possessing it without the passphrase is worth nothing.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SECRET_FIELDS } from './secret-store.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

/**
 * scrypt cost. N=2^17 takes roughly a quarter-second on a modern laptop, which
 * is imperceptible when you type a passphrase once and expensive enough that
 * guessing at scale is not free. maxmem has to be raised to match: Node's
 * default refuses this N.
 */
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** The format marker, so a future change can be told apart rather than guessed at. */
const FORMAT = 'ssh-manager-recovery-v1';

/**
 * Derive the file key from a passphrase.
 * @param {string} passphrase - What the operator typed
 * @param {Buffer} salt - Per-file salt
 * @returns {Buffer} 32-byte key
 */
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT);
}

/**
 * Write a recovery file.
 *
 * @param {Record<string, any>} servers - Decrypted server configs, as the vault hands them out
 * @param {string} passphrase - Chosen by the operator
 * @param {string} outputPath - Where to write
 * @returns {{ path: string, servers: number, secrets: number }}
 */
export function writeRecoveryFile(servers, passphrase, outputPath) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('The passphrase must be at least 8 characters — this is the only thing protecting the file.');
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  const plaintext = Buffer.from(JSON.stringify({ servers }), 'utf8');
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const secrets = Object.values(servers)
    .reduce((count, server) => count + SECRET_FIELDS.filter(f => server?.[f]).length, 0);

  const file = {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    // Stated in the file so whoever finds it in five years knows what it takes
    // to open it, without needing this source.
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
    // Deliberately outside the ciphertext: enough to identify a file without
    // opening it, never enough to be worth stealing.
    contains: { servers: Object.keys(servers).length, secrets },
  };

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { path: path.resolve(outputPath), servers: file.contains.servers, secrets };
}

/**
 * Read a recovery file back.
 *
 * @param {string} inputPath - The file
 * @param {string} passphrase - The one used to write it
 * @returns {Record<string, any>} The servers, in the clear
 */
export function readRecoveryFile(inputPath, passphrase) {
  /** @type {any} */
  let file;
  try {
    file = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${inputPath}: ${error.message}`);
  }
  if (file.format !== FORMAT) {
    throw new Error(`${inputPath} is not a recovery file (found format "${file.format ?? 'none'}").`);
  }

  const kdf = file.kdf ?? {};
  // Read the parameters from the file rather than assuming today's constants:
  // a file written by an older version must still open.
  const key = crypto.scryptSync(
    passphrase.normalize('NFKC'),
    Buffer.from(kdf.salt, 'base64'),
    KEY_BYTES,
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: kdf.maxmem ?? SCRYPT.maxmem }
  );

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')).servers;
  } catch {
    // GCM cannot tell a wrong passphrase from a corrupted file, and guessing
    // which would only mislead.
    throw new Error('Wrong passphrase, or the file has been altered.');
  }
}

/**
 * Describe a recovery file without opening it — what it holds and when it was
 * made, so an operator can tell two of them apart before typing anything.
 *
 * @param {string} inputPath - The file
 * @returns {{ createdAt: string, servers: number, secrets: number }}
 */
export function describeRecoveryFile(inputPath) {
  const file = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (file.format !== FORMAT) throw new Error(`${inputPath} is not a recovery file.`);
  return {
    createdAt: file.createdAt,
    servers: file.contains?.servers ?? 0,
    secrets: file.contains?.secrets ?? 0,
  };
}
