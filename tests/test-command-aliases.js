#!/usr/bin/env node

/**
 * Test suite for Command Aliases
 */

import {
  loadCommandAliases,
  expandCommandAlias,
  addCommandAlias,
  removeCommandAlias,
  listCommandAliases,
  suggestAliases
} from '../src/command-aliases.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🧪 Testing Command Aliases...\n');

const CUSTOM_ALIASES_FILE = path.join(__dirname, '..', '.command-aliases.json');
const backupFile = CUSTOM_ALIASES_FILE + '.backup';

// Backup existing custom aliases if they exist
if (fs.existsSync(CUSTOM_ALIASES_FILE)) {
  fs.copyFileSync(CUSTOM_ALIASES_FILE, backupFile);
  console.log('📦 Backed up existing custom aliases\n');
}

// Test 1: Load command aliases
console.log('Test 1: Load command aliases');
try {
  const aliases = loadCommandAliases();
  assert(typeof aliases === 'object', 'loadCommandAliases should return an object');
  assert(Object.keys(aliases).length > 0, 'Should have at least some aliases from profile');
  console.log(`✅ Loaded ${Object.keys(aliases).length} aliases\n`);
} catch (error) {
  console.error(`❌ Failed to load aliases: ${error.message}\n`);
  process.exit(1);
}

// Test 2: Expand command alias
console.log('Test 2: Expand command alias');
try {
  const aliases = loadCommandAliases();
  
  // Test with a known alias from default profile
  if (aliases['check-memory']) {
    const expanded = expandCommandAlias('check-memory');
    assert(expanded === aliases['check-memory'], 
      'Should expand check-memory to its full command');
    console.log(`✅ Expanded 'check-memory' to '${expanded}'`);
  }
  
  // Test with non-alias command
  const nonAlias = expandCommandAlias('ls -la');
  assert(nonAlias === 'ls -la', 'Non-alias commands should remain unchanged');
  console.log('✅ Non-alias commands remain unchanged\n');
} catch (error) {
  console.error(`❌ Failed to expand aliases: ${error.message}\n`);
  process.exit(1);
}

// Test 3: Add custom alias
console.log('Test 3: Add custom alias');
try {
  const testAlias = 'test-alias-' + Date.now();
  const testCommand = 'echo "This is a test command"';
  
  addCommandAlias(testAlias, testCommand);
  
  const aliases = loadCommandAliases();
  assert(aliases[testAlias] === testCommand, 'Custom alias should be added');
  
  const expanded = expandCommandAlias(testAlias);
  assert(expanded === testCommand, 'Custom alias should expand correctly');
  
  console.log(`✅ Added custom alias: ${testAlias}\n`);
  
  // Cleanup
  removeCommandAlias(testAlias);
} catch (error) {
  console.error(`❌ Failed to add custom alias: ${error.message}\n`);
  process.exit(1);
}

// Test 4: Remove custom alias
console.log('Test 4: Remove custom alias');
try {
  const testAlias = 'test-remove-' + Date.now();
  const testCommand = 'echo "To be removed"';
  
  // Add then remove
  addCommandAlias(testAlias, testCommand);
  removeCommandAlias(testAlias);
  
  const aliases = loadCommandAliases();
  assert(!aliases[testAlias], 'Alias should be removed');
  
  console.log('✅ Successfully removed custom alias\n');
} catch (error) {
  console.error(`❌ Failed to remove alias: ${error.message}\n`);
  process.exit(1);
}

// Test 5: List command aliases
console.log('Test 5: List command aliases');
try {
  const list = listCommandAliases();
  assert(Array.isArray(list), 'listCommandAliases should return an array');
  
  if (list.length > 0) {
    const firstAlias = list[0];
    assert(firstAlias.alias, 'Each alias should have an alias property');
    assert(firstAlias.command, 'Each alias should have a command property');
    assert(typeof firstAlias.isFromProfile === 'boolean', 
      'Each alias should have isFromProfile boolean');
    assert(typeof firstAlias.isCustom === 'boolean', 
      'Each alias should have isCustom boolean');
  }
  
  console.log(`✅ Listed ${list.length} aliases`);
  
  // Show some examples
  const profileAliases = list.filter(a => a.isFromProfile).slice(0, 3);
  const customAliases = list.filter(a => a.isCustom).slice(0, 3);
  
  if (profileAliases.length > 0) {
    console.log('   Profile aliases:', profileAliases.map(a => a.alias).join(', '));
  }
  if (customAliases.length > 0) {
    console.log('   Custom aliases:', customAliases.map(a => a.alias).join(', '));
  }
  console.log();
} catch (error) {
  console.error(`❌ Failed to list aliases: ${error.message}\n`);
  process.exit(1);
}

// Test 6: Suggest aliases
console.log('Test 6: Suggest aliases');
try {
  // Add a test alias for suggestion
  addCommandAlias('test-suggest', 'test suggestion command');
  
  const suggestions = suggestAliases('test');
  assert(Array.isArray(suggestions), 'suggestAliases should return an array');
  
  const testSuggestion = suggestions.find(s => s.alias === 'test-suggest');
  assert(testSuggestion, 'Should find the test alias in suggestions');
  
  console.log(`✅ Found ${suggestions.length} suggestions for 'test'`);
  if (suggestions.length > 0) {
    console.log(`   Examples: ${suggestions.slice(0, 3).map(s => s.alias).join(', ')}`);
  }
  console.log();
  
  // Cleanup
  removeCommandAlias('test-suggest');
} catch (error) {
  console.error(`❌ Failed to suggest aliases: ${error.message}\n`);
  process.exit(1);
}

// Test 7: Profile alias protection
console.log('Test 7: Profile alias protection');
try {
  const aliases = loadCommandAliases();
  const profileAlias = Object.keys(aliases)[0]; // Get first alias
  
  if (profileAlias) {
    const originalCommand = aliases[profileAlias];
    
    // Try to remove a profile alias (should reset to original)
    removeCommandAlias(profileAlias);
    
    const newAliases = loadCommandAliases();
    assert(newAliases[profileAlias] === originalCommand, 
      'Profile aliases should be reset, not removed');
    
    console.log(`✅ Profile alias '${profileAlias}' is protected from removal\n`);
  }
} catch (error) {
  console.error(`❌ Failed profile alias protection test: ${error.message}\n`);
  process.exit(1);
}

// Restore original custom aliases
if (fs.existsSync(backupFile)) {
  fs.copyFileSync(backupFile, CUSTOM_ALIASES_FILE);
  fs.unlinkSync(backupFile);
  console.log('📦 Restored original custom aliases\n');
} else if (fs.existsSync(CUSTOM_ALIASES_FILE)) {
  fs.unlinkSync(CUSTOM_ALIASES_FILE);
}

console.log('🎉 All command alias tests passed!');