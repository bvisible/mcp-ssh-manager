#!/usr/bin/env python3
"""
Test script for SSH FastMCP Server
Tests all tools, resources, and prompts
"""

import sys
import json
from ssh_fastmcp import (
    ssh_execute, 
    ssh_list_servers, 
    get_servers_resource,
    get_config_template,
    get_connection_status,
    server_info_prompt,
    execute_command_prompt
)

def print_section(title):
    """Print a formatted section header"""
    print(f"\n{'='*50}")
    print(f"  {title}")
    print(f"{'='*50}\n")

def test_list_servers():
    """Test listing configured servers"""
    print_section("Testing ssh_list_servers Tool")
    
    try:
        servers = ssh_list_servers()
        print(f"✅ Found {len(servers)} configured servers:")
        for server in servers:
            print(f"  - {server['name']}: {server['host']} ({server['auth_type']})")
        return True
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def test_resources():
    """Test all resources"""
    print_section("Testing Resources")
    
    # Test servers resource
    try:
        servers_info = get_servers_resource()
        print(f"✅ Servers resource: {servers_info['total_servers']} servers configured")
    except Exception as e:
        print(f"❌ Servers resource error: {e}")
    
    # Test config template resource
    try:
        template = get_config_template()
        print(f"✅ Config template resource loaded")
        print(f"   Template keys: {list(template['template'].keys())[:3]}...")
    except Exception as e:
        print(f"❌ Config template error: {e}")
    
    # Test connection status resource
    try:
        status = get_connection_status()
        print(f"✅ Connection status: {status['total_active']} active connections")
    except Exception as e:
        print(f"❌ Connection status error: {e}")

def test_prompts():
    """Test prompt functions"""
    print_section("Testing Prompts")
    
    # Test server info prompt
    try:
        messages = server_info_prompt()
        print(f"✅ Server info prompt generated {len(messages)} messages")
        if messages:
            print(f"   First message: {messages[0].get('content', '')[:50]}...")
    except Exception as e:
        print(f"❌ Server info prompt error: {e}")

def test_ssh_execute(server_name):
    """Test SSH execute on a specific server"""
    print_section(f"Testing ssh_execute on '{server_name}'")
    
    try:
        # Test simple command
        result = ssh_execute(server=server_name, command="echo 'Hello from FastMCP'")
        if result['success']:
            print(f"✅ Command executed successfully")
            print(f"   Output: {result['stdout'].strip()}")
        else:
            print(f"❌ Command failed: {result.get('error', 'Unknown error')}")
        
        # Test with working directory
        result = ssh_execute(server=server_name, command="pwd", cwd="/tmp")
        if result['success']:
            print(f"✅ Command with cwd executed")
            print(f"   Working directory: {result['stdout'].strip()}")
        
        return True
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def main():
    """Run all tests"""
    print("\n" + "="*50)
    print("  🧪 SSH FastMCP Server Test Suite")
    print("="*50)
    
    # Test listing servers
    test_list_servers()
    
    # Test resources
    test_resources()
    
    # Test prompts
    test_prompts()
    
    # Test SSH execution if servers are configured
    servers = ssh_list_servers()
    if servers:
        server_name = servers[0]['name']
        print(f"\n📡 Testing SSH connection to '{server_name}'...")
        test_ssh_execute(server_name)
        
        # Test execute command prompt
        print_section(f"Testing Execute Command Prompt on '{server_name}'")
        try:
            messages = execute_command_prompt(server=server_name, command="hostname")
            print(f"✅ Execute prompt generated {len(messages)} messages")
        except Exception as e:
            print(f"❌ Execute prompt error: {e}")
    else:
        print("\n⚠️  No servers configured. Add servers to .env file to test SSH operations.")
        print("Example .env configuration:")
        template = get_config_template()
        for key, value in list(template['example'].items())[:3]:
            print(f"  {key}={value}")
    
    print("\n" + "="*50)
    print("  ✅ Test suite completed")
    print("="*50 + "\n")

if __name__ == "__main__":
    main()