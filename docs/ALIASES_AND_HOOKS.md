# Aliases and Hooks Guide 🚀

## Profiles System

SSH Manager uses profiles to provide project-specific configurations. Profiles define command aliases and hooks tailored to different project types.

### Available Profiles

- **default** - Basic SSH operations (minimal setup)
- **frappe** - Frappe/ERPNext framework commands
- **docker** - Docker container management
- **nodejs** - Node.js application deployment

### Setting Active Profile

1. **Environment Variable**:
```bash
export SSH_MANAGER_PROFILE=frappe
```

2. **Configuration File**:
Create `.ssh-manager-profile` in project root:
```
frappe
```

3. **Via Claude Code**:
```
"Switch to frappe profile"
"Show current profile"
"List available profiles"
```

## Command Aliases

### Overview
Command aliases are shortcuts for frequently used commands. They are loaded from your active profile.

### Profile-Specific Aliases

Each profile provides relevant aliases:

#### Default Profile
- `check-memory` → Display memory usage
- `check-disk` → Display disk usage
- `system-info` → System information
- `tail-logs` → Tail logs with 100 lines

#### Frappe Profile
- `bench-update` → Full bench update with all flags
- `bench-restart` → Restart all bench services
- `bench-migrate` → Run migrations
- `bench-clear-cache` → Clear cache
- And 20+ more Frappe-specific commands

#### Docker Profile
- `docker-ps` → List all containers
- `docker-logs` → View container logs
- `docker-restart` → Restart containers
- `docker-clean` → Clean unused resources

#### Node.js Profile
- `npm-install` → Production install
- `pm2-restart` → Restart PM2 apps
- `npm-build` → Build application
- `audit-fix` → Fix security issues

### Using Command Aliases in Claude Code

```
"Execute bench-update on production server"
"Run bench-restart on dmis"
"Execute check-memory on develop"
```

### Managing Command Aliases

#### List all aliases
```
"List all command aliases"
```

#### Add custom alias
```
"Add command alias 'my-backup' for command 'bench --site mysite.com backup --with-files'"
```

#### Remove alias
```
"Remove command alias 'my-backup'"
```

#### Suggest aliases for a command
```
"Suggest aliases for 'bench'"
```

## Hooks System

### Overview
Hooks provide automated actions that run before, after, or on error during SSH operations. Like aliases, hooks are loaded from your active profile.

### Profile-Specific Hooks

Each profile defines relevant hooks:

#### Default Profile
- **on-error**: Logs errors to file

#### Frappe Profile
- **pre-bench-update**: Creates backup, checks disk space
- **post-bench-update**: Verifies services, clears cache
- **pre-deploy**: Validates bench status
- **post-deploy**: Restarts workers, clears cache

#### Docker Profile
- **pre-deploy**: Checks Docker, backs up volumes
- **post-deploy**: Verifies containers, restarts if needed

#### Node.js Profile
- **pre-deploy**: Checks Node.js, runs tests
- **post-deploy**: Installs dependencies, restarts app

### Managing Hooks in Claude Code

#### List all hooks
```
"List all SSH hooks"
```

#### Check hook status
```
"Show SSH hooks status"
```

#### Enable a hook
```
"Enable pre-connect hook"
```

#### Disable a hook
```
"Disable post-connect hook"
```

## Configuration Files

### Profile Selection
- Location: `.ssh-manager-profile`
- Contains the active profile name

### Custom Command Aliases
- Location: `.command-aliases.json`
- Contains custom aliases (overrides profile aliases)

### Custom Hooks Configuration
- Location: `.hooks-config.json`
- Contains custom hook definitions (overrides profile hooks)

### Profile Definitions
- Location: `profiles/` directory
- JSON files defining profile-specific configurations

### Hook Scripts
- Location: `hooks/` directory
- Custom scripts can be placed here

## Environment Variables for Hooks

Some hooks require environment variables:

### Slack Notifications
```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
```

## Creating Custom Profiles

You can create your own profile for specific project types:

1. Create a JSON file in `profiles/` directory
2. Define your aliases and hooks
3. Switch to your profile

Example: `profiles/my-project.json`
```json
{
  "name": "my-project",
  "description": "Custom profile for my project",
  "commandAliases": {
    "deploy": "git pull && make install && systemctl restart myapp",
    "logs": "journalctl -u myapp -f",
    "status": "systemctl status myapp"
  },
  "hooks": {
    "pre-deploy": {
      "enabled": true,
      "actions": [
        {
          "type": "validation",
          "name": "run-tests",
          "command": "make test"
        }
      ]
    }
  }
}
```

## Examples

### Switching Profiles

```
# For a Frappe project
"Switch to frappe profile"
"Execute bench-update on production"

# For a Docker project
"Switch to docker profile"
"Execute docker-logs on staging"

# For a Node.js project
"Switch to nodejs profile"
"Execute pm2-restart on production"
```

### Typical Workflow with Hooks

1. **Deployment with validation**
```
"Deploy config.json to production:/etc/app/config.json"
```
This will:
- Run `pre-deploy` hook (check Git status)
- Deploy the file
- Run `post-deploy` hook (log and notify)

2. **Bench update with safety**
```
"Execute bench-update on production"
```
This will:
- Run `pre-bench-update` hook (backup and check disk)
- Execute the update
- Run `post-bench-update` hook (verify services)

### Creating Custom Workflows

You can combine aliases and hooks for powerful automation:

1. Create a custom alias for your deployment command
2. Enable appropriate hooks for validation
3. Execute with a simple command

Example:
```
"Add command alias 'safe-deploy' for 'bench --site all migrate && bench build && bench restart'"
"Execute safe-deploy on production"
```

## Best Practices

1. **Always keep backups enabled** for production deployments
2. **Use aliases** for complex commands to avoid errors
3. **Enable pre-deployment hooks** to catch issues early
4. **Configure notifications** for production deployments
5. **Test hooks** on staging before enabling on production

## Troubleshooting

### Hooks not executing
- Check if hook is enabled: `"Show SSH hooks status"`
- Verify required environment variables are set
- Check `.hooks-config.json` for proper configuration

### Command aliases not working
- List aliases to verify: `"List all command aliases"`
- Check `.command-aliases.json` for syntax errors
- Ensure the base command is valid

### Deployment failures
- Check `deployments.log` for history
- Review `errors.log` for error details
- Verify disk space and permissions on target server