#!/usr/bin/env node

/**
 * Test suite for Profile Loader
 */

import { 
  loadProfile, 
  listProfiles, 
  setActiveProfile, 
  getActiveProfileName 
} from '../src/profile-loader.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🧪 Testing Profile Loader...\n');

// Test 1: Load default profile
console.log('Test 1: Load default profile');
try {
  const profile = loadProfile('default');
  assert(profile.name === 'default', 'Default profile should have name "default"');
  assert(profile.commandAliases, 'Default profile should have commandAliases');
  assert(profile.hooks, 'Default profile should have hooks');
  console.log('✅ Default profile loaded successfully\n');
} catch (error) {
  console.error(`❌ Failed to load default profile: ${error.message}\n`);
  process.exit(1);
}

// Test 2: List available profiles
console.log('Test 2: List available profiles');
try {
  const profiles = listProfiles();
  assert(Array.isArray(profiles), 'listProfiles should return an array');
  assert(profiles.length > 0, 'Should have at least one profile');
  
  const defaultProfile = profiles.find(p => p.name === 'default');
  assert(defaultProfile, 'Default profile should be in the list');
  
  console.log(`✅ Found ${profiles.length} profiles:`);
  profiles.forEach(p => {
    console.log(`   - ${p.name}: ${p.aliasCount} aliases, ${p.hookCount} hooks`);
  });
  console.log();
} catch (error) {
  console.error(`❌ Failed to list profiles: ${error.message}\n`);
  process.exit(1);
}

// Test 3: Load Frappe profile
console.log('Test 3: Load Frappe profile');
try {
  const profile = loadProfile('frappe');
  assert(profile.name === 'frappe', 'Frappe profile should have name "frappe"');
  assert(profile.commandAliases['bench-update'], 'Frappe profile should have bench-update alias');
  assert(profile.hooks['pre-bench-update'], 'Frappe profile should have pre-bench-update hook');
  console.log('✅ Frappe profile loaded successfully');
  console.log(`   - Aliases: ${Object.keys(profile.commandAliases).length}`);
  console.log(`   - Hooks: ${Object.keys(profile.hooks).length}\n`);
} catch (error) {
  console.error(`❌ Failed to load Frappe profile: ${error.message}\n`);
  process.exit(1);
}

// Test 4: Get active profile name
console.log('Test 4: Get active profile name');
try {
  const currentProfile = getActiveProfileName();
  assert(typeof currentProfile === 'string', 'Active profile name should be a string');
  console.log(`✅ Current active profile: ${currentProfile}\n`);
} catch (error) {
  console.error(`❌ Failed to get active profile: ${error.message}\n`);
  process.exit(1);
}

// Test 5: Switch profiles
console.log('Test 5: Switch profiles');
const testProfileFile = path.join(__dirname, '..', '.ssh-manager-profile');
// Read first and treat a missing file as "no profile set", rather than
// checking then reading: the file can change between the two calls.
let originalProfile = null;
try {
  originalProfile = fs.readFileSync(testProfileFile, 'utf8').trim();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

try {
  // Switch to docker profile
  const switchResult = setActiveProfile('docker');
  assert(switchResult === true, 'Should successfully switch to docker profile');
  
  const newProfile = getActiveProfileName();
  assert(newProfile === 'docker', 'Active profile should be docker after switch');
  
  console.log('✅ Successfully switched to docker profile');
  
  // Restore original profile
  if (originalProfile) {
    fs.writeFileSync(testProfileFile, originalProfile);
  } else {
    // force:true removes it if present and stays quiet otherwise — no window
    // between checking and unlinking.
    fs.rmSync(testProfileFile, { force: true });
  }
  console.log('✅ Restored original profile setting\n');
} catch (error) {
  console.error(`❌ Failed to switch profiles: ${error.message}\n`);
  // Cleanup
  if (originalProfile) {
    fs.writeFileSync(testProfileFile, originalProfile);
  } else {
    // force:true removes it if present and stays quiet otherwise — no window
    // between checking and unlinking.
    fs.rmSync(testProfileFile, { force: true });
  }
  process.exit(1);
}

// Test 6: Load non-existent profile (should fallback to default)
console.log('Test 6: Load non-existent profile');
try {
  const profile = loadProfile('non-existent-profile');
  assert(profile, 'Should return a profile even for non-existent name');
  assert(profile.name === 'default' || profile.name === 'minimal', 
    'Should fallback to default or minimal profile');
  console.log(`✅ Correctly fell back to ${profile.name} profile\n`);
} catch (error) {
  console.error(`❌ Failed to handle non-existent profile: ${error.message}\n`);
  process.exit(1);
}

// Test 7: Verify all profile files are valid JSON
console.log('Test 7: Validate all profile JSON files');
try {
  const profilesDir = path.join(__dirname, '..', 'profiles');
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const filePath = path.join(profilesDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const profile = JSON.parse(content);
    
    assert(profile.name, `Profile ${file} should have a name`);
    assert(profile.description, `Profile ${file} should have a description`);
    assert(typeof profile.commandAliases === 'object', 
      `Profile ${file} should have commandAliases object`);
    assert(typeof profile.hooks === 'object', 
      `Profile ${file} should have hooks object`);
    
    console.log(`   ✓ ${file} is valid`);
  }
  console.log(`✅ All ${files.length} profile files are valid\n`);
} catch (error) {
  console.error(`❌ Profile validation failed: ${error.message}\n`);
  process.exit(1);
}

console.log('🎉 All profile tests passed!');