# MCP SSH - Complete Guide to SSH Management via Model Context Protocol

This is the comprehensive guide for **MCP SSH Manager**, the leading Model Context Protocol (MCP) server for SSH remote server management.

## What is MCP SSH?

**MCP SSH Manager** is a complete **Model Context Protocol (MCP) server** that enables SSH remote server management directly from AI assistants like **Claude Code** and **OpenAI Codex**. It's the most comprehensive **SSH MCP** solution available, offering 37+ MCP tools for complete remote server control.

### Why MCP SSH Manager?

If you're searching for:
- **MCP SSH** server
- **SSH MCP** integration
- **Model Context Protocol SSH** tools
- **Claude Code SSH** support
- **OpenAI Codex SSH** compatibility
- **Remote SSH MCP** server
- **SSH automation with AI**

Then **MCP SSH Manager** is exactly what you need! 🎯

## MCP SSH vs Traditional SSH

Traditional SSH requires manual terminal commands and script writing. With **MCP SSH Manager**, you can:

1. **Natural Language Control**: "Deploy my app to production" instead of writing deployment scripts
2. **AI-Powered Automation**: Let Claude Code or Codex handle complex SSH operations
3. **Multi-Server Management**: Control multiple SSH servers from a single interface
4. **Enterprise Features**: Backup, restore, health monitoring, database management
5. **Zero Learning Curve**: Just ask your AI assistant what you want to do

## How to Use MCP SSH with Claude Code

### Quick Installation

```bash
git clone https://github.com/bvisible/mcp-ssh-manager.git
cd mcp-ssh-manager
npm install
claude mcp add ssh-manager node /path/to/mcp-ssh-manager/src/index.js
```

### Natural Language SSH Commands

Once installed, simply ask Claude Code:

- "List my SSH servers"
- "Execute 'docker ps' on production"
- "Backup production database"
- "Monitor CPU usage on all servers"
- "Deploy files to staging server"
- "Check health of production server"

## How to Use SSH MCP with OpenAI Codex

### Codex Integration

```bash
ssh-manager codex setup
ssh-manager export servers.toml
```

Configure in `~/.codex/config.toml`:

```toml
[mcp_servers.ssh-manager]
command = "node"
args = ["/path/to/mcp-ssh-manager/src/index.js"]
env = { SSH_CONFIG_PATH = "/Users/you/.codex/ssh-config.toml" }
```

## MCP SSH Features

### Core SSH MCP Features

1. **SSH Command Execution** - Run any command on remote servers via MCP
2. **File Transfer** - Upload/download files through the MCP protocol
3. **Server Management** - List, configure, and manage SSH connections
4. **Persistent Sessions** - Maintain SSH context across multiple commands

### Enterprise SSH MCP Features

1. **Database Management** (MCP SSH DB tools)
   - MySQL, PostgreSQL, MongoDB support
   - Safe query execution via MCP
   - Database dumps and imports
   - Schema exploration

2. **Backup & Restore** (MCP SSH Backup)
   - Automated backup scheduling
   - Database and file backups
   - One-click restore via MCP
   - Retention policies

3. **Health Monitoring** (MCP SSH Monitor)
   - Real-time server health checks
   - Service status monitoring
   - Process management
   - Alert thresholds

4. **Smart Deployment** (MCP SSH Deploy)
   - Automated deployments via MCP
   - Permission handling
   - Rollback support
   - Multi-server deployment

## Model Context Protocol (MCP) for SSH

The **Model Context Protocol (MCP)** is a standardized way for AI assistants to interact with external tools and services. **MCP SSH Manager** implements the MCP specification to provide:

- **37+ MCP Tools** for SSH operations
- **Type-safe** SSH operations via MCP schemas
- **Secure** credential management
- **Standardized** interface for all AI assistants
- **Extensible** architecture for custom SSH workflows

## SSH MCP Tools Reference

### Core MCP SSH Tools

- `ssh_execute` - Execute SSH commands via MCP
- `ssh_upload` - Upload files through MCP SSH
- `ssh_download` - Download files via MCP SSH
- `ssh_list_servers` - List SSH servers in MCP

### Advanced MCP SSH Tools

- `ssh_backup_create` - Create backups via MCP SSH
- `ssh_health_check` - Health monitoring through MCP
- `ssh_db_dump` - Database operations via MCP SSH
- `ssh_deploy` - Smart deployment through MCP
- `ssh_tunnel_create` - SSH tunnels via MCP
- `ssh_sync` - File synchronization through MCP SSH

[See full list in README.md](../README.md#-available-mcp-tools)

## MCP SSH Configuration

### For Claude Code (Environment Variables)

```env
SSH_SERVER_PROD_HOST=prod.example.com
SSH_SERVER_PROD_USER=admin
SSH_SERVER_PROD_KEYPATH=~/.ssh/prod_key
```

### For OpenAI Codex (TOML Format)

```toml
[ssh_servers.production]
host = "prod.example.com"
user = "admin"
key_path = "~/.ssh/prod_key"
```

## SSH MCP Use Cases

### DevOps Automation with MCP SSH

- Automated deployments to remote servers
- Database backup and restore workflows
- Server health monitoring and alerting
- Log analysis and troubleshooting
- Multi-server configuration management

### Development Workflows with SSH MCP

- Remote development environment setup
- Code deployment to staging/production
- Database migration management
- Service restart and monitoring
- Debug log collection

### Database Administration via MCP SSH

- Backup scheduling and management
- Database dumps and imports
- Query execution and analysis
- Schema inspection
- Cross-server data migration

## MCP SSH Security

**MCP SSH Manager** implements multiple security layers:

1. **Credential Protection** - Never exposes SSH credentials to AI
2. **Command Validation** - Validates all SSH commands before execution
3. **SQL Injection Prevention** - Only allows safe database queries
4. **Audit Logging** - Tracks all SSH operations via MCP
5. **Connection Pooling** - Secure connection management

## Troubleshooting MCP SSH

### MCP SSH Not Found

If "mcp ssh" searches don't show this project:

1. Star this repository on GitHub
2. Share with the MCP community
3. Add topics to your repository
4. Link to this project in your documentation

### MCP SSH Connection Issues

1. Test connection: `ssh-manager server test [name]`
2. Verify SSH credentials
3. Check firewall rules
4. Review MCP server logs

### Claude Code SSH Integration

1. Verify installation: `claude mcp list`
2. Restart Claude Code
3. Check MCP configuration
4. Test with simple command

## MCP SSH Community

### Contributing to MCP SSH

We welcome contributions to **MCP SSH Manager**! See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.

### MCP SSH Support

- GitHub Issues: [Report bugs](https://github.com/bvisible/mcp-ssh-manager/issues)
- Documentation: [Full docs](../README.md)
- Examples: [Example workflows](../examples/)

## MCP SSH Alternatives

While there are other SSH tools and MCP servers, **MCP SSH Manager** offers:

- ✅ Most comprehensive SSH MCP tool collection (37+ tools)
- ✅ Both Claude Code AND OpenAI Codex support
- ✅ Enterprise features (backup, monitoring, database)
- ✅ Active development and support
- ✅ Open source MIT license
- ✅ Production-ready and battle-tested

## Conclusion

**MCP SSH Manager** is the definitive **Model Context Protocol** solution for **SSH remote server management**. Whether you're using **Claude Code** or **OpenAI Codex**, this **MCP SSH** server provides everything you need for AI-powered SSH automation.

**Get started today:**
```bash
git clone https://github.com/bvisible/mcp-ssh-manager.git
cd mcp-ssh-manager
npm install
```

---

## Keywords for Search

This document covers: MCP SSH, SSH MCP, Model Context Protocol SSH, MCP SSH Manager, Claude Code SSH, OpenAI Codex SSH, SSH MCP Server, Remote SSH MCP, MCP Server SSH, SSH automation MCP, AI SSH tools, SSH Model Context Protocol, MCP SSH integration, SSH management MCP, MCP remote server, SSH DevOps MCP, MCP SSH backup, MCP SSH monitoring, MCP SSH database, SSH orchestration MCP.

**Repository**: [https://github.com/bvisible/mcp-ssh-manager](https://github.com/bvisible/mcp-ssh-manager)
