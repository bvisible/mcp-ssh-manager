#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NodeSSH } from 'node-ssh';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Initialize logger
logger.info('MCP SSH Manager starting', { 
  logLevel: process.env.SSH_LOG_LEVEL || 'INFO',
  verbose: process.env.SSH_VERBOSE === 'true'
});

// Initialize hooks system
initializeHooks().catch(error => {
  logger.error('Failed to initialize hooks', { error: error.message });
});

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

// Load server configuration from .env
function loadServerConfig() {
  const servers = {};

  // Parse environment variables to extract servers
  const knownFields = ['HOST', 'USER', 'PASSWORD', 'PORT', 'KEYPATH', 'DEFAULT_DIR', 'DESCRIPTION', 'SUDO_PASSWORD', 'ALIAS'];

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('SSH_SERVER_')) {
      // Remove SSH_SERVER_ prefix
      const remaining = key.substring(11);

      // Find the last known field in the key
      let serverName = null;
      let field = null;

      for (const knownField of knownFields) {
        const idx = remaining.lastIndexOf('_' + knownField);
        if (idx !== -1) {
          serverName = remaining.substring(0, idx).toLowerCase();
          field = knownField.toLowerCase();
          break;
        }
      }

      if (serverName && field) {
        if (!servers[serverName]) {
          servers[serverName] = {};
        }
        servers[serverName][field] = value;
      }
    }
  }

  return servers;
}

// Check if a connection is still valid
async function isConnectionValid(ssh) {
  try {
    // Try to execute a simple command to check if connection is alive
    const result = await ssh.execCommand('echo "ping"', { timeout: 5000 });
    return result.stdout.trim() === 'ping';
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

// Get or create SSH connection with reconnection support
async function getConnection(serverName) {
  const servers = loadServerConfig();

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
  const ssh = new NodeSSH();

  try {
    const connectionConfig = {
      host: serverConfig.host,
      username: serverConfig.user,
      port: parseInt(serverConfig.port || '22'),
      keepaliveInterval: 60000, // Send keepalive every 60 seconds
      keepaliveCountMax: 10, // Allow 10 keepalive failures before disconnecting
      readyTimeout: 30000, // 30 second timeout for initial connection
    };

    // Use password or SSH key
    if (serverConfig.password) {
      connectionConfig.password = serverConfig.password;
    } else if (serverConfig.keypath) {
      const keyPath = serverConfig.keypath.replace('~', process.env.HOME);
      connectionConfig.privateKey = fs.readFileSync(keyPath, 'utf8');
    }

    await ssh.connect(connectionConfig);
    connections.set(normalizedName, ssh);
    connectionTimestamps.set(normalizedName, Date.now());

    // Setup keepalive
    setupKeepalive(normalizedName, ssh);

    logger.logConnection(serverName, 'established', {
      host: serverConfig.host,
      port: connectionConfig.port,
      method: serverConfig.password ? 'password' : 'key'
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

// Register available tools
server.registerTool(
  'ssh_execute',
  {
    description: 'Execute command on remote SSH server',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      command: z.string().describe('Command to execute'),
      cwd: z.string().optional().describe('Working directory (optional, uses default if configured)')
    }
  },
  async ({ server: serverName, command, cwd }) => {
    try {
      const ssh = await getConnection(serverName);

      // Expand command aliases
      const expandedCommand = expandCommandAlias(command);

      // Execute hooks for bench commands
      if (expandedCommand.includes('bench update')) {
        await executeHook('pre-bench-update', {
          server: serverName,
          sshConnection: ssh,
          defaultDir: cwd
        });
      }

      // Use provided cwd, or default_dir from config, or no cwd
      const servers = loadServerConfig();
      const serverConfig = servers[serverName.toLowerCase()];
      const workingDir = cwd || serverConfig?.default_dir;
      const fullCommand = workingDir ? `cd ${workingDir} && ${expandedCommand}` : expandedCommand;

      // Log command execution
      const startTime = logger.logCommand(serverName, fullCommand, workingDir);

      const result = await ssh.execCommand(fullCommand);
      
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              server: serverName,
              command: fullCommand,
              stdout: result.stdout,
              stderr: result.stderr,
              code: result.code,
              success: result.code === 0,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error: ${error.message}`,
          },
        ],
      };
    }
  }
);

server.registerTool(
  'ssh_upload',
  {
    description: 'Upload file to remote SSH server',
    inputSchema: {
      server: z.string().describe('Server name'),
      localPath: z.string().describe('Local file path'),
      remotePath: z.string().describe('Remote destination path')
    }
  },
  async ({ server: serverName, localPath, remotePath }) => {
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

      return {
        content: [
          {
            type: 'text',
            text: `✅ File uploaded successfully\nServer: ${serverName}\nLocal: ${localPath}\nRemote: ${remotePath}`,
          },
        ],
      };
    } catch (error) {
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

server.registerTool(
  'ssh_download',
  {
    description: 'Download file from remote SSH server',
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

server.registerTool(
  'ssh_sync',
  {
    description: 'Synchronize files/folders between local and remote via rsync',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      source: z.string().describe('Source path (use "local:" or "remote:" prefix)'),
      destination: z.string().describe('Destination path (use "local:" or "remote:" prefix)'),
      exclude: z.array(z.string()).optional().describe('Patterns to exclude from sync'),
      dryRun: z.boolean().optional().describe('Perform dry run without actual changes'),
      delete: z.boolean().optional().describe('Delete files in destination not in source'),
      compress: z.boolean().optional().describe('Compress during transfer'),
      verbose: z.boolean().optional().describe('Show detailed progress'),
      checksum: z.boolean().optional().describe('Use checksum instead of timestamp for comparison')
    }
  },
  async ({ server: serverName, source, destination, exclude = [], dryRun = false, delete: deleteFiles = false, compress = true, verbose = false, checksum = false }) => {
    try {
      const ssh = await getConnection(serverName);
      const servers = loadServerConfig();
      const serverConfig = servers[serverName.toLowerCase()];
      
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
      
      if (verbose || logger.verbose) {
        rsyncOptions.push('--progress', '--stats');
      }
      
      // Add exclude patterns
      exclude.forEach(pattern => {
        rsyncOptions.push('--exclude', pattern);
      });
      
      let command;
      let localPath;
      let remotePath;
      
      if (direction === 'push') {
        localPath = cleanSource;
        remotePath = cleanDest;
        
        // Check if local path exists
        if (!fs.existsSync(localPath)) {
          throw new Error(`Local path does not exist: ${localPath}`);
        }
        
        // Build rsync command for push
        command = `rsync ${rsyncOptions.join(' ')} "${localPath}" "${serverConfig.user}@${serverConfig.host}:${remotePath}"`;
      } else {
        localPath = cleanDest;
        remotePath = cleanSource;
        
        // Build rsync command for pull
        command = `rsync ${rsyncOptions.join(' ')} "${serverConfig.user}@${serverConfig.host}:${remotePath}" "${localPath}"`;
      }
      
      // Add SSH options if using non-standard port or key
      const sshOptions = [];
      if (serverConfig.port && serverConfig.port !== '22') {
        sshOptions.push(`-p ${serverConfig.port}`);
      }
      if (serverConfig.keypath) {
        const keyPath = serverConfig.keypath.replace('~', process.env.HOME);
        sshOptions.push(`-i ${keyPath}`);
      }
      
      if (sshOptions.length > 0) {
        command = command.replace('rsync ', `rsync -e "ssh ${sshOptions.join(' ')}" `);
      }
      
      logger.info(`Starting rsync ${direction}`, {
        server: serverName,
        source: direction === 'push' ? localPath : remotePath,
        destination: direction === 'push' ? remotePath : localPath,
        dryRun,
        deleteFiles
      });
      
      const startTime = Date.now();
      
      // Execute rsync via local shell (not SSH)
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      try {
        const { stdout, stderr } = await execAsync(command, {
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
        });
        
        const duration = Date.now() - startTime;
        
        // Parse rsync output for statistics
        let stats = {
          filesTransferred: 0,
          totalSize: 0,
          totalTime: duration
        };
        
        // Extract statistics from rsync output
        const filesMatch = stdout.match(/Number of files transferred: (\d+)/);
        const sizeMatch = stdout.match(/Total transferred file size: ([\d,]+) bytes/);
        const speedMatch = stdout.match(/([\d.]+) bytes\/sec/);
        
        if (filesMatch) stats.filesTransferred = parseInt(filesMatch[1]);
        if (sizeMatch) stats.totalSize = parseInt(sizeMatch[1].replace(/,/g, ''));
        if (speedMatch) stats.speed = parseFloat(speedMatch[1]);
        
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
        
        if (verbose || dryRun) {
          resultText += '\n📋 Detailed output:\n' + stdout;
          if (stderr && stderr.trim()) {
            resultText += '\n⚠️ Warnings:\n' + stderr;
          }
        }
        
        return {
          content: [
            {
              type: 'text',
              text: resultText
            }
          ]
        };
      } catch (execError) {
        logger.error(`Rsync ${direction} failed`, {
          server: serverName,
          error: execError.message,
          stdout: execError.stdout,
          stderr: execError.stderr
        });
        
        throw new Error(`Rsync failed: ${execError.stderr || execError.message}`);
      }
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

server.registerTool(
  'ssh_list_servers',
  {
    description: 'List all configured SSH servers',
    inputSchema: {}
  },
  async () => {
    const servers = loadServerConfig();
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
server.registerTool(
  'ssh_deploy',
  {
    description: 'Deploy files to remote server with automatic permission handling',
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
        for (const step of strategy.steps) {
          const command = step.command.replace('{{tempFile}}', tempFile);

          const result = await ssh.execCommand(command);

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
server.registerTool(
  'ssh_execute_sudo',
  {
    description: 'Execute command with sudo on remote server',
    inputSchema: {
      server: z.string().describe('Server name or alias'),
      command: z.string().describe('Command to execute with sudo'),
      password: z.string().optional().describe('Sudo password (will be masked in output)'),
      cwd: z.string().optional().describe('Working directory')
    }
  },
  async ({ server, command, password, cwd }) => {
    try {
      const ssh = await getConnection(server);
      const servers = loadServerConfig();
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
      if (cwd) {
        fullCommand = `cd ${cwd} && ${fullCommand}`;
      } else if (serverConfig?.default_dir) {
        fullCommand = `cd ${serverConfig.default_dir} && ${fullCommand}`;
      }

      const result = await ssh.execCommand(fullCommand);

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
server.registerTool(
  'ssh_command_alias',
  {
    description: 'Manage command aliases for frequently used commands',
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
server.registerTool(
  'ssh_hooks',
  {
    description: 'Manage automation hooks for SSH operations',
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
server.registerTool(
  'ssh_profile',
  {
    description: 'Manage SSH Manager profiles for different project types',
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
server.registerTool(
  'ssh_connection_status',
  {
    description: 'Check status of SSH connections and manage connection pool',
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

// Manage server aliases
server.registerTool(
  'ssh_alias',
  {
    description: 'Manage server aliases for easier access',
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

        const servers = loadServerConfig();
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
        const servers = loadServerConfig();

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

// Clean up connections on shutdown
process.on('SIGINT', async () => {
  console.error('\n🔌 Closing SSH connections...');
  for (const [name, ssh] of connections) {
    ssh.dispose();
    console.error(`  Closed connection to ${name}`);
  }
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const servers = loadServerConfig();
  const serverList = Object.keys(servers);
  const activeProfile = getActiveProfileName();

  console.error('🚀 MCP SSH Manager Server started');
  console.error(`📦 Profile: ${activeProfile}`);
  console.error(`🖥️  Available servers: ${serverList.length > 0 ? serverList.join(', ') : 'none configured'}`);
  console.error('💡 Use server-manager.py to configure servers');
  console.error('🔄 Connection management: Auto-reconnect enabled, 30min timeout');

  // Set up periodic cleanup of old connections (every 10 minutes)
  setInterval(() => {
    cleanupOldConnections();
  }, 10 * 60 * 1000);
}

main().catch(console.error);
