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
Write the name into `profile` in your settings directory (`~/.ssh-manager/`, or
`SSH_MANAGER_HOME`), which is what switching profiles from Claude Code does:
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
"Execute app-update on production server"
"Run app-restart on myapp"
"Execute check-memory on staging"
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
- **on-error**: Logs errors to `errors.log` in your settings directory (see below)

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

Everything you change at run time lives in your settings directory, beside your
`.env`: `~/.ssh-manager/`, or the directory named by `SSH_MANAGER_HOME`. Files
are created only when you change something, readable by you alone.

| What | File |
|---|---|
| Active profile | `profile` |
| Custom command aliases (override the profile's) | `command-aliases.json` |
| Custom hook definitions (override the profile's) | `hooks.json` |
| Server aliases | `server-aliases.json` |
| Logs written by `log` hook actions | `errors.log`, `deployments.log`, `ssh-key-changes.log` |

Up to 3.8.5 these were written inside the installed package (`.ssh-manager-profile`,
`.command-aliases.json`, `.hooks-config.json`, `.server-aliases.json`), so an
upgrade lost them, and the default `errors.log` landed in whatever directory the
server was started from. An old file there is still read until your next change
writes the new one.

Profile definitions stay in the package's `profiles/` directory.

## Writing Hook Actions

A hook action is one of:

- **`log`** — appends a timestamped line to a file, with no shell involved:
  ```json
  { "type": "log", "name": "log-error", "file": "errors.log", "message": "Error on {server}: {error}" }
  ```
  A relative `file` lands in your settings directory, never in the working directory.
- **`command`** — a shell command run on this machine.
- **`remoteCommand`** — a shell command run on the server, for hooks fired with an
  open connection (`pre-bench-update`, `post-bench-update`).

### How `{placeholders}` reach a command

A placeholder is **never pasted into the command text**. It becomes a reference to
a shell variable that holds the value — `{server}` becomes `"${SSH_MANAGER_HOOK_SERVER}"`,
`{backupId}` becomes `"${SSH_MANAGER_HOOK_BACKUP_ID}"` — quoted to fit where it sits.
A shell does not run what a variable expands to, so a value such as a connection
error chosen by a hostile server cannot become a command. Up to 3.8.5 values were
pasted in, and the default `on-error` hook ran such an error inside double quotes
([GHSA-759m-wfpq-xmx3](https://github.com/bvisible/mcp-ssh-manager/security/advisories/GHSA-759m-wfpq-xmx3)).

You can also read the variables directly (`$SSH_MANAGER_HOOK_SERVER`). Do not hand
them to anything that evaluates text again — `eval`, `sh -c`, arithmetic — where a
value would become code once more. On Windows, local hooks run under `cmd.exe`,
where values are inserted with every character cmd treats specially removed.

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
- Check `~/.ssh-manager/hooks.json` for proper configuration

### Command aliases not working
- List aliases to verify: `"List all command aliases"`
- Check `~/.ssh-manager/command-aliases.json` for syntax errors
- Ensure the base command is valid

### Deployment failures
- Check `~/.ssh-manager/deployments.log` for history
- Review `~/.ssh-manager/errors.log` for error details
- Verify disk space and permissions on target server