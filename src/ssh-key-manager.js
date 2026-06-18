import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logger } from './logger.js';

// Path to known_hosts file
const KNOWN_HOSTS_PATH = path.join(os.homedir(), '.ssh', 'known_hosts');
const KNOWN_HOSTS_BACKUP = path.join(os.homedir(), '.ssh', 'known_hosts.mcp-backup');

/**
 * Parse a known_hosts entry
 */
function parseKnownHostEntry(line) {
  if (!line || line.startsWith('#')) return null;

  const parts = line.split(' ');
  if (parts.length < 3) return null;

  return {
    host: parts[0],
    keyType: parts[1],
    key: parts[2],
    comment: parts.slice(3).join(' ') || ''
  };
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
  if (!fs.existsSync(KNOWN_HOSTS_PATH)) {
    return false;
  }

  const content = fs.readFileSync(KNOWN_HOSTS_PATH, 'utf8');
  const lines = content.split('\n');

  // Format host entry as SSH does
  const hostEntry = port === 22 ? host : `[${host}]:${port}`;

  for (const line of lines) {
    if (line.includes(hostEntry)) {
      return true;
    }
  }

  return false;
}

/**
 * Get current host key from known_hosts
 */
export function getCurrentHostKey(host, port = 22) {
  if (!fs.existsSync(KNOWN_HOSTS_PATH)) {
    return null;
  }

  const content = fs.readFileSync(KNOWN_HOSTS_PATH, 'utf8');
  const lines = content.split('\n');

  // Format host entry as SSH does
  const hostEntry = port === 22 ? host : `[${host}]:${port}`;
  const keys = [];

  for (const line of lines) {
    if (line.includes(hostEntry)) {
      const entry = parseKnownHostEntry(line);
      if (entry) {
        const keyData = Buffer.from(entry.key, 'base64');
        const hash = crypto.createHash('sha256').update(keyData).digest('base64');

        keys.push({
          host: entry.host,
          type: entry.keyType,
          fingerprint: `SHA256:${hash}`,
          fullKey: line
        });
      }
    }
  }

  return keys.length > 0 ? keys : null;
}

/**
 * Remove a host from known_hosts
 */
export function removeHostKey(host, port = 22) {
  try {
    const hostEntry = port === 22 ? host : `[${host}]:${port}`;

    // Use ssh-keygen to remove the host
    execSync(`ssh-keygen -R "${hostEntry}"`, { stdio: 'ignore' });

    logger.info('Host key removed', { host, port });
    return true;
  } catch (error) {
    logger.error('Failed to remove host key', { host, port, error: error.message });
    throw new Error(`Failed to remove host key: ${error.message}`);
  }
}

/**
 * Add a host key to known_hosts
 */
export async function addHostKey(host, port = 22, keyData = null) {
  try {
    // Backup current known_hosts
    if (fs.existsSync(KNOWN_HOSTS_PATH)) {
      fs.copyFileSync(KNOWN_HOSTS_PATH, KNOWN_HOSTS_BACKUP);
    }

    // If no key data provided, fetch it
    if (!keyData) {
      const fingerprints = await getHostKeyFingerprint(host, port);
      if (fingerprints.length === 0) {
        throw new Error('No host keys found');
      }
      keyData = fingerprints.map(fp => fp.fullKey).join('\n');
    }

    // Ensure .ssh directory exists
    const sshDir = path.dirname(KNOWN_HOSTS_PATH);
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
    }

    // Append to known_hosts
    fs.appendFileSync(KNOWN_HOSTS_PATH, keyData + '\n');

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
  if (!fs.existsSync(KNOWN_HOSTS_PATH)) {
    return [];
  }

  const content = fs.readFileSync(KNOWN_HOSTS_PATH, 'utf8');
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
