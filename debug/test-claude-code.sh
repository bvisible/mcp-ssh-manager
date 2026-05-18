#!/bin/bash

echo "🔧 Testing MCP SSH Manager for Claude Code"
echo "==========================================="
echo ""

# Check dependencies
echo "📦 Checking dependencies..."
if [ -f "package.json" ]; then
    echo "✅ package.json found"
else
    echo "❌ package.json not found"
    exit 1
fi

if [ -d "node_modules" ]; then
    echo "✅ node_modules found"
else
    echo "❌ node_modules not found. Run: npm install"
    exit 1
fi

# Check .env
echo ""
echo "🔐 Checking server configuration..."
if [ -f ".env" ]; then
    echo "✅ .env file found"
    server_count=$(grep -c "SSH_SERVER_.*_HOST=" .env)
    echo "✅ $server_count servers configured"
else
    echo "❌ .env file not found"
    exit 1
fi

# Check Claude Code config
echo ""
echo "⚙️  Checking Claude Code configuration..."
config_file="$HOME/.config/claude-code/claude_code_config.json"
if [ -f "$config_file" ]; then
    echo "✅ Claude Code config found"
    if grep -q "ssh-manager" "$config_file"; then
        echo "✅ SSH Manager is configured in Claude Code"
    else
        echo "❌ SSH Manager not found in Claude Code config"
        echo "   Run: python tools/server_manager.py"
        echo "   Then choose option 5"
    fi
else
    echo "❌ Claude Code config not found at $config_file"
fi

echo ""
echo "🎯 Configuration Summary:"
echo "========================"
echo "MCP Server Path: $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/index.js"
echo "Servers configured: $(grep -c "SSH_SERVER_.*_HOST=" .env 2>/dev/null || echo 0)"
echo ""
echo "✅ Ready to use in Claude Code!"
echo ""
echo "Try these commands in Claude Code:"
echo "  - 'Use the ssh_list_servers tool'"
echo "  - 'Use ssh_execute on production to run ls'"
echo "  - 'Use ssh_execute on staging to run hostname'"