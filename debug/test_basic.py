#!/usr/bin/env python3
"""Basic test of SSH servers configuration"""

import os
import re
from dotenv import load_dotenv

load_dotenv()

def load_server_config():
    """Load SSH server configurations from environment variables"""
    servers = {}
    
    # Parse environment variables to extract servers
    for key, value in os.environ.items():
        match = re.match(r'^SSH_SERVER_(\w+)_(\w+)$', key)
        if match:
            server_name = match.group(1).lower()
            field = match.group(2).lower()
            
            if server_name not in servers:
                servers[server_name] = {}
            servers[server_name][field] = value
    
    return servers

# Test loading servers
servers = load_server_config()
print(f"✅ Found {len(servers)} configured servers:")
for name, config in servers.items():
    auth = "password" if "password" in config else "ssh_key"
    print(f"  - {name}: {config.get('host')} ({auth})")
    
if not servers:
    print("\n⚠️  No servers configured. Please add servers to .env file")
    print("\nExample configuration:")
    print("SSH_SERVER_PRODUCTION_HOST=example.com")
    print("SSH_SERVER_PRODUCTION_USER=admin")
    print("SSH_SERVER_PRODUCTION_PASSWORD=password123")
    print("SSH_SERVER_PRODUCTION_PORT=22")