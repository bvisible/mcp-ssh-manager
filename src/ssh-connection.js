import SSHManager from './ssh-manager.js';
import { resolveServerName } from './server-aliases.js';

// Create a socket from a proxy command (e.g., "ncat --proxy 127.0.0.1:1080 --proxy-type socks5 %h %p")
// The command is executed through the system shell, matching OpenSSH ProxyCommand semantics,
// so quoted arguments and shell metacharacters work as users expect.
async function createProxyCommandSocket(proxyCommand, host, port) {
  const { spawn } = await import('child_process');
  const { Duplex } = await import('stream');

  const cmd = proxyCommand.replace(/%h/g, host).replace(/%p/g, port.toString());

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Cast: Node accepts a {readable, writable} pair here, but the bundled
    // types only model the stream/iterable overloads.
    const socket = Duplex.from(/** @type {any} */ ({
      readable: child.stdout,
      writable: child.stdin,
      allowHalfOpen: false
    }));

    // Forward proxy stderr to the MCP server's stderr for debugging
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[proxy-command] ${chunk}`);
    });

    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    socket.on('close', () => {
      if (!child.killed) child.kill();
    });

    child.on('error', (err) => settle(reject, err));
    child.on('spawn', () => settle(resolve, socket));
    child.on('exit', (code, signal) => {
      // Only surface unexpected exits — a kill() after a successful connection is normal.
      if (!settled && code !== 0) {
        settle(reject, new Error(`Proxy command exited with code ${code}${signal ? ` (${signal})` : ''}`));
      } else if (settled && code !== 0 && !signal && !socket.destroyed) {
        socket.destroy(new Error(`Proxy command exited with code ${code}`));
      }
    });
  });
}

/** Validate the complete chain before opening any network connection. */
function validateProxyChain(name, servers) {
  const seen = new Set();
  let current = name;
  while (current) {
    if (seen.has(current)) throw new Error(`Circular proxy jump detected: ${[...seen, current].join(' -> ')}`);
    seen.add(current);
    const config = servers[current];
    if (!config) throw new Error(`Proxy jump server "${current}" not found`);
    if (!config.proxyJump) break;
    const next = resolveServerName(config.proxyJump, servers);
    if (!next) throw new Error(`Proxy jump server "${config.proxyJump}" not found`);
    current = next;
  }
}

/**
 * Shared transport setup for the pooled MCP engine and standalone UI clients.
 * The caller owns ssh; resolveJump supplies either a pooled or an owned client.
 * @param {SSHManager} ssh
 * @param {Record<string, any>} servers
 * @param {{ readyTimeout?: number, resolveJump: (name: string) => Promise<SSHManager> }} options
 * @returns {Promise<string|null>} Canonical jump name, if one was used
 */
export async function connectSSH(ssh, servers, { readyTimeout, resolveJump }) {
  const config = ssh.config;
  const options = readyTimeout === undefined ? {} : { readyTimeout };
  if (config.proxyJump) {
    validateProxyChain(config.name, servers);
    const jumpName = resolveServerName(config.proxyJump, servers);
    const jump = await resolveJump(jumpName);
    const stream = await jump.forwardOut('127.0.0.1', 0, config.host, config.port || 22);
    try { await ssh.connect({ ...options, sock: stream }); }
    catch (error) { stream.destroy(); throw error; }
    ssh.jumpConnection = jump;
    return jumpName;
  }
  if (config.proxyCommand) {
    const socket = await createProxyCommandSocket(config.proxyCommand, config.host, config.port || 22);
    try { await ssh.connect({ ...options, sock: socket }); }
    catch (error) { socket.destroy(); throw error; }
  } else {
    await ssh.connect(options);
  }
  return null;
}

/**
 * Open an independent connection and own its entire jump chain. Disposing the
 * returned client releases every transport, including partial setup on error.
 * @param {string} name
 * @param {Record<string, any>} servers
 * @param {{ readyTimeout?: number }} [options]
 * @returns {Promise<SSHManager>}
 */
export async function connectServer(name, servers, options = {}) {
  const canonical = resolveServerName(name, servers);
  if (!canonical) throw new Error(`Server "${name}" not found`);
  validateProxyChain(canonical, servers);
  const ssh = new SSHManager({ ...servers[canonical], name: canonical });
  const owned = [];
  const dispose = ssh.dispose.bind(ssh);
  ssh.dispose = () => {
    try { dispose(); }
    finally { for (const jump of owned.splice(0)) jump.dispose(); }
  };
  try {
    await connectSSH(ssh, servers, { ...options, resolveJump: async jumpName => {
      const jump = await connectServer(jumpName, servers, options);
      owned.push(jump);
      return jump;
    } });
    return ssh;
  } catch (error) {
    ssh.dispose();
    throw error;
  }
}
