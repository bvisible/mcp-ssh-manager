# Installation Guide for MCP SSH Manager

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation Methods](#installation-methods)
3. [Configuration](#configuration)
4. [Verification](#verification)
5. [Troubleshooting](#troubleshooting)

## Prerequisites

Before installing MCP SSH Manager, ensure you have:

- **Node.js** (v16 or higher) - [Download](https://nodejs.org/)
- **Python** (3.8 or higher) - [Download](https://python.org/)
- **Claude Code CLI** - [Installation Guide](https://claude.ai/code)
- **Git** (for cloning the repository)

Verify installations:
```bash
node --version  # Should show v16.x.x or higher
python --version  # Should show Python 3.8.x or higher
claude --version  # Should show Claude Code version
```

## Installation Methods

### Method 1: Quick Install (Recommended)

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/mcp-ssh-manager.git
cd mcp-ssh-manager

# 2. Install dependencies
npm install
pip install -r tools/requirements.txt

# 3. Configure servers
python tools/server_manager.py
# Choose option 2 to add servers

# 4. Install to Claude Code (choose one)
# For current user only:
claude mcp add ssh-manager node $(pwd)/src/index.js

# For all your projects:
claude mcp add ssh-manager --scope user node $(pwd)/src/index.js

# For team sharing (creates .mcp.json):
claude mcp add ssh-manager --scope project node $(pwd)/src/index.js
```

### Method 2: Manual Installation

#### Step 1: Download and Setup

```bash
# Download the repository
git clone https://github.com/yourusername/mcp-ssh-manager.git
cd mcp-ssh-manager

# Install Node.js dependencies
npm install

# Install Python dependencies
pip install paramiko python-dotenv colorama tabulate
```

#### Step 2: Configure Servers

Create a `.env` file from the template:
```bash
cp .env.example .env
```

Edit `.env` with your server details:
```env
SSH_SERVER_PRODUCTION_HOST=your.server.com
SSH_SERVER_PRODUCTION_USER=yourusername
SSH_SERVER_PRODUCTION_PASSWORD=yourpassword
SSH_SERVER_PRODUCTION_PORT=22
SSH_SERVER_PRODUCTION_DESCRIPTION=My Production Server
```

#### Step 3: Add to Claude Code

```bash
# Get the full path to the project
pwd  # Copy this path

# Add to Claude Code
claude mcp add ssh-manager node /full/path/to/mcp-ssh-manager/src/index.js
```

## Configuration

### Using the Configuration Tool

The easiest way to configure servers:

```bash
python tools/server_manager.py
```

Menu options:
1. **List servers** - View all configured servers
2. **Add server** - Add a new SSH server
3. **Test connection** - Test server connectivity
4. **Remove server** - Remove a server
5. **Update Claude Code** - Update MCP configuration
6. **Install dependencies** - Install required packages

### Manual Configuration

Edit the `.env` file directly:

```env
# Pattern: SSH_SERVER_[NAME]_[PROPERTY]

# Password authentication example
SSH_SERVER_WEBAPP_HOST=web.example.com
SSH_SERVER_WEBAPP_USER=admin
SSH_SERVER_WEBAPP_PASSWORD=secure_password
SSH_SERVER_WEBAPP_PORT=22
SSH_SERVER_WEBAPP_DESCRIPTION=Web Application Server

# SSH key authentication example
SSH_SERVER_DATABASE_HOST=db.example.com
SSH_SERVER_DATABASE_USER=dbadmin
SSH_SERVER_DATABASE_KEYPATH=~/.ssh/id_rsa_db
SSH_SERVER_DATABASE_PORT=22
SSH_SERVER_DATABASE_DESCRIPTION=Database Server
```

### Project-Wide Configuration

To share the MCP configuration with your team:

```bash
# Create project configuration
claude mcp add ssh-manager --scope project node $(pwd)/src/index.js
```

This creates a `.mcp.json` file that can be committed to Git:
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

## Verification

### 1. Check MCP Installation

```bash
claude mcp list
```

You should see `ssh-manager` in the list.

### 2. Test in Claude Code

```bash
claude
```

Then try:
```
"List all SSH servers"
```

### 3. Test Server Connection

```bash
python tools/test-connection.py production
```

### 4. Check MCP Status

In Claude Code:
```
/mcp
```

## Troubleshooting

### Issue: MCP tools not available in Claude Code

**Solution:**
1. Verify installation: `claude mcp list`
2. Restart Claude Code completely
3. Re-add the MCP server:
```bash
claude mcp remove ssh-manager
claude mcp add ssh-manager node $(pwd)/src/index.js
```

### Issue: Connection failed to server

**Solution:**
1. Test connection directly:
```bash
python tools/test-connection.py servername
```
2. Verify credentials in `.env` file
3. Check network connectivity:
```bash
ping your.server.com
```
4. Ensure SSH is enabled on the server

### Issue: Permission denied errors

**Solution:**
1. For SSH key authentication, check key permissions:
```bash
chmod 600 ~/.ssh/your_private_key
```
2. Verify the username has proper permissions on the server
3. Ensure the SSH key is added to `~/.ssh/authorized_keys` on the server

### Issue: Module not found errors

**Solution:**
```bash
# Reinstall Node.js dependencies
rm -rf node_modules package-lock.json
npm install

# Reinstall Python dependencies
pip install --upgrade -r tools/requirements.txt
```

### Issue: .env file not loading

**Solution:**
1. Ensure `.env` is in the project root
2. Check file permissions: `chmod 644 .env`
3. Verify no syntax errors in `.env`
4. Test with the configuration tool:
```bash
python tools/server_manager.py list
```

## Advanced Configuration

### Using Environment Variable Expansion

In `.mcp.json`, you can use environment variables:

```json
{
  "mcpServers": {
    "ssh-manager": {
      "command": "node",
      "args": ["${HOME}/projects/mcp-ssh-manager/src/index.js"],
      "env": {
        "SSH_CONFIG_PATH": "${SSH_CONFIG_PATH:-~/.ssh/config}"
      }
    }
  }
}
```

### Custom SSH Port and Options

For non-standard SSH configurations:

```env
# Custom port
SSH_SERVER_CUSTOM_PORT=2222

# With jump host (configure in ~/.ssh/config)
SSH_SERVER_REMOTE_HOST=internal.server
SSH_SERVER_REMOTE_USER=admin
SSH_SERVER_REMOTE_KEYPATH=~/.ssh/jump_key
```

## Uninstallation

To remove MCP SSH Manager:

```bash
# Remove from Claude Code
claude mcp remove ssh-manager

# Delete the project (optional)
cd ..
rm -rf mcp-ssh-manager
```

## Next Steps

After installation:
1. Test your server connections
2. Try the example commands in Claude Code
3. Configure additional servers as needed
4. Share the `.mcp.json` with your team (if using project scope)

For more help, see the [README](README.md) or open an issue on GitHub.