# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP SSH Manager is a Model Context Protocol server that enables Claude Code to manage multiple SSH connections. It provides tools for executing commands, transferring files, and managing deployments across remote servers.

## Architecture

The system consists of three main components:

1. **MCP Server** (`src/index.js`): Node.js-based MCP server using the Model Context Protocol SDK
   - Handles SSH connections via node-ssh library
   - Manages connection pooling to avoid reconnecting
   - Provides MCP tools for Claude Code integration

2. **Server Management** (`tools/server_manager.py`): Python CLI for configuration
   - Manages `.env` file with server configurations
   - Tests connections using Paramiko
   - Configures Claude Code integration

3. **Deployment Helpers** (`src/deploy-helper.js`, `src/server-aliases.js`): Advanced features
   - Automated deployment strategies with permission handling
   - Server alias management for simplified access
   - Batch deployment scripts generation

## Commands

### Setup and Installation
```bash
npm install                                    # Install Node.js dependencies
./scripts/setup-hooks.sh                      # Setup pre-commit hooks for development
```

### Server Management (Bash CLI)
```bash
ssh-manager server add                        # Add a new server
ssh-manager server list                       # List configured servers
ssh-manager server test SERVER                # Test connection to specific server
ssh-manager server remove SERVER              # Remove a server
ssh-manager server show SERVER                # Show server details
```

### OpenAI Codex Integration
```bash
ssh-manager codex setup                       # Configure for Codex
ssh-manager codex migrate                     # Convert servers to TOML
ssh-manager codex test                        # Test Codex integration
ssh-manager codex convert to-toml            # Convert .env to TOML
ssh-manager codex convert to-env             # Convert TOML to .env
```

### Tool Management (NEW in v3.1)
```bash
ssh-manager tools list                        # Show all tools and status
ssh-manager tools configure                   # Interactive configuration wizard
ssh-manager tools enable <group>              # Enable a tool group
ssh-manager tools disable <group>             # Disable a tool group
ssh-manager tools reset                       # Reset to defaults (all tools)
ssh-manager tools export-claude               # Export auto-approval config
```

**Tool Groups**: core (5), sessions (4), monitoring (6), backup (4), database (4), advanced (14)

**Modes**: all (37 tools, ~43.5k tokens), minimal (5 tools, ~3.5k tokens), custom (variable)

See [docs/TOOL_MANAGEMENT.md](docs/TOOL_MANAGEMENT.md) for complete guide.

### Development and Testing
```bash
npm start                                     # Start MCP server (requires stdin)
./scripts/validate.sh                        # Run all validation checks
node --check src/index.js                   # Check JavaScript syntax
python -m py_compile tools/*.py             # Check Python syntax
```

### Debug Tools (in `debug/` directory)
```bash
./debug/test-claude-code.sh                 # Test Claude Code integration
node debug/test-mcp.js                      # Test MCP connection
node debug/test-ssh-command.js              # Test SSH command execution
python debug/test_basic.py                  # Basic Python tests
python debug/test_fastmcp.py                # FastMCP integration test
```

## MCP Tools Available

The server exposes these tools to Claude Code and OpenAI Codex:

### Core Tools
- `ssh_list_servers`: List all configured SSH servers
- `ssh_execute`: Execute commands on remote servers (supports default directories)
- `ssh_upload`: Upload files to remote servers
- `ssh_download`: Download files from remote servers

### Backup & Restore (v2.1+)
- `ssh_backup_create`: Create database or file backups (MySQL, PostgreSQL, MongoDB, Files)
- `ssh_backup_list`: List all available backups with metadata
- `ssh_backup_restore`: Restore from previous backups
- `ssh_backup_schedule`: Schedule automatic backups using cron

### Health & Monitoring (v2.2+)
- `ssh_health_check`: Comprehensive server health check (CPU, RAM, Disk, Network)
- `ssh_service_status`: Check status of services (nginx, mysql, docker, etc.)
- `ssh_process_manager`: List, monitor, or kill processes
- `ssh_alert_setup`: Configure health monitoring alerts and thresholds

### Database Management (v2.3+)
- `ssh_db_dump`: Create database dumps (MySQL, PostgreSQL, MongoDB)
- `ssh_db_import`: Import SQL dumps or restore databases
- `ssh_db_list`: List databases or tables/collections
- `ssh_db_query`: Execute read-only SELECT queries (security validated)

### Deployment & Management
- `ssh_deploy`: Deploy files with automatic permission/backup handling
- `ssh_execute_sudo`: Execute commands with sudo privileges
- `ssh_alias`: Manage server aliases (add/remove/list)
- `ssh_sync`: Bidirectional file synchronization with rsync
- `ssh_monitor`: System resource monitoring
- `ssh_tail`: Real-time log monitoring

### Advanced Features
- `ssh_session_*`: Persistent SSH sessions
- `ssh_tunnel_*`: SSH tunnel management (local/remote/SOCKS)
- `ssh_group_*`: Server group operations
- `ssh_command_alias`: Command alias management
- `ssh_hooks`: Automation hooks
- `ssh_profile`: Profile management

## Server Configuration

### Configuration Formats

MCP SSH Manager supports two configuration formats:

1. **Environment Variables (.env)** - Traditional format for Claude Code
2. **TOML** - Modern format for OpenAI Codex

### Configuration Loading Priority

The system loads configurations in this order (highest to lowest priority):
1. Environment variables (process.env)
2. `.env` file in project root
3. TOML file (specified by SSH_CONFIG_PATH or ~/.codex/ssh-config.toml)

### .env Format
```
SSH_SERVER_[NAME]_HOST=hostname
SSH_SERVER_[NAME]_USER=username
SSH_SERVER_[NAME]_PASSWORD=password         # For password auth
SSH_SERVER_[NAME]_KEYPATH=~/.ssh/key       # For SSH key auth
SSH_SERVER_[NAME]_PASSPHRASE=passphrase    # Optional, for passphrase-protected keys
SSH_SERVER_[NAME]_PORT=22                  # Optional
SSH_SERVER_[NAME]_DEFAULT_DIR=/path        # Optional default working directory
SSH_SERVER_[NAME]_SUDO_PASSWORD=pass       # Optional for automated sudo
SSH_SERVER_[NAME]_PLATFORM=windows         # Optional: "linux" (default) or "windows"
SSH_SERVER_[NAME]_PROXYJUMP=bastion        # Optional: name of another server to use as jump host
SSH_SERVER_[NAME]_PROXYCOMMAND=command      # Optional: custom proxy command (ncat, ssh -W, etc.)
```

### TOML Format
```toml
[ssh_servers.name]
host = "hostname"
user = "username"
password = "password"                      # For password auth
key_path = "~/.ssh/key"                    # For SSH key auth
passphrase = "key_passphrase"              # Optional, for passphrase-protected keys
port = 22                                  # Optional
default_dir = "/path"                      # Optional default working directory
sudo_password = "pass"                     # Optional for automated sudo
platform = "windows"                       # Optional: "linux" (default) or "windows"
proxy_jump = "bastion"                     # Optional: name of another server to use as jump host
proxy_command = "command"                   # Optional: custom proxy command (ncat, ssh -W, etc.)
```

## Key Implementation Details

1. **Connection Pooling**: The server maintains persistent SSH connections in a Map to avoid reconnection overhead (src/index.js:31)

2. **Server Resolution**: Server names are resolved through aliases first, then direct lookup. Names are normalized to lowercase (src/index.js:54-68)

3. **Default Directories**: If a server has a DEFAULT_DIR configured and no cwd is provided to ssh_execute, commands run in that directory

4. **Deployment Strategy**: The deploy helper detects permission issues and automatically creates scripts for sudo execution when needed

5. **Environment Loading**: Uses dotenv to load configuration from `.env` file in project root

6. **Proxy Command Support**: Custom proxy commands (SOCKS5, ssh -W, etc.) are executed locally to establish connections, with proper error handling and timeout management (src/index.js:389-432)

## Security Considerations

- Never commit `.env` files (included in .gitignore)
- SSH keys preferred over passwords
- Sudo passwords stored separately from regular passwords
- Connection errors logged to stderr for debugging
- Pre-commit hooks check for sensitive data leaks

## Validation and Quality

Run `./scripts/validate.sh` before commits to check:
- JavaScript syntax validity
- Python syntax validity
- No `.env` file in git
- MCP server startup
- Dependencies installed

## Claude Code Integration

To install in Claude Code:
```bash
claude mcp add ssh-manager node /absolute/path/to/mcp-ssh-manager/src/index.js
```

Configuration is stored in `~/.config/claude-code/claude_code_config.json`