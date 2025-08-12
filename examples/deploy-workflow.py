#!/usr/bin/env python3
"""
Example deployment workflow using MCP SSH Manager
This script demonstrates how to automate deployments similar to the ERPNext scenario
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

def deploy_erpnext_customization():
    """
    Example: Deploy ERPNext customization files
    Similar to the user's scenario with payment_proposal files
    """
    
    # Define the files to deploy
    files_to_deploy = [
        {
            "local": "/Users/jeremy/GitHub/erpnextswiss/erpnextswiss/doctype/payment_proposal/payment_proposal.py",
            "remote": "/home/neoffice/frappe-bench/apps/erpnextswiss/erpnextswiss/doctype/payment_proposal/payment_proposal.py"
        },
        {
            "local": "/Users/jeremy/GitHub/erpnextswiss/erpnextswiss/doctype/payment_proposal/payment_proposal.js",
            "remote": "/home/neoffice/frappe-bench/apps/erpnextswiss/erpnextswiss/doctype/payment_proposal/payment_proposal.js"
        }
    ]
    
    # Deployment options
    options = {
        "owner": "neoffice:neoffice",  # Set correct ownership
        "permissions": "644",           # Standard file permissions
        "backup": True,                 # Always backup before overwriting
        "restart": "cd /home/neoffice/frappe-bench && bench restart"  # Restart after deployment
    }
    
    # Create deployment configuration
    deployment = create_deployment_config("dmis", files_to_deploy, options)
    
    print("📦 Deployment Configuration:")
    print(json.dumps(deployment, indent=2))
    
    # In Claude Code, you would say:
    # "Deploy payment_proposal files to dmis server with neoffice ownership and restart bench"
    
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
    
    # Example 1: ERPNext deployment (like the user's scenario)
    print("Example 1: ERPNext Deployment")
    print("-" * 30)
    deploy_erpnext_customization()
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
    print('   "Create alias dmis for dmis_server"')
    print()
    print("2. Deploy multiple files at once:")
    print('   "Deploy all .py and .js files from payment_proposal to dmis"')
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