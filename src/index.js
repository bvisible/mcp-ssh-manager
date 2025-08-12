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
  detectDeploymentNeeds,
  createBatchDeployScript 
} from './deploy-helper.js';
import { 
  resolveServerName, 
  loadAliases, 
  addAlias,
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
  addHook,
  removeHook,
  toggleHook,
  listHooks
} from './hooks-system.js';
import {
  loadProfile,
  listProfiles,
  setActiveProfile,
  getActiveProfileName
} from './profile-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Initialize hooks system
initializeHooks().catch(console.error);

// Map to store active connections
const connections = new Map();

// Load server configuration from .env
function loadServerConfig() {
  const servers = {};
  
  // Parse environment variables to extract servers
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^SSH_SERVER_(\w+)_(\w+)$/);
    if (match) {
      const [, serverName, field] = match;
      const serverNameLower = serverName.toLowerCase();
      if (!servers[serverNameLower]) {
        servers[serverNameLower] = {};
      }
      servers[serverNameLower][field.toLowerCase()] = value;
    }
  }
  
  return servers;
}

// Get or create SSH connection
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
  
  if (!connections.has(normalizedName)) {
    const serverConfig = servers[normalizedName];

    const ssh = new NodeSSH();
    
    try {
      const connectionConfig = {
        host: serverConfig.host,
        username: serverConfig.user,
        port: parseInt(serverConfig.port || '22'),
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
      console.error(`✅ Connected to ${serverName}`);
      
      // Execute post-connect hook
      await executeHook('post-connect', { server: serverName });
    } catch (error) {
      // Execute error hook
      await executeHook('on-error', { server: serverName, error: error.message });
      throw new Error(`Failed to connect to ${serverName}: ${error.message}`);
    }
  }
  
  return connections.get(normalizedName);
}

// Create MCP server
const server = new McpServer({
  name: 'mcp-ssh-manager',
  version: '1.2.0',
});

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
      
      const result = await ssh.execCommand(fullCommand);
      
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
      await ssh.putFile(localPath, remotePath);
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ File uploaded successfully\nServer: ${serverName}\nLocal: ${localPath}\nRemote: ${remotePath}`,
          },
        ],
      };
    } catch (error) {
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
      await ssh.getFile(localPath, remotePath);
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ File downloaded successfully\nServer: ${serverName}\nRemote: ${remotePath}\nLocal: ${localPath}`,
          },
        ],
      };
    } catch (error) {
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
          
          // Mask sudo password in output
          const displayCommand = command.replace(/echo "[^"]+" \| sudo -S/, 'sudo');
          
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
}

main().catch(console.error);