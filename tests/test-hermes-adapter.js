import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function runTests() {
  console.log('\n?? Testing Hermes Adapter...');

  try {
    // Set env before dynamic import
    process.env.MCP_CLIENT_ID = 'hermes';

    const { truncateOutput, isHermes } = await import('../src/config.js');
    const { loadToolConfig } = await import('../src/tool-config-manager.js');

    // 1. Verify isHermes flag
    assert.strictEqual(isHermes, true, 'isHermes should be true when MCP_CLIENT_ID=hermes');
    console.log('? isHermes flag works correctly');

    // 2. Verify truncateOutput limits
    const longString = 'A'.repeat(8000);
    const truncated = truncateOutput(longString);
    assert.ok(truncated.length < 8000, 'Output should be truncated');
    assert.ok(truncated.includes('characters truncated]'), 'Output should contain truncation message');
    assert.ok(truncated.startsWith('A'.repeat(4000)), 'Output should be truncated at 4000 chars');
    console.log('? truncateOutput enforces 4000 char limit for Hermes');

    // 3. Verify tool config preset
    // Mock the config file by setting up an empty instance and overriding mode
    const manager = await loadToolConfig();
    manager.config = { version: '1.0', mode: 'hermes', tools: {}, groups: {} };
    
    // Check specific tools
    assert.strictEqual(manager.isToolEnabled('ssh_execute'), true, 'ssh_execute should be enabled');
    assert.strictEqual(manager.isToolEnabled('ssh_list_servers'), true, 'ssh_list_servers should be enabled');
    assert.strictEqual(manager.isToolEnabled('ssh_health_check'), true, 'ssh_health_check should be enabled');
    assert.strictEqual(manager.isToolEnabled('ssh_process_manager'), true, 'ssh_process_manager should be enabled');
    
    // Check a non-Hermes tool
    assert.strictEqual(manager.isToolEnabled('ssh_upload'), false, 'ssh_upload should be disabled');
    assert.strictEqual(manager.isToolEnabled('ssh_deploy'), false, 'ssh_deploy should be disabled');
    
    console.log('? Tool config manager loads Hermes preset correctly');
    console.log('?? All Hermes adapter tests passed!\n');
    
    process.exit(0);
  } catch (error) {
    console.error('? Hermes adapter tests failed:');
    console.error(error);
    process.exit(1);
  }
}

runTests();
