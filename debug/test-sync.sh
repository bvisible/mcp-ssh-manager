#!/bin/bash

echo "🧪 Test SSH Sync Tool"
echo "===================="
echo ""

# Create test directory structure
TEST_DIR="/tmp/mcp-sync-test"
rm -rf $TEST_DIR
mkdir -p $TEST_DIR/source
mkdir -p $TEST_DIR/dest

# Create test files
echo "File 1 content" > $TEST_DIR/source/file1.txt
echo "File 2 content" > $TEST_DIR/source/file2.txt
echo "Config file" > $TEST_DIR/source/config.json
mkdir -p $TEST_DIR/source/subdir
echo "Nested file" > $TEST_DIR/source/subdir/nested.txt
echo "Should be excluded" > $TEST_DIR/source/temp.log
echo "Also excluded" > $TEST_DIR/source/cache.tmp

echo "📁 Test directory created:"
tree $TEST_DIR 2>/dev/null || ls -la $TEST_DIR/source

echo ""
echo "Test scenarios:"
echo "1. Dry run to see what would be synced"
echo "2. Actual sync with exclusions"
echo "3. Pull from remote (if you have a test server configured)"
echo ""

echo "📋 Example commands to test ssh_sync:"
echo ""
echo "# Dry run - see what would be synced"
echo 'ssh_sync server:"test-server" source:"local:/tmp/mcp-sync-test/source/" destination:"remote:/tmp/sync-dest/" dryRun:true exclude:["*.log","*.tmp"]'
echo ""
echo "# Actual push to remote"
echo 'ssh_sync server:"test-server" source:"local:/tmp/mcp-sync-test/source/" destination:"remote:/tmp/sync-dest/" exclude:["*.log","*.tmp"] verbose:true'
echo ""
echo "# Pull from remote"
echo 'ssh_sync server:"test-server" source:"remote:/tmp/sync-dest/" destination:"local:/tmp/mcp-sync-test/pulled/" verbose:true'
echo ""
echo "# Sync with delete option (careful!)"
echo 'ssh_sync server:"test-server" source:"local:/tmp/mcp-sync-test/source/" destination:"remote:/tmp/sync-dest/" delete:true dryRun:true'
echo ""
echo "⚠️  Note: Replace 'test-server' with an actual configured server name"
echo "    Run 'ssh_list_servers' to see available servers"