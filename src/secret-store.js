// Encrypted local store for server credentials — the v4 vault.
//
// Why this exists: until now the only way to give a server a password was to
// write it in clear text in a .env or TOML file. That file sits in a project
// directory, gets copied into backups, and shows up in `cat`. Competing MCP SSH
// servers put credentials in the OS keychain, and it is the last substantive
// gap we have against them.
//
// Design constraints, in order:
//
//   1. **Nothing changes for existing users.** The vault is one more source in
//      the loader's chain, consulted only when it exists. No vault, no change.
//   2. **No new npm dependency.** Encryption uses Node's built-in crypto; the
//      master key lives in the OS keychain, reached through the tools already
//      present on each platform, with a file fallback when there is none.
//   3. **The engine stays headless.** A GUI can drive this module, but nothing
//      here requires one — the CLI and the MCP server use the same API.
//
// The file format is deliberately boring JSON so it can be inspected, backed up
// and diffed. Only the secret values are ciphertext; hosts, users, ports and
// modes stay readable, because hiding them buys nothing and makes the file
// impossible to reason about.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';

const VAULT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

// Keychain coordinates. One service name per platform tool, one account.
const KEYCHAIN_SERVICE = 'mcp-ssh-manager';
const KEYCHAIN_ACCOUNT = 'vault-master-key';

/** Fields whose values are encrypted rather than stored as-is. */
export const SECRET_FIELDS = ['password', 'passphrase', 'sudoPassword'];

/** Apply a transform to credentials, including those in additional accounts.
 * @param {any} value
 * @param {(secret: any) => any} transform
 * @returns {any}
 */
function mapSecrets(value, transform) {
  if (Array.isArray(value)) return value.map(item => mapSecrets(item, transform));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field,
    SECRET_FIELDS.includes(field) ? transform(item) : mapSecrets(item, transform)]));
}

/** @param {Record<string, any>} servers @returns {any[]} */
function secretValues(servers) {
  const values = [];
  for (const config of Object.values(servers)) {
    mapSecrets(config, value => { values.push(value); return value; });
  }
  return values;
}

/** A browser receives presence flags, never secrets, including nested accounts.
 * @param {any} value
 * @returns {any}
 */
export function publicServerConfig(value) {
  if (Array.isArray(value)) return value.map(publicServerConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([field, item]) =>
    SECRET_FIELDS.includes(field)
      ? [`has${field[0].toUpperCase()}${field.slice(1)}`, true]
      : [field, publicServerConfig(item)]));
}

/**
 * Default vault location. Kept next to the other per-user state
 * (~/.ssh-manager/) rather than in the project directory, so it is not caught
 * by a `git add .` or copied with the repository.
 * @returns {string} Absolute path to the vault file
 */
export function defaultVaultPath() {
  return process.env.SSH_MANAGER_VAULT
    || path.join(process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager'), 'vault.json');
}

/**
 * How long a keychain call may take before it is abandoned.
 *
 * These helpers talk to a user session, and this software mostly runs where
 * there is not one: a server over SSH, a container, a CI runner, a launchd
 * agent. `secret-tool` with no D-Bus to answer it, or `security` raising a
 * modal in a process that has no window, can sit there indefinitely — and the
 * vault read is on the path of every command, so everything sits with it.
 *
 * Five seconds, then give up: the answer after five hours would be the same
 * one, and falling back to the key file is already the supported path.
 */
const KEYCHAIN_TIMEOUT_MS = 5000;

/**
 * Read the master key from the OS keychain.
 *
 * macOS uses `security`, Linux `secret-tool` (libsecret), both of which ship
 * with the desktop. Windows has no equivalent CLI, so it falls through to the
 * file fallback. Returns null when the platform has no store, the tool is
 * missing, or no key has been stored yet — all normal conditions, not errors.
 *
 * @returns {Buffer|null} The 32-byte key, or null when unavailable
 */
function readKeyFromKeychain() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('security', [
        'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'
      ], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS });
      return Buffer.from(out.trim(), 'base64');
    }
    if (process.platform === 'linux') {
      const out = execFileSync('secret-tool', [
        'lookup', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT
      ], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS });
      const trimmed = out.trim();
      return trimmed ? Buffer.from(trimmed, 'base64') : null;
    }
  } catch {
    // No entry, no tool, the user declined the prompt, or the deadline passed.
    // All of them mean the same thing here: no key from the keychain.
  }
  return null;
}

/**
 * Store the master key in the OS keychain.
 * @param {Buffer} key - The key to store
 * @returns {boolean} True when the keychain accepted it
 */
function writeKeyToKeychain(key) {
  const encoded = key.toString('base64');
  try {
    if (process.platform === 'darwin') {
      execFileSync('security', [
        'add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT,
        '-w', encoded, '-U'
      ], { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS });
      return true;
    }
    if (process.platform === 'linux') {
      execFileSync('secret-tool', [
        'store', '--label=MCP SSH Manager vault key',
        'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT
      ], { input: encoded, stdio: ['pipe', 'ignore', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS });
      return true;
    }
  } catch {
    // Fall through to the file fallback.
  }
  return false;
}

/**
 * Path of the fallback key file, used where no OS keychain is reachable.
 * @returns {string} Absolute path
 */
function fallbackKeyPath() {
  return path.join(path.dirname(defaultVaultPath()), 'vault.key');
}

/**
 * Resolve the master key, creating one on first use.
 *
 * Prefers the OS keychain. Falls back to a 0600 file, which is weaker — the key
 * then sits next to the data it protects — but still strictly better than the
 * clear-text .env it replaces, and it keeps the vault usable on Windows, in
 * containers and over SSH sessions with no desktop keyring.
 *
 * `minted` says the key did not exist and was created here. The caller needs
 * that: a fresh key against an existing vault means every secret in it is
 * unreadable, and generating one silently is how an operator finds out weeks
 * later, from a failed deploy, that their credentials are gone.
 *
 * @param {{ create?: boolean }} [options]
 * @returns {{ key: Buffer, source: 'keychain'|'file', minted: boolean }}
 */
function resolveMasterKey({ create = true } = {}) {
  // SSH_MANAGER_KEY_SOURCE=file skips the OS keychain entirely. Needed wherever
  // there is no desktop session to prompt — CI, containers, a plain SSH login —
  // and it is what makes the vault testable without touching the developer's
  // real keychain.
  const forceFile = process.env.SSH_MANAGER_KEY_SOURCE === 'file';

  const fromKeychain = forceFile ? null : readKeyFromKeychain();
  if (fromKeychain && fromKeychain.length === KEY_BYTES) {
    return { key: fromKeychain, source: 'keychain', minted: false };
  }

  const keyFile = fallbackKeyPath();
  if (fs.existsSync(keyFile)) {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length === KEY_BYTES) return { key, source: 'file', minted: false };
  }

  if (!create) {
    throw Object.assign(new Error('The vault is encrypted with a key this machine no longer has. '
      + 'Restore a recovery file or re-import the original configuration. No new key was created.'),
    { code: 'VAULT_KEY_MISMATCH' });
  }

  // First use: mint a key and try to put it somewhere safe.
  const key = crypto.randomBytes(KEY_BYTES);
  if (!forceFile && writeKeyToKeychain(key)) {
    return { key, source: 'keychain', minted: true };
  }

  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (existing.length !== KEY_BYTES) throw new Error(`Invalid vault key file: ${keyFile}`);
    return { key: existing, source: 'file', minted: false };
  }
  logger.warn('Vault key stored in a file: no OS keychain available', { keyFile });
  return { key, source: 'file', minted: true };
}

/**
 * Encrypt one secret value.
 * @param {string} plaintext - Value to encrypt
 * @param {Buffer} key - Master key
 * @returns {string} `v1:<iv>:<tag>:<ciphertext>`, all base64
 */
export function encryptValue(plaintext, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt one secret value.
 *
 * GCM authenticates as well as encrypts: a tampered vault throws here rather
 * than silently yielding a wrong password that would then be sent to a server.
 *
 * @param {string} encoded - Value produced by encryptValue
 * @param {Buffer} key - Master key
 * @returns {string} The plaintext
 */
export function decryptValue(encoded, key) {
  const parts = String(encoded).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted value');
  }
  const [, iv, tag, ciphertext] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

/**
 * An encrypted, file-backed store of server definitions.
 *
 * Every method reads and writes the file immediately: there is no in-memory
 * cache to go stale when the CLI and the MCP server are both running.
 */
export class SecretStore {
  /**
   * @param {string} [vaultPath] - Vault file location; defaults to defaultVaultPath()
   */
  constructor(vaultPath = defaultVaultPath()) {
    this.vaultPath = vaultPath;
    /** @type {Buffer|null} */
    this.key = null;
    /** @type {'keychain'|'file'|null} */
    this.keySource = null;
  }

  /**
   * Whether the vault on disk holds anything encrypted. Read straight from the
   * file rather than through the store, because this runs before a key exists.
   *
   * @returns {boolean}
   */
  #vaultHoldsSecrets() {
    if (!fs.existsSync(this.vaultPath)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.vaultPath, 'utf8'));
      return secretValues(raw.servers || {}).length > 0;
    } catch {
      // An unreadable vault is a different problem, reported where it is read.
      return false;
    }
  }


  /**
   * Can this machine's key actually open what is in the vault?
   *
   * Separate from unlock() because the commands that reassure an operator —
   * `vault list`, `vault status` — read the file without ever decrypting a
   * value, and so reported "3 servers, encrypted: password" for a vault whose
   * key was gone. Something that looks like confirmation has to be
   * confirmation.
   *
   * @returns {{ ok: boolean, reason?: string, checked: number }}
   */
  checkKey() {
    if (!fs.existsSync(this.vaultPath)) return { ok: true, checked: 0 };

    /** @type {any} */
    let raw;
    try {
      raw = this.read();
    } catch (error) {
      return { ok: false, reason: `The vault file is unreadable: ${error.message}`, checked: 0 };
    }

    const encrypted = secretValues(raw.servers || {});
    if (encrypted.length === 0) return { ok: true, checked: 0 };

    // GCM authenticates each value separately. One good value says nothing
    // about damage to a later value, or a vault assembled under different keys.
    try {
      this.getAllDecrypted();
      return { ok: true, checked: encrypted.length };
    } catch (error) {
      return {
        ok: false,
        checked: encrypted.length,
        reason: error.message,
      };
    }
  }

  /** @returns {boolean} True when a vault file exists on disk */
  exists() {
    return fs.existsSync(this.vaultPath);
  }

  /**
   * Load (or create) the master key. Idempotent.
   *
   * Existing ciphertext requires an existing key that decrypts every value.
   * A missing key never creates a replacement as a side effect of reading:
   * repeated failures must not quietly produce a vault encrypted by two keys.
   * Explicit recovery is the separate operation that can replace lost data.
   *
   * @throws {Error} when the key cannot open the vault that is there
   */
  unlock() {
    if (this.key) return;
    const { key, source } = resolveMasterKey({ create: !this.#vaultHoldsSecrets() });
    try {
      for (const value of secretValues(this.read().servers)) decryptValue(value, key);
    } catch {
      throw Object.assign(
        new Error(
          `The key cannot decrypt every secret in ${this.vaultPath}.\n`
          + 'The key is wrong or a stored secret is damaged. Nothing has been overwritten.\n\n'
          + 'If you have a recovery file: ssh-manager vault restore <file>\n'
          + 'If the servers are still in a .env: delete the vault and run ssh-manager vault import\n'
          + `Otherwise the secrets in it are unrecoverable — move ${this.vaultPath} aside and start again.`
        ),
        { code: 'VAULT_KEY_MISMATCH' }
      );
    }
    this.key = key;
    this.keySource = source;
  }

  /**
   * Read the raw vault file.
   * @returns {{ version: number, servers: Record<string, any> }}
   */
  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.vaultPath, 'utf8'));
      if (parsed.version !== VAULT_VERSION) {
        throw new Error(`Unsupported vault version ${parsed.version}`);
      }
      if (!parsed.servers || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)
        || Object.values(parsed.servers).some(server => !server || typeof server !== 'object' || Array.isArray(server))) {
        throw new Error('Invalid vault server data');
      }
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: VAULT_VERSION, servers: {} };
      throw error;
    }
  }

  /**
   * Write the vault, owner-readable only.
   * @param {{ version: number, servers: Record<string, any> }} data - Vault contents
   */
  write(data) {
    fs.mkdirSync(path.dirname(this.vaultPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.vaultPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.vaultPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  /** Serialise CLI/desktop writers without exposing partial JSON to readers.
   * @template T
   * @param {() => T} update
   * @returns {T}
   */
  #withWriteLock(update) {
    fs.mkdirSync(path.dirname(this.vaultPath), { recursive: true, mode: 0o700 });
    const lock = `${this.vaultPath}.lock`;
    let descriptor;
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // An interrupted writer may leave its lock. Reclaim only when the OS
      // confirms that recorded process is gone, never on an arbitrary timeout.
      try {
        const owner = Number(fs.readFileSync(lock, 'utf8'));
        if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Unknown lock owner');
        try { process.kill(owner, 0); } catch (probe) {
          if (probe.code !== 'ESRCH') throw probe;
          fs.rmSync(lock);
          descriptor = fs.openSync(lock, 'wx', 0o600);
        }
      } catch { /* Another writer owns it, or ownership cannot be proved. */ }
      if (descriptor === undefined) throw Object.assign(new Error('The vault is being updated. Try again.'), { code: 'VAULT_BUSY' });
    }
    try {
      fs.writeFileSync(descriptor, String(process.pid));
      return update();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lock, { force: true });
    }
  }

  /**
   * Add or replace a server. Secret fields are encrypted; everything else is
   * stored as-is so the file stays readable.
   *
   * @param {string} name - Server name (normalised to lowercase, as elsewhere)
   * @param {Record<string, any>} config - Server config in loader (camelCase) shape
   */
  setServer(name, config) {
    return this.#withWriteLock(() => {
      // A cached key must not permit an edit to conceal damage that happened
      // since unlocking. Backups and edits are all-or-nothing reads.
      this.getAllDecrypted();
      const data = this.read();
      // A metadata-only vault gives us no ciphertext against which to test a
      // cached key. Resolve it afresh before introducing a credential.
      if (secretValues(data.servers).length === 0) this.key = null;
      if (this.keySource === 'file' && this.key && !fs.existsSync(fallbackKeyPath())) {
        throw Object.assign(new Error('The vault key file is missing. Back up the unlocked vault before restoring it.'),
          { code: 'VAULT_KEY_MISMATCH' });
      }
      this.unlock();
      /** @type {Record<string, any>} */
      const stored = {};
      for (const [field, value] of Object.entries(config)) {
        if (value === undefined || value === null) continue;
        stored[field] = value;
      }
      Object.defineProperty(data.servers, name.toLowerCase(), { value: mapSecrets(stored,
        value => encryptValue(value, /** @type {Buffer} */ (this.key))), enumerable: true, configurable: true, writable: true });
      this.write(data);
    });
  }

  /**
   * Remove a server.
   * @param {string} name - Server name
   * @returns {boolean} True when a server was actually removed
   */
  removeServer(name) {
    return this.#withWriteLock(() => {
      const data = this.read();
      const key = name.toLowerCase();
      if (!(key in data.servers)) return false;
      delete data.servers[key];
      this.write(data);
      return true;
    });
  }

  /**
   * Server names held in the vault. Does not need the key — listing what exists
   * should not require unlocking anything.
   * @returns {string[]} Sorted names
   */
  listServers() {
    return Object.keys(this.read().servers).sort();
  }

  /**
   * All servers with their secrets decrypted, in the shape the loader expects.
   * @returns {Record<string, any>} Server configs keyed by lowercase name
   */
  getAllDecrypted() {
    const data = this.read();
    if (Object.keys(data.servers).length === 0) return {};
    const decrypt = () => Object.fromEntries(Object.entries(data.servers).map(([name, stored]) => [name,
      mapSecrets(stored, value => decryptValue(value, /** @type {Buffer} */ (this.key)))]));
    if (secretValues(data.servers).length === 0) return decrypt();
    const hadCachedKey = this.key !== null;
    this.unlock();
    try {
      return decrypt();
    } catch (error) {
      if (!hadCachedKey) throw error;
      // Another process can restore the same vault under a new key. Retry a
      // stale cached key once, without ever minting a replacement for lost data.
      this.key = null;
      this.unlock();
      return decrypt();
    }
  }

  /** Restore an already decrypted recovery file in one atomic replacement.
   * Unreadable existing data is replaced only after an explicit CLI confirmation.
   * @param {Record<string, any>} servers
   * @param {{ replaceUnreadable?: boolean, expectedRevision?: string }} [options]
   */
  restoreServers(servers, { replaceUnreadable = false, expectedRevision } = {}) {
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)
      || Object.values(servers).some(config => !config || typeof config !== 'object' || Array.isArray(config))) {
      throw new Error('Invalid recovery server data');
    }
    return this.#withWriteLock(() => {
      if (expectedRevision !== undefined) {
        let revision = 'missing';
        try { revision = crypto.createHash('sha256').update(fs.readFileSync(this.vaultPath)).digest('hex'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (expectedRevision !== revision) throw Object.assign(
          new Error('The vault changed. Preview the recovery file again before restoring.'), { code: 'VAULT_CHANGED' });
      }
      let existing = {};
      try { existing = this.getAllDecrypted(); } catch (error) {
        if (!replaceUnreadable) throw error;
      }
      const { key, source } = resolveMasterKey();
      const all = { ...existing, ...servers };
      const encrypted = Object.fromEntries(Object.entries(all).map(([name, config]) => [name.toLowerCase(),
        mapSecrets(config, value => encryptValue(value, key))]));
      this.write({ version: VAULT_VERSION, servers: encrypted });
      this.key = key;
      this.keySource = source;
    });
  }
}
