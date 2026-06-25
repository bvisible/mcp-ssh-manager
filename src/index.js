#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import SSHManager from './ssh-manager.js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { ServerConfigManager } from './server-config-manager.js';
import {
  getTempFilename,
  buildDeploymentStrategy,
  detectDeploymentNeeds
} from './deploy-helper.js';
import {
  resolveServerName,
  addAlias,
  removeAlias,
  listAliases
} from './server-aliases.js';
import {
  expandCommandAlias,
  addCommandAlias,
  removeCommandAlias,
  listCommandAliases,
  suggestAliases
} from './command-aliases.js';
import {
  TIMEOUTS,
  truncateOutput,
  formatJSONResponse
} from './config.js';
import {
  initializeHooks,
  executeHook,
  toggleHook,
  listHooks
} from './hooks-system.js';
import {
  loadProfile,
  listProfiles,
  setActiveProfile,
  getActiveProfileName
} from './profile-loader.js';
import { logger } from './logger.js';
import { parseRsyncStats } from './rsync-stats.js';
import {
  createSession,
  getSession,
  listSessions,
  closeSession
} from './session-manager.js';
import {
  createGroup,
  updateGroup,
  deleteGroup,
  addServersToGroup,
  removeServersFromGroup,
  listGroups,
  executeOnGroup
} from './server-groups.js';
import {
  createTunnel,
  listTunnels,
  closeTunnel,
  closeServerTunnels
} from './tunnel-manager.js';
import {
  getHostKeyFingerprint,
  isHostKnown,
  getCurrentHostKey,
  removeHostKey,
  addHostKey,
  updateHostKey,
  hasHostKeyChanged,
  listKnownHosts,
  detectSSHKeyError,
  extractHostFromSSHError
} from './ssh-key-manager.js';
import {
  BACKUP_TYPES,
  DEFAULT_BACKUP_DIR,
  generateBackupId,
  getBackupMetadataPath,
  getBackupFilePath,
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
  buildFilesBackupCommand,
  buildRestoreCommand,
  createBackupMetadata,
  buildSaveMetadataCommand,
  buildListBackupsCommand,
  parseBackupsList,
  buildCleanupCommand,
  buildCronScheduleCommand
} from './backup-manager.js';
import {
  HEALTH_STATUS,
  buildServiceStatusCommand,
  parseServiceStatus,
  buildProcessListCommand,
  parseProcessList,
  buildKillProcessCommand,
  buildProcessInfoCommand,
  createAlertConfig,
  buildSaveAlertConfigCommand,
  buildLoadAlertConfigCommand,
  checkAlertThresholds,
  buildComprehensiveHealthCheckCommand,
  parseComprehensiveHealthCheck,
  resolveServiceName
} from './health-monitor.js';
import {
  DB_TYPES,
  buildMySQLDumpCommand as buildDBMySQLDumpCommand,
  buildPostgreSQLDumpCommand as buildDBPostgreSQLDumpCommand,
  buildMongoDBDumpCommand as buildDBMongoDBDumpCommand,
  buildMySQLImportCommand,
  buildPostgreSQLImportCommand,
  buildMongoDBRestoreCommand,
  buildMySQLListDatabasesCommand,
  buildMySQLListTablesCommand,
  buildPostgreSQLListDatabasesCommand,
  buildPostgreSQLListTablesCommand,
  buildMongoDBListDatabasesCommand,
  buildMongoDBListCollectionsCommand,
  buildMySQLQueryCommand,
  buildPostgreSQLQueryCommand,
  buildMongoDBQueryCommand,
  isSafeQuery,
  countQueryRows,
  parseDatabaseList,
  parseTableList,
  parseSize,
  formatBytes
} from './database-manager.js';
import { loadToolConfig, isToolEnabled } from './tool-config-manager.js';
import { evaluatePolicy } from './policy.js';
import { auditLog } from './audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve .env file path with fallback chain:
// 1. SSH_ENV_PATH env var (explicit override)
// 2. ~/.ssh-manager/.env (user config dir — where ssh-manager CLI writes)
// 3. process.cwd()/.env (standard working directory)
// 4. ~/.env (home directory)
// 5. __dirname/../.env (backward compat for local installs)
function resolveEnvFilePath() {
  if (process.env.SSH_ENV_PATH) {
    return process.env.SSH_ENV_PATH;
  }
  const sshManagerHome = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
  const candidates = [
    path.join(sshManagerHome, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(process.cwd(), '.env');
}

const envFilePath = resolveEnvFilePath();
const envFile = dotenv.config({ path: envFilePath, processEnv: {} });
const envFileValues = envFile.parsed || {};

function getRuntimeEnv(name) {
  return process.env[name] ?? envFileValues[name];
}

// Initialize logger
logger.info('MCP SSH Manager starting', {
  logLevel: getRuntimeEnv('SSH_LOG_LEVEL') || 'INFO',
  verbose: getRuntimeEnv('SSH_VERBOSE') === 'true',
  envFilePath
});

// Load SSH server configuration
const serverConfigManager = new ServerConfigManager({
  envPath: envFilePath,
  tomlPath: getRuntimeEnv('SSH_CONFIG_PATH'),
  preferToml: getRuntimeEnv('PREFER_TOML_CONFIG') === 'true'
});

try {
  const loadedServers = await serverConfigManager.loadInitial();
  logger.info(`Loaded ${Object.keys(loadedServers).length} SSH server configurations`);
} catch (error) {
  logger.error('Failed to load server configuration', { error: error.message });
}

// Initialize hooks system
try {
  await initializeHooks();
} catch (error) {
  logger.error('Failed to initialize hooks', { error: error.message });
}

// Load tool configuration
let toolConfig = null;
try {
  toolConfig = await loadToolConfig();
  const summary = toolConfig.getSummary();
  logger.info(`Tool configuration loaded: ${summary.mode} mode, ${summary.enabledCount}/${summary.totalTools} tools enabled`);
  if (summary.mode === 'all') {
    logger.info('💡 Tip: Run "ssh-manager tools configure" to reduce context usage in Claude Code');
  }
} catch (error) {
  logger.error('Failed to load tool configuration', { error: error.message });
  logger.info('Using default configuration (all tools enabled)');
}

// Map to store active connections
const connections = new Map();

// Map to store connection timestamps for timeout management
const connectionTimestamps = new Map();

// Connection timeout in milliseconds (30 minutes)
const CONNECTION_TIMEOUT = 30 * 60 * 1000;

// Keepalive interval in milliseconds (5 minutes)
const KEEPALIVE_INTERVAL = 5 * 60 * 1000;

// Map to store keepalive intervals
const keepaliveIntervals = new Map();

// Extra grace window so the remote `timeout` wrapper can exit cleanly
// and return its timeout exit code before the local SSH exec timeout fires.
const WRAPPED_COMMAND_TIMEOUT_GRACE_MS = 5000;

// Map to track proxy jump dependencies (target -> jump server)
const jumpDependencies = new Map();

// Load server configuration (backward compatibility wrapper)
async function loadServerConfig() {
  // This function is kept for backward compatibility
  return serverConfigManager.getServers();
}

// ── Per-server security policy plumbing (v3.5.0+) ──────────────────────────────
//
// Wire any handler that mutates remote state (or executes arbitrary commands)
// through the helpers below. They are *always* safe to call: for any server
// without a security mode configured (default `unrestricted`), evaluatePolicy()
// early-returns { allowed: true } and auditLog() is a no-op when AUDIT_LOG is
// absent — so pre-v3.5.0 configs see zero behavior change.

async function getServerConfig(serverName) {
  if (!serverName) return null;
  const servers = await loadServerConfig();
  return servers[String(serverName).toLowerCase()] || null;
}

// Apply policy + audit a denial in one shot. Returns null when allowed; returns
// an MCP error response object when denied (handler should `return` it directly).
async function applyServerPolicy(serverName, toolName, args, command) {
  const serverConfig = await getServerConfig(serverName);
  const policy = evaluatePolicy(serverConfig, toolName, command);
  if (!policy.allowed) {
    auditLog(serverConfig, toolName, args, policy);
    return {
      content: [
        {
          type: 'text',
          text: formatJSONResponse({
            server: serverName,
            tool: toolName,
            success: false,
            error: `Policy denied: ${policy.reason}`,
            code: -2,
          }),
        },
      ],
      isError: true,
    };
  }
  return null;
}

// Convenience for the success-path audit: handlers call this after execution to
// record the outcome. No-op when AUDIT_LOG is not configured.
async function auditOk(serverName, toolName, args, executionResult) {
  const serverConfig = await getServerConfig(serverName);
  auditLog(serverConfig, toolName, args, { allowed: true }, executionResult);
}

// Execute command with timeout - using child_process timeout for real kill
async function execCommandWithTimeout(ssh, command, options = {}, timeoutMs = 30000) {
  // Pass through rawCommand and platform if specified
  const { rawCommand, platform = 'linux', ...otherOptions } = options;

  // Windows targets: encode the command as PowerShell -EncodedCommand (UTF-16
  // LE base64). This is the standard approach (used by Ansible / Chef / Puppet)
  // because cmd.exe's quoting rules are inconsistent across versions and break
  // commands containing $vars, $(...) subexpressions, double-quoted strings,
  // pipes, etc. Base64 sidesteps all escape issues entirely.
  if (platform === 'windows' && !rawCommand) {
    // Suppress progress (avoids CLIXML sentinels in stderr) + force UTF-8 stdout
    const prelude = '$ProgressPreference=\'SilentlyContinue\'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';
    const fullPSCommand = `${prelude} ${command}`;
    const utf16le = Buffer.from(fullPSCommand, 'utf16le');
    const b64 = utf16le.toString('base64');
    // -OutputFormat Text prevents stderr/info streams from being CLIXML-encoded
    const wrappedCommand = `powershell -NoProfile -OutputFormat Text -EncodedCommand ${b64}`;
    return ssh.execCommand(wrappedCommand, { ...otherOptions, execOptions: { ...(otherOptions.execOptions || {}) } });
  }

  // For commands that might hang, use the system's timeout command if available.
  // Note: the `!isWindows` guard that existed here previously is intentionally
  // removed. Windows targets return early above (the `if (platform === 'windows'
  // && !rawCommand)` block), so by the time execution reaches this line it is
  // guaranteed to be a Linux/macOS target. The behaviour is identical; the old
  // guard was made redundant by the early-return path.
  const useSystemTimeout = timeoutMs > 0 && timeoutMs < 300000 && !rawCommand; // Max 5 minutes, not for raw commands

  if (useSystemTimeout) {
    // Wrap command with timeout command (works on Linux/Mac)
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    const wrappedCommand = `timeout ${timeoutSeconds} sh -c '${command.replace(/'/g, '\'\\\'\'')}'`;

    try {
      const result = await ssh.execCommand(wrappedCommand, {
        ...otherOptions,
        timeout: timeoutMs + WRAPPED_COMMAND_TIMEOUT_GRACE_MS
      });

      // Check if timeout occurred (exit code 124 on Linux, 124 or 143 on Mac)
      if (result.code === 124 || result.code === 143) {
        throw new Error(`Command timeout after ${timeoutMs}ms: ${command.substring(0, 100)}...`);
      }

      return result;
    } catch (error) {
      // If timeout occurred, remove connection from pool
      if (error.message.includes('timeout')) {
        for (const [name, conn] of connections.entries()) {
          if (conn === ssh) {
            logger.warn(`Removing timed-out connection for ${name}`);
            connections.delete(name);
            connectionTimestamps.delete(name);
            if (keepaliveIntervals.has(name)) {
              clearInterval(keepaliveIntervals.get(name));
              keepaliveIntervals.delete(name);
            }
            // Force close the connection
            ssh.dispose();
            break;
          }
        }
      }
      throw error;
    }
  } else {
    // No timeout or very long timeout, execute normally
    return ssh.execCommand(command, { ...options, timeout: timeoutMs });
  }
}

// Check if a connection is still valid
async function isConnectionValid(ssh) {
  try {
    return await ssh.ping();
  } catch (error) {
    logger.debug('Connection validation failed', { error: error.message });
    return false;
  }
}

// Setup keepalive for a connection
function setupKeepalive(serverName, ssh) {
  // Clear existing keepalive if any
  if (keepaliveIntervals.has(serverName)) {
    clearInterval(keepaliveIntervals.get(serverName));
  }

  // Set up new keepalive interval
  const interval = setInterval(async () => {
    try {
      const isValid = await isConnectionValid(ssh);
      if (!isValid) {
        logger.warn(`Connection to ${serverName} lost, will reconnect on next use`);
        closeConnection(serverName);
      } else {
        // Update timestamp on successful keepalive
        connectionTimestamps.set(serverName, Date.now());
        logger.debug('Keepalive successful', { server: serverName });
      }
    } catch (error) {
      logger.error(`Keepalive failed for ${serverName}`, { error: error.message });
    }
  }, KEEPALIVE_INTERVAL);

  // Don't let the keepalive timer keep the process alive on its own. As a stdio
  // MCP server we must exit when our transport closes; an active interval would
  // otherwise pin the event loop and leave the process orphaned.
  if (typeof interval.unref === 'function') interval.unref();

  keepaliveIntervals.set(serverName, interval);
}

// Close a connection and clean up
function closeConnection(serverName) {
  const normalizedName = serverName.toLowerCase();

  // Clear keepalive interval
  if (keepaliveIntervals.has(normalizedName)) {
    clearInterval(keepaliveIntervals.get(normalizedName));
    keepaliveIntervals.delete(normalizedName);
  }

  // Close SSH connection
  const ssh = connections.get(normalizedName);
  if (ssh) {
    ssh.dispose();
    connections.delete(normalizedName);
  }

  // Remove timestamp
  connectionTimestamps.delete(normalizedName);

  // Clean up jump dependency tracking
  jumpDependencies.delete(normalizedName);

  logger.logConnection(serverName, 'closed');
}

// Clean up old connections
function cleanupOldConnections() {
  const now = Date.now();
  for (const [serverName, timestamp] of connectionTimestamps.entries()) {
    if (now - timestamp > CONNECTION_TIMEOUT) {
      logger.info(`Connection to ${serverName} timed out, closing`, { timeout: CONNECTION_TIMEOUT });
      closeConnection(serverName);
    }
  }
}

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

    const socket = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
      allowHalfOpen: false
    });

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

// Get or create SSH connection with reconnection support
async function getConnection(serverName) {
  const servers = await loadServerConfig();

  // Execute pre-connect hook
  await executeHook('pre-connect', { server: serverName });

  // Try to resolve through aliases first
  const resolvedName = resolveServerName(serverName, servers);

  if (!resolvedName) {
    const availableServers = Object.keys(servers);
    const aliases = listAliases();
    const aliasInfo = aliases.length > 0 ?
      ` Aliases: ${aliases.map(a => `${a.alias}->${a.target}`).join(', ')}` : '';
    throw new Error(
      `Server "${serverName}" not found. Available servers: ${availableServers.join(', ') || 'none'}.${aliasInfo}`
    );
  }

  const normalizedName = resolvedName;

  // Check if we have an existing connection
  if (connections.has(normalizedName)) {
    const existingSSH = connections.get(normalizedName);

    // Verify the connection is still valid
    const isValid = await isConnectionValid(existingSSH);

    if (isValid) {
      // Update timestamp and return existing connection
      connectionTimestamps.set(normalizedName, Date.now());
      return existingSSH;
    } else {
      // Connection is dead, remove it
      logger.info(`Connection to ${serverName} lost, reconnecting`);
      closeConnection(normalizedName);
    }
  }

  // Create new connection
  const serverConfig = servers[normalizedName];
  const ssh = new SSHManager(serverConfig);

  try {
    if (serverConfig.proxyJump) {
      const jumpServerName = serverConfig.proxyJump.toLowerCase();

      // Validate jump server exists
      if (!servers[jumpServerName]) {
        throw new Error(
          `Proxy jump server "${serverConfig.proxyJump}" not found. ` +
          `Available servers: ${Object.keys(servers).join(', ')}`
        );
      }

      // Detect circular proxy jumps
      const visited = new Set([normalizedName]);
      let current = jumpServerName;
      while (current) {
        if (visited.has(current)) {
          throw new Error(`Circular proxy jump detected: ${[...visited, current].join(' -> ')}`);
        }
        visited.add(current);
        current = servers[current]?.proxyJump?.toLowerCase() || null;
      }

      // Connect to jump server (recursive — handles chained jumps)
      const jumpSSH = await getConnection(serverConfig.proxyJump);

      // Create forwarded stream through the jump server
      const stream = await jumpSSH.forwardOut(
        '127.0.0.1', 0,
        serverConfig.host, serverConfig.port || 22
      );

      // Connect target through the forwarded stream
      await ssh.connect({ sock: stream });
      jumpDependencies.set(normalizedName, jumpServerName);
      ssh.jumpConnection = jumpSSH;
    } else if (serverConfig.proxyCommand) {
      // Create socket via proxy command (e.g., SOCKS5 proxy)
      const socket = await createProxyCommandSocket(
        serverConfig.proxyCommand,
        serverConfig.host,
        serverConfig.port || 22
      );
      await ssh.connect({ sock: socket });
    } else {
      await ssh.connect();
    }

    connections.set(normalizedName, ssh);
    connectionTimestamps.set(normalizedName, Date.now());

    // Setup keepalive
    setupKeepalive(normalizedName, ssh);

    logger.logConnection(serverName, 'established', {
      host: serverConfig.host,
      port: serverConfig.port,
      method: serverConfig.password ? 'password' : 'key',
      proxyJump: serverConfig.proxyJump || null,
      proxyCommand: serverConfig.proxyCommand ? '<set>' : null
    });

    // Execute post-connect hook
    await executeHook('post-connect', { server: serverName });
  } catch (error) {
    logger.logConnection(serverName, 'failed', { error: error.message });
    // Execute error hook
    await executeHook('on-error', { server: serverName, error: error.message });
    throw new Error(`Failed to connect to ${serverName}: ${error.message}`);
  }

  return connections.get(normalizedName);
}

// Create MCP server
const server = new McpServer({
  name: 'mcp-ssh-manager',
  version: '1.2.0',
});

logger.info('MCP Server initialized', { version: '1.2.0' });

/**
 * Helper function to conditionally register tools based on configuration
 * @param {string} toolName - Name of the tool
 * @param {Object} schema - Tool schema
 * @param {Function} handler - Tool handler function
 */
function registerToolConditional(toolName, schema, handler) {
  if (isToolEnabled(toolName)) {
    server.registerTool(toolName, schema, handler);
    logger.debug(`Registered tool: ${toolName}`);
  } else {
    logger.debug(`Skipped disabled tool: ${toolName}`);
  }
}

// Register available tools
registerToolConditional(
  'ssh_execute',
  {
    description: 'Runs a shell command over SSH on a named configured server and returns stdout, stderr, and exit code. Mutates remote state depending on the command; not read-only. Expands command aliases before running. Uses the cwd parameter or, if omitted, the server configured default directory; adapts syntax for Linux versus Windows PowerShell targets. Timeout defaults to 120000 ms and is capped at 300000 ms. Under readonly mode destructive commands like rm or dd are refused; under restricted mode the command must match allow patterns. Output is truncated when very large.',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      command: z.string().describe('Command to execute'),
      cwd: z.string().optional().describe('Working directory (optional, uses default if configured)'),
      timeout: z.number().optional().describe('Command timeout in milliseconds (default: 120000, max: 300000)')
    }
  },
  async ({ server: serverName, command, cwd, timeout = TIMEOUTS.DEFAULT_COMMAND_TIMEOUT }) => {
    // Cap timeout at maximum allowed
    const cappedTimeout = Math.min(timeout, TIMEOUTS.MAX_COMMAND_TIMEOUT);

    // Expand aliases BEFORE policy evaluation so the user can't bypass a DENY
    // regex by hiding a destructive command behind an alias.
    const expandedCommand = expandCommandAlias(command);

    const denied = await applyServerPolicy(serverName, 'ssh_execute', { command, cwd }, expandedCommand);
    if (denied) return denied;

    try {
      const ssh = await getConnection(serverName);

      // Execute hooks for bench commands
      if (expandedCommand.includes('bench update')) {
        await executeHook('pre-bench-update', {
          server: serverName,
          sshConnection: ssh,
          defaultDir: cwd
        });
      }

      // Use provided cwd, or default_dir from config, or no cwd
      const servers = await loadServerConfig();
      const serverConfig = servers[serverName.toLowerCase()];
      const workingDir = cwd || serverConfig?.default_dir;
      const platform = serverConfig?.platform || 'linux';

      // Build cwd-prefixed command using platform-appropriate syntax
      let fullCommand;
      if (workingDir) {
        if (platform === 'windows') {
          const escapedDir = workingDir.replace(/'/g, '\'\'');
          fullCommand = `Set-Location '${escapedDir}'; ${expandedCommand}`;
        } else {
          fullCommand = `cd ${workingDir} && ${expandedCommand}`;
        }
      } else {
        fullCommand = expandedCommand;
      }

      // Log command execution
      const startTime = logger.logCommand(serverName, fullCommand, workingDir);

      const result = await execCommandWithTimeout(ssh, fullCommand, { platform }, cappedTimeout);

      // Log command result
      logger.logCommandResult(serverName, fullCommand, startTime, result);

      // Execute post-hooks for bench commands
      if (expandedCommand.includes('bench update') && result.code === 0) {
        await executeHook('post-bench-update', {
          server: serverName,
          sshConnection: ssh,
          defaultDir: cwd
        });
      }

      // Truncate output if too large to prevent Claude Code crashes
      const stdout = truncateOutput(result.stdout);
      const stderr = truncateOutput(result.stderr);

      await auditOk(serverName, 'ssh_execute', { command, cwd }, {
        code: result.code,
        success: result.code === 0,
      });

      return {
        content: [
          {
            type: 'text',
            text: formatJSONResponse({
              server: serverName,
              command: fullCommand,
              stdout: stdout,
              stderr: stderr,
              code: result.code,
              success: result.code === 0,
            }),
          },
        ],
      };
    } catch (error) {
      await auditOk(serverName, 'ssh_execute', { command, cwd }, {
        success: false,
        error: error.message,
      });
      logger.error('ssh_execute failed', {
        server: serverName,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: formatJSONResponse({
              server: serverName,
              success: false,
              error: truncateOutput(error.message, 1000),
              code: -1
            }),
          },
        ],
        isError: true
      };
    }
  }
);

registerToolConditional(
  'ssh_upload',
  {
    description: 'Uploads one local file to a remote destination path over SFTP on the named server, overwriting any existing remote file at that path. Mutates remote state and is not idempotent beyond replacing the target. Creates no backup. Requires the local file to exist. Does not use sudo, so the remote path must be writable by the configured SSH user. This tool is blocked entirely on servers set to readonly or restricted security mode. For directory trees use ssh_sync instead.',
    inputSchema: {
      server: z.string().describe('Server name'),
      localPath: z.string().describe('Local file path'),
      remotePath: z.string().describe('Remote destination path')
    }
  },
  async ({ server: serverName, localPath, remotePath }) => {
    const denied = await applyServerPolicy(serverName, 'ssh_upload', { localPath, remotePath });
    if (denied) return denied;

    try {
      const ssh = await getConnection(serverName);

      logger.logTransfer('upload', serverName, localPath, remotePath);
      const startTime = Date.now();

      await ssh.putFile(localPath, remotePath);

      const fileStats = fs.statSync(localPath);
      logger.logTransfer('upload', serverName, localPath, remotePath, {
        success: true,
        size: fileStats.size,
        duration: `${Date.now() - startTime}ms`
      });

      await auditOk(serverName, 'ssh_upload', { localPath, remotePath }, { success: true });

      return {
        content: [
          {
            type: 'text',
            text: `✅ File uploaded successfully\nServer: ${serverName}\nLocal: ${localPath}\nRemote: ${remotePath}`,
          },
        ],
      };
    } catch (error) {
      await auditOk(serverName, 'ssh_upload', { localPath, remotePath }, {
        success: false,
        error: error.message,
      });
      logger.logTransfer('upload', serverName, localPath, remotePath, {
        success: false,
        error: error.message
      });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Upload error: ${error.message}`,
          },
        ],
      };
    }
  }
);

registerToolConditional(
  'ssh_download',
  {
    description: 'Downloads one remote file from the named server to a local destination path over SFTP, overwriting any existing local file at that path. Affects only the local filesystem and is read-only on the remote side, so it stays allowed even on servers in readonly or restricted security mode. Reads the remote file using the configured SSH user, which must have permission to read it. Handles single files only; use ssh_sync for directories.',
    inputSchema: {
      server: z.string().describe('Server name'),
      remotePath: z.string().describe('Remote file path'),
      localPath: z.string().describe('Local destination path')
    }
  },
  async ({ server: serverName, remotePath, localPath }) => {
    try {
      const ssh = await getConnection(serverName);

      logger.logTransfer('download', serverName, remotePath, localPath);
      const startTime = Date.now();

      await ssh.getFile(localPath, remotePath);

      const fileStats = fs.statSync(localPath);
      logger.logTransfer('download', serverName, remotePath, localPath, {
        success: true,
        size: fileStats.size,
        duration: `${Date.now() - startTime}ms`
      });

      return {
        content: [
          {
            type: 'text',
            text: `✅ File downloaded successfully\nServer: ${serverName}\nRemote: ${remotePath}\nLocal: ${localPath}`,
          },
        ],
      };
    } catch (error) {
      logger.logTransfer('download', serverName, remotePath, localPath, {
        success: false,
        error: error.message
      });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Download error: ${error.message}`,
          },
        ],
      };
    }
  }
);

registerToolConditional(
  'ssh_sync',
  {
    description: 'Synchronizes files or directories between local and remote using rsync over SSH on the named server. Each of source and destination must carry a local: or remote: prefix and one side must be local and the other remote; with no prefix it assumes a push from local to remote. Mutates the destination. Setting delete true removes destination files absent from source, which is destructive; dryRun true previews without changing anything. Compression is on by default. Password authentication requires sshpass installed locally. Blocked on readonly or restricted servers. Timeout defaults to 30000 ms.',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      source: z.string().describe('Source path (use "local:" or "remote:" prefix)'),
      destination: z.string().describe('Destination path (use "local:" or "remote:" prefix)'),
      exclude: z.array(z.string()).optional().describe('Patterns to exclude from sync'),
      dryRun: z.boolean().optional().describe('Perform dry run without actual changes'),
      delete: z.boolean().optional().describe('Delete files in destination not in source'),
      compress: z.boolean().optional().describe('Compress during transfer'),
      verbose: z.boolean().optional().describe('Show detailed progress'),
      checksum: z.boolean().optional().describe('Use checksum instead of timestamp for comparison'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)')
    }
  },
  async ({ server: serverName, source, destination, exclude = [], dryRun = false, delete: deleteFiles = false, compress = true, verbose = false, checksum = false, timeout = 30000 }) => {
    const denied = await applyServerPolicy(serverName, 'ssh_sync', { source, destination, dryRun, delete: deleteFiles });
    if (denied) return denied;

    try {
      await getConnection(serverName);
      const servers = await loadServerConfig();
      const serverConfig = servers[serverName.toLowerCase()];

      // Check if sshpass is available for password authentication
      if (!serverConfig.keypath && serverConfig.password) {
        // Check if sshpass is installed
        try {
          const { execSync } = await import('child_process');
          execSync('which sshpass', { stdio: 'ignore' });
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Error: ssh_sync with password authentication requires sshpass.\n\nThe server '${serverName}' uses password authentication.\nPlease install sshpass: brew install hudochenkov/sshpass/sshpass (macOS) or apt-get install sshpass (Linux)\n\nAlternatively, use ssh_upload or ssh_download for single file transfers.`
              }
            ]
          };
        }
      }

      // Determine sync direction based on source/destination prefixes
      const isLocalSource = source.startsWith('local:');
      const isRemoteSource = source.startsWith('remote:');
      const isLocalDest = destination.startsWith('local:');
      const isRemoteDest = destination.startsWith('remote:');

      // Clean paths
      const cleanSource = source.replace(/^(local:|remote:)/, '');
      const cleanDest = destination.replace(/^(local:|remote:)/, '');

      // Validate direction
      if ((isLocalSource && isLocalDest) || (isRemoteSource && isRemoteDest)) {
        throw new Error('Source and destination must be different (one local, one remote). Use prefixes: local: or remote:');
      }

      // If no prefixes, assume old format (local source to remote dest)
      const direction = (isLocalSource || (!isLocalSource && !isRemoteSource)) ? 'push' : 'pull';

      // Build rsync command
      let rsyncOptions = ['-avz'];

      if (!compress) {
        rsyncOptions = ['-av'];
      }

      if (checksum) {
        rsyncOptions.push('--checksum');
      }

      if (deleteFiles) {
        rsyncOptions.push('--delete');
      }

      if (dryRun) {
        rsyncOptions.push('--dry-run');
      }

      // Always include --stats so we can parse transfer counts
      rsyncOptions.push('--stats');

      // Add exclude patterns
      exclude.forEach(pattern => {
        rsyncOptions.push('--exclude', pattern);
      });

      let localPath;
      let remotePath;

      if (direction === 'push') {
        localPath = cleanSource;
        remotePath = cleanDest;

        // Check if local path exists
        if (!fs.existsSync(localPath)) {
          throw new Error(`Local path does not exist: ${localPath}`);
        }
      } else {
        localPath = cleanDest;
        remotePath = cleanSource;
      }

      // Add SSH options for non-interactive mode
      const sshOptions = [];

      // Different options based on authentication method
      if (serverConfig.keypath) {
        sshOptions.push('-o BatchMode=yes');           // No password prompts
        sshOptions.push('-o StrictHostKeyChecking=accept-new'); // Accept new keys, reject changed ones
        sshOptions.push('-o ConnectTimeout=10');        // Connection timeout

        const keyPath = serverConfig.keypath.replace('~', os.homedir());
        sshOptions.push(`-i ${keyPath}`);
      } else {
        // With sshpass, we don't use BatchMode
        sshOptions.push('-o StrictHostKeyChecking=accept-new'); // Accept new keys, reject changed ones
        sshOptions.push('-o ConnectTimeout=10');
      }

      if (serverConfig.port && serverConfig.port !== '22') {
        sshOptions.push(`-p ${serverConfig.port}`);
      }

      logger.info(`Starting rsync ${direction}`, {
        server: serverName,
        source: direction === 'push' ? localPath : remotePath,
        destination: direction === 'push' ? remotePath : localPath,
        dryRun,
        deleteFiles
      });

      const startTime = Date.now();

      // Execute rsync via spawn for non-blocking streaming
      const { spawn } = await import('child_process');

      return new Promise((resolve, reject) => {
        let output = '';
        let errorOutput = '';
        let killed = false;

        // Build command based on authentication method
        let rsyncCommand;
        let rsyncArgs = [];
        let processEnv = { ...process.env };

        if (serverConfig.password) {
          // Use sshpass for password authentication
          rsyncCommand = 'sshpass';
          rsyncArgs.push('-p', serverConfig.password);
          rsyncArgs.push('rsync');

          // Add rsync options
          rsyncOptions.forEach(opt => rsyncArgs.push(opt));

          // Add SSH command
          const sshCmd = `ssh ${sshOptions.join(' ')}`;
          rsyncArgs.push('-e', sshCmd);
        } else {
          // Direct rsync for key authentication
          rsyncCommand = 'rsync';

          // Add rsync options
          rsyncOptions.forEach(opt => rsyncArgs.push(opt));

          // Add SSH command with all options
          const sshCmd = `ssh ${sshOptions.join(' ')}`;
          rsyncArgs.push('-e', sshCmd);

          processEnv.SSH_ASKPASS = '/bin/false';
          processEnv.DISPLAY = '';
        }

        // Add source and destination
        if (direction === 'push') {
          rsyncArgs.push(localPath);
          rsyncArgs.push(`${serverConfig.user}@${serverConfig.host}:${remotePath}`);
        } else {
          rsyncArgs.push(`${serverConfig.user}@${serverConfig.host}:${remotePath}`);
          rsyncArgs.push(localPath);
        }

        const rsyncProcess = spawn(rsyncCommand, rsyncArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: processEnv
        });

        // Set timeout
        const timer = setTimeout(() => {
          killed = true;
          rsyncProcess.kill('SIGTERM');
          reject(new Error(`Rsync timeout after ${timeout}ms`));
        }, timeout);

        // Collect output with size limit
        rsyncProcess.stdout.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          // Limit output size to prevent memory issues
          if (output.length > 100000) {
            output = output.slice(-50000);
          }
        });

        rsyncProcess.stderr.on('data', (data) => {
          const chunk = data.toString();
          errorOutput += chunk;
          if (errorOutput.length > 50000) {
            errorOutput = errorOutput.slice(-25000);
          }
        });

        rsyncProcess.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`Failed to start rsync: ${err.message}`));
        });

        rsyncProcess.on('close', (code) => {
          clearTimeout(timer);

          if (killed) {
            return; // Already rejected due to timeout
          }

          const duration = Date.now() - startTime;

          if (code !== 0) {
            logger.error(`Rsync ${direction} failed`, {
              server: serverName,
              exitCode: code,
              error: errorOutput,
              duration: `${duration}ms`
            });

            // Check if it's an SSH key error
            if (detectSSHKeyError(errorOutput)) {
              const hostInfo = extractHostFromSSHError(errorOutput);
              let errorMsg = `SSH host key verification failed for ${serverName}.\n`;

              if (hostInfo) {
                errorMsg += `Host: ${hostInfo.host}:${hostInfo.port}\n`;
              }

              errorMsg += '\n📍 To fix this issue:\n';
              errorMsg += '1. Verify the server identity\n';
              errorMsg += '2. Use \'ssh_key_manage\' tool with action \'verify\' to check the key\n';
              errorMsg += '3. Use \'ssh_key_manage\' tool with action \'accept\' to update the key if you trust the server\n';
              errorMsg += `\nOriginal error:\n${errorOutput}`;

              reject(new Error(errorMsg));
            } else {
              reject(new Error(`Rsync failed with exit code ${code}: ${errorOutput || 'Unknown error'}`));
            }
            return;
          }

          // Parse rsync output for statistics. Handles rsync 2.x/3.x wording,
          // GNU "bytes" vs openrsync "B" suffixes, and locale separators.
          const stats = parseRsyncStats(output, duration);

          logger.info(`Rsync ${direction} completed`, {
            server: serverName,
            direction,
            duration: `${duration}ms`,
            filesTransferred: stats.filesTransferred,
            totalSize: stats.totalSize,
            dryRun
          });

          // Format output
          let resultText = dryRun ? '🔍 Dry run completed\n' : '✅ Sync completed successfully\n';
          resultText += `Direction: ${direction === 'push' ? 'Local → Remote' : 'Remote → Local'}\n`;
          resultText += `Server: ${serverName}\n`;
          resultText += `Source: ${direction === 'push' ? localPath : remotePath}\n`;
          resultText += `Destination: ${direction === 'push' ? remotePath : localPath}\n`;

          if (stats.filesTransferred > 0) {
            resultText += `Files transferred: ${stats.filesTransferred}\n`;
            if (stats.totalSize > 0) {
              const sizeKB = (stats.totalSize / 1024).toFixed(2);
              resultText += `Total size: ${sizeKB} KB\n`;
            }
            if (stats.speed) {
              const speedKB = (stats.speed / 1024).toFixed(2);
              resultText += `Average speed: ${speedKB} KB/s\n`;
            }
          } else {
            resultText += 'No files needed to be transferred\n';
          }

          resultText += `Time: ${(duration / 1000).toFixed(2)} seconds\n`;

          if (verbose && output.length < 5000) {
            resultText += '\n📋 Sync statistics:\n';
            // Only show relevant stats lines
            const statsLines = output.split('\n').filter(line =>
              line.includes('Number of') ||
              line.includes('Total') ||
              line.includes('sent') ||
              line.includes('received')
            );
            if (statsLines.length > 0) {
              resultText += statsLines.join('\n');
            }
          }

          resolve({
            content: [
              {
                type: 'text',
                text: resultText
              }
            ]
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Sync error: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_tail',
  {
    description: 'Reads the tail of a remote log file on the named server, optionally filtered by a grep pattern. Read-only; it does not modify remote state. Behavior depends on follow, which defaults to true: in follow mode it starts a streaming tail whose output is written to the server process stderr rather than returned, and the response only reports a session note, so to capture content directly set follow to false to get the last N lines back. The lines parameter defaults to 10.',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      file: z.string().describe('Path to the log file to tail'),
      lines: z.number().optional().describe('Number of lines to show initially (default: 10)'),
      follow: z.boolean().optional().describe('Follow file for new content (default: true)'),
      grep: z.string().optional().describe('Filter lines with grep pattern')
    }
  },
  async ({ server: serverName, file, lines = 10, follow = true, grep }) => {
    try {
      const ssh = await getConnection(serverName);

      // Build tail command
      let command = `tail -n ${lines}`;
      if (follow) {
        command += ' -f';
      }
      command += ` "${file}"`;

      // Add grep filter if specified
      if (grep) {
        command += ` | grep "${grep}"`;
      }

      logger.info(`Starting tail on ${serverName}`, {
        file,
        lines,
        follow,
        grep
      });

      // For follow mode, we need to handle streaming
      if (follow) {
        // Create a unique session ID for this tail
        const sessionId = `tail_${Date.now()}`;

        // Store the SSH stream for later cleanup
        await ssh.execCommandStream(command, {
          onStdout: (chunk) => {
            // In a real implementation, this would stream to the client
            console.error(`[${serverName}:${file}] ${chunk}`);
          },
          onStderr: (chunk) => {
            console.error(`[ERROR] ${chunk}`);
          }
        });

        return {
          content: [
            {
              type: 'text',
              text: `📜 Tailing ${file} on ${serverName}\nSession ID: ${sessionId}\nShowing last ${lines} lines${grep ? ` (filtered: ${grep})` : ''}\n\n⚠️ Note: In follow mode, output is streamed to stderr.\nTo stop tailing, you'll need to kill the session.`
            }
          ]
        };
      } else {
        // Non-follow mode - just get the output
        const tailServers = await loadServerConfig();
        const tailServerConfig = tailServers[serverName.toLowerCase()];
        const result = await execCommandWithTimeout(ssh, command, { platform: tailServerConfig?.platform }, 15000);

        if (result.code !== 0) {
          throw new Error(result.stderr || 'Failed to tail file');
        }

        logger.info(`Tail completed on ${serverName}`, {
          file,
          lines: result.stdout.split('\n').length
        });

        return {
          content: [
            {
              type: 'text',
              text: `📜 Last ${lines} lines of ${file} on ${serverName}${grep ? ` (filtered: ${grep})` : ''}:\n\n${result.stdout}`
            }
          ]
        };
      }
    } catch (error) {
      logger.error(`Tail failed on ${serverName}`, {
        file,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Tail error: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_monitor',
  {
    description: 'Collects a read-only snapshot of system resources on the named Linux server by running inspection commands such as top, free, df, ss, and ps. The type parameter selects the view and defaults to overview; other values are cpu, memory, disk, network, and process. Does not change remote state and needs no sudo. The interval and duration parameters are accepted for continuous monitoring intent but a single snapshot is gathered. Targets Linux tooling, so output may be empty on Windows hosts.',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      type: z.enum(['overview', 'cpu', 'memory', 'disk', 'network', 'process']).optional().describe('Type of monitoring (default: overview)'),
      interval: z.number().optional().describe('Update interval in seconds for continuous monitoring'),
      duration: z.number().optional().describe('Duration in seconds for continuous monitoring')
    }
  },
  async ({ server: serverName, type = 'overview', interval, duration }) => {
    try {
      const ssh = await getConnection(serverName);

      logger.info(`Starting system monitoring on ${serverName}`, {
        type,
        interval,
        duration
      });

      let commands = {};
      let output = {};

      // Define monitoring commands based on type
      switch (type) {
      case 'cpu':
        commands.cpu = 'top -bn1 | head -20';
        commands.load = 'uptime';
        commands.cores = 'nproc';
        break;

      case 'memory':
        commands.memory = 'free -h';
        commands.swap = 'swapon --show';
        commands.top_mem = 'ps aux --sort=-%mem | head -10';
        break;

      case 'disk':
        commands.disk = 'df -h';
        commands.inodes = 'df -i';
        commands.io = 'iostat -x 1 2 | tail -n +4';
        break;

      case 'network':
        commands.interfaces = 'ip -s link show';
        commands.connections = 'ss -tunap | head -20';
        commands.netstat = 'netstat -i';
        break;

      case 'process':
        commands.process = 'ps aux --sort=-%cpu | head -20';
        commands.count = 'ps aux | wc -l';
        commands.zombies = 'ps aux | grep -c defunct || echo 0';
        break;

      case 'overview':
      default:
        commands.uptime = 'uptime';
        commands.cpu = 'mpstat 1 1 2>/dev/null || top -bn1 | grep \'Cpu\'';
        commands.memory = 'free -h';
        commands.disk = 'df -h | grep -E \'^/dev/\' | head -5';
        commands.load = 'cat /proc/loadavg';
        commands.processes = 'ps aux | wc -l';
        break;
      }

      // Execute all monitoring commands
      const startTime = Date.now();
      const monServers = await loadServerConfig();
      const monServerConfig = monServers[serverName.toLowerCase()];

      for (const [key, cmd] of Object.entries(commands)) {
        try {
          const result = await execCommandWithTimeout(ssh, cmd, { platform: monServerConfig?.platform }, 10000);
          if (result.code === 0) {
            output[key] = result.stdout.trim();
          } else {
            output[key] = `Error: ${result.stderr || 'Command failed'}`;
          }
        } catch (err) {
          output[key] = `Error: ${err.message}`;
        }
      }

      const monitoringDuration = Date.now() - startTime;

      // Format the output based on type
      let formattedOutput = `📊 System Monitor - ${serverName}\n`;
      formattedOutput += `Type: ${type} | Time: ${new Date().toISOString()}\n`;
      formattedOutput += `Collection time: ${monitoringDuration}ms\n`;
      formattedOutput += '━'.repeat(50) + '\n\n';

      switch (type) {
      case 'overview':
        formattedOutput += `⏱️ UPTIME\n${output.uptime || 'N/A'}\n\n`;
        formattedOutput += `💻 CPU\n${output.cpu || 'N/A'}\n\n`;
        formattedOutput += `📈 LOAD AVERAGE\n${output.load || 'N/A'}\n\n`;
        formattedOutput += `💾 MEMORY\n${output.memory || 'N/A'}\n\n`;
        formattedOutput += `💿 DISK USAGE\n${output.disk || 'N/A'}\n\n`;
        formattedOutput += `📝 PROCESSES: ${output.processes || 'N/A'}\n`;
        break;

      case 'cpu':
        formattedOutput += `🖥️ CPU CORES: ${output.cores || 'N/A'}\n\n`;
        formattedOutput += `📊 LOAD\n${output.load || 'N/A'}\n\n`;
        formattedOutput += `📈 TOP PROCESSES\n${output.cpu || 'N/A'}\n`;
        break;

      case 'memory':
        formattedOutput += `💾 MEMORY USAGE\n${output.memory || 'N/A'}\n\n`;
        formattedOutput += `🔄 SWAP\n${output.swap || 'No swap configured'}\n\n`;
        formattedOutput += `📊 TOP MEMORY CONSUMERS\n${output.top_mem || 'N/A'}\n`;
        break;

      case 'disk':
        formattedOutput += `💿 DISK SPACE\n${output.disk || 'N/A'}\n\n`;
        formattedOutput += `📁 INODE USAGE\n${output.inodes || 'N/A'}\n\n`;
        formattedOutput += `⚡ I/O STATS\n${output.io || 'N/A'}\n`;
        break;

      case 'network':
        formattedOutput += `🌐 NETWORK INTERFACES\n${output.interfaces || 'N/A'}\n\n`;
        formattedOutput += `🔌 CONNECTIONS\n${output.connections || 'N/A'}\n\n`;
        formattedOutput += `📊 INTERFACE STATS\n${output.netstat || 'N/A'}\n`;
        break;

      case 'process':
        formattedOutput += `📝 PROCESS COUNT: ${output.count || 'N/A'}\n`;
        formattedOutput += `⚠️ ZOMBIE PROCESSES: ${output.zombies || '0'}\n\n`;
        formattedOutput += `📊 TOP PROCESSES BY CPU\n${output.process || 'N/A'}\n`;
        break;
      }

      // Log monitoring results
      logger.info(`System monitoring completed on ${serverName}`, {
        type,
        duration: `${monitoringDuration}ms`,
        metrics: Object.keys(output).length
      });

      // If continuous monitoring requested
      if (interval && duration) {
        formattedOutput += `\n\n⏰ Continuous monitoring: Every ${interval}s for ${duration}s\n`;
        formattedOutput += '(Not implemented in this version - would require streaming support)';
      }

      return {
        content: [
          {
            type: 'text',
            text: formattedOutput
          }
        ]
      };
    } catch (error) {
      logger.error(`Monitoring failed on ${serverName}`, {
        type,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Monitor error: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_history',
  {
    description: 'Returns the in-memory log of SSH commands previously run through this server process during the current session, formatted with timestamps, server, duration, and success status. Purely local and read-only: it opens no SSH connection and does not persist across restarts. Optional filters narrow the results by server name, by success or failure, and by a search substring in the command text; limit defaults to 20 most recent entries. Does not expose command output, only the commands and their outcomes.',
    inputSchema: {
      limit: z.number().optional().describe('Number of commands to show (default: 20)'),
      server: z.string().optional().describe('Filter by server name'),
      success: z.boolean().optional().describe('Filter by success/failure'),
      search: z.string().optional().describe('Search in commands')
    }
  },
  async ({ limit = 20, server, success, search }) => {
    try {
      // Get history from logger
      let history = logger.getHistory(limit * 2); // Get more to account for filtering

      // Apply filters
      if (server) {
        history = history.filter(h => h.server?.toLowerCase().includes(server.toLowerCase()));
      }

      if (success !== undefined) {
        history = history.filter(h => h.success === success);
      }

      if (search) {
        history = history.filter(h => h.command?.toLowerCase().includes(search.toLowerCase()));
      }

      // Limit results
      history = history.slice(-limit);

      // Format output
      let output = '📜 SSH Command History\n';
      output += `Showing last ${history.length} commands`;

      const filters = [];
      if (server) filters.push(`server: ${server}`);
      if (success !== undefined) filters.push(success ? 'successful only' : 'failed only');
      if (search) filters.push(`search: ${search}`);

      if (filters.length > 0) {
        output += ` (filtered: ${filters.join(', ')})`;
      }

      output += '\n' + '━'.repeat(60) + '\n\n';

      if (history.length === 0) {
        output += 'No commands found matching the criteria.\n';
      } else {
        history.forEach((entry, index) => {
          const time = new Date(entry.timestamp).toLocaleString();
          const status = entry.success ? '✅' : '❌';
          const duration = entry.duration || 'N/A';

          output += `${history.length - index}. ${status} [${time}]\n`;
          output += `   Server: ${entry.server || 'unknown'}\n`;
          output += `   Command: ${entry.command?.substring(0, 100) || 'N/A'}`;
          if (entry.command && entry.command.length > 100) {
            output += '...';
          }
          output += '\n';
          output += `   Duration: ${duration}`;

          if (!entry.success && entry.error) {
            output += `\n   Error: ${entry.error}`;
          }

          output += '\n\n';
        });
      }

      output += '━'.repeat(60) + '\n';
      output += `Total commands in history: ${logger.getHistory(1000).length}\n`;

      logger.info('Command history retrieved', {
        limit,
        filters: filters.length,
        results: history.length
      });

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error retrieving history: ${error.message}`
          }
        ]
      };
    }
  }
);

// SSH Session Management Tools

registerToolConditional(
  'ssh_session_start',
  {
    description: 'Opens a new persistent interactive shell on the named configured server and returns a generated session ID. Stateful and side-effecting: it establishes (or reuses pooled) SSH connection and keeps an open shell that preserves working directory, environment, and command history across later ssh_session_send calls, unlike one-shot ssh_execute. The optional name is only a human label. The session stays open and consumes a remote shell until ssh_session_close is called.',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      name: z.string().optional().describe('Optional session name for identification')
    }
  },
  async ({ server: serverName, name }) => {
    try {
      const ssh = await getConnection(serverName);
      const session = await createSession(serverName, ssh);

      const sessionName = name || `Session on ${serverName}`;

      logger.info('SSH session started', {
        id: session.id,
        server: serverName,
        name: sessionName
      });

      return {
        content: [
          {
            type: 'text',
            text: `🚀 SSH Session Started\n\nSession ID: ${session.id}\nServer: ${serverName}\nName: ${sessionName}\nState: ${session.state}\nWorking Directory: ${session.context.cwd}\n\nUse ssh_session_send to execute commands in this session.\nUse ssh_session_close to terminate the session.`
          }
        ]
      };
    } catch (error) {
      logger.error('Failed to start SSH session', {
        server: serverName,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to start session: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_session_send',
  {
    description: 'Runs one command inside an already-open session identified by its session ID, reusing the persisted working directory, environment, and history of that shell. Mutates remote state like any shell command and is not idempotent; cd and export update the saved context for subsequent calls. Commands run through a bash-style shell (Unix-oriented). The security policy of the underlying server is enforced, so readonly or restricted servers may refuse. Default timeout is 30000 ms.',
    inputSchema: {
      session: z.string().describe('Session ID from ssh_session_start'),
      command: z.string().describe('Command to execute in the session'),
      timeout: z.number().optional().describe('Command timeout in milliseconds (default: 30000)')
    }
  },
  async ({ session: sessionId, command, timeout = 30000 }) => {
    try {
      const session = getSession(sessionId);

      // Resolve the session's underlying server to its policy.
      const denied = await applyServerPolicy(session.serverName, 'ssh_session_send', { session: sessionId, command }, command);
      if (denied) return denied;

      const startTime = Date.now();
      const result = await session.execute(command, { timeout });
      const duration = Date.now() - startTime;

      logger.info('Session command executed', {
        session: sessionId,
        command: command.substring(0, 50),
        success: result.success,
        duration: `${duration}ms`
      });

      let output = `📟 Session: ${sessionId}\n`;
      output += `Server: ${session.serverName}\n`;
      output += `Working Directory: ${session.context.cwd}\n`;
      output += `Command: ${command}\n`;
      output += `Duration: ${duration}ms\n`;
      output += '━'.repeat(60) + '\n\n';

      if (result.success) {
        output += '✅ Output:\n' + result.output;
      } else {
        output += '❌ Error:\n' + (result.error || result.output);
      }

      // Add session state info
      output += '\n\n' + '━'.repeat(60) + '\n';
      output += `Session State: ${session.state}\n`;
      output += `Commands Executed: ${session.context.history.length}\n`;

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logger.error('Failed to send command to session', {
        session: sessionId,
        command,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Session error: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_session_list',
  {
    description: 'Lists currently active SSH sessions with their ID, server, state, working directory, command count, age, idle time, and any defined variables. Read-only: it inspects in-memory session state and changes nothing on remote hosts or local config. The optional server argument is a case-insensitive substring filter on server name; omit it to list every active session. Closed sessions are excluded from the results.',
    inputSchema: {
      server: z.string().optional().describe('Filter by server name')
    }
  },
  async ({ server }) => {
    try {
      let sessions = listSessions();

      // Filter by server if specified
      if (server) {
        sessions = sessions.filter(s =>
          s.server.toLowerCase().includes(server.toLowerCase())
        );
      }

      let output = '📋 Active SSH Sessions\n';
      output += '━'.repeat(60) + '\n\n';

      if (sessions.length === 0) {
        output += 'No active sessions';
        if (server) {
          output += ` for server "${server}"`;
        }
        output += '.\n';
      } else {
        sessions.forEach((session, index) => {
          const age = Math.floor((Date.now() - new Date(session.created).getTime()) / 1000);
          const idle = Math.floor((Date.now() - new Date(session.lastActivity).getTime()) / 1000);

          output += `${index + 1}. Session: ${session.id}\n`;
          output += `   Server: ${session.server}\n`;
          output += `   State: ${session.state}\n`;
          output += `   Working Dir: ${session.cwd || 'unknown'}\n`;
          output += `   Commands Run: ${session.historyCount}\n`;
          output += `   Age: ${formatDuration(age)}\n`;
          output += `   Idle: ${formatDuration(idle)}\n`;

          if (session.variables.length > 0) {
            output += `   Variables: ${session.variables.join(', ')}\n`;
          }

          output += '\n';
        });
      }

      output += '━'.repeat(60) + '\n';
      output += `Total Active Sessions: ${sessions.length}\n`;

      logger.info('Listed SSH sessions', {
        total: sessions.length,
        filter: server
      });

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error listing sessions: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_session_close',
  {
    description: 'Terminates an open SSH session given its session ID, writing exit to the remote shell, ending it, and discarding its in-memory history and context; the session ID becomes unusable afterward. Destructive to session state but does not delete remote files. Passing the literal value all closes every active session at once, ignoring individual close errors. It does not drop the pooled underlying connection, only the interactive shell.',
    inputSchema: {
      session: z.string().describe('Session ID to close (or "all" to close all sessions)')
    }
  },
  async ({ session: sessionId }) => {
    try {
      if (sessionId === 'all') {
        const sessions = listSessions();
        const count = sessions.length;

        sessions.forEach(s => {
          try {
            closeSession(s.id);
          } catch (err) {
            // Ignore individual close errors
          }
        });

        logger.info('Closed all SSH sessions', { count });

        return {
          content: [
            {
              type: 'text',
              text: `🔚 Closed ${count} SSH sessions`
            }
          ]
        };
      } else {
        closeSession(sessionId);

        logger.info('SSH session closed', { session: sessionId });

        return {
          content: [
            {
              type: 'text',
              text: `🔚 Session closed: ${sessionId}`
            }
          ]
        };
      }
    } catch (error) {
      logger.error('Failed to close session', {
        session: sessionId,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to close session: ${error.message}`
          }
        ]
      };
    }
  }
);

// Helper function to format duration
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  } else {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
}

// Server Group Management Tools

registerToolConditional(
  'ssh_execute_group',
  {
    description: 'Runs one command on every server belonging to the named group and returns a per-server success or failure report. Mutates remote state on each member and is not idempotent. Best-effort: the security policy of each server is evaluated independently, so readonly or restricted members are reported as failed without aborting the rest unless stopOnError is set. Strategy may be parallel, sequential, or rolling (delay applies between servers). Per-server timeout is 30000 ms; cwd defaults to the default_dir of each server.',
    inputSchema: {
      group: z.string().describe('Group name (e.g., "production", "staging", "all")'),
      command: z.string().describe('Command to execute'),
      strategy: z.enum(['parallel', 'sequential', 'rolling']).optional().describe('Execution strategy'),
      delay: z.number().optional().describe('Delay between servers in ms (for rolling)'),
      stopOnError: z.boolean().optional().describe('Stop execution on first error'),
      cwd: z.string().optional().describe('Working directory')
    }
  },
  async ({ group: groupName, command, strategy, delay, stopOnError, cwd }) => {
    try {
      // Execute command on each server in the group
      const result = await executeOnGroup(
        groupName,
        async (serverName) => {
          // Per-server policy: each server in the group is evaluated independently.
          // A server in readonly/restricted mode refuses the command; others
          // execute normally. Refusal is surfaced as a per-server failure rather
          // than aborting the whole group (group execution is best-effort).
          const denied = await applyServerPolicy(serverName, 'ssh_execute_group', { group: groupName, command, cwd }, command);
          if (denied) {
            const errorText = denied.content?.[0]?.text || 'Policy denied';
            return { stdout: '', stderr: errorText, code: -2, success: false };
          }
          const ssh = await getConnection(serverName);

          // Build full command with cwd if provided.
          // Use platform-appropriate syntax: Set-Location for Windows (cmd.exe
          // does not support `cd && `) vs cd && for Linux/macOS.
          const servers = await loadServerConfig();
          const serverConfig = servers[serverName.toLowerCase()];
          const workingDir = cwd || serverConfig?.default_dir;
          const platform = serverConfig?.platform || 'linux';
          let fullCommand;
          if (workingDir) {
            if (platform === 'windows') {
              // Single-quote escaping: replace ' with '' (PowerShell convention)
              const escapedDir = workingDir.replace(/'/g, '\'\'');
              fullCommand = `Set-Location '${escapedDir}'; ${command}`;
            } else {
              fullCommand = `cd ${workingDir} && ${command}`;
            }
          } else {
            fullCommand = command;
          }

          const execResult = await execCommandWithTimeout(ssh, fullCommand, { platform }, 30000);

          return {
            stdout: execResult.stdout,
            stderr: execResult.stderr,
            code: execResult.code,
            success: execResult.code === 0
          };
        },
        { strategy, delay, stopOnError }
      );

      // Format output
      let output = `🚀 Group Execution: ${groupName}\n`;
      output += `Command: ${command}\n`;
      output += `Strategy: ${result.strategy}\n`;
      output += '━'.repeat(60) + '\n\n';

      // Show results for each server
      result.results.forEach(({ server, success, result: execResult, error }) => {
        output += `📍 ${server}: ${success ? '✅ SUCCESS' : '❌ FAILED'}\n`;

        if (success && execResult) {
          if (execResult.stdout) {
            output += `   Output: ${execResult.stdout.substring(0, 200)}`;
            if (execResult.stdout.length > 200) output += '...';
            output += '\n';
          }
          if (execResult.stderr) {
            output += `   Stderr: ${execResult.stderr.substring(0, 100)}\n`;
          }
        } else if (error) {
          output += `   Error: ${error}\n`;
        }
        output += '\n';
      });

      // Summary
      output += '━'.repeat(60) + '\n';
      output += `Summary: ${result.summary.successful}/${result.summary.total} successful`;
      if (result.summary.failed > 0) {
        output += ` (${result.summary.failed} failed)`;
      }
      output += '\n';

      logger.info('Group command executed', {
        group: groupName,
        command: command.substring(0, 50),
        ...result.summary
      });

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logger.error('Group execution failed', {
        group: groupName,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Group execution error: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_group_manage',
  {
    description: 'Creates, updates, deletes, and inspects named server groups used by ssh_execute_group, persisting changes to local configuration only with no remote side effects. The action selects the operation: create, update, delete, add-servers, remove-servers, or list. Every action except list requires name; add-servers and remove-servers also require a non-empty servers array. list is read-only. Optional strategy, delay, and stopOnError set default group execution behavior.',
    inputSchema: {
      action: z.enum(['create', 'update', 'delete', 'list', 'add-servers', 'remove-servers']).describe('Action to perform'),
      name: z.string().optional().describe('Group name'),
      servers: z.array(z.string()).optional().describe('Server names'),
      description: z.string().optional().describe('Group description'),
      strategy: z.enum(['parallel', 'sequential', 'rolling']).optional().describe('Execution strategy'),
      delay: z.number().optional().describe('Delay between servers in ms'),
      stopOnError: z.boolean().optional().describe('Stop on error flag')
    }
  },
  async ({ action, name, servers, description, strategy, delay, stopOnError }) => {
    try {
      let result;
      let output = '';

      switch (action) {
      case 'create':
        if (!name) throw new Error('Group name required for create');
        result = createGroup(name, servers || [], {
          description,
          strategy,
          delay,
          stopOnError
        });
        output = `✅ Group '${name}' created\n`;
        output += `Servers: ${result.servers.join(', ') || 'none'}\n`;
        output += `Strategy: ${result.strategy}\n`;
        break;

      case 'update':
        if (!name) throw new Error('Group name required for update');
        result = updateGroup(name, {
          servers,
          description,
          strategy,
          delay,
          stopOnError
        });
        output = `✅ Group '${name}' updated\n`;
        output += `Servers: ${result.servers.join(', ')}\n`;
        break;

      case 'delete':
        if (!name) throw new Error('Group name required for delete');
        deleteGroup(name);
        output = `✅ Group '${name}' deleted`;
        break;

      case 'add-servers':
        if (!name) throw new Error('Group name required');
        if (!servers || servers.length === 0) throw new Error('Servers required');
        result = addServersToGroup(name, servers);
        output = `✅ Added ${servers.length} servers to '${name}'\n`;
        output += `Total servers: ${result.servers.length}\n`;
        output += `Members: ${result.servers.join(', ')}`;
        break;

      case 'remove-servers':
        if (!name) throw new Error('Group name required');
        if (!servers || servers.length === 0) throw new Error('Servers required');
        result = removeServersFromGroup(name, servers);
        output = `✅ Removed ${servers.length} servers from '${name}'\n`;
        output += `Remaining: ${result.servers.length}\n`;
        output += `Members: ${result.servers.join(', ') || 'none'}`;
        break;

      case 'list': {
        const groups = listGroups();
        output = '📋 Server Groups\n';
        output += '━'.repeat(60) + '\n\n';

        groups.forEach(group => {
          output += `📁 ${group.name}`;
          if (group.dynamic) output += ' (dynamic)';
          output += '\n';
          output += `   Description: ${group.description}\n`;
          output += `   Servers: ${group.serverCount} servers\n`;
          if (group.servers.length > 0) {
            output += `   Members: ${group.servers.slice(0, 5).join(', ')}`;
            if (group.servers.length > 5) output += ` ... +${group.servers.length - 5} more`;
            output += '\n';
          }
          output += `   Strategy: ${group.strategy || 'parallel'}\n`;
          if (group.delay) output += `   Delay: ${group.delay}ms\n`;
          if (group.stopOnError) output += '   Stop on error: yes\n';
          output += '\n';
        });

        output += '━'.repeat(60) + '\n';
        output += `Total groups: ${groups.length}`;
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
      }

      logger.info('Group management action completed', {
        action,
        name,
        servers: servers?.length
      });

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logger.error('Group management failed', {
        action,
        name,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Group management error: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_list_servers',
  {
    description: 'Lists all SSH servers defined in the loaded configuration, returning for each the name, host, user, port, authentication type (password or key), default directory, and description. Read-only and local: it reads configuration only and opens no SSH connections. Deliberately omits secrets, so no passwords, key paths, passphrases, or sudo passwords are returned. Takes no parameters. Useful as a first call to discover which server names other tools accept.',
    inputSchema: {}
  },
  async () => {
    const servers = await loadServerConfig();
    const serverInfo = Object.entries(servers).map(([name, config]) => ({
      name,
      host: config.host,
      user: config.user,
      port: config.port || '22',
      auth: config.password ? 'password' : 'key',
      defaultDir: config.default_dir || '',
      description: config.description || ''
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(serverInfo, null, 2),
        },
      ],
    };
  }
);

// New deploy tool for automated deployment
registerToolConditional(
  'ssh_deploy',
  {
    description: 'Deploys a list of local files to remote paths on the named server, uploading each to a temporary location first and then moving it into place. Mutates remote state. By default it backs up any existing target file before overwriting; backup can be disabled per call. Options can set owner and permissions, supply a sudo password, and name a single service to restart afterward. Detects sensible owner and permission defaults from the remote path. Runs pre and post deploy hooks. Blocked entirely on servers in readonly or restricted security mode.',
    inputSchema: {
      server: z.string().describe('Server name or alias'),
      files: z.array(z.object({
        local: z.string().describe('Local file path'),
        remote: z.string().describe('Remote file path')
      })).describe('Array of files to deploy'),
      options: z.object({
        owner: z.string().optional().describe('Set file owner (e.g., "user:group")'),
        permissions: z.string().optional().describe('Set file permissions (e.g., "644")'),
        backup: z.boolean().optional().default(true).describe('Backup existing files'),
        restart: z.string().optional().describe('Service to restart after deployment'),
        sudoPassword: z.string().optional().describe('Sudo password if needed (use with caution)')
      }).optional().describe('Deployment options')
    }
  },
  async ({ server, files, options = {} }) => {
    const denied = await applyServerPolicy(server, 'ssh_deploy', {
      files: files.map((f) => ({ local: f.local, remote: f.remote })),
      options,
    });
    if (denied) return denied;

    try {
      const ssh = await getConnection(server);

      // Execute pre-deploy hook
      await executeHook('pre-deploy', {
        server: server,
        files: files.map(f => f.local).join(', ')
      });

      const deployments = [];
      const results = [];

      // Prepare deployment for each file
      for (const file of files) {
        const tempFile = getTempFilename(path.basename(file.local));
        const needs = detectDeploymentNeeds(file.remote);

        // Merge detected needs with user options
        const deployOptions = {
          ...options,
          owner: options.owner || needs.suggestedOwner,
          permissions: options.permissions || needs.suggestedPerms
        };

        const strategy = buildDeploymentStrategy(file.remote, deployOptions);

        // Upload file to temp location first
        await ssh.putFile(file.local, tempFile);
        results.push(`✅ Uploaded ${path.basename(file.local)} to temp location`);

        // Execute deployment strategy
        const deployServers = await loadServerConfig();
        const deployServerConfig = deployServers[server.toLowerCase()];
        for (const step of strategy.steps) {
          const command = step.command.replace('{{tempFile}}', tempFile);

          const result = await execCommandWithTimeout(ssh, command, { platform: deployServerConfig?.platform }, 15000);

          if (result.code !== 0 && step.type !== 'backup') {
            throw new Error(`${step.type} failed: ${result.stderr}`);
          }

          if (step.type !== 'cleanup') {
            results.push(`✅ ${step.type}: ${file.remote}`);
          }
        }

        deployments.push({
          local: file.local,
          remote: file.remote,
          tempFile,
          strategy
        });
      }

      // Execute post-deploy hook
      await executeHook('post-deploy', {
        server: server,
        files: files.map(f => f.remote).join(', ')
      });

      return {
        content: [
          {
            type: 'text',
            text: `🚀 Deployment successful!\n\n${results.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Deployment failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Execute command with sudo support
registerToolConditional(
  'ssh_execute_sudo',
  {
    description: 'Runs a command with elevated privileges via sudo on the named server and returns the exit code and output. Prepends sudo when absent. If a password is given, or a sudo password is configured for the server, it is piped to sudo -S and masked in the returned output. Mutates remote state and can be destructive. Honors the cwd parameter or the server default directory and adapts to Linux or Windows. Timeout defaults to 30000 ms. Blocked entirely in readonly mode; in restricted mode the command must satisfy the allow and deny patterns.',
    inputSchema: {
      server: z.string().describe('Server name or alias'),
      command: z.string().describe('Command to execute with sudo'),
      password: z.string().optional().describe('Sudo password (will be masked in output)'),
      cwd: z.string().optional().describe('Working directory'),
      timeout: z.number().optional().describe('Command timeout in milliseconds (default: 30000)')
    }
  },
  async ({ server, command, password, cwd, timeout = 30000 }) => {
    // ssh_execute_sudo is in READONLY_BLOCKED_TOOLS, so readonly mode blocks
    // it at the tool level. In restricted mode the command itself is matched
    // against ALLOW/DENY patterns.
    const denied = await applyServerPolicy(server, 'ssh_execute_sudo', { command, cwd }, command);
    if (denied) return denied;

    try {
      const ssh = await getConnection(server);
      const servers = await loadServerConfig();
      const resolvedName = resolveServerName(server, servers);
      const serverConfig = servers[resolvedName];

      // Build the full command
      let fullCommand = command;

      // Add sudo if not already present
      if (!fullCommand.startsWith('sudo ')) {
        fullCommand = `sudo ${fullCommand}`;
      }

      // Add password if provided
      if (password) {
        fullCommand = `echo "${password}" | sudo -S ${command.replace(/^sudo /, '')}`;
      } else if (serverConfig?.sudo_password) {
        // Use configured sudo password if available
        fullCommand = `echo "${serverConfig.sudo_password}" | sudo -S ${command.replace(/^sudo /, '')}`;
      }

      // Add working directory if specified
      const platform = serverConfig?.platform || 'linux';
      if (cwd) {
        if (platform === 'windows') {
          const escapedDir = cwd.replace(/'/g, '\'\'');
          fullCommand = `Set-Location '${escapedDir}'; ${fullCommand}`;
        } else {
          fullCommand = `cd ${cwd} && ${fullCommand}`;
        }
      } else if (serverConfig?.default_dir) {
        if (platform === 'windows') {
          const escapedDir = serverConfig.default_dir.replace(/'/g, '\'\'');
          fullCommand = `Set-Location '${escapedDir}'; ${fullCommand}`;
        } else {
          fullCommand = `cd ${serverConfig.default_dir} && ${fullCommand}`;
        }
      }

      const result = await execCommandWithTimeout(ssh, fullCommand, { platform }, timeout);

      // Mask password in output for security
      const maskedCommand = fullCommand.replace(/echo "[^"]+" \| sudo -S/, 'sudo');

      return {
        content: [
          {
            type: 'text',
            text: `🔐 Sudo command executed\nServer: ${server}\nCommand: ${maskedCommand}\nExit code: ${result.code}\n\nOutput:\n${result.stdout || result.stderr}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Sudo execution failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Manage command aliases
registerToolConditional(
  'ssh_command_alias',
  {
    description: 'Manages local shorthand aliases that map a short name to a full command string, stored in local config with no remote execution or side effects. The action selects behavior: add (requires both alias and command), remove (requires alias), list to show all aliases tagged as profile or custom, or suggest to return existing aliases matching a search term passed in the command field. Adding an existing alias overwrites it.',
    inputSchema: {
      action: z.enum(['add', 'remove', 'list', 'suggest']).describe('Action to perform'),
      alias: z.string().optional().describe('Alias name (for add/remove)'),
      command: z.string().optional().describe('Command to alias (for add) or search term (for suggest)')
    }
  },
  async ({ action, alias, command }) => {
    try {
      switch (action) {
      case 'add': {
        if (!alias || !command) {
          throw new Error('Both alias and command are required for add action');
        }

        addCommandAlias(alias, command);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Command alias created: ${alias} -> ${command}`,
            },
          ],
        };
      }

      case 'remove': {
        if (!alias) {
          throw new Error('Alias is required for remove action');
        }

        removeCommandAlias(alias);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Command alias removed: ${alias}`,
            },
          ],
        };
      }

      case 'list': {
        const aliases = listCommandAliases();

        const aliasInfo = aliases.map(({ alias, command, isFromProfile, isCustom }) =>
          `  ${alias} -> ${command}${isFromProfile ? ' (profile)' : ''}${isCustom ? ' (custom)' : ''}`
        ).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: aliases.length > 0 ?
                `📝 Command aliases:\n${aliasInfo}` :
                '📝 No command aliases configured',
            },
          ],
        };
      }

      case 'suggest': {
        if (!command) {
          throw new Error('Command search term is required for suggest action');
        }

        const suggestions = suggestAliases(command);

        const suggestionInfo = suggestions.map(({ alias, command }) =>
          `  ${alias} -> ${command}`
        ).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: suggestions.length > 0 ?
                `💡 Suggested aliases for "${command}":\n${suggestionInfo}` :
                `💡 No aliases found matching "${command}"`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Command alias operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Manage hooks
registerToolConditional(
  'ssh_hooks',
  {
    description: 'Manages automation hooks that fire around SSH operations such as pre-deploy, toggling them on or off in local configuration only with no immediate remote action. The action selects behavior: list shows each hook with its enabled state, description, and action count; enable and disable flip a hook and both require the hook name; status summarizes which hooks are currently enabled versus disabled. Toggling persists and affects later operations.',
    inputSchema: {
      action: z.enum(['list', 'enable', 'disable', 'status']).describe('Action to perform'),
      hook: z.string().optional().describe('Hook name (for enable/disable)')
    }
  },
  async ({ action, hook }) => {
    try {
      switch (action) {
      case 'list': {
        const hooks = listHooks();

        const hooksInfo = hooks.map(({ name, enabled, description, actionCount }) =>
          `  ${enabled ? '✅' : '⭕'} ${name}: ${description} (${actionCount} actions)`
        ).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: hooks.length > 0 ?
                `🎣 Available hooks:\n${hooksInfo}` :
                '🎣 No hooks configured',
            },
          ],
        };
      }

      case 'enable': {
        if (!hook) {
          throw new Error('Hook name is required for enable action');
        }

        toggleHook(hook, true);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Hook enabled: ${hook}`,
            },
          ],
        };
      }

      case 'disable': {
        if (!hook) {
          throw new Error('Hook name is required for disable action');
        }

        toggleHook(hook, false);
        return {
          content: [
            {
              type: 'text',
              text: `⭕ Hook disabled: ${hook}`,
            },
          ],
        };
      }

      case 'status': {
        const hooks = listHooks();
        const enabledHooks = hooks.filter(h => h.enabled);
        const disabledHooks = hooks.filter(h => !h.enabled);

        return {
          content: [
            {
              type: 'text',
              text: `🎣 Hook status:\n  Enabled: ${enabledHooks.map(h => h.name).join(', ') || 'none'}\n  Disabled: ${disabledHooks.map(h => h.name).join(', ') || 'none'}`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Hook operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Manage profiles
registerToolConditional(
  'ssh_profile',
  {
    description: 'Manages SSH Manager profiles that bundle command aliases and hooks for different project types, affecting local configuration only with no remote side effects. The action selects behavior: list shows available profiles and the active one, current shows the active profile details, and switch activates a named profile and requires the profile argument. A successful switch reports that Claude Code must be restarted before the new profile takes effect.',
    inputSchema: {
      action: z.enum(['list', 'switch', 'current']).describe('Action to perform'),
      profile: z.string().optional().describe('Profile name (for switch)')
    }
  },
  async ({ action, profile }) => {
    try {
      switch (action) {
      case 'list': {
        const profiles = listProfiles();

        const profileInfo = profiles.map(p =>
          `  ${p.name}: ${p.description} (${p.aliasCount} aliases, ${p.hookCount} hooks)`
        ).join('\n');

        const current = getActiveProfileName();

        return {
          content: [
            {
              type: 'text',
              text: profiles.length > 0 ?
                `📚 Available profiles (current: ${current}):\n${profileInfo}` :
                '📚 No profiles found',
            },
          ],
        };
      }

      case 'switch': {
        if (!profile) {
          throw new Error('Profile name is required for switch action');
        }

        if (setActiveProfile(profile)) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Switched to profile: ${profile}\n⚠️  Restart Claude Code to apply profile changes`,
              },
            ],
          };
        } else {
          throw new Error(`Failed to switch to profile: ${profile}`);
        }
      }

      case 'current': {
        const current = getActiveProfileName();
        const profile = loadProfile();

        return {
          content: [
            {
              type: 'text',
              text: `📦 Current profile: ${current}\n📝 Description: ${profile.description || 'No description'}\n🔧 Aliases: ${Object.keys(profile.commandAliases || {}).length}\n🎣 Hooks: ${Object.keys(profile.hooks || {}).length}`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Profile operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Connection management tool
registerToolConditional(
  'ssh_connection_status',
  {
    description: 'Inspects and manages the pooled SSH connections held by this server process; affects only local in-memory connections, never remote state. The action parameter selects: status lists active connections with age and keepalive (read-only); reconnect closes then reopens one connection; disconnect closes one connection; cleanup drops aged-out and dead connections. The server parameter is required for reconnect and disconnect and ignored otherwise.',
    inputSchema: {
      action: z.enum(['status', 'reconnect', 'disconnect', 'cleanup']).describe('Action to perform'),
      server: z.string().optional().describe('Server name (for reconnect/disconnect)')
    }
  },
  async ({ action, server }) => {
    try {
      switch (action) {
      case 'status': {
        const activeConnections = [];
        const now = Date.now();

        for (const [serverName, ssh] of connections.entries()) {
          const timestamp = connectionTimestamps.get(serverName);
          const ageMinutes = Math.floor((now - timestamp) / 1000 / 60);
          const isValid = await isConnectionValid(ssh);

          activeConnections.push({
            server: serverName,
            status: isValid ? '✅ Active' : '❌ Dead',
            age: `${ageMinutes} minutes`,
            keepalive: keepaliveIntervals.has(serverName) ? '✅' : '❌'
          });
        }

        const statusInfo = activeConnections.length > 0 ?
          activeConnections.map(c => `  ${c.server}: ${c.status} (age: ${c.age}, keepalive: ${c.keepalive})`).join('\n') :
          '  No active connections';

        return {
          content: [
            {
              type: 'text',
              text: `🔌 Connection Pool Status:\n${statusInfo}\n\nSettings:\n  Timeout: ${CONNECTION_TIMEOUT / 1000 / 60} minutes\n  Keepalive: Every ${KEEPALIVE_INTERVAL / 1000 / 60} minutes`,
            },
          ],
        };
      }

      case 'reconnect': {
        if (!server) {
          throw new Error('Server name is required for reconnect action');
        }

        const normalizedName = server.toLowerCase();
        if (connections.has(normalizedName)) {
          closeConnection(normalizedName);
        }

        await getConnection(server);
        return {
          content: [
            {
              type: 'text',
              text: `♻️  Reconnected to ${server}`,
            },
          ],
        };
      }

      case 'disconnect': {
        if (!server) {
          throw new Error('Server name is required for disconnect action');
        }

        closeConnection(server);
        return {
          content: [
            {
              type: 'text',
              text: `🔌 Disconnected from ${server}`,
            },
          ],
        };
      }

      case 'cleanup': {
        const oldCount = connections.size;
        cleanupOldConnections();

        // Also check and remove dead connections
        for (const [serverName, ssh] of connections.entries()) {
          const isValid = await isConnectionValid(ssh);
          if (!isValid) {
            closeConnection(serverName);
          }
        }

        const cleaned = oldCount - connections.size;
        return {
          content: [
            {
              type: 'text',
              text: `🧹 Cleanup complete: ${cleaned} connections closed, ${connections.size} active`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Connection management failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// SSH Tunnel Management - Create tunnel
registerToolConditional(
  'ssh_tunnel_create',
  {
    description: 'Opens a new SSH connection to the named server and starts a port-forwarding or SOCKS proxy tunnel that keeps running until closed. The type parameter selects local forward, remote forward, or dynamic SOCKS5 proxy. localPort is always required; remoteHost and remotePort are required for local and remote types but ignored for dynamic. localHost defaults to 127.0.0.1. Returns a tunnel ID used later to close it.',
    inputSchema: {
      server: z.string().describe('Server name or alias'),
      type: z.enum(['local', 'remote', 'dynamic']).describe('Tunnel type'),
      localHost: z.string().optional().describe('Local host (default: 127.0.0.1)'),
      localPort: z.number().describe('Local port'),
      remoteHost: z.string().optional().describe('Remote host (not needed for dynamic)'),
      remotePort: z.number().optional().describe('Remote port (not needed for dynamic)')
    }
  },
  async ({ server, type, localHost, localPort, remoteHost, remotePort }) => {
    try {
      const servers = await loadServerConfig();
      const resolvedName = resolveServerName(server, servers);

      if (!resolvedName) {
        throw new Error(`Server "${server}" not found`);
      }

      const serverConfig = servers[resolvedName];
      const ssh = new SSHManager(serverConfig);
      await ssh.connect();

      const config = {
        type,
        localHost: localHost || '127.0.0.1',
        localPort,
        remoteHost,
        remotePort
      };

      const tunnel = await createTunnel(resolvedName, ssh, config);

      let output = '✅ SSH tunnel created\n';
      output += `ID: ${tunnel.id}\n`;
      output += `Type: ${type}\n`;
      output += `Local: ${config.localHost}:${localPort}\n`;

      if (type === 'local') {
        output += `Remote: ${remoteHost}:${remotePort}\n`;
        output += `\n📌 Access remote ${remoteHost}:${remotePort} via local ${config.localHost}:${localPort}`;
      } else if (type === 'remote') {
        output += `Remote: ${remoteHost}:${remotePort}\n`;
        output += `\n📌 Remote ${remoteHost}:${remotePort} will forward to local ${config.localHost}:${localPort}`;
      } else if (type === 'dynamic') {
        output += `SOCKS proxy: ${config.localHost}:${localPort}\n`;
        output += `\n📌 SOCKS5 proxy available at ${config.localHost}:${localPort}`;
        output += `\n💡 Configure browser/app: SOCKS5 proxy ${config.localHost}:${localPort}`;
      }

      logger.info('SSH tunnel created', {
        id: tunnel.id,
        server: resolvedName,
        type,
        local: `${config.localHost}:${localPort}`
      });

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logger.error('Failed to create tunnel', { error: error.message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Tunnel creation failed: ${error.message}`
          }
        ]
      };
    }
  }
);

// List active tunnels
registerToolConditional(
  'ssh_tunnel_list',
  {
    description: 'Lists currently active SSH tunnels tracked by this process, showing each tunnel ID, server, type, state, local and remote endpoints, active and total connection counts, bytes transferred, error count, and timestamps. Read-only: it does not create, modify, or close anything. The optional server parameter filters results to one server; omit it to list every active tunnel across all servers.',
    inputSchema: {
      server: z.string().optional().describe('Filter by server name')
    }
  },
  async ({ server }) => {
    try {
      const servers = await loadServerConfig();
      let resolvedName = null;

      if (server) {
        resolvedName = resolveServerName(server, servers);
        if (!resolvedName) {
          throw new Error(`Server "${server}" not found`);
        }
      }

      const tunnels = listTunnels(resolvedName);

      if (tunnels.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '📋 No active tunnels'
            }
          ]
        };
      }

      let output = '📋 Active SSH Tunnels\n';
      output += '━'.repeat(60) + '\n\n';

      tunnels.forEach(tunnel => {
        output += `🔧 ${tunnel.id}\n`;
        output += `   Server: ${tunnel.server}\n`;
        output += `   Type: ${tunnel.type}\n`;
        output += `   State: ${tunnel.state}\n`;
        output += `   Local: ${tunnel.config.localHost}:${tunnel.config.localPort}\n`;

        if (tunnel.type !== 'dynamic') {
          output += `   Remote: ${tunnel.config.remoteHost}:${tunnel.config.remotePort}\n`;
        }

        output += `   Active connections: ${tunnel.activeConnections}\n`;
        output += `   Total connections: ${tunnel.stats.connectionsTotal}\n`;
        output += `   Bytes transferred: ${(tunnel.stats.bytesTransferred / 1024).toFixed(2)} KB\n`;
        output += `   Errors: ${tunnel.stats.errors}\n`;
        output += `   Created: ${new Date(tunnel.created).toLocaleString()}\n`;
        output += `   Last activity: ${new Date(tunnel.lastActivity).toLocaleString()}\n`;
        output += '\n';
      });

      output += '━'.repeat(60) + '\n';
      output += `Total tunnels: ${tunnels.length}`;

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logger.error('Failed to list tunnels', { error: error.message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to list tunnels: ${error.message}`
          }
        ]
      };
    }
  }
);

// Close a tunnel
registerToolConditional(
  'ssh_tunnel_close',
  {
    description: 'Tears down active SSH tunnels created earlier, freeing the bound local ports; this affects only local tunnel state, not the remote host. Exactly one of tunnelId or server must be supplied: tunnelId closes that single tunnel, while server closes every tunnel for the named server and reports how many were closed. Supplying neither raises an error. Closing is final and cannot be undone.',
    inputSchema: {
      tunnelId: z.string().optional().describe('Tunnel ID to close'),
      server: z.string().optional().describe('Close all tunnels for this server')
    }
  },
  async ({ tunnelId, server }) => {
    try {
      if (!tunnelId && !server) {
        throw new Error('Either tunnelId or server must be specified');
      }

      let output = '';

      if (tunnelId) {
        // Close specific tunnel
        closeTunnel(tunnelId);
        output = `✅ Tunnel ${tunnelId} closed`;

        logger.info('SSH tunnel closed', { id: tunnelId });
      } else if (server) {
        // Close all tunnels for server
        const servers = await loadServerConfig();
        const resolvedName = resolveServerName(server, servers);

        if (!resolvedName) {
          throw new Error(`Server "${server}" not found`);
        }

        const count = closeServerTunnels(resolvedName);
        output = `✅ Closed ${count} tunnel(s) for server ${resolvedName}`;

        logger.info('Server tunnels closed', {
          server: resolvedName,
          count
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logger.error('Failed to close tunnel', { error: error.message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to close tunnel: ${error.message}`
          }
        ]
      };
    }
  }
);

// Manage SSH host keys
registerToolConditional(
  'ssh_key_manage',
  {
    description: 'Manages SSH host key fingerprints in your local known_hosts file for the named server. The action parameter selects: verify, check, and list are read-only comparisons or listings; accept adds or updates the host key in known_hosts; remove deletes it. accept and remove mutate local state and are blocked on servers configured as readonly. server is required for every action except list. autoAccept defaults to false and should be used with caution.',
    inputSchema: {
      action: z.enum(['verify', 'accept', 'remove', 'list', 'check']).describe('Action to perform'),
      server: z.string().optional().describe('Server name (required for most actions)'),
      autoAccept: z.boolean().optional().describe('Automatically accept new keys (use with caution)')
    }
  },
  async ({ action, server, autoAccept = false }) => {
    // Mutating actions (accept, remove) are blocked in readonly mode at the
    // tool level. Pure-read actions (verify, list, check) are allowed regardless,
    // so we only gate when the action would modify state.
    if (server && (action === 'accept' || action === 'remove')) {
      const denied = await applyServerPolicy(server, 'ssh_key_manage', { action, autoAccept });
      if (denied) return denied;
    }
    try {
      const servers = await loadServerConfig();
      let resolvedName, serverConfig, host, port;

      // Resolve server details for actions that need them
      if (server && action !== 'list') {
        resolvedName = resolveServerName(server, servers);
        if (!resolvedName) {
          throw new Error(`Server "${server}" not found`);
        }
        serverConfig = servers[resolvedName];
        host = serverConfig.host;
        port = parseInt(serverConfig.port || '22');
      }

      switch (action) {
      case 'verify': {
        // Check if host key has changed
        const verification = await hasHostKeyChanged(host, port);

        if (verification.changed) {
          // Execute pre-connect-key-change hook
          await executeHook('pre-connect-key-change', {
            server: resolvedName,
            host,
            port,
            currentFingerprints: verification.currentFingerprints,
            newFingerprints: verification.newFingerprints
          });

          let output = `⚠️  SSH host key has changed for ${server} (${host}:${port})\n\n`;
          output += 'Current fingerprints:\n';
          verification.currentFingerprints.forEach(fp => {
            output += `  ${fp}\n`;
          });
          output += '\nNew fingerprints:\n';
          verification.newFingerprints.forEach(fp => {
            output += `  ${fp}\n`;
          });
          output += '\n⚠️  This could indicate a security issue or server reinstallation.\n';
          output += 'Use \'ssh_key_manage\' with action \'accept\' to update the key if you trust this change.';

          return {
            content: [
              {
                type: 'text',
                text: output
              }
            ]
          };
        } else {
          let output = `✅ SSH host key verified for ${server} (${host}:${port})\n`;
          output += `Reason: ${verification.reason}\n`;

          if (verification.reason === 'not_in_known_hosts') {
            output += '\nℹ️  Host not in known_hosts. Use \'accept\' action to add it.';
          }

          return {
            content: [
              {
                type: 'text',
                text: output
              }
            ]
          };
        }
      }

      case 'accept': {
        // Check if key exists
        const isKnown = isHostKnown(host, port);

        if (isKnown) {
          // Update existing key
          await updateHostKey(host, port);

          // Execute post-key-update hook
          await executeHook('post-key-update', {
            server: resolvedName,
            host,
            port,
            action: 'updated'
          });

          logger.info('SSH host key updated', { server: resolvedName, host, port });

          return {
            content: [
              {
                type: 'text',
                text: `✅ SSH host key updated for ${server} (${host}:${port})\nThe new key has been accepted and saved.`
              }
            ]
          };
        } else {
          // Add new key
          await addHostKey(host, port);

          // Execute post-key-update hook
          await executeHook('post-key-update', {
            server: resolvedName,
            host,
            port,
            action: 'added'
          });

          logger.info('SSH host key added', { server: resolvedName, host, port });

          return {
            content: [
              {
                type: 'text',
                text: `✅ SSH host key added for ${server} (${host}:${port})\nThe key has been saved to known_hosts.`
              }
            ]
          };
        }
      }

      case 'remove': {
        removeHostKey(host, port);

        logger.info('SSH host key removed', { server: resolvedName, host, port });

        return {
          content: [
            {
              type: 'text',
              text: `✅ SSH host key removed for ${server} (${host}:${port})`
            }
          ]
        };
      }

      case 'check': {
        // Get current fingerprints
        const currentKeys = getCurrentHostKey(host, port);
        const newKeys = await getHostKeyFingerprint(host, port);

        let output = `🔑 SSH Host Keys for ${server} (${host}:${port})\n`;
        output += '━'.repeat(60) + '\n\n';

        if (currentKeys && currentKeys.length > 0) {
          output += '📋 Keys in known_hosts:\n';
          currentKeys.forEach(key => {
            output += `  ${key.type}: ${key.fingerprint}\n`;
          });
        } else {
          output += '⚠️  No keys found in known_hosts\n';
        }

        output += '\n🌐 Keys from server:\n';
        if (newKeys && newKeys.length > 0) {
          newKeys.forEach(key => {
            output += `  ${key.type}: ${key.fingerprint}\n`;
          });
        } else {
          output += '  ❌ Could not fetch keys from server\n';
        }

        return {
          content: [
            {
              type: 'text',
              text: output
            }
          ]
        };
      }

      case 'list': {
        const knownHosts = listKnownHosts();

        let output = '🔑 Known SSH Hosts\n';
        output += '━'.repeat(60) + '\n\n';

        if (knownHosts.length === 0) {
          output += 'No hosts in known_hosts file\n';
        } else {
          // Map server names to known hosts
          const serverMap = new Map();
          for (const [name, config] of Object.entries(servers)) {
            const key = `${config.host}:${config.port || 22}`;
            serverMap.set(key, name);
          }

          knownHosts.forEach(entry => {
            const serverName = serverMap.get(`${entry.host}:${entry.port}`);
            output += `📍 ${entry.host}:${entry.port}`;
            if (serverName) {
              output += ` (${serverName})`;
            }
            output += '\n';

            entry.keys.forEach(key => {
              output += `   ${key.type}: ${key.fingerprint}\n`;
            });
            output += '\n';
          });
        }

        output += '━'.repeat(60) + '\n';
        output += `Total: ${knownHosts.length} hosts`;

        return {
          content: [
            {
              type: 'text',
              text: output
            }
          ]
        };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      logger.error('SSH key management failed', { action, server, error: error.message });

      return {
        content: [
          {
            type: 'text',
            text: `❌ SSH key management error: ${error.message}`
          }
        ]
      };
    }
  }
);

// Manage server aliases
registerToolConditional(
  'ssh_alias',
  {
    description: 'Manages local name aliases that let you reference a configured server by a shorter or alternative name. The action parameter selects add, remove, or list. add creates an alias pointing to an existing server and requires both alias and server; remove deletes an alias and requires alias; list shows all aliases (read-only). add and remove persist the alias mapping locally. The target server must already exist for add to succeed.',
    inputSchema: {
      action: z.enum(['add', 'remove', 'list']).describe('Action to perform'),
      alias: z.string().optional().describe('Alias name (for add/remove)'),
      server: z.string().optional().describe('Server name (for add)')
    }
  },
  async ({ action, alias, server }) => {
    try {
      switch (action) {
      case 'add': {
        if (!alias || !server) {
          throw new Error('Both alias and server are required for add action');
        }

        const servers = await loadServerConfig();
        const resolvedName = resolveServerName(server, servers);

        if (!resolvedName) {
          throw new Error(`Server "${server}" not found`);
        }

        addAlias(alias, resolvedName);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Alias created: ${alias} -> ${resolvedName}`,
            },
          ],
        };
      }

      case 'remove': {
        if (!alias) {
          throw new Error('Alias is required for remove action');
        }

        removeAlias(alias);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Alias removed: ${alias}`,
            },
          ],
        };
      }

      case 'list': {
        const aliases = listAliases();
        const servers = await loadServerConfig();

        const aliasInfo = aliases.map(({ alias, target }) => {
          const server = servers[target];
          return `  ${alias} -> ${target} (${server?.host || 'unknown'})`;
        }).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: aliases.length > 0 ?
                `📝 Server aliases:\n${aliasInfo}` :
                '📝 No aliases configured',
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Alias operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// ============================================================================
// BACKUP & RESTORE TOOLS
// ============================================================================

registerToolConditional(
  'ssh_backup_create',
  {
    description: 'Creates a database or file backup on the remote server over SSH, writing a compressed archive plus a JSON metadata file into backupDir. Supports mysql, postgresql, mongodb, and files (full is not yet implemented and errors). Database types require database; files requires paths. After writing it prunes backups older than retention days (default 7); compress defaults to true. Runs pre-backup and post-backup hooks.',
    inputSchema: {
      server: z.string().describe('Server name'),
      type: z.enum(['mysql', 'postgresql', 'mongodb', 'files', 'full'])
        .describe('Backup type: mysql, postgresql, mongodb, files, or full'),
      name: z.string().describe('Backup name (e.g., production, app-data)'),
      database: z.string().optional()
        .describe('Database name (required for db types)'),
      dbUser: z.string().optional()
        .describe('Database user'),
      dbPassword: z.string().optional()
        .describe('Database password'),
      dbHost: z.string().optional()
        .describe('Database host (default: localhost)'),
      dbPort: z.number().optional()
        .describe('Database port'),
      paths: z.array(z.string()).optional()
        .describe('Paths to backup (for files type)'),
      exclude: z.array(z.string()).optional()
        .describe('Patterns to exclude from backup'),
      backupDir: z.string().optional()
        .describe(`Backup directory (default: ${DEFAULT_BACKUP_DIR})`),
      retention: z.number().optional()
        .describe('Retention period in days (default: 7)'),
      compress: z.boolean().optional()
        .describe('Compress backup (default: true)')
    }
  },
  async ({ server: serverName, type, name, database, dbUser, dbPassword, dbHost, dbPort, paths, exclude, backupDir, retention = 7, compress = true }) => {
    const denied = await applyServerPolicy(serverName, 'ssh_backup_create', { type, name, database, paths });
    if (denied) return denied;

    try {
      const ssh = await getConnection(serverName);

      // Execute pre-backup hook
      await executeHook('pre-backup', {
        server: serverName,
        type,
        database,
        paths
      });

      const backupDirectory = backupDir || DEFAULT_BACKUP_DIR;
      const backupId = generateBackupId(type, name);
      const backupFile = getBackupFilePath(backupId, backupDirectory);
      const metadataPath = getBackupMetadataPath(backupId, backupDirectory);

      // Ensure backup directory exists with proper error handling
      const mkdirResult = await ssh.execCommand(`mkdir -p "${backupDirectory}"`);
      if (mkdirResult.code !== 0) {
        throw new Error(`Failed to create backup directory: ${mkdirResult.stderr || mkdirResult.stdout}`);
      }

      logger.info(`Creating backup: ${backupId}`, {
        server: serverName,
        type,
        name,
        database
      });

      // Build backup command based on type
      let backupCommand;

      switch (type) {
      case BACKUP_TYPES.MYSQL:
        if (!database) {
          throw new Error('database parameter required for MySQL backup');
        }
        backupCommand = buildMySQLDumpCommand({
          database,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
          outputFile: backupFile,
          compress
        });
        break;

      case BACKUP_TYPES.POSTGRESQL:
        if (!database) {
          throw new Error('database parameter required for PostgreSQL backup');
        }
        backupCommand = buildPostgreSQLDumpCommand({
          database,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
          outputFile: backupFile,
          compress
        });
        break;

      case BACKUP_TYPES.MONGODB: {
        if (!database) {
          throw new Error('database parameter required for MongoDB backup');
        }
        const mongoOutputDir = backupFile.replace('.gz', '');
        backupCommand = buildMongoDBDumpCommand({
          database,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
          outputDir: mongoOutputDir,
          compress
        });
        break;
      }

      case BACKUP_TYPES.FILES:
        if (!paths || paths.length === 0) {
          throw new Error('paths parameter required for files backup');
        }
        backupCommand = buildFilesBackupCommand({
          paths,
          outputFile: backupFile,
          exclude: exclude || [],
          compress
        });
        break;

      case BACKUP_TYPES.FULL:
        // Full backup combines database and files
        throw new Error('Full backup not yet implemented. Use separate mysql/postgresql/files backups.');

      default:
        throw new Error(`Unknown backup type: ${type}`);
      }

      // Execute backup command
      const result = await ssh.execCommand(backupCommand);

      if (result.code !== 0) {
        throw new Error(`Backup failed: ${result.stderr || result.stdout}`);
      }

      // Get backup file size
      const sizeResult = await ssh.execCommand(`stat -f%z "${backupFile}" 2>/dev/null || stat -c%s "${backupFile}" 2>/dev/null`);
      const size = parseInt(sizeResult.stdout.trim()) || 0;

      // Create and save metadata
      const metadata = createBackupMetadata(backupId, type, {
        server: serverName,
        database,
        paths,
        compress,
        retention
      });
      metadata.size = size;
      metadata.status = 'completed';

      const saveMetadataCmd = buildSaveMetadataCommand(metadata, metadataPath);
      await ssh.execCommand(saveMetadataCmd);

      // Cleanup old backups based on retention
      const cleanupCmd = buildCleanupCommand(backupDirectory, retention);
      await ssh.execCommand(cleanupCmd);

      // Execute post-backup hook
      await executeHook('post-backup', {
        server: serverName,
        backupId,
        type,
        size,
        success: true
      });

      logger.info(`Backup created successfully: ${backupId}`, {
        size,
        location: backupFile
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              backup_id: backupId,
              type,
              size,
              size_human: `${(size / 1024 / 1024).toFixed(2)} MB`,
              location: backupFile,
              metadata_path: metadataPath,
              created_at: metadata.created_at,
              retention_days: retention
            }, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Backup creation failed', {
        server: serverName,
        type,
        error: error.message
      });

      await executeHook('post-backup', {
        server: serverName,
        type,
        success: false,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Backup failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_backup_list',
  {
    description: 'Lists existing backups found in backupDir on the remote server, returning each backup id, type, database or paths, size, compression, retention, status, and creation time parsed from stored metadata. Read-only: it inspects the filesystem and mutates nothing. Optional type filters results to mysql, postgresql, mongodb, files, or full. backupDir defaults to the configured backup directory.',
    inputSchema: {
      server: z.string().describe('Server name'),
      type: z.enum(['mysql', 'postgresql', 'mongodb', 'files', 'full']).optional()
        .describe('Filter by backup type'),
      backupDir: z.string().optional()
        .describe(`Backup directory (default: ${DEFAULT_BACKUP_DIR})`)
    }
  },
  async ({ server: serverName, type, backupDir }) => {
    try {
      const ssh = await getConnection(serverName);
      const backupDirectory = backupDir || DEFAULT_BACKUP_DIR;

      logger.info(`Listing backups on ${serverName}`, { type, backupDir: backupDirectory });

      // Build and execute list command
      const listCommand = buildListBackupsCommand(backupDirectory, type);
      const result = await ssh.execCommand(listCommand);

      if (result.code !== 0 && result.stderr) {
        throw new Error(`Failed to list backups: ${result.stderr}`);
      }

      // Parse backups list
      const backups = parseBackupsList(result.stdout);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: backups.length,
              backups: backups.map(b => ({
                id: b.id,
                type: b.type,
                created_at: b.created_at,
                database: b.database,
                paths: b.paths,
                size: b.size,
                size_human: b.size ? `${(b.size / 1024 / 1024).toFixed(2)} MB` : 'unknown',
                compressed: b.compressed,
                retention_days: b.retention,
                status: b.status
              }))
            }, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Failed to list backups', {
        server: serverName,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to list backups: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_backup_restore',
  {
    description: 'Restores a previously created backup identified by backupId, reading its metadata to pick the engine. This is destructive and overwrites the target: PostgreSQL runs pg_restore with --clean --if-exists which DROPs existing objects, MongoDB runs mongorestore --drop, and MySQL pipes the dump into the live database replacing matching objects. Supports mysql, postgresql, mongodb, and files. Runs pre-restore and post-restore hooks.',
    inputSchema: {
      server: z.string().describe('Server name'),
      backupId: z.string().describe('Backup ID to restore'),
      database: z.string().optional()
        .describe('Target database name (for db restores)'),
      dbUser: z.string().optional()
        .describe('Database user'),
      dbPassword: z.string().optional()
        .describe('Database password'),
      dbHost: z.string().optional()
        .describe('Database host (default: localhost)'),
      dbPort: z.number().optional()
        .describe('Database port'),
      targetPath: z.string().optional()
        .describe('Target path for files restore (default: /)'),
      backupDir: z.string().optional()
        .describe(`Backup directory (default: ${DEFAULT_BACKUP_DIR})`)
    }
  },
  async ({ server: serverName, backupId, database, dbUser, dbPassword, dbHost, dbPort, targetPath, backupDir }) => {
    const denied = await applyServerPolicy(serverName, 'ssh_backup_restore', { backupId, database, targetPath });
    if (denied) return denied;

    try {
      const ssh = await getConnection(serverName);
      const backupDirectory = backupDir || DEFAULT_BACKUP_DIR;
      const metadataPath = getBackupMetadataPath(backupId, backupDirectory);

      // Read backup metadata
      const metadataResult = await ssh.execCommand(`cat "${metadataPath}"`);
      if (metadataResult.code !== 0) {
        throw new Error(`Backup not found: ${backupId}`);
      }

      const metadata = JSON.parse(metadataResult.stdout);
      const backupFile = getBackupFilePath(backupId, backupDirectory);

      // Execute pre-restore hook
      await executeHook('pre-restore', {
        server: serverName,
        backupId,
        type: metadata.type,
        database
      });

      logger.info(`Restoring backup: ${backupId}`, {
        server: serverName,
        type: metadata.type
      });

      // Build restore command
      const restoreCommand = buildRestoreCommand(metadata.type, backupFile, {
        database: database || metadata.database,
        user: dbUser,
        password: dbPassword,
        host: dbHost,
        port: dbPort,
        targetPath
      });

      // Execute restore
      const result = await ssh.execCommand(restoreCommand);

      if (result.code !== 0) {
        throw new Error(`Restore failed: ${result.stderr || result.stdout}`);
      }

      // Execute post-restore hook
      await executeHook('post-restore', {
        server: serverName,
        backupId,
        type: metadata.type,
        success: true
      });

      logger.info(`Backup restored successfully: ${backupId}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              backup_id: backupId,
              type: metadata.type,
              restored_at: new Date().toISOString(),
              original_created: metadata.created_at,
              database: database || metadata.database,
              paths: metadata.paths
            }, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Restore failed', {
        server: serverName,
        backupId,
        error: error.message
      });

      await executeHook('post-restore', {
        server: serverName,
        backupId,
        success: false,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Restore failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_backup_schedule',
  {
    description: 'Schedules a recurring backup on the remote server by writing an executable bash script to /usr/local/bin/ssh-manager-backup-NAME.sh and installing a crontab entry for the given cron expression. Mutates the remote filesystem and crontab, and typically needs root to write that path. Supports mysql, postgresql, mongodb, and files; the generated script also deletes backups older than retention days (default 7).',
    inputSchema: {
      server: z.string().describe('Server name'),
      schedule: z.string().describe('Cron schedule (e.g., "0 2 * * *" for daily at 2 AM)'),
      type: z.enum(['mysql', 'postgresql', 'mongodb', 'files'])
        .describe('Backup type'),
      name: z.string().describe('Backup name'),
      database: z.string().optional()
        .describe('Database name (for db types)'),
      paths: z.array(z.string()).optional()
        .describe('Paths to backup (for files type)'),
      retention: z.number().optional()
        .describe('Retention period in days (default: 7)')
    }
  },
  async ({ server: serverName, schedule, type, name, database, paths, retention = 7 }) => {
    const denied = await applyServerPolicy(serverName, 'ssh_backup_schedule', { schedule, type, name, database, paths });
    if (denied) return denied;

    try {
      const ssh = await getConnection(serverName);

      // Build backup script path
      const scriptPath = `/usr/local/bin/ssh-manager-backup-${name}.sh`;
      const backupDirectory = DEFAULT_BACKUP_DIR;

      // Create backup script
      let scriptContent = '#!/bin/bash\n\n';
      scriptContent += `# SSH Manager automated backup: ${name}\n`;
      scriptContent += `# Type: ${type}\n`;
      scriptContent += `# Created: ${new Date().toISOString()}\n\n`;

      const backupId = `\${BACKUP_TYPE}_${name}_$(date +%Y%m%d_%H%M%S)_\${RANDOM}`;
      const backupFile = `${backupDirectory}/${backupId}.gz`;

      scriptContent += `BACKUP_DIR="${backupDirectory}"\n`;
      scriptContent += `BACKUP_TYPE="${type}"\n`;
      scriptContent += `BACKUP_ID="${backupId}"\n`;
      scriptContent += `BACKUP_FILE="${backupFile}"\n\n`;
      scriptContent += 'mkdir -p "$BACKUP_DIR"\n\n';

      // Add backup command based on type
      switch (type) {
      case BACKUP_TYPES.MYSQL:
        scriptContent += `mysqldump --single-transaction --routines --triggers ${database} | gzip > "$BACKUP_FILE"\n`;
        break;
      case BACKUP_TYPES.POSTGRESQL:
        scriptContent += `pg_dump --format=custom --clean --if-exists ${database} | gzip > "$BACKUP_FILE"\n`;
        break;
      case BACKUP_TYPES.MONGODB:
        scriptContent += `mongodump --db ${database} --out /tmp/mongo_\${RANDOM} && tar -czf "$BACKUP_FILE" -C /tmp mongo_*\n`;
        break;
      case BACKUP_TYPES.FILES:
        scriptContent += `tar -czf "$BACKUP_FILE" ${paths.join(' ')}\n`;
        break;
      }

      // Add cleanup command
      scriptContent += '\n# Cleanup old backups\n';
      scriptContent += `find "$BACKUP_DIR" -name "*_${name}_*" -type f -mtime +${retention} -delete\n`;

      // Save script to remote server
      const escapedScript = scriptContent.replace(/'/g, '\'\\\'\'');
      await ssh.execCommand(`echo '${escapedScript}' > "${scriptPath}" && chmod +x "${scriptPath}"`);

      // Add to crontab
      const cronComment = `ssh-manager-backup-${name}`;
      const cronCommand = buildCronScheduleCommand(schedule, scriptPath, cronComment);
      const cronResult = await ssh.execCommand(cronCommand);

      if (cronResult.code !== 0) {
        throw new Error(`Failed to schedule backup: ${cronResult.stderr}`);
      }

      logger.info(`Backup scheduled: ${name}`, {
        server: serverName,
        schedule,
        type,
        retention
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              name,
              schedule,
              type,
              database,
              paths,
              retention_days: retention,
              script_path: scriptPath,
              next_run: 'Use crontab -l to see next run time'
            }, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Failed to schedule backup', {
        server: serverName,
        name,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to schedule backup: ${error.message}`
          }
        ]
      };
    }
  }
);

// ============================================================================
// HEALTH CHECKS & MONITORING TOOLS
// ============================================================================

registerToolConditional(
  'ssh_health_check',
  {
    description: 'Runs a comprehensive read-only health check on the named server by executing diagnostic shell commands over SSH, then returns parsed JSON with overall status, CPU, memory, disk usage, and uptime. It only reads metrics and changes nothing on the remote host. Set detailed to true to additionally include load average and network metrics; it defaults to false. Critical CPU, memory, or disk conditions are surfaced in a critical_issues list.',
    inputSchema: {
      server: z.string().describe('Server name'),
      detailed: z.boolean().optional()
        .describe('Include detailed metrics (network, load average)')
    }
  },
  async ({ server: serverName, detailed = false }) => {
    try {
      const ssh = await getConnection(serverName);

      logger.info(`Running health check on ${serverName}`, { detailed });

      // Build and execute comprehensive health check
      const healthCommand = buildComprehensiveHealthCheckCommand();
      const result = await ssh.execCommand(healthCommand);

      if (result.code !== 0) {
        throw new Error(`Health check failed: ${result.stderr}`);
      }

      // Parse results
      const health = parseComprehensiveHealthCheck(result.stdout);

      // Build response
      const response = {
        server: serverName,
        timestamp: new Date().toISOString(),
        overall_status: health.overall_status || HEALTH_STATUS.UNKNOWN,
        cpu: health.cpu,
        memory: health.memory,
        disks: health.disks,
        uptime: health.uptime
      };

      if (detailed) {
        response.load_average = health.load_average;
        response.network = health.network;
      }

      // Check if there are any critical issues
      const criticalIssues = [];
      if (health.cpu && health.cpu.status === HEALTH_STATUS.CRITICAL) {
        criticalIssues.push(`CPU usage critical: ${health.cpu.percent}%`);
      }
      if (health.memory && health.memory.status === HEALTH_STATUS.CRITICAL) {
        criticalIssues.push(`Memory usage critical: ${health.memory.percent}%`);
      }
      if (health.disks) {
        for (const disk of health.disks) {
          if (disk.status === HEALTH_STATUS.CRITICAL) {
            criticalIssues.push(`Disk ${disk.mount} critical: ${disk.percent}%`);
          }
        }
      }

      if (criticalIssues.length > 0) {
        response.critical_issues = criticalIssues;
      }

      logger.info(`Health check completed: ${health.overall_status}`, {
        server: serverName,
        status: health.overall_status
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Health check failed', {
        server: serverName,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Health check failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_service_status',
  {
    description: 'Checks the running state of the named system services on a remote server by querying each one over SSH, returning JSON per service plus running and stopped counts and an aggregate health rating. Read-only: it inspects status without starting, stopping, or restarting anything. The services array parameter is required and lists the service names to check, for example nginx, mysql, or docker; common names are resolved to their actual unit names automatically.',
    inputSchema: {
      server: z.string().describe('Server name'),
      services: z.array(z.string())
        .describe('Service names to check (e.g., nginx, mysql, docker)')
    }
  },
  async ({ server: serverName, services }) => {
    try {
      const ssh = await getConnection(serverName);

      logger.info(`Checking service status on ${serverName}`, {
        services: services.join(', ')
      });

      const serviceStatuses = [];

      // Check each service
      for (const serviceName of services) {
        const resolvedName = resolveServiceName(serviceName);
        const statusCommand = buildServiceStatusCommand(resolvedName);
        const result = await ssh.execCommand(statusCommand);

        const status = parseServiceStatus(result.stdout, serviceName);
        serviceStatuses.push(status);
      }

      // Count running vs stopped
      const running = serviceStatuses.filter(s => s.status === 'running').length;
      const stopped = serviceStatuses.filter(s => s.status === 'stopped').length;

      const response = {
        server: serverName,
        timestamp: new Date().toISOString(),
        total: serviceStatuses.length,
        running,
        stopped,
        services: serviceStatuses,
        overall_health: stopped === 0 ? HEALTH_STATUS.HEALTHY :
          running > stopped ? HEALTH_STATUS.WARNING :
            HEALTH_STATUS.CRITICAL
      };

      logger.info('Service check completed', {
        server: serverName,
        running,
        stopped
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Service status check failed', {
        server: serverName,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Service status check failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_process_manager',
  {
    description: 'Lists, inspects, or terminates processes on a remote server over SSH. The action parameter selects: list returns top processes (read-only), info returns details for one process (read-only), and kill sends a signal to terminate a process and mutates remote state. pid is required for kill and info. kill is blocked on servers configured as readonly. signal defaults to TERM, sortBy defaults to cpu, and limit defaults to 20; filter narrows the list by name or command.',
    inputSchema: {
      server: z.string().describe('Server name'),
      action: z.enum(['list', 'kill', 'info'])
        .describe('Action: list processes, kill process, or get process info'),
      pid: z.number().optional()
        .describe('Process ID (required for kill and info actions)'),
      signal: z.enum(['TERM', 'KILL', 'HUP', 'INT', 'QUIT']).optional()
        .describe('Signal to send when killing (default: TERM)'),
      sortBy: z.enum(['cpu', 'memory']).optional()
        .describe('Sort processes by CPU or memory (default: cpu)'),
      limit: z.number().optional()
        .describe('Number of processes to return (default: 20)'),
      filter: z.string().optional()
        .describe('Filter processes by name/command')
    }
  },
  async ({ server: serverName, action, pid, signal = 'TERM', sortBy = 'cpu', limit = 20, filter }) => {
    // Only the `kill` action mutates remote state — gate just that branch so
    // operators on readonly servers can still `list` / `info` processes.
    if (action === 'kill') {
      const denied = await applyServerPolicy(serverName, 'ssh_process_manager', { action, pid, signal });
      if (denied) return denied;
    }
    try {
      const ssh = await getConnection(serverName);

      logger.info(`Process manager action: ${action}`, {
        server: serverName,
        pid,
        filter
      });

      let response;

      switch (action) {
      case 'list': {
        const listCommand = buildProcessListCommand({ sortBy, limit, filter });
        const result = await ssh.execCommand(listCommand);

        if (result.code !== 0) {
          throw new Error(`Failed to list processes: ${result.stderr}`);
        }

        const processes = parseProcessList(result.stdout);

        response = {
          server: serverName,
          action: 'list',
          count: processes.length,
          sorted_by: sortBy,
          processes
        };
        break;
      }

      case 'kill': {
        if (!pid) {
          throw new Error('pid parameter required for kill action');
        }

        // Get process info first
        const infoCommand = buildProcessInfoCommand(pid);
        const infoResult = await ssh.execCommand(infoCommand);

        let processInfo = {};
        if (infoResult.code === 0 && infoResult.stdout) {
          try {
            processInfo = JSON.parse(infoResult.stdout);
          } catch (e) {
            // Process might not exist
          }
        }

        // Kill the process
        const killCommand = buildKillProcessCommand(pid, signal);
        const killResult = await ssh.execCommand(killCommand);

        if (killResult.code !== 0) {
          throw new Error(`Failed to kill process ${pid}: ${killResult.stderr}`);
        }

        response = {
          server: serverName,
          action: 'kill',
          pid,
          signal,
          process: processInfo,
          success: true
        };

        logger.info(`Process killed: ${pid}`, {
          server: serverName,
          signal
        });
        break;
      }

      case 'info': {
        if (!pid) {
          throw new Error('pid parameter required for info action');
        }

        const infoCommand = buildProcessInfoCommand(pid);
        const result = await ssh.execCommand(infoCommand);

        if (result.code !== 0 || !result.stdout) {
          throw new Error(`Process ${pid} not found`);
        }

        const processInfo = JSON.parse(result.stdout);

        response = {
          server: serverName,
          action: 'info',
          process: processInfo
        };
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Process manager failed', {
        server: serverName,
        action,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Process manager failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_alert_setup',
  {
    description: 'Configures and evaluates CPU, memory, and disk usage alert thresholds for a remote server. The action parameter selects: set writes the threshold config to /etc/ssh-manager-alerts.json on the remote host (mutating, may need write access to /etc, and is blocked on readonly servers); get reads back that config; check reads current metrics and compares them to stored thresholds. get and check are read-only. enabled defaults to true; check errors if no config exists yet.',
    inputSchema: {
      server: z.string().describe('Server name'),
      action: z.enum(['set', 'get', 'check'])
        .describe('Action: set thresholds, get config, or check current metrics against thresholds'),
      cpuThreshold: z.number().optional()
        .describe('CPU usage threshold percentage (e.g., 80)'),
      memoryThreshold: z.number().optional()
        .describe('Memory usage threshold percentage (e.g., 90)'),
      diskThreshold: z.number().optional()
        .describe('Disk usage threshold percentage (e.g., 85)'),
      enabled: z.boolean().optional()
        .describe('Enable or disable alerts (default: true)')
    }
  },
  async ({ server: serverName, action, cpuThreshold, memoryThreshold, diskThreshold, enabled = true }) => {
    // `set` writes config on the remote; `get` and `check` are read-only.
    if (action === 'set') {
      const denied = await applyServerPolicy(serverName, 'ssh_alert_setup', { action, cpuThreshold, memoryThreshold, diskThreshold, enabled });
      if (denied) return denied;
    }
    try {
      const ssh = await getConnection(serverName);
      const configPath = '/etc/ssh-manager-alerts.json';

      logger.info(`Alert setup action: ${action}`, {
        server: serverName
      });

      let response;

      switch (action) {
      case 'set': {
        // Create alert configuration
        const config = createAlertConfig({
          cpu: cpuThreshold,
          memory: memoryThreshold,
          disk: diskThreshold,
          enabled
        });

        // Save to server
        const saveCommand = buildSaveAlertConfigCommand(config, configPath);
        const saveResult = await ssh.execCommand(saveCommand);

        if (saveResult.code !== 0) {
          throw new Error(`Failed to save alert config: ${saveResult.stderr}`);
        }

        response = {
          server: serverName,
          action: 'set',
          config,
          config_path: configPath,
          success: true
        };

        logger.info('Alert thresholds configured', {
          server: serverName,
          thresholds: config
        });
        break;
      }

      case 'get': {
        // Load configuration
        const loadCommand = buildLoadAlertConfigCommand(configPath);
        const result = await ssh.execCommand(loadCommand);

        let config = {};
        if (result.stdout && result.stdout.trim()) {
          try {
            config = JSON.parse(result.stdout);
          } catch (e) {
            config = { error: 'Failed to parse config' };
          }
        }

        response = {
          server: serverName,
          action: 'get',
          config,
          config_path: configPath
        };
        break;
      }

      case 'check': {
        // Load thresholds
        const loadCommand = buildLoadAlertConfigCommand(configPath);
        const loadResult = await ssh.execCommand(loadCommand);

        let thresholds = {};
        if (loadResult.stdout && loadResult.stdout.trim()) {
          try {
            thresholds = JSON.parse(loadResult.stdout);
          } catch (e) {
            throw new Error('No alert configuration found. Use action=set to configure.');
          }
        } else {
          throw new Error('No alert configuration found. Use action=set to configure.');
        }

        if (!thresholds.enabled) {
          response = {
            server: serverName,
            action: 'check',
            message: 'Alerts are disabled',
            thresholds
          };
          break;
        }

        // Get current metrics
        const healthCommand = buildComprehensiveHealthCheckCommand();
        const healthResult = await ssh.execCommand(healthCommand);

        if (healthResult.code !== 0) {
          throw new Error('Failed to get current metrics');
        }

        const metrics = parseComprehensiveHealthCheck(healthResult.stdout);

        // Check thresholds
        const alerts = checkAlertThresholds(metrics, thresholds);

        response = {
          server: serverName,
          action: 'check',
          thresholds,
          current_metrics: {
            cpu: metrics.cpu,
            memory: metrics.memory,
            disks: metrics.disks
          },
          alerts,
          alert_count: alerts.length,
          status: alerts.length === 0 ? 'ok' : 'alerts_triggered'
        };

        if (alerts.length > 0) {
          logger.warn('Health alerts triggered', {
            server: serverName,
            alert_count: alerts.length,
            alerts
          });
        }
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Alert setup failed', {
        server: serverName,
        action,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Alert setup failed: ${error.message}`
          }
        ]
      };
    }
  }
);

// ============================================================================
// DATABASE MANAGEMENT TOOLS
// ============================================================================

registerToolConditional(
  'ssh_db_dump',
  {
    description: 'Dumps a database to a file on the remote server over SSH; it reads data only and does not modify the database. Supports mysql (using --single-transaction --routines --triggers), postgresql (custom format with --clean --if-exists, restorable via pg_restore), and mongodb. compress defaults to true and gzips the output. The optional tables list applies to MySQL and PostgreSQL only and is ignored for MongoDB.',
    inputSchema: {
      server: z.string().describe('Server name'),
      type: z.enum(['mysql', 'postgresql', 'mongodb'])
        .describe('Database type'),
      database: z.string().describe('Database name'),
      outputFile: z.string().describe('Output file path (will be created on remote server)'),
      dbUser: z.string().optional().describe('Database user'),
      dbPassword: z.string().optional().describe('Database password'),
      dbHost: z.string().optional().describe('Database host (default: localhost)'),
      dbPort: z.number().optional().describe('Database port'),
      compress: z.boolean().optional().describe('Compress output with gzip (default: true)'),
      tables: z.array(z.string()).optional().describe('Specific tables to dump (MySQL/PostgreSQL only)')
    }
  },
  async ({ server: serverName, type, database, outputFile, dbUser, dbPassword, dbHost, dbPort, compress = true, tables }) => {
    const denied = await applyServerPolicy(serverName, 'ssh_db_dump', { type, database, outputFile, tables });
    if (denied) return denied;

    try {
      const ssh = await getConnection(serverName);

      logger.info(`Dumping ${type} database: ${database}`, {
        server: serverName,
        compress
      });

      // Build dump command based on type
      let dumpCommand;
      const options = {
        database,
        user: dbUser,
        password: dbPassword,
        host: dbHost,
        port: dbPort,
        outputFile,
        compress,
        tables
      };

      switch (type) {
      case DB_TYPES.MYSQL:
        dumpCommand = buildDBMySQLDumpCommand(options);
        break;
      case DB_TYPES.POSTGRESQL:
        dumpCommand = buildDBPostgreSQLDumpCommand(options);
        break;
      case DB_TYPES.MONGODB:
        options.outputDir = outputFile.replace(/\.(tar\.gz|gz)$/, '');
        dumpCommand = buildDBMongoDBDumpCommand(options);
        break;
      default:
        throw new Error(`Unsupported database type: ${type}`);
      }

      // Execute dump
      const result = await ssh.execCommand(dumpCommand);

      if (result.code !== 0) {
        throw new Error(`Dump failed: ${result.stderr || result.stdout}`);
      }

      // Get file size
      const sizeCommand = `stat -f%z "${outputFile}" 2>/dev/null || stat -c%s "${outputFile}" 2>/dev/null`;
      const sizeResult = await ssh.execCommand(sizeCommand);
      const size = parseSize(sizeResult.stdout);

      logger.info(`Database dump completed: ${formatBytes(size)}`, {
        server: serverName,
        database,
        size
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              server: serverName,
              type,
              database,
              output_file: outputFile,
              size_bytes: size,
              size_human: formatBytes(size),
              compressed: compress,
              timestamp: new Date().toISOString()
            }, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Database dump failed', {
        server: serverName,
        type,
        database,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Database dump failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_db_import',
  {
    description: 'Imports a dump file into a target database on the remote server and is destructive to existing data. PostgreSQL uses pg_restore --clean --if-exists which DROPs existing objects before loading; MongoDB uses mongorestore with --drop controlled by the drop flag (default true); MySQL pipes the file into the live database, replacing objects defined in it. Supports mysql, postgresql, mongodb. Compressed .gz inputs are decompressed automatically.',
    inputSchema: {
      server: z.string().describe('Server name'),
      type: z.enum(['mysql', 'postgresql', 'mongodb'])
        .describe('Database type'),
      database: z.string().describe('Target database name'),
      inputFile: z.string().describe('Input file path (on remote server)'),
      dbUser: z.string().optional().describe('Database user'),
      dbPassword: z.string().optional().describe('Database password'),
      dbHost: z.string().optional().describe('Database host (default: localhost)'),
      dbPort: z.number().optional().describe('Database port'),
      drop: z.boolean().optional().describe('Drop existing collections/tables before import (MongoDB only, default: true)')
    }
  },
  async ({ server: serverName, type, database, inputFile, dbUser, dbPassword, dbHost, dbPort, drop = true }) => {
    const denied = await applyServerPolicy(serverName, 'ssh_db_import', { type, database, inputFile, drop });
    if (denied) return denied;

    try {
      const ssh = await getConnection(serverName);

      logger.info(`Importing ${type} database: ${database}`, {
        server: serverName,
        inputFile
      });

      // Build import command based on type
      let importCommand;
      const options = {
        database,
        user: dbUser,
        password: dbPassword,
        host: dbHost,
        port: dbPort,
        inputFile,
        drop
      };

      switch (type) {
      case DB_TYPES.MYSQL:
        importCommand = buildMySQLImportCommand(options);
        break;
      case DB_TYPES.POSTGRESQL:
        importCommand = buildPostgreSQLImportCommand(options);
        break;
      case DB_TYPES.MONGODB:
        options.inputPath = inputFile;
        importCommand = buildMongoDBRestoreCommand(options);
        break;
      default:
        throw new Error(`Unsupported database type: ${type}`);
      }

      // Execute import
      const result = await ssh.execCommand(importCommand);

      if (result.code !== 0) {
        throw new Error(`Import failed: ${result.stderr || result.stdout}`);
      }

      logger.info('Database import completed', {
        server: serverName,
        database
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              server: serverName,
              type,
              database,
              input_file: inputFile,
              timestamp: new Date().toISOString(),
              message: `Database ${database} imported successfully`
            }, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Database import failed', {
        server: serverName,
        type,
        database,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Database import failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_db_list',
  {
    description: 'Lists database objects on the remote server for the given engine without modifying anything. When database is provided it lists the tables (SQL) or collections (MongoDB) of that database; when omitted it lists all databases with common system databases filtered out. Supports mysql, postgresql, and mongodb. Returns the items and a count. Read-only and safe to call repeatedly.',
    inputSchema: {
      server: z.string().describe('Server name'),
      type: z.enum(['mysql', 'postgresql', 'mongodb'])
        .describe('Database type'),
      database: z.string().optional()
        .describe('Database name (if provided, lists tables/collections; if omitted, lists databases)'),
      dbUser: z.string().optional().describe('Database user'),
      dbPassword: z.string().optional().describe('Database password'),
      dbHost: z.string().optional().describe('Database host (default: localhost)'),
      dbPort: z.number().optional().describe('Database port')
    }
  },
  async ({ server: serverName, type, database, dbUser, dbPassword, dbHost, dbPort }) => {
    try {
      const ssh = await getConnection(serverName);

      const listType = database ? 'tables/collections' : 'databases';
      logger.info(`Listing ${listType} for ${type}`, {
        server: serverName,
        database
      });

      let listCommand;
      const options = {
        database,
        user: dbUser,
        password: dbPassword,
        host: dbHost,
        port: dbPort
      };

      // Build command based on type and what to list
      if (database) {
        // List tables/collections
        switch (type) {
        case DB_TYPES.MYSQL:
          listCommand = buildMySQLListTablesCommand(options);
          break;
        case DB_TYPES.POSTGRESQL:
          listCommand = buildPostgreSQLListTablesCommand(options);
          break;
        case DB_TYPES.MONGODB:
          listCommand = buildMongoDBListCollectionsCommand(options);
          break;
        }
      } else {
        // List databases
        switch (type) {
        case DB_TYPES.MYSQL:
          listCommand = buildMySQLListDatabasesCommand(options);
          break;
        case DB_TYPES.POSTGRESQL:
          listCommand = buildPostgreSQLListDatabasesCommand(options);
          break;
        case DB_TYPES.MONGODB:
          listCommand = buildMongoDBListDatabasesCommand(options);
          break;
        }
      }

      // Execute list command
      const result = await ssh.execCommand(listCommand);

      if (result.code !== 0 && result.stderr) {
        throw new Error(`List failed: ${result.stderr}`);
      }

      // Parse results
      const items = database
        ? parseTableList(result.stdout)
        : parseDatabaseList(result.stdout, type);

      const response = {
        success: true,
        server: serverName,
        type,
        listing: database ? 'tables' : 'databases'
      };

      if (database) {
        response.database = database;
        response.tables = items;
        response.count = items.length;
      } else {
        response.databases = items;
        response.count = items.length;
      }

      logger.info(`Listed ${items.length} ${listType}`, {
        server: serverName,
        type
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Database list failed', {
        server: serverName,
        type,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Database list failed: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_db_query',
  {
    description: 'Runs a read-only query against a remote database. For mysql and postgresql it is strictly limited to SELECT: the query must begin with SELECT and any insert, update, delete, drop, create, alter, truncate, grant, revoke, or exec keyword is rejected before execution. For mongodb it runs a find() and requires the collection parameter. Returns the raw command output as text.',
    inputSchema: {
      server: z.string().describe('Server name'),
      type: z.enum(['mysql', 'postgresql', 'mongodb'])
        .describe('Database type'),
      database: z.string().describe('Database name'),
      query: z.string().describe('SQL query (SELECT only) or MongoDB find query'),
      collection: z.string().optional()
        .describe('Collection name (MongoDB only)'),
      dbUser: z.string().optional().describe('Database user'),
      dbPassword: z.string().optional().describe('Database password'),
      dbHost: z.string().optional().describe('Database host (default: localhost)'),
      dbPort: z.number().optional().describe('Database port')
    }
  },
  async ({ server: serverName, type, database, query, collection, dbUser, dbPassword, dbHost, dbPort }) => {
    try {
      const ssh = await getConnection(serverName);

      // Validate query safety for SQL databases
      if (type !== DB_TYPES.MONGODB && !isSafeQuery(query)) {
        throw new Error('Only SELECT queries are allowed for security reasons');
      }

      logger.info(`Executing ${type} query`, {
        server: serverName,
        database,
        query: query.substring(0, 100)
      });

      let queryCommand;
      const options = {
        database,
        query,
        user: dbUser,
        password: dbPassword,
        host: dbHost,
        port: dbPort
      };

      // Build query command based on type
      switch (type) {
      case DB_TYPES.MYSQL:
        queryCommand = buildMySQLQueryCommand(options);
        break;
      case DB_TYPES.POSTGRESQL:
        queryCommand = buildPostgreSQLQueryCommand(options);
        break;
      case DB_TYPES.MONGODB:
        if (!collection) {
          throw new Error('collection parameter required for MongoDB queries');
        }
        options.collection = collection;
        queryCommand = buildMongoDBQueryCommand(options);
        break;
      default:
        throw new Error(`Unsupported database type: ${type}`);
      }

      // Execute query
      const result = await ssh.execCommand(queryCommand);

      if (result.code !== 0) {
        throw new Error(`Query failed: ${result.stderr || result.stdout}`);
      }

      // Parse output (basic parsing, output depends on database type)
      const output = result.stdout.trim();
      // Derive the real row count from each engine's output structure rather than the
      // raw line count, which counts cosmetic wrapper/header lines (issue #45).
      const rowCount = countQueryRows(output, type);

      logger.info('Query executed successfully', {
        server: serverName,
        database,
        rows: rowCount
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              server: serverName,
              type,
              database,
              collection: collection || null,
              query,
              row_count: rowCount,
              output: output,
              timestamp: new Date().toISOString()
            }, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Database query failed', {
        server: serverName,
        type,
        database,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Database query failed: ${error.message}`
          }
        ]
      };
    }
  }
);

// Clean up connections on shutdown.
//
// A stdio MCP server is torn down by its host (e.g. Claude Code) closing our
// stdin — not by SIGINT, which only arrives on an interactive Ctrl-C. Handling
// SIGINT alone meant the process was never signalled on normal teardown and was
// reparented to init as an orphan, leaking one node process per session. Listen
// for SIGTERM and stdin EOF as well, and make shutdown idempotent so overlapping
// signals can't double-dispose.
let isShuttingDown = false;
function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`\n🔌 Closing SSH connections (${reason})...`);
  for (const [name, ssh] of connections) {
    try {
      ssh.dispose();
      console.error(`  Closed connection to ${name}`);
    } catch (error) {
      console.error(`  Error closing ${name}: ${error.message}`);
    }
  }
  // Best-effort flush of any final stdout the host may still read, but never
  // hang if it has already stopped reading: a short unref'd timer forces exit
  // regardless, so this can't reintroduce a stuck process.
  const force = setTimeout(() => process.exit(0), 250);
  if (typeof force.unref === 'function') force.unref();
  process.stdout.write('', () => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
// When launched as a stdio MCP server the host closes our stdin to signal
// teardown; treat that EOF as a shutdown request. 'end' fires when the readable
// side is fully consumed; 'close' covers the fd being torn down without a clean
// 'end'. The idempotent guard above makes the overlap harmless.
process.stdin.on('end', () => shutdown('stdin ended'));
process.stdin.on('close', () => shutdown('stdin closed'));

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const servers = await loadServerConfig();
  const serverList = Object.keys(servers);
  const activeProfile = getActiveProfileName();

  console.error('🚀 MCP SSH Manager Server started');
  console.error(`📦 Profile: ${activeProfile}`);
  console.error(`🖥️  Available servers: ${serverList.length > 0 ? serverList.join(', ') : 'none configured'}`);
  console.error('💡 Use server-manager.py to configure servers');
  console.error('🔄 Connection management: Auto-reconnect enabled, 30min timeout');

  // Set up periodic cleanup of old connections (every 10 minutes).
  // unref() so this timer alone never keeps the process alive after the
  // stdio transport has closed.
  const cleanupTimer = setInterval(() => {
    cleanupOldConnections();
  }, 10 * 60 * 1000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

main().catch(console.error);
