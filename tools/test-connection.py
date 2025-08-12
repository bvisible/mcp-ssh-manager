#!/usr/bin/env python3
"""Quick SSH connection testing"""

import sys
import os

# Add the parent directory to the path to import server_manager
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

try:
    from server_manager import SSHServerManager
except ImportError:
    # If direct import fails, try importing as module
    import server_manager
    SSHServerManager = server_manager.SSHServerManager

def main():
    manager = SSHServerManager()
    
    if len(sys.argv) < 2:
        print("Usage: python test-connection.py <server_name>")
        print("\nAvailable servers:")
        for server in manager.servers.keys():
            print(f"  - {server}")
        sys.exit(1)
    
    server_name = sys.argv[1]
    success = manager.test_connection(server_name)
    
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()