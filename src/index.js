#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NodeSSH } from 'node-ssh';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

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
  const normalizedName = serverName.toLowerCase();
  
  if (!connections.has(normalizedName)) {
    const servers = loadServerConfig();
    const serverConfig = servers[normalizedName];
    
    if (!serverConfig) {
      const availableServers = Object.keys(servers);
      throw new Error(
        `Server "${serverName}" not found. Available servers: ${availableServers.join(', ') || 'none'}`
      );
    }

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
    } catch (error) {
      throw new Error(`Failed to connect to ${serverName}: ${error.message}`);
    }
  }
  
  return connections.get(normalizedName);
}

// Create MCP server
const server = new McpServer({
  name: 'mcp-ssh-manager',
  version: '1.0.0',
});

// Register available tools
server.registerTool(
  'ssh_execute',
  {
    description: 'Execute command on remote SSH server',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      command: z.string().describe('Command to execute'),
      cwd: z.string().optional().describe('Working directory (optional)')
    }
  },
  async ({ server: serverName, command, cwd }) => {
    try {
      const ssh = await getConnection(serverName);
      const fullCommand = cwd ? `cd ${cwd} && ${command}` : command;
      const result = await ssh.execCommand(fullCommand);
      
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
  
  console.error('🚀 MCP SSH Manager Server started');
  console.error(`📦 Available servers: ${serverList.length > 0 ? serverList.join(', ') : 'none configured'}`);
  console.error('💡 Use server-manager.py to add servers');
}

main().catch(console.error);