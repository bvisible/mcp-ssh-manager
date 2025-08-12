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
pip install -r tools/requirements.txt         # Install Python dependencies
./scripts/setup-hooks.sh                      # Setup pre-commit hooks for development
```

### Server Management
```bash
python tools/server_manager.py                # Interactive server configuration
python tools/server_manager.py list          # List configured servers
python tools/server_manager.py add           # Add new server
python tools/server_manager.py test SERVER   # Test connection to specific server
python tools/test-connection.py SERVER       # Alternative connection test
```

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

The server exposes these tools to Claude Code:

- `ssh_list_servers`: List all configured SSH servers
- `ssh_execute`: Execute commands on remote servers (supports default directories)
- `ssh_upload`: Upload files to remote servers
- `ssh_download`: Download files from remote servers
- `ssh_deploy`: Deploy files with automatic permission/backup handling
- `ssh_execute_sudo`: Execute commands with sudo privileges
- `ssh_alias`: Manage server aliases (add/remove/list)

## Server Configuration

Servers are configured in `.env` file with pattern:
```
SSH_SERVER_[NAME]_HOST=hostname
SSH_SERVER_[NAME]_USER=username
SSH_SERVER_[NAME]_PASSWORD=password         # For password auth
SSH_SERVER_[NAME]_KEYPATH=~/.ssh/key       # For SSH key auth
SSH_SERVER_[NAME]_PORT=22                  # Optional
SSH_SERVER_[NAME]_DEFAULT_DIR=/path        # Optional default working directory
SSH_SERVER_[NAME]_SUDO_PASSWORD=pass       # Optional for automated sudo
```

## Key Implementation Details

1. **Connection Pooling**: The server maintains persistent SSH connections in a Map to avoid reconnection overhead (src/index.js:31)

2. **Server Resolution**: Server names are resolved through aliases first, then direct lookup. Names are normalized to lowercase (src/index.js:54-68)

3. **Default Directories**: If a server has a DEFAULT_DIR configured and no cwd is provided to ssh_execute, commands run in that directory

4. **Deployment Strategy**: The deploy helper detects permission issues and automatically creates scripts for sudo execution when needed

5. **Environment Loading**: Uses dotenv to load configuration from `.env` file in project root

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