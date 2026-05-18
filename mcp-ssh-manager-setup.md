# MCP SSH Manager - Complete Project Setup

Complete instructions for Claude Code. Create all files in `/path/to/mcp-ssh-manager/`

## 📦 STEP 1: Project structure

Create this folder structure:

```
/path/to/mcp-ssh-manager/
├── src/
│   └── index.js
├── tools/
│   ├── server-manager.py
│   ├── test-connection.py
│   └── requirements.txt
├── examples/
│   ├── .env.example
│   └── claude-code-config.example.json
├── .github/
│   └── workflows/
│       └── test.yml
├── package.json
├── .gitignore
├── LICENSE
├── README.md
└── CONTRIBUTING.md
```

## 📄 STEP 2: Files to create

### 📌 FILE: package.json

```json
{
  "name": "mcp-ssh-manager",
  "version": "1.0.0",
  "description": "MCP server for managing multiple SSH connections in Claude Code",
  "main": "src/index.js",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "setup": "npm install && pip install -r tools/requirements.txt",
    "configure": "python tools/server-manager.py",
    "test-connection": "python tools/test-connection.py"
  },
  "keywords": [
    "mcp",
    "ssh",
    "claude-code",
    "model-context-protocol",
    "remote-server",
    "ssh-manager"
  ],
  "author": "MCP SSH Manager Contributors",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/mcp-ssh-manager.git"
  },
  "bugs": {
    "url": "https://github.com/yourusername/mcp-ssh-manager/issues"
  },
  "homepage": "https://github.com/yourusername/mcp-ssh-manager#readme",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.2",
    "node-ssh": "^13.2.0",
    "dotenv": "^16.4.5"
  },
  "engines": {
    "node": ">=16.0.0"
  }
}
```

### 📌 FILE: src/index.js

```javascript
#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from '@modelcontextprotocol/sdk/types.js';
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
    inputSchema: z.object({
      server: z.string().describe('Server name from configuration'),
      command: z.string().describe('Command to execute'),
      cwd: z.string().optional().describe('Working directory (optional)')
    })
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
    inputSchema: z.object({
      server: z.string().describe('Server name'),
      localPath: z.string().describe('Local file path'),
      remotePath: z.string().describe('Remote destination path')
    })
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
    inputSchema: z.object({
      server: z.string().describe('Server name'),
      remotePath: z.string().describe('Remote file path'),
      localPath: z.string().describe('Local destination path')
    })
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
    inputSchema: z.object({})
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
```

### 📌 FILE: tools/server-manager.py

```python
#!/usr/bin/env python3
"""
SSH Server Manager - Interface for managing SSH servers
"""

import os
import sys
import json
import re
from pathlib import Path
from typing import Dict, Optional
import subprocess
from getpass import getpass

try:
    import paramiko
    from colorama import init, Fore, Style
    from tabulate import tabulate
    init()
except ImportError:
    print("Installing required packages...")
    subprocess.run([sys.executable, '-m', 'pip', 'install', 'paramiko', 'python-dotenv', 'colorama', 'tabulate'])
    import paramiko
    from colorama import init, Fore, Style
    from tabulate import tabulate
    init()

class SSHServerManager:
    def __init__(self):
        self.script_dir = Path(__file__).parent.parent
        self.env_file = self.script_dir / '.env'
        self.servers = self.load_servers()
        
    def load_servers(self) -> Dict:
        """Load servers from .env file"""
        servers = {}
        
        if not self.env_file.exists():
            return servers
            
        with open(self.env_file, 'r') as f:
            lines = f.readlines()
            
        for line in lines:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                if key.startswith('SSH_SERVER_'):
                    parts = key.split('_')
                    if len(parts) >= 4:
                        server_name = parts[2].lower()
                        field = '_'.join(parts[3:]).lower()
                        
                        if server_name not in servers:
                            servers[server_name] = {}
                        servers[server_name][field] = value.strip('"\'')
                        
        return servers
    
    def save_servers(self):
        """Save servers to .env file"""
        lines = []
        
        # Add header
        lines.append("# ============================================\n")
        lines.append("# MCP SSH Manager - Server Configuration\n")
        lines.append("# ============================================\n")
        lines.append("# Generated by server-manager.py\n")
        lines.append("# NEVER commit this file to version control!\n\n")
        
        # Add each server
        for server_name, config in self.servers.items():
            lines.append(f"# Server: {server_name}\n")
            for field, value in config.items():
                key = f"SSH_SERVER_{server_name.upper()}_{field.upper()}"
                # Escape values containing spaces or special characters
                if ' ' in value or '"' in value or '=' in value:
                    value = f'"{value}"'
                lines.append(f"{key}={value}\n")
            lines.append("\n")
        
        with open(self.env_file, 'w') as f:
            f.writelines(lines)
            
        print(f"{Fore.GREEN}✅ Configuration saved to {self.env_file}{Style.RESET_ALL}")
    
    def test_connection(self, server_name: str) -> bool:
        """Test connection to a server"""
        server_name = server_name.lower()
        
        if server_name not in self.servers:
            print(f"{Fore.RED}❌ Server '{server_name}' not found{Style.RESET_ALL}")
            return False
            
        config = self.servers[server_name]
        
        print(f"\n{Fore.CYAN}Testing connection to {server_name}...{Style.RESET_ALL}")
        print(f"  Host: {config.get('host')}")
        print(f"  User: {config.get('user')}")
        print(f"  Port: {config.get('port', '22')}")
        
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        
        try:
            if 'password' in config:
                client.connect(
                    hostname=config['host'],
                    username=config['user'],
                    password=config['password'],
                    port=int(config.get('port', 22)),
                    timeout=10
                )
            elif 'keypath' in config:
                key_path = os.path.expanduser(config['keypath'])
                client.connect(
                    hostname=config['host'],
                    username=config['user'],
                    key_filename=key_path,
                    port=int(config.get('port', 22)),
                    timeout=10
                )
            else:
                print(f"{Fore.RED}❌ No authentication method configured{Style.RESET_ALL}")
                return False
            
            # Test with a simple command
            stdin, stdout, stderr = client.exec_command('echo "Connection successful" && hostname')
            output = stdout.read().decode().strip()
            
            print(f"{Fore.GREEN}✅ Connection successful!{Style.RESET_ALL}")
            print(f"  Response: {output}")
            
            client.close()
            return True
            
        except Exception as e:
            print(f"{Fore.RED}❌ Connection failed: {e}{Style.RESET_ALL}")
            return False
    
    def validate_server_name(self, name: str) -> bool:
        """Validate server name"""
        if not name:
            return False
        # Accept letters, numbers, underscores and hyphens
        return bool(re.match(r'^[a-zA-Z0-9_-]+

### 📌 FILE: tools/test-connection.py

```python
#!/usr/bin/env python3
"""Quick SSH connection testing"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from server_manager import SSHServerManager

def main():
    manager = SSHServerManager()
    
    if len(sys.argv) < 2:
        print("Usage: python test-connection.py <server_name>")
        print("\nAvailable servers:")
        for server in manager.servers.keys():
            print(f"  - {server}")
        sys.exit(1)
    
    server_name = sys.argv[1]
    success = manager.test_connection(server_name)
    
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
```

### 📌 FILE: tools/requirements.txt

```txt
paramiko>=3.4.0
python-dotenv>=1.0.1
colorama>=0.4.6
tabulate>=0.9.0
```

### 📌 FILE: examples/.env.example

```env
# ============================================
# MCP SSH Manager - Server Configuration
# ============================================
# Copy this file to the root directory as .env
# and fill with your actual server details
# NEVER commit the .env file to version control!

# --------------------------------------------
# Example Server 1: Production (Password Auth)
# --------------------------------------------
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=admin
SSH_SERVER_PRODUCTION_PASSWORD=your_secure_password_here
SSH_SERVER_PRODUCTION_PORT=22
SSH_SERVER_PRODUCTION_DESCRIPTION=Main production server

# --------------------------------------------
# Example Server 2: Staging (SSH Key Auth)
# --------------------------------------------
SSH_SERVER_STAGING_HOST=staging.example.com
SSH_SERVER_STAGING_USER=deploy
SSH_SERVER_STAGING_KEYPATH=~/.ssh/staging_key
SSH_SERVER_STAGING_PORT=22
SSH_SERVER_STAGING_DESCRIPTION=Staging environment

# --------------------------------------------
# Example Server 3: Development (Custom Port)
# --------------------------------------------
SSH_SERVER_DEVELOPMENT_HOST=192.168.1.100
SSH_SERVER_DEVELOPMENT_USER=developer
SSH_SERVER_DEVELOPMENT_PASSWORD=dev_password_here
SSH_SERVER_DEVELOPMENT_PORT=2222
SSH_SERVER_DEVELOPMENT_DESCRIPTION=Local development server

# --------------------------------------------
# Server Naming Convention:
# SSH_SERVER_[NAME]_[PROPERTY]
# 
# Where NAME is your server identifier (UPPERCASE)
# And PROPERTY can be:
# - HOST: Server hostname or IP
# - USER: SSH username
# - PASSWORD: SSH password (for password auth)
# - KEYPATH: Path to SSH private key (for key auth)
# - PORT: SSH port (default: 22)
# - DESCRIPTION: Optional description
# --------------------------------------------
```

### 📌 FILE: examples/claude-code-config.example.json

```json
{
  "apiKey": "your-anthropic-api-key-here",
  "mcpServers": {
    "ssh-manager": {
      "command": "node",
      "args": ["/path/to/mcp-ssh-manager/src/index.js"]
    },
    "example-other-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

### 📌 FILE: .gitignore

```gitignore
# Environment variables - NEVER commit these!
.env
.env.local
.env.*.local

# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
package-lock.json

# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
.venv

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# Logs
logs/
*.log

# Testing
coverage/
.nyc_output/
.pytest_cache/

# Build
dist/
build/
*.egg-info/

# Temporary files
tmp/
temp/

# SSH Keys - NEVER commit these!
*.pem
*.key
id_rsa*
id_dsa*
id_ecdsa*
id_ed25519*

# Backup files
*.backup
*.bak
```

### 📌 FILE: README.md

```markdown
# MCP SSH Manager 🚀

A Model Context Protocol (MCP) server that enables Claude Code to manage multiple SSH connections seamlessly. Features a Python-based CLI for easy server configuration and connection testing.

## 🌟 Features

- **Multiple SSH Server Management**: Configure and manage multiple SSH servers from a single interface
- **Secure Credential Storage**: Uses `.env` files to store credentials securely (never committed to git)
- **Python Management Interface**: User-friendly CLI for adding, testing, and removing servers
- **Claude Code Integration**: Seamless integration with Claude Code through MCP
- **Connection Testing**: Built-in connection testing before deployment
- **Support for Multiple Authentication Methods**: Password and SSH key authentication

## 📋 Prerequisites

- Node.js (v16 or higher)
- Python 3.8+
- Claude Code installed and configured
- npm (comes with Node.js)
- pip (Python package manager)

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/mcp-ssh-manager.git
cd mcp-ssh-manager
```

### 2. Install Dependencies

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r tools/requirements.txt
```

### 3. Configure Your Servers

Run the interactive server manager:

```bash
python tools/server-manager.py
```

Choose from the menu:
- `1` - List configured servers
- `2` - Add a new server
- `3` - Test server connection
- `4` - Remove a server
- `5` - Update Claude Code configuration
- `6` - Install/update dependencies

### 4. Add Your First Server

When adding a server, you'll be prompted for:
- Server name (e.g., `production`, `staging`, `development`)
- Host/IP address
- Username
- Port (default: 22)
- Authentication method (password or SSH key)
- Optional description

### 5. Integrate with Claude Code

Update your Claude Code configuration:

```bash
python tools/server-manager.py update-claude
```

Or manually add to `~/.config/claude-code/claude_code_config.json`:

```json
{
  "mcpServers": {
    "ssh-manager": {
      "command": "node",
      "args": ["/path/to/mcp-ssh-manager/src/index.js"]
    }
  }
}
```

### 6. Restart Claude Code

After configuration, restart Claude Code to load the MCP server.

## 🔧 Configuration

### Environment Variables

The `.env` file stores your server configurations:

```env
# Server: production
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=admin
SSH_SERVER_PRODUCTION_PASSWORD=your_password_here
SSH_SERVER_PRODUCTION_PORT=22
SSH_SERVER_PRODUCTION_DESCRIPTION=Production Server

# Server: staging (using SSH key)
SSH_SERVER_STAGING_HOST=staging.example.com
SSH_SERVER_STAGING_USER=deploy
SSH_SERVER_STAGING_KEYPATH=~/.ssh/staging_key
SSH_SERVER_STAGING_PORT=22
```

**⚠️ Important**: Never commit your `.env` file to version control!

## 📝 Usage in Claude Code

Once configured, you can use these commands in Claude Code:

### List Available Servers
```
Use the ssh_list_servers tool to show all configured servers
```

### Execute Commands
```
Use ssh_execute on server "production" to run "ls -la /var/www"
Execute "docker ps" on the staging server
Run "systemctl status nginx" on production
```

### File Operations
```
Upload file.txt to production:/home/admin/file.txt
Download /var/log/app.log from staging server to ./app.log
```

### Working Directory
```
On production server, run "npm install" in directory /var/www/app
```

## 🛠️ Available MCP Tools

- **ssh_execute**: Execute commands on remote servers
- **ssh_upload**: Upload files to remote servers
- **ssh_download**: Download files from remote servers
- **ssh_list_servers**: List all configured servers

## 📁 Project Structure

```
mcp-ssh-manager/
├── src/                    # Core MCP server implementation
│   └── index.js           # Main MCP server with all functionality
├── tools/                  # Management utilities
│   ├── server-manager.py  # Interactive server manager
│   ├── test-connection.py # Connection testing script
│   └── requirements.txt   # Python dependencies
├── examples/              # Example configurations
│   ├── .env.example       # Template for environment variables
│   └── claude-code-config.example.json  # Claude Code config example
└── package.json          # Node.js dependencies
```

## 🧪 Testing Connections

Test a specific server connection:

```bash
python tools/test-connection.py production
```

Or use the interactive manager:

```bash
python tools/server-manager.py
# Then choose option 3
```

## 🔒 Security Best Practices

1. **Never commit `.env` files** - Always use `.env.example` as a template
2. **Use SSH keys when possible** - More secure than passwords
3. **Limit server access** - Use minimal required permissions
4. **Rotate credentials regularly** - Update passwords and keys periodically
5. **Use strong passwords** - Generate secure passwords for server access

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🐛 Troubleshooting

### MCP Tools Not Available in Claude Code

1. Ensure the server is properly configured in Claude Code config
2. Restart Claude Code after configuration changes
3. Check server logs: `node src/index.js` (run manually to see errors)

### Connection Failed

1. Verify server credentials using `test-connection.py`
2. Check network connectivity to the server
3. Ensure SSH service is running on the remote server
4. Verify firewall rules allow SSH connections

### Permission Denied

1. Check username and password/key
2. Verify SSH key permissions: `chmod 600 ~/.ssh/your_key`
3. Ensure user has necessary permissions on the remote server

## 📊 Roadmap

- [ ] GUI interface (Tkinter/PyQt)
- [ ] Session management and connection pooling
- [ ] SFTP browser interface
- [ ] Terminal emulator integration
- [ ] Connection profiles export/import
- [ ] Encrypted credential storage
- [ ] Multi-factor authentication support
- [ ] Proxy/jump host support

## 🙏 Acknowledgments

- Built for use with [Claude Code](https://www.anthropic.com)
- Uses the [Model Context Protocol](https://modelcontextprotocol.io)
- SSH handling via [node-ssh](https://www.npmjs.com/package/node-ssh)
- Python SSH testing with [Paramiko](https://www.paramiko.org)

## 📧 Support

For issues, questions, or suggestions:
- Open an issue on [GitHub Issues](https://github.com/yourusername/mcp-ssh-manager/issues)
- Check existing issues before creating a new one
- Provide detailed information for bug reports

---

Made with ❤️ for the Claude Code community
```

### 📌 FILE: CONTRIBUTING.md

```markdown
# Contributing to MCP SSH Manager

First off, thank you for considering contributing to MCP SSH Manager! It's people like you that make this tool better for everyone.

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples**
- **Describe the behavior you observed and expected**
- **Include logs and error messages**
- **Include your environment details** (OS, Node.js version, Python version)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Use a clear and descriptive title**
- **Provide a detailed description of the suggested enhancement**
- **Provide specific examples to demonstrate the enhancement**
- **Describe the current behavior and expected behavior**
- **Explain why this enhancement would be useful**

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. Ensure the test suite passes
4. Make sure your code follows the existing code style
5. Write a clear commit message

## Development Process

1. Clone your fork:
   ```bash
   git clone https://github.com/your-username/mcp-ssh-manager.git
   cd mcp-ssh-manager
   ```

2. Install dependencies:
   ```bash
   npm install
   pip install -r tools/requirements.txt
   ```

3. Create a branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

4. Make your changes and test them

5. Commit your changes:
   ```bash
   git add .
   git commit -m "Add your descriptive commit message"
   ```

6. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

7. Open a Pull Request

## Style Guidelines

### JavaScript Style
- Use ES6+ features
- Use async/await for asynchronous code
- Add JSDoc comments for functions
- Use meaningful variable names

### Python Style
- Follow PEP 8
- Use type hints where appropriate
- Add docstrings to functions and classes
- Use meaningful variable names

### Commit Messages
- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests liberally after the first line

## Testing

Before submitting a pull request:

1. Test your changes manually
2. Ensure existing functionality still works
3. Test with different server configurations
4. Verify Claude Code integration works

## Documentation

- Update README.md if you change functionality
- Add JSDoc/docstrings for new functions
- Update examples if needed
- Keep documentation clear and concise

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing! 🎉
```

### 📌 FILE: LICENSE

```
MIT License

Copyright (c) 2024 MCP SSH Manager Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 📌 FILE: .github/workflows/test.yml

```yaml
name: Tests

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    strategy:
      matrix:
        node-version: [16.x, 18.x, 20.x]
        python-version: ['3.8', '3.9', '3.10', '3.11']
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Use Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v3
      with:
        node-version: ${{ matrix.node-version }}
    
    - name: Set up Python ${{ matrix.python-version }}
      uses: actions/setup-python@v4
      with:
        python-version: ${{ matrix.python-version }}
    
    - name: Install Node dependencies
      run: npm ci
    
    - name: Install Python dependencies
      run: |
        python -m pip install --upgrade pip
        pip install -r tools/requirements.txt
    
    - name: Check Node syntax
      run: node --check src/index.js
    
    - name: Check Python syntax
      run: |
        python -m py_compile tools/server-manager.py
        python -m py_compile tools/test-connection.py
    
    - name: Create test .env file
      run: |
        echo "SSH_SERVER_TEST_HOST=localhost" > .env
        echo "SSH_SERVER_TEST_USER=test" >> .env
        echo "SSH_SERVER_TEST_PASSWORD=test" >> .env
        echo "SSH_SERVER_TEST_PORT=22" >> .env
    
    - name: Test server manager
      run: python tools/server-manager.py list
```

## 🚀 STEP 3: Installation and Configuration

### Initial installation commands:

```bash
# 1. Go to project directory
cd /path/to/mcp-ssh-manager

# 2. Install dependencies
npm install
pip install -r tools/requirements.txt

# 3. Launch server manager
python tools/server-manager.py

# 4. Add a server (option 2)
# Server name: myapp
# Host: host.example.com
# User: deploy
# Password: <your password>
# Port: 22
# Description: My production server

# 5. Test connection (option 3)

# 6. Update Claude Code (option 5)
```

## 📊 STEP 4: Usage in Claude Code

Once installed and configured, restart Claude Code and use these commands:

```bash
# List servers
Use the ssh_list_servers tool

# Execute a command
Use ssh_execute on server myapp to run "ls -la"

# Restart the application
On myapp, execute "cd /opt/myapp && ./bin/restart"

# Upload/Download
Upload file.txt to myapp:/tmp/file.txt
Download /var/log/app.log from myapp to ./app.log
```

## 🔐 STEP 5: Git Configuration (to publish on GitHub)

```bash
# Initialize git
cd /path/to/mcp-ssh-manager
git init

# VERIFY that .env is NOT in git
git status
# .env should NOT appear

# Add all files
git add .

# First commit
git commit -m "Initial commit: MCP SSH Manager for Claude Code"

# Create repo on GitHub, then:
git remote add origin https://github.com/YOURUSERNAME/mcp-ssh-manager.git
git branch -M main
git push -u origin main

# Release tag
git tag -a v1.0.0 -m "First stable release"
git push origin v1.0.0
```

## ⚠️ IMPORTANT - Security

1. **NEVER** commit the `.env` file (it's in .gitignore)
2. **ALWAYS** check with `git status` before pushing
3. **USE** `.env.example` as template
4. **DO NOT** put real data in examples

## 📝 Usage Notes

- MCP server starts automatically when Claude Code calls it
- SSH connections are cached for performance
- Use Ctrl+C to properly close connections
- Logs appear in Claude Code console

## 🎯 Next Steps

After installation:
1. Test MCP tools in Claude Code
2. Add other servers if needed
3. Customize descriptions for each server
4. Publish on GitHub if desired (without .env!)

---

**Ready!** Run these commands in Claude Code to create the entire project. 🚀
, name))
    
    def add_server(self):
        """Add a new server"""
        print(f"\n{Fore.CYAN}=== Add New SSH Server ==={Style.RESET_ALL}\n")
        
        # Server name
        while True:
            server_name = input("Server name (e.g., 'staging', 'production'): ").strip().lower()
            if not self.validate_server_name(server_name):
                print(f"{Fore.RED}Invalid name. Use only letters, numbers, underscores, and hyphens.{Style.RESET_ALL}")
                continue
            break
            
        if server_name in self.servers:
            overwrite = input(f"{Fore.YELLOW}Server '{server_name}' exists. Overwrite? (y/n): {Style.RESET_ALL}")
            if overwrite.lower() != 'y':
                return
        
        # Basic configuration
        config = {}
        config['host'] = input("Host/IP address: ").strip()
        if not config['host']:
            print(f"{Fore.RED}Host cannot be empty{Style.RESET_ALL}")
            return
            
        config['user'] = input("Username: ").strip()
        if not config['user']:
            print(f"{Fore.RED}Username cannot be empty{Style.RESET_ALL}")
            return
            
        config['port'] = input("Port [22]: ").strip() or "22"
        
        # Authentication method
        auth_method = input("Authentication method (password/key) [password]: ").strip().lower() or "password"
        
        if auth_method == "password":
            password = getpass("Password: ")
            if not password:
                print(f"{Fore.RED}Password cannot be empty{Style.RESET_ALL}")
                return
            config['password'] = password
        else:
            key_path = input("Path to private key [~/.ssh/id_rsa]: ").strip() or "~/.ssh/id_rsa"
            # Check if file exists
            expanded_path = os.path.expanduser(key_path)
            if not os.path.exists(expanded_path):
                print(f"{Fore.YELLOW}Warning: Key file not found at {expanded_path}{Style.RESET_ALL}")
                cont = input("Continue anyway? (y/n): ")
                if cont.lower() != 'y':
                    return
            config['keypath'] = key_path
        
        # Optional description
        description = input("Description (optional): ").strip()
        if description:
            config['description'] = description
        
        # Save
        self.servers[server_name] = config
        self.save_servers()
        
        # Test connection
        test = input(f"\n{Fore.CYAN}Test connection now? (y/n): {Style.RESET_ALL}")
        if test.lower() == 'y':
            self.test_connection(server_name)
    
    def list_servers(self):
        """List all configured servers"""
        if not self.servers:
            print(f"{Fore.YELLOW}No servers configured yet.{Style.RESET_ALL}")
            print("Use option 2 to add a server.")
            return
            
        print(f"\n{Fore.CYAN}=== Configured SSH Servers ==={Style.RESET_ALL}\n")
        
        table_data = []
        for name, config in self.servers.items():
            auth_type = '🔑 Key' if 'keypath' in config else '🔐 Password'
            description = config.get('description', '')
            if len(description) > 30:
                description = description[:27] + '...'
            
            table_data.append([
                name,
                config.get('host', ''),
                config.get('user', ''),
                config.get('port', '22'),
                auth_type,
                description
            ])
        
        headers = ['Name', 'Host', 'User', 'Port', 'Auth', 'Description']
        print(tabulate(table_data, headers=headers, tablefmt='grid'))
    
    def remove_server(self):
        """Remove a server"""
        if not self.servers:
            print(f"{Fore.YELLOW}No servers to remove.{Style.RESET_ALL}")
            return
            
        self.list_servers()
        server_name = input("\nEnter server name to remove: ").strip().lower()
        
        if server_name in self.servers:
            confirm = input(f"{Fore.YELLOW}Remove server '{server_name}'? (y/n): {Style.RESET_ALL}")
            if confirm.lower() == 'y':
                del self.servers[server_name]
                self.save_servers()
                print(f"{Fore.GREEN}✅ Server '{server_name}' removed{Style.RESET_ALL}")
        else:
            print(f"{Fore.RED}❌ Server '{server_name}' not found{Style.RESET_ALL}")
    
    def update_claude_config(self):
        """Update Claude Code configuration"""
        config_path = Path.home() / '.config' / 'claude-code' / 'claude_code_config.json'
        
        if not config_path.exists():
            print(f"{Fore.RED}❌ Claude Code config not found at {config_path}{Style.RESET_ALL}")
            print("\nTo manually configure Claude Code, add this to your config:")
            print(f"{Fore.CYAN}")
            print(json.dumps({
                "mcpServers": {
                    "ssh-manager": {
                        "command": "node",
                        "args": [str(self.script_dir / 'src' / 'index.js')]
                    }
                }
            }, indent=2))
            print(f"{Style.RESET_ALL}")
            return
            
        try:
            with open(config_path, 'r') as f:
                config = json.load(f)
        except json.JSONDecodeError:
            print(f"{Fore.RED}❌ Invalid JSON in Claude Code config{Style.RESET_ALL}")
            return
        
        # Add our MCP server
        if 'mcpServers' not in config:
            config['mcpServers'] = {}
            
        config['mcpServers']['ssh-manager'] = {
            "command": "node",
            "args": [str(self.script_dir / 'src' / 'index.js')]
        }
        
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
            
        print(f"{Fore.GREEN}✅ Claude Code configuration updated{Style.RESET_ALL}")
        print(f"{Fore.YELLOW}⚠️  Please restart Claude Code to apply changes{Style.RESET_ALL}")
    
    def install_dependencies(self):
        """Install required dependencies"""
        print(f"\n{Fore.CYAN}=== Installing Dependencies ==={Style.RESET_ALL}\n")
        
        # Install npm dependencies
        print("Installing npm packages...")
        result = subprocess.run(['npm', 'install'], cwd=self.script_dir)
        if result.returncode != 0:
            print(f"{Fore.RED}❌ Failed to install npm packages{Style.RESET_ALL}")
            return
        
        # Install Python packages
        print("\nInstalling Python packages...")
        subprocess.run([sys.executable, '-m', 'pip', 'install', '-r', 
                       str(self.script_dir / 'tools' / 'requirements.txt')])
        
        print(f"\n{Fore.GREEN}✅ Dependencies installed{Style.RESET_ALL}")
    
    def run_interactive(self):
        """Interactive menu"""
        while True:
            print(f"\n{Fore.CYAN}=== SSH Server Manager ==={Style.RESET_ALL}")
            print("1. List servers")
            print("2. Add server")
            print("3. Test connection")
            print("4. Remove server")
            print("5. Update Claude Code config")
            print("6. Install dependencies")
            print("0. Exit")
            
            choice = input(f"\n{Fore.YELLOW}Choice: {Style.RESET_ALL}").strip()
            
            if choice == '1':
                self.list_servers()
            elif choice == '2':
                self.add_server()
            elif choice == '3':
                if not self.servers:
                    print(f"{Fore.YELLOW}No servers configured.{Style.RESET_ALL}")
                else:
                    self.list_servers()
                    server = input("\nServer name to test: ").strip()
                    if server:
                        self.test_connection(server)
            elif choice == '4':
                self.remove_server()
            elif choice == '5':
                self.update_claude_config()
            elif choice == '6':
                self.install_dependencies()
            elif choice == '0':
                print(f"{Fore.GREEN}Goodbye!{Style.RESET_ALL}")
                break
            else:
                print(f"{Fore.RED}Invalid choice{Style.RESET_ALL}")

def main():
    manager = SSHServerManager()
    
    if len(sys.argv) > 1:
        command = sys.argv[1]
        if command == 'list':
            manager.list_servers()
        elif command == 'add':
            manager.add_server()
        elif command == 'test' and len(sys.argv) > 2:
            manager.test_connection(sys.argv[2])
        elif command == 'remove' and len(sys.argv) > 2:
            server_name = sys.argv[2].lower()
            if server_name in manager.servers:
                del manager.servers[server_name]
                manager.save_servers()
                print(f"Server '{server_name}' removed")
        elif command == 'update-claude':
            manager.update_claude_config()
        elif command == 'install':
            manager.install_dependencies()
        else:
            print(f"Unknown command: {command}")
            print("Usage: python server-manager.py [list|add|test|remove|update-claude|install]")
    else:
        manager.run_interactive()

if __name__ == "__main__":
    main()
```

### 📌 FILE: tools/test-connection.py

```python
#!/usr/bin/env python3
"""Test rapide des connexions SSH"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from server_manager import SSHServerManager

def main():
    manager = SSHServerManager()
    
    if len(sys.argv) < 2:
        print("Usage: python test-connection.py <server_name>")
        print("\nAvailable servers:")
        for server in manager.servers.keys():
            print(f"  - {server}")
        sys.exit(1)
    
    server_name = sys.argv[1]
    success = manager.test_connection(server_name)
    
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
```

### 📌 FILE: tools/requirements.txt

```txt
paramiko>=3.4.0
python-dotenv>=1.0.1
colorama>=0.4.6
tabulate>=0.9.0
```

### 📌 FILE: examples/.env.example

```env
# ============================================
# MCP SSH Manager - Server Configuration
# ============================================
# Copy this file to the root directory as .env
# and fill with your actual server details
# NEVER commit the .env file to version control!

# --------------------------------------------
# Example Server 1: Production (Password Auth)
# --------------------------------------------
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=admin
SSH_SERVER_PRODUCTION_PASSWORD=your_secure_password_here
SSH_SERVER_PRODUCTION_PORT=22
SSH_SERVER_PRODUCTION_DESCRIPTION=Main production server

# --------------------------------------------
# Example Server 2: Staging (SSH Key Auth)
# --------------------------------------------
SSH_SERVER_STAGING_HOST=staging.example.com
SSH_SERVER_STAGING_USER=deploy
SSH_SERVER_STAGING_KEYPATH=~/.ssh/staging_key
SSH_SERVER_STAGING_PORT=22
SSH_SERVER_STAGING_DESCRIPTION=Staging environment

# --------------------------------------------
# Example Server 3: Development (Custom Port)
# --------------------------------------------
SSH_SERVER_DEVELOPMENT_HOST=192.168.1.100
SSH_SERVER_DEVELOPMENT_USER=developer
SSH_SERVER_DEVELOPMENT_PASSWORD=dev_password_here
SSH_SERVER_DEVELOPMENT_PORT=2222
SSH_SERVER_DEVELOPMENT_DESCRIPTION=Local development server

# --------------------------------------------
# Server Naming Convention:
# SSH_SERVER_[NAME]_[PROPERTY]
# 
# Where NAME is your server identifier (UPPERCASE)
# And PROPERTY can be:
# - HOST: Server hostname or IP
# - USER: SSH username
# - PASSWORD: SSH password (for password auth)
# - KEYPATH: Path to SSH private key (for key auth)
# - PORT: SSH port (default: 22)
# - DESCRIPTION: Optional description
# --------------------------------------------
```

### 📌 FILE: .gitignore

```gitignore
# Environment variables - NEVER commit these!
.env
.env.local
.env.*.local

# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
package-lock.json

# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
.venv

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# Logs
logs/
*.log

# Testing
coverage/
.nyc_output/
.pytest_cache/

# Build
dist/
build/
*.egg-info/

# Temporary files
tmp/
temp/

# SSH Keys - NEVER commit these!
*.pem
*.key
id_rsa*
id_dsa*
id_ecdsa*
id_ed25519*

# Backup files
*.backup
*.bak
```

### 📌 FILE: README.md

```markdown
# MCP SSH Manager 🚀

A Model Context Protocol (MCP) server that enables Claude Code to manage multiple SSH connections seamlessly. Features a Python-based CLI for easy server configuration and connection testing.

## 🌟 Features

- **Multiple SSH Server Management**: Configure and manage multiple SSH servers from a single interface
- **Secure Credential Storage**: Uses `.env` files to store credentials securely (never committed to git)
- **Python Management Interface**: User-friendly CLI for adding, testing, and removing servers
- **Claude Code Integration**: Seamless integration with Claude Code through MCP
- **Connection Testing**: Built-in connection testing before deployment
- **Support for Multiple Authentication Methods**: Password and SSH key authentication

## 📋 Prerequisites

- Node.js (v16 or higher)
- Python 3.8+
- Claude Code installed and configured
- npm (comes with Node.js)
- pip (Python package manager)

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/mcp-ssh-manager.git
cd mcp-ssh-manager
```

### 2. Install Dependencies

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r tools/requirements.txt
```

### 3. Configure Your Servers

Run the interactive server manager:

```bash
python tools/server-manager.py
```

Choose from the menu:
- `1` - List configured servers
- `2` - Add a new server
- `3` - Test server connection
- `4` - Remove a server
- `5` - Update Claude Code configuration
- `6` - Install/update dependencies

### 4. Add Your First Server

When adding a server, you'll be prompted for:
- Server name (e.g., `production`, `staging`, `development`)
- Host/IP address
- Username
- Port (default: 22)
- Authentication method (password or SSH key)
- Optional description

### 5. Integrate with Claude Code

Update your Claude Code configuration:

```bash
python tools/server-manager.py update-claude
```

Or manually add to `~/.config/claude-code/claude_code_config.json`:

```json
{
  "mcpServers": {
    "ssh-manager": {
      "command": "node",
      "args": ["/path/to/mcp-ssh-manager/src/index.js"]
    }
  }
}
```

### 6. Restart Claude Code

After configuration, restart Claude Code to load the MCP server.

## 🔧 Configuration

### Environment Variables

The `.env` file stores your server configurations:

```env
# Server: production
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=admin
SSH_SERVER_PRODUCTION_PASSWORD=your_password_here
SSH_SERVER_PRODUCTION_PORT=22
SSH_SERVER_PRODUCTION_DESCRIPTION=Production Server

# Server: staging (using SSH key)
SSH_SERVER_STAGING_HOST=staging.example.com
SSH_SERVER_STAGING_USER=deploy
SSH_SERVER_STAGING_KEYPATH=~/.ssh/staging_key
SSH_SERVER_STAGING_PORT=22
```

**⚠️ Important**: Never commit your `.env` file to version control!

## 📝 Usage in Claude Code

Once configured, you can use these commands in Claude Code:

### List Available Servers
```
Use the ssh_list_servers tool to show all configured servers
```

### Execute Commands
```
Use ssh_execute on server "production" to run "ls -la /var/www"
Execute "docker ps" on the staging server
Run "systemctl status nginx" on production
```

### File Operations
```
Upload file.txt to production:/home/admin/file.txt
Download /var/log/app.log from staging server to ./app.log
```

### Working Directory
```
On production server, run "npm install" in directory /var/www/app
```

## 🛠️ Available MCP Tools

- **ssh_execute**: Execute commands on remote servers
- **ssh_upload**: Upload files to remote servers
- **ssh_download**: Download files from remote servers
- **ssh_list_servers**: List all configured servers

## 📁 Project Structure

```
mcp-ssh-manager/
├── src/                    # Core MCP server implementation
│   ├── index.js           # Main MCP server
│   ├── ssh-handler.js     # SSH connection handling
│   └── config-loader.js   # Configuration management
├── tools/                  # Management utilities
│   ├── server-manager.py  # Interactive server manager
│   ├── test-connection.py # Connection testing script
│   └── requirements.txt   # Python dependencies
├── examples/              # Example configurations
└── package.json          # Node.js dependencies
```

## 🧪 Testing Connections

Test a specific server connection:

```bash
python tools/test-connection.py production
```

Or use the interactive manager:

```bash
python tools/server-manager.py
# Then choose option 3
```

## 🔒 Security Best Practices

1. **Never commit `.env` files** - Always use `.env.example` as a template
2. **Use SSH keys when possible** - More secure than passwords
3. **Limit server access** - Use minimal required permissions
4. **Rotate credentials regularly** - Update passwords and keys periodically
5. **Use strong passwords** - Generate secure passwords for server access

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🐛 Troubleshooting

### MCP Tools Not Available in Claude Code

1. Ensure the server is properly configured in Claude Code config
2. Restart Claude Code after configuration changes
3. Check server logs: `node src/index.js` (run manually to see errors)

### Connection Failed

1. Verify server credentials using `test-connection.py`
2. Check network connectivity to the server
3. Ensure SSH service is running on the remote server
4. Verify firewall rules allow SSH connections

### Permission Denied

1. Check username and password/key
2. Verify SSH key permissions: `chmod 600 ~/.ssh/your_key`
3. Ensure user has necessary permissions on the remote server

## 📊 Roadmap

- [ ] GUI interface (Tkinter/PyQt)
- [ ] Session management and connection pooling
- [ ] SFTP browser interface
- [ ] Terminal emulator integration
- [ ] Connection profiles export/import
- [ ] Encrypted credential storage
- [ ] Multi-factor authentication support
- [ ] Proxy/jump host support

## 🙏 Acknowledgments

- Built for use with [Claude Code](https://www.anthropic.com)
- Uses the [Model Context Protocol](https://modelcontextprotocol.io)
- SSH handling via [node-ssh](https://www.npmjs.com/package/node-ssh)
- Python SSH testing with [Paramiko](https://www.paramiko.org)

## 📧 Support

For issues, questions, or suggestions:
- Open an issue on [GitHub Issues](https://github.com/yourusername/mcp-ssh-manager/issues)
- Check existing issues before creating a new one
- Provide detailed information for bug reports

---

Made with ❤️ for the Claude Code community
```

### 📌 FILE: CONTRIBUTING.md

```markdown
# Contributing to MCP SSH Manager

First off, thank you for considering contributing to MCP SSH Manager! It's people like you that make this tool better for everyone.

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples**
- **Describe the behavior you observed and expected**
- **Include logs and error messages**
- **Include your environment details** (OS, Node.js version, Python version)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Use a clear and descriptive title**
- **Provide a detailed description of the suggested enhancement**
- **Provide specific examples to demonstrate the enhancement**
- **Describe the current behavior and expected behavior**
- **Explain why this enhancement would be useful**

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. Ensure the test suite passes
4. Make sure your code follows the existing code style
5. Write a clear commit message

## Development Process

1. Clone your fork:
   ```bash
   git clone https://github.com/your-username/mcp-ssh-manager.git
   cd mcp-ssh-manager
   ```

2. Install dependencies:
   ```bash
   npm install
   pip install -r tools/requirements.txt
   ```

3. Create a branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

4. Make your changes and test them

5. Commit your changes:
   ```bash
   git add .
   git commit -m "Add your descriptive commit message"
   ```

6. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

7. Open a Pull Request

## Style Guidelines

### JavaScript Style
- Use ES6+ features
- Use async/await for asynchronous code
- Add JSDoc comments for functions
- Use meaningful variable names

### Python Style
- Follow PEP 8
- Use type hints where appropriate
- Add docstrings to functions and classes
- Use meaningful variable names

### Commit Messages
- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests liberally after the first line

## Testing

Before submitting a pull request:

1. Test your changes manually
2. Ensure existing functionality still works
3. Test with different server configurations
4. Verify Claude Code integration works

## Documentation

- Update README.md if you change functionality
- Add JSDoc/docstrings for new functions
- Update examples if needed
- Keep documentation clear and concise

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing! 🎉
```

### 📌 FILE: LICENSE

```
MIT License

Copyright (c) 2024 MCP SSH Manager Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 📌 FILE: .github/workflows/test.yml

```yaml
name: Tests

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    strategy:
      matrix:
        node-version: [16.x, 18.x, 20.x]
        python-version: ['3.8', '3.9', '3.10', '3.11']
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Use Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v3
      with:
        node-version: ${{ matrix.node-version }}
    
    - name: Set up Python ${{ matrix.python-version }}
      uses: actions/setup-python@v4
      with:
        python-version: ${{ matrix.python-version }}
    
    - name: Install Node dependencies
      run: npm ci
    
    - name: Install Python dependencies
      run: |
        python -m pip install --upgrade pip
        pip install -r tools/requirements.txt
    
    - name: Check Node syntax
      run: node --check src/index.js
    
    - name: Check Python syntax
      run: |
        python -m py_compile tools/server-manager.py
        python -m py_compile tools/test-connection.py
    
    - name: Create test .env file
      run: |
        echo "SSH_SERVER_TEST_HOST=localhost" > .env
        echo "SSH_SERVER_TEST_USER=test" >> .env
        echo "SSH_SERVER_TEST_PASSWORD=test" >> .env
        echo "SSH_SERVER_TEST_PORT=22" >> .env
    
    - name: Test server manager
      run: python tools/server-manager.py list
```

## 🚀 ÉTAPE 3: Installation et Configuration

### Commandes d'installation initiale:

```bash
# 1. Aller dans le dossier du projet
cd /path/to/mcp-ssh-manager

# 2. Installer les dépendances
npm install
pip install -r tools/requirements.txt

# 3. Lancer le gestionnaire de serveurs
python tools/server-manager.py

# 4. Ajouter un serveur (option 2)
# Server name: myapp
# Host: host.example.com
# User: deploy
# Password: <votre mot de passe>
# Port: 22
# Description: Mon serveur de production

# 5. Tester la connexion (option 3)

# 6. Mettre à jour Claude Code (option 5)
```

## 📊 ÉTAPE 4: Utilisation dans Claude Code

Une fois installé et configuré, redémarre Claude Code et utilise ces commandes:

```bash
# Lister les serveurs
Utilise l'outil ssh_list_servers

# Exécuter une commande
Utilise ssh_execute sur le serveur myapp pour exécuter "ls -la"

# Redémarrer l'application
Sur myapp, exécute "cd /opt/myapp && ./bin/restart"

# Upload/Download
Upload file.txt vers myapp:/tmp/file.txt
Download /var/log/app.log depuis myapp vers ./app.log
```

## 🔐 ÉTAPE 5: Configuration Git (pour publier sur GitHub)

```bash
# Initialiser git
cd /path/to/mcp-ssh-manager
git init

# VÉRIFIER que .env n'est PAS dans git
git status
# .env ne doit PAS apparaître

# Ajouter tous les fichiers
git add .

# Premier commit
git commit -m "Initial commit: MCP SSH Manager for Claude Code"

# Créer le repo sur GitHub, puis:
git remote add origin https://github.com/TONUSERNAME/mcp-ssh-manager.git
git branch -M main
git push -u origin main

# Tag de release
git tag -a v1.0.0 -m "First stable release"
git push origin v1.0.0
```

## ⚠️ IMPORTANT - Sécurité

1. **JAMAIS** commiter le fichier `.env` (il est dans .gitignore)
2. **TOUJOURS** vérifier avec `git status` avant de push
3. **UTILISER** `.env.example` comme template
4. **NE PAS** mettre de vraies données dans les exemples

## 📝 Notes d'utilisation

- Le serveur MCP démarre automatiquement quand Claude Code l'appelle
- Les connexions SSH sont maintenues en cache pour la performance
- Utilisez Ctrl+C pour fermer proprement les connexions
- Les logs apparaissent dans la console de Claude Code

## 🎯 Prochaines étapes

Après l'installation:
1. Tester les outils MCP dans Claude Code
2. Ajouter d'autres serveurs si nécessaire
3. Personnaliser les descriptions pour chaque serveur
4. Publier sur GitHub si désiré (sans le .env!)

---

**Prêt!** Lance ces commandes dans Claude Code pour créer tout le projet. 🚀
