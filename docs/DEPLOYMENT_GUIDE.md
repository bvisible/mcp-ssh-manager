# SSH Manager Deployment Guide 🚀

## Overview

The MCP SSH Manager now includes advanced deployment features that solve common deployment challenges:

- ✅ Automatic permission handling
- ✅ Secure sudo execution
- ✅ Server aliases for easier access
- ✅ Batch file deployments
- ✅ Automatic backups before deployment

## New Tools

### 1. `ssh_deploy` - Automated File Deployment

Deploy files with automatic permission handling and backup.

#### Basic Usage

```
"Deploy my config file to production server"
"Upload all JavaScript files to staging"
```

#### Advanced Usage with Options

```json
{
  "server": "production",
  "files": [
    {
      "local": "/local/path/file.js",
      "remote": "/var/www/app/file.js"
    }
  ],
  "options": {
    "owner": "www-data:www-data",
    "permissions": "644",
    "backup": true,
    "restart": "systemctl restart nginx"
  }
}
```

### 2. `ssh_execute_sudo` - Execute with Sudo

Run commands with sudo privileges securely.

```
"Run 'apt update' on production with sudo"
"Execute 'systemctl restart nginx' as root on staging"
```

### 3. `ssh_alias` - Manage Server Aliases

Create shortcuts for your servers.

```
"Create alias 'prod' for production server"
"List all server aliases"
"Remove alias 'old-server'"
```

## Common Deployment Workflows

### ERPNext/Frappe Deployment

For the scenario from your conversation, here's the optimized workflow:

```
# Step 1: Create aliases for easier access
"Create alias 'dmis' for dmis server"

# Step 2: Deploy files using the new tool
"Deploy payment_proposal.py and payment_proposal.js to dmis:/home/neoffice/frappe-bench/apps/erpnextswiss/"

# Step 3: Restart the service
"Run 'bench restart' on dmis"
```

The deployment tool automatically:
- Uploads to a temp location first
- Moves files to the correct location
- Handles permissions if needed
- Creates backups of existing files

### Web Application Deployment

```
# Deploy with automatic nginx restart
"Deploy index.html to production:/var/www/html with nginx restart"

# This single command:
# 1. Backs up existing index.html
# 2. Uploads new file to temp
# 3. Moves to final location with correct permissions
# 4. Restarts nginx
```

### Configuration File Updates

```
# Deploy sensitive config with proper permissions
"Deploy nginx.conf to prod:/etc/nginx/ with owner root:root and permissions 644"
```

## Security Best Practices

### 1. Sudo Password Handling

⚠️ **Never** pass sudo passwords directly in commands. Instead:

**Option A: Configure in .env (Recommended)**
```env
SSH_SERVER_PRODUCTION_SUDO_PASSWORD=your_password
```

**Option B: Use key-based sudo (Most Secure)**
Configure passwordless sudo for specific commands on your server.

### 2. Sensitive File Handling

The deployment tool automatically:
- Never logs passwords in output
- Masks sensitive information in logs
- Uses secure temp file locations

### 3. Backup Strategy

Always enabled by default:
- Creates timestamped backups before overwriting
- Format: `original_file.bak.YYYYMMDD_HHMMSS`

## Troubleshooting

### Permission Denied Errors

**Problem**: Can't write to system directories

**Solution**: Use `ssh_deploy` with proper options:
```json
{
  "options": {
    "owner": "www-data:www-data",
    "sudoPassword": "configured_in_env"
  }
}
```

### Server Not Found

**Problem**: "Server 'dmis.neoffice.me' not found"

**Solution**: Use configured name or create an alias:
```
"Create alias 'dmis.neoffice.me' for dmis"
```

### Files Not Updating

**Problem**: Files uploaded but changes not visible

**Solution**: Ensure service restart:
```json
{
  "options": {
    "restart": "bench restart"
  }
}
```

## Configuration Examples

### .env Configuration

```env
# Server with sudo password for deployments
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=deploy
SSH_SERVER_PRODUCTION_PASSWORD=deploy_password
SSH_SERVER_PRODUCTION_SUDO_PASSWORD=sudo_password
SSH_SERVER_PRODUCTION_DEFAULT_DIR=/var/www/app

# Development server with key auth
SSH_SERVER_DEV_HOST=dev.example.com
SSH_SERVER_DEV_USER=developer
SSH_SERVER_DEV_KEYPATH=~/.ssh/dev_key
SSH_SERVER_DEV_DEFAULT_DIR=/home/developer/app
```

### Alias Configuration

Create a `.server-aliases.json`:

```json
{
  "prod": "production",
  "dev": "development",
  "stage": "staging",
  "dmis": "dmis_server"
}
```

## Performance Tips

1. **Batch Deployments**: Deploy multiple files in one command
2. **Use Aliases**: Shorter names = faster typing
3. **Default Directories**: Set default dirs to avoid repetition
4. **Connection Reuse**: Connections are kept alive during session

## Example: Complete ERPNext Update

Based on your real scenario, here's the optimized workflow:

```bash
# 1. Setup (one time)
"Create alias 'dmis' for dmis server"

# 2. Deploy both files at once
"Deploy these files to dmis:
- payment_proposal.py to /home/neoffice/frappe-bench/apps/erpnextswiss/erpnextswiss/doctype/payment_proposal/
- payment_proposal.js to same location"

# 3. Restart service
"Run 'cd /home/neoffice/frappe-bench && bench restart' on dmis"
```

This replaces your previous multi-step process:
- ❌ Upload to wrong location
- ❌ Permission errors
- ❌ Manual sudo password entry
- ❌ Copy from /tmp
- ✅ Single command deployment!

## Support

For issues or questions:
- Check server logs: `"Execute 'tail -f /var/log/syslog' on server"`
- Test connection: `python tools/test-connection.py servername`
- View aliases: `"List server aliases"`