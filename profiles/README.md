# SSH Manager Profiles

Profiles allow you to configure command aliases and hooks for specific project types.

## Available Profiles

- `default.json` - Basic SSH operations (minimal setup)
- `frappe.json` - Frappe/ERPNext specific commands and hooks
- `docker.json` - Docker container management
- `kubernetes.json` - Kubernetes cluster operations
- `nodejs.json` - Node.js application deployment
- `python.json` - Python application deployment

## Creating Custom Profiles

Create a JSON file in this directory with your custom configuration:

```json
{
  "name": "my-project",
  "description": "Custom profile for my project",
  "commandAliases": {
    "deploy": "git pull && npm install && npm run build",
    "restart": "pm2 restart all"
  },
  "hooks": {
    "pre-deploy": {
      "enabled": true,
      "actions": [...]
    }
  }
}
```

## Loading Profiles

Profiles can be loaded via:
1. Environment variable: `SSH_MANAGER_PROFILE=frappe`
2. Configuration file: `.ssh-manager-profile` in project root
3. Default: Uses `default.json` if no profile specified