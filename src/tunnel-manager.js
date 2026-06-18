/**
 * SSH Tunnel Manager
 * Manages SSH port forwarding and SOCKS proxy tunnels
 */

import { v4 as uuidv4 } from 'uuid';
import net from 'net';
import { logger } from './logger.js';

// Map to store active tunnels
const tunnels = new Map();

// Tunnel types
const TUNNEL_TYPES = {
  LOCAL: 'local',        // Local port forwarding (access remote service locally)
  REMOTE: 'remote',      // Remote port forwarding (expose local service remotely)
  DYNAMIC: 'dynamic'     // SOCKS proxy
};

// Tunnel states
const TUNNEL_STATES = {
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
  CLOSED: 'closed'
};

class SSHTunnel {
  constructor(id, serverName, ssh, config) {
    this.id = id;
    this.serverName = serverName;
    this.ssh = ssh;
    this.type = config.type;
    this.config = config;
    this.state = TUNNEL_STATES.CONNECTING;
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.connections = new Set();
    this.server = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.stats = {
      bytesTransferred: 0,
      connectionsTotal: 0,
      connectionsActive: 0,
      errors: 0
    };
  }

  /**
   * Start the tunnel
   */
  async start() {
    try {
      switch (this.type) {
      case TUNNEL_TYPES.LOCAL:
        await this.startLocalForwarding();
        break;

      case TUNNEL_TYPES.REMOTE:
        await this.startRemoteForwarding();
        break;

      case TUNNEL_TYPES.DYNAMIC:
        await this.startDynamicForwarding();
        break;

      default:
        throw new Error(`Unknown tunnel type: ${this.type}`);
      }

      this.state = TUNNEL_STATES.ACTIVE;
      this.lastActivity = new Date();

      logger.info(`SSH tunnel ${this.id} started`, {
        type: this.type,
        server: this.serverName,
        local: `${this.config.localHost}:${this.config.localPort}`,
        remote: this.type !== TUNNEL_TYPES.DYNAMIC ?
          `${this.config.remoteHost}:${this.config.remotePort}` : 'SOCKS'
      });

    } catch (error) {
      this.state = TUNNEL_STATES.FAILED;
      logger.error(`Failed to start tunnel ${this.id}`, {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Start local port forwarding
   */
  async startLocalForwarding() {
    const { localHost, localPort, remoteHost, remotePort } = this.config;

    // Create local server
    this.server = net.createServer(async (localSocket) => {
      this.stats.connectionsTotal++;
      this.stats.connectionsActive++;
      this.connections.add(localSocket);
      this.lastActivity = new Date();

      logger.debug(`New connection to tunnel ${this.id}`, {
        from: localSocket.remoteAddress
      });

      try {
        // Forward to remote via SSH
        const stream = await this.ssh.forwardOut(
          localSocket.remoteAddress || '127.0.0.1',
          localSocket.remotePort || 0,
          remoteHost,
          remotePort
        );

        // Pipe data between local and remote
        localSocket.pipe(stream).pipe(localSocket);

        // Track data transfer
        localSocket.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });

        stream.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });

        // Handle disconnection
        const cleanup = () => {
          this.stats.connectionsActive--;
          this.connections.delete(localSocket);
          localSocket.destroy();
          stream.destroy();
        };

        localSocket.on('close', cleanup);
        localSocket.on('error', cleanup);
        stream.on('close', cleanup);
        stream.on('error', cleanup);

      } catch (error) {
        this.stats.errors++;
        logger.error('Tunnel forwarding error', {
          tunnel: this.id,
          error: error.message
        });
        localSocket.destroy();
      }
    });

    // Start listening
    await new Promise((resolve, reject) => {
      this.server.listen(localPort, localHost, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    logger.info('Local forwarding established', {
      local: `${localHost}:${localPort}`,
      remote: `${remoteHost}:${remotePort}`
    });
  }

  /**
   * Start remote port forwarding
   */
  async startRemoteForwarding() {
    const { localHost, localPort, remoteHost, remotePort } = this.config;

    // Request remote forwarding from SSH server
    await new Promise((resolve, reject) => {
      this.ssh.forwardIn(remoteHost, remotePort, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Handle incoming connections from remote
    this.ssh.on('tcp connection', (info, accept) => {
      if (info.destPort !== remotePort) return;

      this.stats.connectionsTotal++;
      this.stats.connectionsActive++;
      this.lastActivity = new Date();

      const remoteSocket = accept();

      // Connect to local service
      const localSocket = net.connect(localPort, localHost, () => {
        // Pipe data between remote and local
        remoteSocket.pipe(localSocket).pipe(remoteSocket);

        // Track data transfer
        remoteSocket.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });

        localSocket.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });
      });

      // Handle errors and cleanup
      const cleanup = () => {
        this.stats.connectionsActive--;
        remoteSocket.destroy();
        localSocket.destroy();
      };

      localSocket.on('error', (err) => {
        this.stats.errors++;
        logger.error('Remote forwarding error', {
          tunnel: this.id,
          error: err.message
        });
        cleanup();
      });

      remoteSocket.on('close', cleanup);
      localSocket.on('close', cleanup);
    });

    logger.info('Remote forwarding established', {
      local: `${localHost}:${localPort}`,
      remote: `${remoteHost}:${remotePort}`
    });
  }

  /**
   * Start dynamic port forwarding (SOCKS proxy)
   */
  async startDynamicForwarding() {
    const { localHost, localPort } = this.config;

    // Create SOCKS server
    this.server = net.createServer(async (localSocket) => {
      this.stats.connectionsTotal++;
      this.stats.connectionsActive++;
      this.connections.add(localSocket);
      this.lastActivity = new Date();

      let targetHost = null;
      let targetPort = null;
      let stream = null;

      // Simple SOCKS5 implementation (basic)
      localSocket.once('data', async (chunk) => {
        // Parse SOCKS request (simplified)
        if (chunk[0] === 0x05) { // SOCKS5
          // Send auth method response
          localSocket.write(Buffer.from([0x05, 0x00]));

          localSocket.once('data', async (chunk2) => {
            // Parse connection request
            if (chunk2[0] === 0x05 && chunk2[1] === 0x01) { // CONNECT
              const addrType = chunk2[3];
              let offset = 4;

              if (addrType === 0x01) { // IPv4
                targetHost = `${chunk2[4]}.${chunk2[5]}.${chunk2[6]}.${chunk2[7]}`;
                offset = 8;
              } else if (addrType === 0x03) { // Domain
                const domainLen = chunk2[4];
                targetHost = chunk2.slice(5, 5 + domainLen).toString();
                offset = 5 + domainLen;
              }

              targetPort = (chunk2[offset] << 8) | chunk2[offset + 1];

              try {
                // Create SSH forwarding stream
                stream = await this.ssh.forwardOut(
                  '127.0.0.1', 0,
                  targetHost, targetPort
                );

                // Send success response
                const response = Buffer.from([
                  0x05, 0x00, 0x00, 0x01,
                  0, 0, 0, 0,  // Bind address (0.0.0.0)
                  0, 0         // Bind port
                ]);
                localSocket.write(response);

                // Pipe data
                localSocket.pipe(stream).pipe(localSocket);

                // Track data
                localSocket.on('data', (chunk) => {
                  this.stats.bytesTransferred += chunk.length;
                  this.lastActivity = new Date();
                });

                stream.on('data', (chunk) => {
                  this.stats.bytesTransferred += chunk.length;
                  this.lastActivity = new Date();
                });

              } catch (error) {
                // Send error response
                const response = Buffer.from([
                  0x05, 0x01, 0x00, 0x01,
                  0, 0, 0, 0, 0, 0
                ]);
                localSocket.write(response);
                localSocket.destroy();
                this.stats.errors++;
              }
            }
          });
        } else {
          // Not SOCKS5, close connection
          localSocket.destroy();
        }
      });

      // Cleanup on disconnect
      localSocket.on('close', () => {
        this.stats.connectionsActive--;
        this.connections.delete(localSocket);
        if (stream) stream.destroy();
      });

      localSocket.on('error', () => {
        this.stats.errors++;
        this.stats.connectionsActive--;
        this.connections.delete(localSocket);
        if (stream) stream.destroy();
      });
    });

    // Start listening
    await new Promise((resolve, reject) => {
      this.server.listen(localPort, localHost, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    logger.info('SOCKS proxy established', {
      local: `${localHost}:${localPort}`
    });
  }

  /**
   * Get tunnel information
   */
  getInfo() {
    return {
      id: this.id,
      server: this.serverName,
      type: this.type,
      state: this.state,
      config: {
        localHost: this.config.localHost,
        localPort: this.config.localPort,
        remoteHost: this.config.remoteHost,
        remotePort: this.config.remotePort
      },
      stats: this.stats,
      created: this.createdAt,
      lastActivity: this.lastActivity,
      activeConnections: this.connections.size
    };
  }

  /**
   * Close the tunnel
   */
  close() {
    logger.info(`Closing tunnel ${this.id}`);

    this.state = TUNNEL_STATES.CLOSED;

    // Close all active connections
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Cancel remote forwarding if needed
    if (this.type === TUNNEL_TYPES.REMOTE) {
      this.ssh.unforwardIn(this.config.remoteHost, this.config.remotePort);
    }

    tunnels.delete(this.id);
  }

  /**
   * Reconnect tunnel
   */
  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Max reconnect attempts reached for tunnel ${this.id}`);
      this.state = TUNNEL_STATES.FAILED;
      return false;
    }

    this.reconnectAttempts++;
    this.state = TUNNEL_STATES.RECONNECTING;

    logger.info(`Reconnecting tunnel ${this.id}`, {
      attempt: this.reconnectAttempts
    });

    try {
      await this.start();
      this.reconnectAttempts = 0;
      return true;
    } catch (error) {
      logger.error(`Reconnect failed for tunnel ${this.id}`, {
        error: error.message
      });

      // Retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      setTimeout(() => this.reconnect(), delay);

      return false;
    }
  }
}

/**
 * Create a new SSH tunnel
 */
export async function createTunnel(serverName, ssh, config) {
  const tunnelId = `tunnel_${Date.now()}_${uuidv4().substring(0, 8)}`;

  // Validate config
  if (!config.type || !Object.values(TUNNEL_TYPES).includes(config.type)) {
    throw new Error(`Invalid tunnel type: ${config.type}`);
  }

  // Set defaults
  config.localHost = config.localHost || '127.0.0.1';

  if (config.type !== TUNNEL_TYPES.DYNAMIC) {
    if (!config.remoteHost || !config.remotePort) {
      throw new Error('Remote host and port required for port forwarding');
    }
  }

  if (!config.localPort) {
    throw new Error('Local port required');
  }

  const tunnel = new SSHTunnel(tunnelId, serverName, ssh, config);
  tunnels.set(tunnelId, tunnel);

  try {
    await tunnel.start();

    logger.info('SSH tunnel created', {
      id: tunnelId,
      type: config.type,
      server: serverName
    });

    return tunnel;
  } catch (error) {
    tunnels.delete(tunnelId);
    throw error;
  }
}

/**
 * List all active tunnels
 */
export function listTunnels(serverName = null) {
  const activeTunnels = [];

  for (const [, tunnel] of tunnels.entries()) {
    if (tunnel.state !== TUNNEL_STATES.CLOSED) {
      if (!serverName || tunnel.serverName === serverName) {
        activeTunnels.push(tunnel.getInfo());
      }
    }
  }

  return activeTunnels;
}

/**
 * Close a tunnel
 */
export function closeTunnel(tunnelId) {
  const tunnel = tunnels.get(tunnelId);

  if (!tunnel) {
    throw new Error(`Tunnel ${tunnelId} not found`);
  }

  tunnel.close();
  return true;
}

/**
 * Close all tunnels for a server
 */
export function closeServerTunnels(serverName) {
  let closedCount = 0;

  for (const [, tunnel] of tunnels.entries()) {
    if (tunnel.serverName === serverName) {
      tunnel.close();
      closedCount++;
    }
  }

  return closedCount;
}

/**
 * Monitor tunnel health
 */
function monitorTunnels() {
  const now = Date.now();
  const healthTimeout = 60 * 1000; // 1 minute

  for (const [id, tunnel] of tunnels.entries()) {
    if (tunnel.state === TUNNEL_STATES.ACTIVE) {
      const idle = now - tunnel.lastActivity.getTime();

      // Check if tunnel is still healthy
      if (idle > healthTimeout && tunnel.connections.size === 0) {
        logger.debug(`Tunnel ${id} idle for ${idle}ms`);
      }

      // Auto-reconnect failed tunnels
      if (tunnel.state === TUNNEL_STATES.FAILED) {
        tunnel.reconnect();
      }
    }
  }
}

// Monitor tunnels periodically.
// unref() so this interval never keeps the process alive on its own: as part of
// a stdio MCP server we must exit when the transport closes, not stay pinned by
// a background timer.
const tunnelMonitor = setInterval(monitorTunnels, 30 * 1000); // Every 30 seconds
if (typeof tunnelMonitor.unref === 'function') tunnelMonitor.unref();
