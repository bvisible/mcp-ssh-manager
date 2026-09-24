import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logger } from './logger.js';

// The standard OpenSSH file remains the default. The override also lets tests
// and headless deployments isolate trust without touching a user's key files.
function knownHostsPath() {
  return process.env.SSH_MANAGER_KNOWN_HOSTS || path.join(os.homedir(), '.ssh', 'known_hosts');
}

/** Parse ordinary, hashed and marker-prefixed OpenSSH known_hosts entries. */
function parseKnownHostEntry(line) {
  const parts = line.trim().split(/\s+/);
  if (!parts[0] || parts[0].startsWith('#')) return null;
  const marker = parts[0].startsWith('@') ? parts.shift() : null;
  if (parts.length < 3) return null;
  return { host: parts[0], keyType: parts[1], key: parts[2], marker,
    comment: parts.slice(3).join(' ') || '' };
}

function hostEntryName(host, port) {
  return Number(port) === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
}

function matchesHostPattern(pattern, host) {
  if (pattern.startsWith('|1|')) {
    const [, version, salt, expected] = pattern.split('|');
    if (version !== '1' || !salt || !expected) return false;
    const actual = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest();
    const hash = Buffer.from(expected, 'base64');
    return actual.length === hash.length && crypto.timingSafeEqual(actual, hash);
  }
  const expression = pattern.toLowerCase().split('').map(char =>
    char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${expression}$`).test(host);
}

function matchesHost(entry, host) {
  let matched = false;
  for (const pattern of entry.host.split(',')) {
    if (pattern.startsWith('!')) {
      if (matchesHostPattern(pattern.slice(1), host)) return false;
    } else if (matchesHostPattern(pattern, host)) matched = true;
  }
  return matched;
}

function matchingEntries(host, port) {
  let content;
  try { content = fs.readFileSync(knownHostsPath(), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const name = hostEntryName(host, port);
  return content.split('\n').map(parseKnownHostEntry).filter(entry => entry && matchesHost(entry, name));
}

/** Prefer a stored key's algorithm so a multi-key server presents a trusted key. */
export function trustedHostKeyAlgorithms(host, port = 22) {
  return [...new Set(matchingEntries(host, port)
    .filter(entry => !entry.marker)
    .flatMap(entry => entry.keyType === 'ssh-rsa'
      ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [entry.keyType]))];
}

/**
 * Verify the actual handshake key. An unknown host is trusted on first use and
 * that exact key is pinned synchronously before authentication can proceed.
 * Existing entries, including hashed hostnames and revocations, fail closed.
 */
export function verifyHostKey(host, port, key) {
  if (!Buffer.isBuffer(key) || key.length < 4) throw new Error('Invalid SSH host key');
  const size = key.readUInt32BE(0);
  if (size < 1 || size > key.length - 4) throw new Error('Invalid SSH host key');
  const keyType = key.subarray(4, 4 + size).toString('ascii');
  if (!/^[a-zA-Z0-9@._+-]+$/.test(keyType)) throw new Error('Invalid SSH host key type');
  const encoded = key.toString('base64');
  const entries = matchingEntries(host, port);
  if (entries.some(entry => entry.marker === '@revoked' && entry.key === encoded)) {
    throw new Error(`SSH host key is revoked for ${host}:${port}`);
  }
  if (entries.some(entry => !entry.marker && entry.key === encoded)) return true;
  if (entries.length) {
    throw new Error(`SSH host key changed or is not trusted for ${host}:${port}; verify the server identity before updating known_hosts`);
  }
  const name = hostEntryName(host, port);
  if (/[\s,|!]/.test(name)) throw new Error('Invalid SSH hostname');
  const file = knownHostsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefix = '';
  try {
    const existing = fs.readFileSync(file, 'utf8');
    if (existing && !existing.endsWith('\n')) prefix = '\n';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.appendFileSync(file, `${prefix}${name} ${keyType} ${encoded}\n`, { mode: 0o600 });
  logger.info('SSH host key trusted on first use', { host, port });
  return true;
}

/**
 * Get the SSH host key fingerprint for a server
 */
export async function getHostKeyFingerprint(host, port = 22) {
  return new Promise((resolve, reject) => {
    const cmd = spawn('ssh-keyscan', ['-p', port.toString(), '-t', 'ed25519,rsa,ecdsa', host]);
    let stdout = '';
    let stderr = '';

    cmd.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    cmd.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    cmd.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to get host key: ${stderr}`));
        return;
      }

      const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('#'));
      const fingerprints = [];

      for (const line of lines) {
        const entry = parseKnownHostEntry(line);
        if (entry) {
          // Calculate SHA256 fingerprint
          const keyData = Buffer.from(entry.key, 'base64');
          const hash = crypto.createHash('sha256').update(keyData).digest('base64');

          fingerprints.push({
            host: entry.host,
            type: entry.keyType,
            fingerprint: `SHA256:${hash}`,
            fullKey: line
          });
        }
      }

      resolve(fingerprints);
    });
  });
}

/**
 * Check if a host key exists in known_hosts
 */
export function isHostKnown(host, port = 22) {
  return matchingEntries(host, port).length > 0;
}

/** Get matching trusted fingerprints without contacting the server. */
export function getCurrentHostKey(host, port = 22) {
  const keys = matchingEntries(host, port).map(entry => ({
    host: entry.host, type: entry.keyType,
    fingerprint: `SHA256:${crypto.createHash('sha256').update(Buffer.from(entry.key, 'base64')).digest('base64')}`,
    fullKey: `${entry.marker ? `${entry.marker} ` : ''}${entry.host} ${entry.keyType} ${entry.key}`,
  }));
  return keys.length ? keys : null;
}

/**
 * Remove a host from known_hosts
 */
export function removeHostKey(host, port = 22) {
  const hostEntry = port === 22 ? host : `[${host}]:${port}`;

  // Was it there to begin with? ssh-keygen -R succeeds either way, so without
  // this the function would report success for a host it never touched — and a
  // control plane would tell an operator it forgot a key that is still there.
  // Return before touching ssh-keygen when there is nothing to remove: the
  // command fails outright where no known_hosts file exists at all (a fresh CI
  // runner, a container), and reporting that as an error would be wrong — there
  // was simply no key.
  if (!isHostKnown(host, port)) {
    logger.info('No host key to remove', { host, port });
    return false;
  }

  try {
    // execFileSync, not execSync: arguments are passed to the process directly
    // instead of through a shell. `host` comes from a server config, which an
    // operator (or the control plane's own form) can set to anything, so a
    // value containing a quote or $(...) used to be a command injection here —
    // the same class of bug fixed across the database and backup builders.
    execFileSync('ssh-keygen', ['-R', hostEntry, '-f', knownHostsPath()], { stdio: 'ignore' });
  } catch (error) {
    logger.error('Failed to remove host key', { host, port, error: error.message });
    throw new Error(`Failed to remove host key: ${error.message}`);
  }

  logger.info('Host key removed', { host, port });
  return true;
}

/**
 * Add a host key to known_hosts
 */
export async function addHostKey(host, port = 22, keyData = null) {
  try {
    // Backup current known_hosts. Copy first and treat "not there" as nothing
    // to back up, rather than checking then copying: between the two calls the
    // file can be replaced, and the check adds a race without preventing the
    // failure it appears to guard against.
    try {
      fs.copyFileSync(knownHostsPath(), `${knownHostsPath()}.mcp-backup`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // If no key data provided, fetch it
    if (!keyData) {
      const fingerprints = await getHostKeyFingerprint(host, port);
      if (fingerprints.length === 0) {
        throw new Error('No host keys found');
      }
      keyData = fingerprints.map(fp => fp.fullKey).join('\n');
    }

    // Ensure .ssh directory exists. No existsSync guard: mkdirSync with
    // recursive:true is already a no-op on an existing directory, and checking
    // first only opens a window where the directory can change underneath us.
    const sshDir = path.dirname(knownHostsPath());
    fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });

    // Append to known_hosts
    fs.appendFileSync(knownHostsPath(), keyData + '\n', { mode: 0o600 });

    logger.info('Host key added', { host, port });
    return true;
  } catch (error) {
    logger.error('Failed to add host key', { host, port, error: error.message });
    throw new Error(`Failed to add host key: ${error.message}`);
  }
}

/**
 * Update a host key (remove old, add new)
 */
export async function updateHostKey(host, port = 22) {
  try {
    // Remove old key
    removeHostKey(host, port);

    // Add new key
    await addHostKey(host, port);

    logger.info('Host key updated', { host, port });
    return true;
  } catch (error) {
    logger.error('Failed to update host key', { host, port, error: error.message });
    throw new Error(`Failed to update host key: ${error.message}`);
  }
}

/**
 * Verify if host key has changed
 */
export async function hasHostKeyChanged(host, port = 22) {
  try {
    const currentKeys = getCurrentHostKey(host, port);
    if (!currentKeys || currentKeys.length === 0) {
      // No key in known_hosts
      return { changed: false, reason: 'not_in_known_hosts' };
    }

    const newKeys = await getHostKeyFingerprint(host, port);
    if (!newKeys || newKeys.length === 0) {
      return { changed: false, reason: 'cannot_fetch_key' };
    }

    // Check if any current key matches any new key
    for (const currentKey of currentKeys) {
      for (const newKey of newKeys) {
        if (currentKey.fingerprint === newKey.fingerprint) {
          return { changed: false, reason: 'key_matches' };
        }
      }
    }

    // Keys don't match
    return {
      changed: true,
      reason: 'key_mismatch',
      currentFingerprints: currentKeys.map(k => k.fingerprint),
      newFingerprints: newKeys.map(k => k.fingerprint)
    };
  } catch (error) {
    logger.error('Failed to verify host key', { host, port, error: error.message });
    return { changed: false, reason: 'verification_error', error: error.message };
  }
}

/**
 * List all known hosts
 */
export function listKnownHosts() {
  if (!fs.existsSync(knownHostsPath())) {
    return [];
  }

  const content = fs.readFileSync(knownHostsPath(), 'utf8');
  const lines = content.split('\n');
  const hosts = new Map();

  for (const line of lines) {
    if (line && !line.startsWith('#')) {
      const entry = parseKnownHostEntry(line);
      if (entry) {
        // Extract host and port
        let host = entry.host;
        let port = 22;

        if (host.startsWith('[')) {
          const match = host.match(/\[([^\]]+)\]:(\d+)/);
          if (match) {
            host = match[1];
            port = parseInt(match[2]);
          }
        }

        const keyData = Buffer.from(entry.key, 'base64');
        const hash = crypto.createHash('sha256').update(keyData).digest('base64');

        const hostKey = `${host}:${port}`;
        if (!hosts.has(hostKey)) {
          hosts.set(hostKey, {
            host,
            port,
            keys: []
          });
        }

        hosts.get(hostKey).keys.push({
          type: entry.keyType,
          fingerprint: `SHA256:${hash}`
        });
      }
    }
  }

  return Array.from(hosts.values());
}

/**
 * Detect SSH key error in command output
 */
export function detectSSHKeyError(stderr) {
  const keyErrorPatterns = [
    'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED',
    'Host key verification failed',
    'The authenticity of host',
    'ECDSA host key for .* has changed',
    'RSA host key for .* has changed',
    'ED25519 host key for .* has changed',
    'Offending key in',
    'Add correct host key in'
  ];

  for (const pattern of keyErrorPatterns) {
    if (stderr.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract host info from SSH error
 */
export function extractHostFromSSHError(stderr) {
  // Try to extract host and port from error message
  const patterns = [
    /Offending (?:RSA|ECDSA|ED25519) key in .+:(\d+)/i,
    /Host key for \[([^\]]+)\]:(\d+) has changed/i,
    /Host key for ([^\s]+) has changed/i,
    /The authenticity of host '\[([^\]]+)\]:(\d+)'/i,
    /The authenticity of host '([^\s]+) \(/i
  ];

  for (const pattern of patterns) {
    const match = stderr.match(pattern);
    if (match) {
      if (match[2]) {
        // Host and port
        return { host: match[1], port: parseInt(match[2]) };
      } else {
        // Just host
        return { host: match[1], port: 22 };
      }
    }
  }

  return null;
}
