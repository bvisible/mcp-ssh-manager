#!/usr/bin/env python3
"""
Example deployment workflow using MCP SSH Manager.

These examples show three common deployment scenarios with the ssh_deploy
tool. All names (servers, paths, owners) are generic placeholders — adapt
them to your own infrastructure.
"""

import os
import sys
import json
from pathlib import Path

# Add parent directory to path to import tools
sys.path.insert(0, str(Path(__file__).parent.parent / 'tools'))

from server_manager import load_env_config, test_server_connection

def create_deployment_config(server_name, files, options=None):
    """
    Create a deployment configuration for ssh_deploy tool
    """
    config = {
        "server": server_name,
        "files": files,
        "options": options or {}
    }
    return config

def deploy_python_app_customization():
    """
    Example: deploy two files of a Python application into a target install.
    Replace the local/remote paths and the server alias with your own values.
    """

    files_to_deploy = [
        {
            "local": "./build/myapp/module/handler.py",
            "remote": "/opt/myapp/apps/myapp/module/handler.py"
        },
        {
            "local": "./build/myapp/module/handler.js",
            "remote": "/opt/myapp/apps/myapp/module/handler.js"
        }
    ]

    options = {
        "owner": "appuser:appuser",     # Set correct ownership
        "permissions": "644",            # Standard file permissions
        "backup": True,                  # Always backup before overwriting
        "restart": "cd /opt/myapp && ./bin/restart"  # Restart hook
    }

    deployment = create_deployment_config("production", files_to_deploy, options)

    print("📦 Deployment Configuration:")
    print(json.dumps(deployment, indent=2))

    # In Claude Code, you would say:
    # "Deploy handler files to production with appuser ownership and restart the app"

    return deployment

def deploy_web_application():
    """
    Example: Deploy web application files
    """

    files_to_deploy = [
        {
            "local": "./dist/index.html",
            "remote": "/var/www/html/index.html"
        },
        {
            "local": "./dist/app.js",
            "remote": "/var/www/html/js/app.js"
        },
        {
            "local": "./dist/styles.css",
            "remote": "/var/www/html/css/styles.css"
        }
    ]

    options = {
        "owner": "www-data:www-data",
        "permissions": "644",
        "backup": True,
        "restart": "systemctl restart nginx"
    }

    deployment = create_deployment_config("production", files_to_deploy, options)

    print("🌐 Web Deployment Configuration:")
    print(json.dumps(deployment, indent=2))

    return deployment

def deploy_configuration_files():
    """
    Example: Deploy configuration files with elevated privileges
    """

    files_to_deploy = [
        {
            "local": "./config/nginx.conf",
            "remote": "/etc/nginx/nginx.conf"
        },
        {
            "local": "./config/app.env",
            "remote": "/etc/myapp/app.env"
        }
    ]

    options = {
        "owner": "root:root",
        "permissions": "600",  # Restrictive permissions for config files
        "backup": True,
        "restart": "systemctl reload nginx && systemctl restart myapp"
    }

    deployment = create_deployment_config("production", files_to_deploy, options)

    print("⚙️ Configuration Deployment:")
    print(json.dumps(deployment, indent=2))

    return deployment

def main():
    """
    Demonstrate various deployment scenarios
    """

    print("🚀 MCP SSH Manager - Deployment Examples")
    print("=" * 50)
    print()

    # Check if server configuration exists
    servers = load_env_config()

    if not servers:
        print("⚠️ No servers configured. Run 'python tools/server_manager.py' to add servers.")
        return

    print("📋 Available servers:", ", ".join(servers.keys()))
    print()

    # Example 1: Python application file deployment
    print("Example 1: Python application customization deployment")
    print("-" * 30)
    deploy_python_app_customization()
    print()

    # Example 2: Web application deployment
    print("Example 2: Web Application Deployment")
    print("-" * 30)
    deploy_web_application()
    print()

    # Example 3: Configuration files deployment
    print("Example 3: Configuration Files Deployment")
    print("-" * 30)
    deploy_configuration_files()
    print()

    print("💡 Tips for using in Claude Code:")
    print("-" * 30)
    print("1. Create server aliases for easier access:")
    print('   "Create alias prod for production_server"')
    print()
    print("2. Deploy multiple files at once:")
    print('   "Deploy all .py and .js files from module/ to production"')
    print()
    print("3. Use sudo for system files:")
    print('   "Deploy nginx.conf to production:/etc/nginx/ with sudo"')
    print()
    print("4. Always test connection first:")
    print('   "Test connection to production server"')
    print()
    print("📚 See docs/DEPLOYMENT_GUIDE.md for complete documentation")

if __name__ == "__main__":
    main()
