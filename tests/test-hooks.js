#!/usr/bin/env node

/**
 * Test suite for Hooks System
 */

import {
  initializeHooks,
  loadHooksConfig,
  executeHook,
  addHook,
  removeHook,
  toggleHook,
  listHooks
} from '../src/hooks-system.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🧪 Testing Hooks System...\n');

const HOOKS_CONFIG_FILE = path.join(__dirname, '..', '.hooks-config.json');
const backupFile = HOOKS_CONFIG_FILE + '.backup';

// Backup existing hooks config if it exists
if (fs.existsSync(HOOKS_CONFIG_FILE)) {
  fs.copyFileSync(HOOKS_CONFIG_FILE, backupFile);
  console.log('📦 Backed up existing hooks configuration\n');
}

// Test 1: Initialize hooks
console.log('Test 1: Initialize hooks system');
try {
  await initializeHooks();
  assert(fs.existsSync(path.join(__dirname, '..', 'hooks')), 
    'Hooks directory should be created');
  console.log('✅ Hooks system initialized\n');
} catch (error) {
  console.error(`❌ Failed to initialize hooks: ${error.message}\n`);
  process.exit(1);
}

// Test 2: Load hooks configuration
console.log('Test 2: Load hooks configuration');
try {
  const hooks = loadHooksConfig();
  assert(typeof hooks === 'object', 'loadHooksConfig should return an object');
  
  // Should have at least on-error hook from default
  assert(hooks['on-error'], 'Should have on-error hook');
  
  console.log(`✅ Loaded ${Object.keys(hooks).length} hooks`);
  console.log(`   Hooks: ${Object.keys(hooks).join(', ')}\n`);
} catch (error) {
  console.error(`❌ Failed to load hooks: ${error.message}\n`);
  process.exit(1);
}

// Test 3: List hooks
console.log('Test 3: List hooks');
try {
  const hooksList = listHooks();
  assert(Array.isArray(hooksList), 'listHooks should return an array');
  
  if (hooksList.length > 0) {
    const firstHook = hooksList[0];
    assert(firstHook.name, 'Each hook should have a name');
    assert(typeof firstHook.enabled === 'boolean', 'Each hook should have enabled boolean');
    assert(firstHook.description, 'Each hook should have a description');
    assert(typeof firstHook.actionCount === 'number', 'Each hook should have actionCount');
  }
  
  console.log(`✅ Listed ${hooksList.length} hooks`);
  hooksList.forEach(h => {
    console.log(`   ${h.enabled ? '✓' : '✗'} ${h.name}: ${h.actionCount} actions`);
  });
  console.log();
} catch (error) {
  console.error(`❌ Failed to list hooks: ${error.message}\n`);
  process.exit(1);
}

// Test 4: Add custom hook
console.log('Test 4: Add custom hook');
try {
  const testHook = {
    enabled: true,
    description: 'Test hook for unit testing',
    actions: [
      {
        type: 'notification',
        name: 'test-action',
        command: 'echo "Test hook executed"'
      }
    ]
  };
  
  addHook('test-hook', testHook);
  
  const hooks = loadHooksConfig();
  assert(hooks['test-hook'], 'Test hook should be added');
  assert(hooks['test-hook'].description === testHook.description, 
    'Test hook should have correct description');
  
  console.log('✅ Successfully added custom hook\n');
  
  // Cleanup
  removeHook('test-hook');
} catch (error) {
  console.error(`❌ Failed to add hook: ${error.message}\n`);
  process.exit(1);
}

// Test 5: Toggle hook
console.log('Test 5: Toggle hook enable/disable');
try {
  // Add a test hook
  addHook('toggle-test', {
    enabled: true,
    description: 'Hook for toggle testing',
    actions: []
  });
  
  // Disable it
  toggleHook('toggle-test', false);
  let hooks = loadHooksConfig();
  assert(hooks['toggle-test'].enabled === false, 'Hook should be disabled');
  
  // Enable it
  toggleHook('toggle-test', true);
  hooks = loadHooksConfig();
  assert(hooks['toggle-test'].enabled === true, 'Hook should be enabled');
  
  console.log('✅ Successfully toggled hook state\n');
  
  // Cleanup
  removeHook('toggle-test');
} catch (error) {
  console.error(`❌ Failed to toggle hook: ${error.message}\n`);
  process.exit(1);
}

// Test 6: Execute hook
console.log('Test 6: Execute hook');
try {
  // Create a test file to verify hook execution
  const testFile = path.join(__dirname, '..', 'test-hook-output.txt');
  
  // Add a test hook that creates a file
  addHook('execution-test', {
    enabled: true,
    description: 'Hook execution test',
    actions: [
      {
        type: 'notification',
        name: 'create-test-file',
        command: `echo "Hook executed at $(date)" > ${testFile}`
      }
    ]
  });
  
  // Execute the hook
  const result = await executeHook('execution-test', { server: 'test-server' });
  assert(result.success === true, 'Hook execution should succeed');
  
  // Verify file was created
  assert(fs.existsSync(testFile), 'Hook should have created test file');
  
  console.log('✅ Hook executed successfully');
  
  // Cleanup
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }
  removeHook('execution-test');
  console.log('✅ Cleaned up test artifacts\n');
} catch (error) {
  console.error(`❌ Failed to execute hook: ${error.message}\n`);
  const testFile = path.join(__dirname, '..', 'test-hook-output.txt');
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }
  process.exit(1);
}

// Test 7: Execute disabled hook (should skip)
console.log('Test 7: Execute disabled hook');
try {
  // Add a disabled hook
  addHook('disabled-test', {
    enabled: false,
    description: 'Disabled hook test',
    actions: [
      {
        type: 'notification',
        name: 'should-not-run',
        command: 'echo "This should not execute"'
      }
    ]
  });
  
  // Try to execute it
  const result = await executeHook('disabled-test', {});
  assert(result.success === true, 'Should return success');
  assert(result.skipped === true, 'Should indicate hook was skipped');
  
  console.log('✅ Disabled hook was correctly skipped\n');
  
  // Cleanup
  removeHook('disabled-test');
} catch (error) {
  console.error(`❌ Failed disabled hook test: ${error.message}\n`);
  process.exit(1);
}

// Test 8: Hook with context replacement
console.log('Test 8: Hook with context replacement');
try {
  const testFile = path.join(__dirname, '..', 'context-test.txt');
  
  addHook('context-test', {
    enabled: true,
    description: 'Context replacement test',
    actions: [
      {
        type: 'notification',
        name: 'use-context',
        command: `echo "Server: {server}, Error: {error}" > ${testFile}`
      }
    ]
  });
  
  await executeHook('context-test', { 
    server: 'production', 
    error: 'test-error' 
  });
  
  if (fs.existsSync(testFile)) {
    const content = fs.readFileSync(testFile, 'utf8');
    assert(content.includes('production'), 'Should replace {server} with context value');
    assert(content.includes('test-error'), 'Should replace {error} with context value');
    console.log('✅ Context replacement works correctly');
    fs.unlinkSync(testFile);
  }
  
  // Cleanup
  removeHook('context-test');
  console.log();
} catch (error) {
  console.error(`❌ Failed context replacement test: ${error.message}\n`);
  const testFile = path.join(__dirname, '..', 'context-test.txt');
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }
  process.exit(1);
}

// Restore original hooks config
if (fs.existsSync(backupFile)) {
  fs.copyFileSync(backupFile, HOOKS_CONFIG_FILE);
  fs.unlinkSync(backupFile);
  console.log('📦 Restored original hooks configuration\n');
} else if (fs.existsSync(HOOKS_CONFIG_FILE)) {
  // If no backup but file exists, keep the current one
  console.log('📦 Kept current hooks configuration\n');
}

console.log('🎉 All hooks tests passed!');