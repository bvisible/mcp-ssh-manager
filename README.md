# MCP SSH Manager - SSH Remote Server Management via Model Context Protocol 🚀

A Model Context Protocol (MCP) server that enables **Claude Code** and **OpenAI Codex** to manage multiple SSH connections. Execute commands, transfer files, manage databases, create backups, monitor health, and automate DevOps tasks across your servers — directly from your AI assistant.

<div align="center">

[![npm version](https://img.shields.io/npm/v/mcp-ssh-manager.svg?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/mcp-ssh-manager)
[![npm downloads](https://img.shields.io/npm/dt/mcp-ssh-manager.svg?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/mcp-ssh-manager)
[![Version](https://img.shields.io/badge/Version-3.2.2-brightgreen?style=for-the-badge)](https://github.com/bvisible/mcp-ssh-manager/releases/tag/v3.2.2)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Compatible-5A67D8?style=for-the-badge&logo=anthropic)](https://claude.ai/code)
[![OpenAI Codex](https://img.shields.io/badge/OpenAI_Codex-Compatible-00A67E?style=for-the-badge&logo=openai)](https://openai.com/codex)
[![MCP](https://img.shields.io/badge/MCP-Server-orange?style=for-the-badge)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## 🎉 What's New in v3.2.2

**Global Install Fix & CLI Binary** (Released: April 7, 2026)

- **🔧 Global install fixed**: `.env` path resolution now uses a fallback chain instead of hardcoded `__dirname` — works correctly with `npm install -g` ([#16](https://github.com/bvisible/mcp-ssh-manager/issues/16), [#19](https://github.com/bvisible/mcp-ssh-manager/issues/19))
  - Fallback chain: `~/.ssh-manager/.env` → `cwd/.env` → `~/.env` → project `.env`
  - Auto-creates `~/.ssh-manager/.env` on first `ssh-manager server add`
- **📦 `ssh-manager` CLI registered as binary**: `npm install -g` now creates both `mcp-ssh-manager` and `ssh-manager` commands ([#18](https://github.com/bvisible/mcp-ssh-manager/issues/18))
- **⚡ Race condition fix**: Server config is now fully loaded before the MCP server accepts requests

---

## Previous Releases

### v3.2.0 - ProxyJump / Bastion Host Support (March 18, 2026)

- **🔀 ProxyJump support**: Connect to servers behind bastion/jump hosts with a simple `PROXYJUMP` config field ([#15](https://github.com/bvisible/mcp-ssh-manager/issues/15))
  - Chain multiple jumps (A → B → C) via recursive connections
  - Circular dependency detection prevents infinite loops
  - All tools work transparently through jump hosts
- **📦 npx support fixed**: `npx mcp-ssh-manager` now works correctly ([#14](https://github.com/bvisible/mcp-ssh-manager/issues/14))

### v3.1.5 - SSH Agent & Passphrase Support (March 5, 2026)

- **🔑 SSH Agent support**: Automatically uses `ssh-agent` when `SSH_AUTH_SOCK` is available — passphrase-protected keys work transparently
- **🔐 Passphrase configuration**: New `passphrase` field for both `.env` and TOML formats

Thanks to [@snjax](https://github.com/snjax) for the original contribution ([#12](https://github.com/bvisible/mcp-ssh-manager/pull/12)).

### v3.1.4 - Windows SSH Host Support (February 22, 2026)

- **🪟 Windows SSH host fix**: Commands no longer fail on Windows hosts running OpenSSH ([#10](https://github.com/bvisible/mcp-ssh-manager/issues/10))
- New per-server `platform` config field (`SSH_SERVER_FOO_PLATFORM=windows` or `platform = "windows"` in TOML)
- When `platform=windows`, the Linux `timeout`/`sh -c` command wrapper is skipped and the SSH library's native timeout is used instead
- All tools (`ssh_execute`, `ssh_tail`, `ssh_monitor`, `ssh_deploy`, `ssh_execute_sudo`, `ssh_group_execute`) are platform-aware

### v3.1.2 - Windows Compatibility Fix (February 9, 2026)

- **🪟 Windows support**: Fixed crash on Windows where `process.env.HOME` is undefined ([#8](https://github.com/bvisible/mcp-ssh-manager/issues/8))
- Now uses `os.homedir()` for cross-platform compatibility (Linux, macOS, Windows)

### v3.1.0 - Tool Activation System (November 15, 2025)

### 🎯 Context Usage Optimization
- **92% context reduction**: Enable only the tools you need (minimal mode: 5 tools vs all 37)
- **Tool management CLI**: `ssh-manager tools list/configure/enable/disable`
- **6 tool groups**: Core, Sessions, Monitoring, Backup, Database, Advanced
- **Auto-approval export**: Generate Claude Code auto-approval configs

### v3.0.0 - Enterprise DevOps Platform (October 1, 2025)

This release adds **12 new MCP tools** transforming SSH Manager into a comprehensive DevOps automation platform:

### 💾 Backup & Restore System (4 tools)
- **Automated backups** for MySQL, PostgreSQL, MongoDB, and file systems
- **Smart scheduling** with cron integration and retention policies
- **One-click restore** with cross-database support
- **Metadata tracking** for audit and compliance

### 🏥 Health & Monitoring (4 tools)
- **Real-time health checks** with CPU, RAM, Disk, and Network metrics
- **Service monitoring** for nginx, mysql, docker, and custom services
- **Process management** with CPU/RAM sorting and kill capabilities
- **Alert thresholds** with configurable notifications

### 🗄️ Database Management (4 tools)
- **Safe database dumps** with compression and selective exports
- **Database imports** with automatic decompression
- **Schema exploration** listing databases, tables, and collections
- **Secure queries** with SQL injection prevention (SELECT-only)

**📊 Total: 37 MCP Tools** | **🔧 ~4,100 Lines of Code Added** | **✅ Production Ready**

[Read Full Changelog →](CHANGELOG.md#300---2025-10-01)

---

## 📑 Table of Contents

- [Features](#-features)
- [Tool Management](#-tool-management--context-optimization)
- [Prerequisites](#-prerequisites)
- [Quick Start - Claude Code](#-quick-start---claude-code)
- [Quick Start - OpenAI Codex](#-quick-start---openai-codex)
- [Available MCP Tools](#-available-mcp-tools)
- [Configuration](#-configuration)
- [Usage Examples](#-usage-examples)
- [Security](#-security-best-practices)
- [Troubleshooting](#-troubleshooting)
- [Known Limitations](#known-limitations)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🌟 Features

### Core Features
- **🔗 Multiple SSH Connections** - Manage unlimited SSH servers from a single interface
- **🔐 Secure Authentication** - Support for password, SSH key, and ssh-agent authentication (including passphrase-protected keys)
- **🔀 ProxyJump / Bastion Host** - Connect to servers behind jump hosts with chained multi-hop support
- **🔌 ProxyCommand / Custom Proxy** - Connect through SOCKS5 proxies or custom proxy commands (ncat, ssh -W, etc.)
- **📁 File Operations** - Upload and download files between local and remote systems
- **⚡ Command Execution** - Run commands on remote servers with working directory support
- **📂 Default Directories** - Set default working directories per server for convenience
- **🎯 Easy Configuration** - Simple `.env` file setup with guided configuration tool

### Enterprise DevOps Features (v3.0) 🎉
- **💾 Backup & Restore** - Automated backups for MySQL, PostgreSQL, MongoDB, and files
- **🏥 Health Monitoring** - Real-time server health checks (CPU, RAM, Disk, Services)
- **🗄️ Database Management** - Safe database operations with SQL injection prevention
- **📊 Process Management** - Monitor and control server processes
- **⚠️ Smart Alerts** - Configurable health thresholds and notifications

### v2.0 Features
- **🚀 Bash CLI** - Lightning-fast pure Bash CLI for server management
- **📊 Advanced Logging** - Comprehensive logging system with levels and history
- **🔄 Rsync Integration** - Bidirectional file sync with rsync support
- **💻 Persistent Sessions** - Maintain shell context across multiple commands
- **👥 Server Groups** - Execute commands on multiple servers simultaneously
- **🔧 SSH Tunnels** - Local/remote port forwarding and SOCKS proxy support
- **📈 System Monitoring** - Real-time monitoring of CPU, memory, disk, and network
- **🏷️ Server Aliases** - Use short aliases instead of full server names
- **🚀 Smart Deployment** - Automated file deployment with permission handling
- **🔑 Sudo Support** - Execute commands with sudo privileges securely
- **📝 OpenAI Codex Support** - Compatible with OpenAI Codex via TOML configuration

---

## ⚙️ Tool Management & Context Optimization

**NEW in v3.1**: Reduce Claude Code context usage by 92% with tool activation management!

MCP SSH Manager includes **37 tools** organized into **6 groups**. By default, all tools are enabled, but you can optimize for your specific workflow:

### Quick Setup

```bash
# Interactive configuration wizard
ssh-manager tools configure

# View current configuration
ssh-manager tools list

# Enable/disable specific groups
ssh-manager tools enable monitoring
ssh-manager tools disable backup
```

### Configuration Modes

| Mode | Tools | Context Usage | Best For |
|------|-------|---------------|----------|
| **All** (default) | 37 tools | ~43.5k tokens | Full feature set, most users |
| **Minimal** | 5 tools | ~3.5k tokens | Basic SSH operations only |
| **Custom** | 5-37 tools | Varies | Tailored to your workflow |

### Tool Groups

- **Core** (5 tools) - Always enabled: list, execute, upload, download, sync
- **Sessions** (4 tools) - Persistent SSH sessions
- **Monitoring** (6 tools) - Health checks, service status, process management
- **Backup** (4 tools) - Database and file backups
- **Database** (4 tools) - MySQL, PostgreSQL, MongoDB operations
- **Advanced** (14 tools) - Deployment, sudo, tunnels, groups, aliases, etc.

### Benefits

- **92% context reduction** in minimal mode (~40k tokens saved)
- **Fewer approval prompts** in Claude Code
- **Faster loading** and cleaner interface
- **Auto-approval configuration** export for Claude Code

📖 [**Complete Tool Management Guide →**](docs/TOOL_MANAGEMENT.md)

---

## 📋 Prerequisites

- Node.js (v18 or higher)
- npm (comes with Node.js)
- **Platforms**: Linux, macOS, Windows
- **For Claude Code**: Claude Code CLI installed
- **For OpenAI Codex**: Codex CLI configured
- Bash 4.0+ (for CLI management tools)
- rsync (for file synchronization)
- sshpass (optional, for rsync with password authentication)
  - macOS: `brew install hudochenkov/sshpass/sshpass`
  - Linux: `apt-get install sshpass`

## 🚀 Quick Start - Claude Code

### 1. Install MCP SSH Manager

**Option A: Install from npm (recommended)**

```bash
# Install globally from npm
npm install -g mcp-ssh-manager

# Or install locally
npx mcp-ssh-manager
```

**Option B: Install from source**

```bash
# Clone and install
git clone https://github.com/bvisible/mcp-ssh-manager.git
cd mcp-ssh-manager
npm install

# Install the Bash CLI
cd cli && ./install.sh

# Configure your first server
ssh-manager server add
```

### 2. Install to Claude Code

```bash
# For personal use (current user only)
claude mcp add ssh-manager node /path/to/mcp-ssh-manager/src/index.js

# For team sharing (creates .mcp.json in project)
claude mcp add ssh-manager --scope project node /path/to/mcp-ssh-manager/src/index.js

# For all your projects
claude mcp add ssh-manager --scope user node /path/to/mcp-ssh-manager/src/index.js
```

### 3. Configure Auto-Approval (Optional but Recommended)

To avoid being prompted for approval on every SSH command, add auto-approve configuration:

Edit `~/.config/claude-code/claude_code_config.json`:

```json
{
  "mcpServers": {
    "ssh-manager": {
      "command": "node",
      "args": ["/path/to/mcp-ssh-manager/src/index.js"],
      "autoApprove": [
        "mcp__ssh-manager__ssh_execute",
        "mcp__ssh-manager__ssh_list_servers",
        "mcp__ssh-manager__ssh_upload",
        "mcp__ssh-manager__ssh_download",
        "mcp__ssh-manager__ssh_sync",
        "mcp__ssh-manager__ssh_alias"
      ]
    }
  }
}
```

**Important**: Restart Claude Code after making this change.

For full auto-approval of all SSH tools, see the complete list in [examples/claude-code-config.example.json](examples/claude-code-config.example.json).

### 4. Start Using!

In Claude Code, you can now:

```
"List all my SSH servers"
"Execute 'ls -la' on production server"  # Uses default directory if set
"Run 'docker ps' on staging"
"Upload config.json to production:/etc/app/config.json"
"Download logs from staging:/var/log/app.log"
```

**With Default Directories:**
If you set `/var/www/html` as default for production, these commands are equivalent:
- `"Run 'ls' on production"` → executes in `/var/www/html`
- `"Run 'ls' on production in /tmp"` → executes in `/tmp` (overrides default)

---

## 🚀 Quick Start - OpenAI Codex

### 1. Install MCP SSH Manager

Same installation as Claude Code (see above), then configure for Codex:

```bash
# Set up Codex integration
ssh-manager codex setup

# Migrate existing servers to TOML format (if you have .env servers)
ssh-manager codex migrate

# Test the integration
ssh-manager codex test
```

### 2. Manual Configuration (Optional)

If you prefer manual setup, add to `~/.codex/config.toml`:

```toml
[mcp_servers.ssh-manager]
command = "node"
args = ["/absolute/path/to/mcp-ssh-manager/src/index.js"]
env = { SSH_CONFIG_PATH = "/Users/you/.codex/ssh-config.toml" }
startup_timeout_ms = 20000
```

### 3. Configure Servers in TOML Format

Create or edit `~/.codex/ssh-config.toml`:

```toml
[ssh_servers.production]
host = "prod.example.com"
user = "admin"
password = "secure_password"  # or use key_path
key_path = "~/.ssh/id_rsa"   # for SSH key auth (recommended)
passphrase = "key_passphrase" # optional, for passphrase-protected keys
port = 22
default_dir = "/var/www"
description = "Production server"

[ssh_servers.staging]
host = "staging.example.com"
user = "deploy"
key_path = "~/.ssh/staging_key"
port = 2222
default_dir = "/home/deploy/app"

[ssh_servers.winhost]
host = "192.168.1.90"
user = "svc-ssh"
key_path = "~/.ssh/winhost_key"
port = 2222
platform = "windows"
description = "Windows host via OpenSSH"

[ssh_servers.bastion]
host = "bastion.example.com"
user = "jumpuser"
key_path = "~/.ssh/bastion_key"

[ssh_servers.internal]
host = "10.0.0.5"
user = "admin"
key_path = "~/.ssh/internal_key"
proxy_jump = "bastion"
description = "Private server behind bastion"
```

💡 **See [examples/codex-ssh-config.example.toml](examples/codex-ssh-config.example.toml) for more complete examples!**

### 4. Start Using in Codex!

In OpenAI Codex, you can now:

```
"List my SSH servers"
"Execute 'docker ps' on production"
"Upload file.txt to staging:/tmp/"
"Monitor CPU usage on all servers"
"Download production:/var/log/app.log to ./logs/"
```

### Converting Between Formats

Switch easily between Claude Code (.env) and Codex (TOML):

```bash
# Convert .env to TOML (for Codex)
ssh-manager codex convert to-toml

# Convert TOML back to .env (for Claude Code)
ssh-manager codex convert to-env
```

Both formats can coexist! The system supports both simultaneously.

---

## 🛠️ Available MCP Tools

### Core Tools

#### `ssh_list_servers`
Lists all configured SSH servers with their details.

#### `ssh_execute`
Execute commands on remote servers.
- Parameters: `server` (name), `command`, `cwd` (optional working directory)
- **Note**: If no `cwd` is provided, uses the server's default directory if configured

#### `ssh_upload`
Upload files to remote servers.
- Parameters: `server`, `local_path`, `remote_path`

#### `ssh_download`
Download files from remote servers.
- Parameters: `server`, `remote_path`, `local_path`

### Backup & Restore Tools (v2.1+) 🔄

#### `ssh_backup_create`
Create backup of database or files on remote server.
- Types: MySQL, PostgreSQL, MongoDB, Files
- Parameters: `server`, `type`, `name`, `database`, `paths`, `retention`
- Automatic compression and metadata tracking
- See [Backup Guide](docs/BACKUP_GUIDE.md) for detailed usage

#### `ssh_backup_list`
List all available backups on remote server.
- Parameters: `server`, `type` (optional filter)
- Returns backup details with size, date, and retention info

#### `ssh_backup_restore`
Restore from a previous backup.
- Parameters: `server`, `backupId`, `database`, `targetPath`
- Supports cross-database restoration

#### `ssh_backup_schedule`
Schedule automatic backups using cron.
- Parameters: `server`, `schedule` (cron format), `type`, `name`
- Automatic cleanup based on retention policy

### Health & Monitoring Tools (v2.2+) 🏥

#### `ssh_health_check`
Perform comprehensive health check on remote server.
- Checks: CPU, Memory, Disk, Network, Uptime, Load average
- Returns overall health status (healthy/warning/critical)
- Optional detailed mode for extended metrics

#### `ssh_service_status`
Check status of services (nginx, mysql, docker, etc.).
- Parameters: `server`, `services` (array)
- Returns running/stopped status for each service
- Works with both systemd and sysv init systems

#### `ssh_process_manager`
List, monitor, or kill processes on remote server.
- Actions: list (top processes), kill (terminate), info (details)
- Sort by CPU or memory usage
- Filter processes by name

#### `ssh_alert_setup`
Configure health monitoring alerts and thresholds.
- Actions: set (configure), get (view), check (test thresholds)
- Configurable CPU, memory, and disk thresholds
- Automatic alert triggering when thresholds exceeded

### Database Management Tools (v2.3+) 🗄️

#### `ssh_db_dump`
Create database dump/backup on remote server.
- Supports: MySQL, PostgreSQL, MongoDB
- Parameters: `server`, `type`, `database`, `outputFile`, `dbUser`, `dbPassword`, `dbHost`, `dbPort`
- Optional: `compress` (gzip), `tables` (specific tables only)
- Returns dump size and location

#### `ssh_db_import`
Import SQL dump or restore database on remote server.
- Supports: MySQL, PostgreSQL, MongoDB
- Parameters: `server`, `type`, `database`, `inputFile`, `dbUser`, `dbPassword`, `dbHost`, `dbPort`
- Handles compressed (.gz) files automatically
- Optional: `drop` (drop database before restore for MongoDB)

#### `ssh_db_list`
List databases or tables on remote server.
- Parameters: `server`, `type`, `database` (optional), `dbUser`, `dbPassword`, `dbHost`, `dbPort`
- Without database: lists all databases (filters system DBs)
- With database: lists all tables/collections
- Returns structured list with count

#### `ssh_db_query`
Execute read-only SQL queries on remote database.
- Parameters: `server`, `type`, `database`, `query`, `dbUser`, `dbPassword`, `dbHost`, `dbPort`
- **Security**: Only SELECT queries allowed for safety
- MongoDB: Use `collection` parameter for find queries
- Returns query results with row count

### Deployment Tools (v1.2+)

#### `ssh_deploy` 🚀
Deploy files with automatic permission and backup handling.
- Parameters: `server`, `files` (array), `options` (owner, permissions, backup, restart)
- Automatically handles permission issues and creates backups

#### `ssh_execute_sudo` 🔐
Execute commands with sudo privileges.
- Parameters: `server`, `command`, `password` (optional), `cwd` (optional)
- Securely handles sudo password without exposing in logs

### Server Management

#### `ssh_alias` 🏷️
Manage server aliases for easier access.
- Parameters: `action` (add/remove/list), `alias`, `server`
- Example: Create alias "prod" for "production" server

#### `ssh_command_alias` 📝
Manage command aliases for frequently used commands.
- Parameters: `action` (add/remove/list/suggest), `alias`, `command`
- Aliases loaded from active profile
- Example: Custom aliases for your project

#### `ssh_hooks` 🎣
Manage automation hooks for SSH operations.
- Parameters: `action` (list/enable/disable/status), `hook`
- Hooks loaded from active profile
- Example: Project-specific validation and automation

#### `ssh_profile` 📚
Manage configuration profiles for different project types.
- Parameters: `action` (list/switch/current), `profile`
- Available profiles: default, frappe, docker, nodejs
- Example: Switch between different project configurations

## 🔧 Configuration

### Profiles

SSH Manager uses profiles to configure aliases and hooks for different project types:

1. **Set active profile**: 
   - Environment variable: `export SSH_MANAGER_PROFILE=frappe`
   - Configuration file: Create `.ssh-manager-profile` with profile name
   - Default: Uses `default` profile if not specified

2. **Available profiles**:
   - `default` - Basic SSH operations
   - `frappe` - Frappe/ERPNext specific
   - `docker` - Docker container management
   - `nodejs` - Node.js applications
   - Create custom profiles in `profiles/` directory

### Environment Variables

Servers are configured in the `.env` file with this pattern:

```env
# Server configuration pattern
SSH_SERVER_[NAME]_HOST=hostname_or_ip
SSH_SERVER_[NAME]_USER=username
SSH_SERVER_[NAME]_PASSWORD=password  # For password auth
SSH_SERVER_[NAME]_KEYPATH=~/.ssh/key  # For SSH key auth
SSH_SERVER_[NAME]_PASSPHRASE=key_passphrase  # Optional, for passphrase-protected keys
SSH_SERVER_[NAME]_PORT=22  # Optional, defaults to 22
SSH_SERVER_[NAME]_DEFAULT_DIR=/path/to/dir  # Optional, default working directory
SSH_SERVER_[NAME]_DESCRIPTION=Description  # Optional
SSH_SERVER_[NAME]_PLATFORM=windows  # Optional: "linux" (default) or "windows"
SSH_SERVER_[NAME]_PROXYJUMP=bastion  # Optional: name of another server to use as jump host
SSH_SERVER_[NAME]_PROXYCOMMAND=command  # Optional: custom proxy command (ncat, ssh -W, etc.)

# Example: Linux server
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=admin
SSH_SERVER_PRODUCTION_PASSWORD=secure_password
SSH_SERVER_PRODUCTION_PORT=22
SSH_SERVER_PRODUCTION_DEFAULT_DIR=/var/www/html
SSH_SERVER_PRODUCTION_DESCRIPTION=Production Server
SSH_SERVER_PRODUCTION_SUDO_PASSWORD=secure_sudo_pass  # Optional, for automated deployments

# Example: Windows server (OpenSSH for Windows)
SSH_SERVER_WINHOST_HOST=192.168.1.90
SSH_SERVER_WINHOST_USER=svc-ssh
SSH_SERVER_WINHOST_KEYPATH=~/.ssh/winhost_key
SSH_SERVER_WINHOST_PORT=2222
SSH_SERVER_WINHOST_PLATFORM=windows
SSH_SERVER_WINHOST_DESCRIPTION=Windows host via OpenSSH

# Example: Server behind a bastion/jump host
SSH_SERVER_BASTION_HOST=bastion.example.com
SSH_SERVER_BASTION_USER=jumpuser
SSH_SERVER_BASTION_KEYPATH=~/.ssh/bastion_key

SSH_SERVER_INTERNAL_HOST=10.0.0.5
SSH_SERVER_INTERNAL_USER=admin
SSH_SERVER_INTERNAL_KEYPATH=~/.ssh/internal_key
SSH_SERVER_INTERNAL_PROXYJUMP=bastion
SSH_SERVER_INTERNAL_DESCRIPTION=Private server behind bastion
```

### Server Management Tool

The Python management tool (`tools/server_manager.py`) provides:

1. **List servers** - View all configured servers
2. **Add server** - Interactive server configuration
3. **Test connection** - Verify server connectivity
4. **Remove server** - Delete server configuration
5. **Update Claude Code** - Configure MCP in Claude Code
6. **Install dependencies** - Setup required packages

## 📁 Project Structure

```
mcp-ssh-manager/
├── src/
│   ├── index.js              # Main MCP server (37 tools)
│   ├── ssh-manager.js        # SSH connection handling
│   ├── config-loader.js      # .env & TOML config loading
│   ├── session-manager.js    # Persistent SSH sessions
│   ├── backup-manager.js     # Backup & restore
│   ├── health-monitor.js     # Health checks & alerts
│   ├── database-manager.js   # Database operations
│   ├── tunnel-manager.js     # SSH tunnel management
│   ├── server-groups.js      # Group operations
│   └── ...
├── cli/
│   ├── ssh-manager           # Bash CLI entrypoint
│   ├── commands/              # CLI command modules
│   └── lib/                   # CLI libraries
├── profiles/                  # Configuration profiles (frappe, docker, nodejs...)
├── examples/                  # Example configs
├── docs/                      # Documentation
└── package.json
```

## 🧪 Testing

### Test Server Connection

```bash
python tools/test-connection.py production
```

### Verify MCP Installation

```bash
claude mcp list
```

### Check Server Status in Claude Code

```
/mcp
```

## 🔒 Security Best Practices

1. **Never commit `.env` files** - Always use `.env.example` as template
2. **Use SSH keys when possible** - More secure than passwords
3. **Limit server access** - Use minimal required permissions
4. **Rotate credentials** - Update passwords and keys regularly

### 🔑 Passphrase-Protected SSH Keys

MCP SSH Manager supports passphrase-protected SSH keys in two ways:

**Option 1: SSH Agent (recommended)**

If your SSH key is loaded into `ssh-agent`, MCP SSH Manager will use it automatically — no configuration changes needed:

```bash
# Add your key to the agent (enter passphrase once)
ssh-add ~/.ssh/your_key

# Verify the key is loaded
ssh-add -l
```

The server detects the `SSH_AUTH_SOCK` environment variable and connects to the running agent. This is the same mechanism that regular `ssh` uses for GUI passphrase prompts.

**Option 2: Passphrase in configuration**

You can store the passphrase directly in the server config:

`.env` format:
```env
SSH_SERVER_MYSERVER_KEYPATH=~/.ssh/id_rsa
SSH_SERVER_MYSERVER_PASSPHRASE="your_passphrase"
```

TOML format:
```toml
[ssh_servers.myserver]
key_path = "~/.ssh/id_rsa"
passphrase = "your_passphrase"
```

> **Note:** SSH Agent is preferred over storing passphrases in config files for better security.

## 📚 Advanced Usage

### ProxyJump / Bastion Host

Connect to servers behind a bastion or jump host. The connection is tunneled through the jump server transparently — all tools (execute, upload, download, sync) work as usual.

```env
# Define the bastion server
SSH_SERVER_BASTION_HOST=bastion.example.com
SSH_SERVER_BASTION_USER=jumpuser
SSH_SERVER_BASTION_KEYPATH=~/.ssh/bastion_key

# Point the target server to the bastion
SSH_SERVER_PRIVATE_HOST=10.0.0.5
SSH_SERVER_PRIVATE_USER=admin
SSH_SERVER_PRIVATE_PROXYJUMP=bastion
```

Or in TOML:
```toml
[ssh_servers.bastion]
host = "bastion.example.com"
user = "jumpuser"
key_path = "~/.ssh/bastion_key"

[ssh_servers.private]
host = "10.0.0.5"
user = "admin"
proxy_jump = "bastion"
```

**Chained jumps** are supported: if `bastion` itself has a `proxy_jump`, the chain is followed recursively. Circular references are detected and rejected.

### ProxyCommand / Custom Proxy

Connect through SOCKS5 proxies or custom proxy commands. The proxy command executes locally and forwards traffic to the remote host.

```env
# SOCKS5 proxy via ncat
SSH_SERVER_SOCKS_HOST=target.example.com
SSH_SERVER_SOCKS_USER=admin
SSH_SERVER_SOCKS_PROXYCOMMAND="ncat --proxy 127.0.0.1:1080 --proxy-type socks5 %h %p"

# Windows SSH proxy command
SSH_SERVER_WINPROXY_HOST=internal.example.com
SSH_SERVER_WINPROXY_USER=admin
SSH_SERVER_WINPROXY_PROXYCOMMAND="C:\Windows\System32\OpenSSH\ssh.exe -W %h:%p user@jump-host"
```

Or in TOML:
```toml
[ssh_servers.socks]
host = "target.example.com"
user = "admin"
proxy_command = "ncat --proxy 127.0.0.1:1080 --proxy-type socks5 %h %p"

[ssh_servers.winproxy]
host = "internal.example.com"
user = "admin"
proxy_command = "C:\\Windows\\System32\\OpenSSH\\ssh.exe -W %h:%p user@jump-host"
```

The proxy command must be a valid command that reads from stdin and writes to stdout, accepting `%h` and `%p` placeholders for host and port.

### Documentation
- [DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) - Deployment strategies and permission handling
- [ALIASES_AND_HOOKS.md](docs/ALIASES_AND_HOOKS.md) - Command aliases and automation hooks
- Real-world examples and best practices

## 🐛 Troubleshooting

### Claude Code Crashes / Interruptions

**Symptoms:**
- Claude shows "Interrupted: What should Claude do instead?"
- MCP tools execute but Claude stops working
- Commands succeed but Claude freezes

**Solution:** v3.1.1 includes automatic fixes:
- ✅ Output auto-truncated to prevent context overflow
- ✅ Timeout increased to 2 minutes (default), max 5 minutes
- ✅ Standardized error responses

**Performance Tuning** (add to `.env`):
```bash
# Reduce output size (default: 10000 characters)
MCP_SSH_MAX_OUTPUT_LENGTH=5000

# Increase timeout for slow commands (default: 120000ms)
MCP_SSH_DEFAULT_TIMEOUT=180000

# Use compact JSON to save tokens (default: false)
MCP_SSH_COMPACT_JSON=true
```

**For large outputs:**
```bash
# Instead of: cat huge-log.txt
# Use: tail -n 100 huge-log.txt
# Or: grep ERROR huge-log.txt | tail -n 50
```

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for complete guide.

### MCP Tools Not Available

1. Ensure MCP is installed: `claude mcp list`
2. Restart Claude Code after installation
3. Check server logs for errors

### Connection Failed

1. Test connection: `ssh-manager server test [server_name]`
2. Verify network connectivity
3. Check firewall rules
4. Ensure SSH service is running on remote server

### Permission Denied

1. Verify username and password/key
2. Check SSH key permissions: `chmod 600 ~/.ssh/your_key`
3. Ensure user has necessary permissions on remote server

## 📚 Usage Examples

### Backup & Restore

```
"Backup production MySQL database before deployment"
"List all backups on production server"
"Restore backup from yesterday"
"Schedule daily database backup at 2 AM"
"Backup website files excluding cache and logs"
```

For detailed backup examples, see [examples/backup-workflow.js](examples/backup-workflow.js) and [docs/BACKUP_GUIDE.md](docs/BACKUP_GUIDE.md).

### Using the Bash CLI

```bash
# Basic server management
ssh-manager server list
ssh-manager server add
ssh-manager ssh prod1

# File synchronization
ssh-manager sync push prod1 ./app /var/www/
ssh-manager sync pull prod1 /var/log/app.log ./

# SSH tunnels
ssh-manager tunnel create prod1 local 3307:localhost:3306
ssh-manager tunnel list

# Execute commands
ssh-manager exec prod1 "docker ps"
```

### Using in Claude Code or OpenAI Codex

Once installed, simply ask your AI assistant:

**Claude Code examples:**
- "List my SSH servers"
- "Execute 'df -h' on production server"
- "Upload this file to staging:/var/www/"
- "Create an SSH tunnel to access remote MySQL"
- "Monitor CPU usage on all servers"
- "Start a persistent session on prod1"

**OpenAI Codex examples:**
- "Show my SSH servers"
- "Run df -h on production"
- "Upload file.txt to staging:/tmp/"
- "Check CPU usage on all servers"

Both AI assistants support the same MCP tools! 🚀

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Clone and install dependencies
3. **Setup pre-commit hooks** for code quality:
   ```bash
   ./scripts/setup-hooks.sh
   ```
4. Create your feature branch
5. Make your changes (hooks will validate on commit)
6. Push to your branch
7. Open a Pull Request

### Code Quality

This project uses automated quality checks:
- **ESLint** for JavaScript linting
- **Black** for Python formatting
- **Flake8** for Python linting
- **Prettier** for code formatting
- **Pre-commit hooks** for automated validation
- **Secret detection** to prevent credential leaks

Run validation manually: `./scripts/validate.sh`

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built for [Claude Code](https://claude.ai/code)
- Uses the [Model Context Protocol](https://modelcontextprotocol.io)
- SSH handling via [node-ssh](https://www.npmjs.com/package/node-ssh)
- Server management with [Paramiko](https://www.paramiko.org)

---

## Known Limitations

### Command Timeout
- The timeout parameter for SSH commands is advisory only
- Due to SSH2 library limitations, commands may continue running on the server even after timeout
- On Linux/macOS hosts, a system `timeout` wrapper is used for reliable command termination
- **Windows hosts**: Set `PLATFORM=windows` in your server config to skip the Linux `timeout`/`sh -c` wrapper (which is incompatible with Windows OpenSSH)

### SSH Sync (rsync)
- Password authentication requires `sshpass` to be installed
- SSH key authentication is recommended for better security and reliability
- Large file transfers may take time and appear to hang - be patient

### Connection Management
- Connections are pooled and reused for performance
- If a connection becomes stale, it will be automatically reconnected on next use
- Force reconnection by using the `ssh_connection_status` tool with `reconnect` action

## 📧 Support

For issues, questions, or suggestions:
- Open an issue on [GitHub Issues](https://github.com/bvisible/mcp-ssh-manager/issues)
- Check existing issues before creating new ones

---

<div align="center">

Made with ❤️ for the Claude Code community

<br/><br/>

<a href="https://glama.ai/mcp/servers/@bvisible/mcp-ssh-manager">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@bvisible/mcp-ssh-manager/badge" alt="SSH Manager MCP server" />
</a>

<br/>

<a href="https://mseep.ai/app/bvisible-mcp-ssh-manager">
  <img src="https://mseep.net/pr/bvisible-mcp-ssh-manager-badge.png" alt="MseeP.ai Security Assessment Badge" />
</a>

</div>
