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
 * @returns {{ key: Buffer, source: 'keychain'|'file', minted: boolean }}
 */
export function resolveMasterKey() {
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

  // First use: mint a key and try to put it somewhere safe.
  const key = crypto.randomBytes(KEY_BYTES);
  if (!forceFile && writeKeyToKeychain(key)) {
    return { key, source: 'keychain', minted: true };
  }

  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
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
      return Object.values(raw.servers || {}).some(server =>
        SECRET_FIELDS.some(field => typeof (/** @type {any} */ (server))[field] === 'string'
          && (/** @type {any} */ (server))[field].startsWith('v1:')));
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
      raw = JSON.parse(fs.readFileSync(this.vaultPath, 'utf8'));
    } catch (error) {
      return { ok: false, reason: `The vault file is unreadable: ${error.message}`, checked: 0 };
    }

    /** @type {string[]} */
    const encrypted = [];
    for (const server of Object.values(raw.servers || {})) {
      for (const field of SECRET_FIELDS) {
        const value = (/** @type {any} */ (server))[field];
        if (typeof value === 'string' && value.startsWith('v1:')) encrypted.push(value);
      }
    }
    if (encrypted.length === 0) return { ok: true, checked: 0 };

    try {
      this.unlock();
    } catch (error) {
      return { ok: false, reason: error.message, checked: 0 };
    }

    // One value is enough: they share a key, so either all of them open or
    // none do.
    try {
      decryptValue(encrypted[0], /** @type {Buffer} */ (this.key));
      return { ok: true, checked: encrypted.length };
    } catch {
      return {
        ok: false,
        checked: encrypted.length,
        reason: `The key on this machine does not decrypt ${this.vaultPath}.\n`
          + 'Restore from a recovery file (ssh-manager vault restore <file>), '
          + 're-import from a .env, or move the vault aside and start again.',
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
   * Refuses one specific pairing: a key that was just minted against a vault
   * that already holds encrypted values. That combination has exactly one
   * cause — the real key is gone (a new machine, a wiped keychain, a deleted
   * key file) — and exactly one honest response, which is to say so. Carrying
   * on would re-encrypt new secrets under the new key while the old ones stay
   * unreadable, and nothing would look wrong until a connection failed.
   *
   * @throws {Error} when the key cannot open the vault that is there
   */
  unlock() {
    if (this.key) return;
    const { key, source, minted } = resolveMasterKey();
    if (minted && this.#vaultHoldsSecrets()) {
      throw Object.assign(
        new Error(
          `The vault at ${this.vaultPath} is encrypted with a key this machine no longer has.\n`
          + 'A new key was generated, which cannot read it. Nothing has been overwritten.\n\n'
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
    fs.writeFileSync(this.vaultPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Add or replace a server. Secret fields are encrypted; everything else is
   * stored as-is so the file stays readable.
   *
   * @param {string} name - Server name (normalised to lowercase, as elsewhere)
   * @param {Record<string, any>} config - Server config in loader (camelCase) shape
   */
  setServer(name, config) {
    this.unlock();
    const data = this.read();
    /** @type {Record<string, any>} */
    const stored = {};
    for (const [field, value] of Object.entries(config)) {
      if (value === undefined || value === null) continue;
      stored[field] = SECRET_FIELDS.includes(field)
        ? encryptValue(value, /** @type {Buffer} */ (this.key))
        : value;
    }
    data.servers[name.toLowerCase()] = stored;
    this.write(data);
  }

  /**
   * Remove a server.
   * @param {string} name - Server name
   * @returns {boolean} True when a server was actually removed
   */
  removeServer(name) {
    const data = this.read();
    const key = name.toLowerCase();
    if (!(key in data.servers)) return false;
    delete data.servers[key];
    this.write(data);
    return true;
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
    this.unlock();

    /** @type {Record<string, any>} */
    const out = {};
    for (const [name, stored] of Object.entries(data.servers)) {
      /** @type {Record<string, any>} */
      const config = {};
      for (const [field, value] of Object.entries(stored)) {
        if (SECRET_FIELDS.includes(field)) {
          try {
            config[field] = decryptValue(value, /** @type {Buffer} */ (this.key));
          } catch (error) {
            // One unreadable secret must not take the whole vault down: report
            // it and leave the field unset, so the other servers still work.
            logger.error(`Cannot decrypt ${field} for server "${name}"`, { error: error.message });
          }
        } else {
          config[field] = value;
        }
      }
      out[name] = config;
    }
    return out;
  }
}
