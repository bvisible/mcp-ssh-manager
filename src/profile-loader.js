/**
 * Profile Loader for SSH Manager
 * Loads configuration profiles for different project types
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const PROFILE_CONFIG_FILE = path.join(__dirname, '..', '.ssh-manager-profile');

/**
 * Get the active profile name
 */
export function getActiveProfileName() {
  // 1. Check environment variable
  if (process.env.SSH_MANAGER_PROFILE) {
    return process.env.SSH_MANAGER_PROFILE;
  }
  
  // 2. Check configuration file
  if (fs.existsSync(PROFILE_CONFIG_FILE)) {
    try {
      const profileName = fs.readFileSync(PROFILE_CONFIG_FILE, 'utf8').trim();
      if (profileName) {
        return profileName;
      }
    } catch (error) {
      console.error(`Error reading profile config: ${error.message}`);
    }
  }
  
  // 3. Default to 'default' profile
  return 'default';
}

/**
 * Load a profile by name
 */
export function loadProfile(profileName = null) {
  const name = profileName || getActiveProfileName();
  const profilePath = path.join(PROFILES_DIR, `${name}.json`);
  
  try {
    if (fs.existsSync(profilePath)) {
      const profileData = fs.readFileSync(profilePath, 'utf8');
      const profile = JSON.parse(profileData);
      
      console.error(`📦 Loaded profile: ${profile.name} - ${profile.description}`);
      return profile;
    } else {
      console.error(`⚠️  Profile '${name}' not found, using default profile`);
      return loadDefaultProfile();
    }
  } catch (error) {
    console.error(`❌ Error loading profile '${name}': ${error.message}`);
    return loadDefaultProfile();
  }
}

/**
 * Load the default profile
 */
function loadDefaultProfile() {
  const defaultPath = path.join(PROFILES_DIR, 'default.json');
  
  try {
    if (fs.existsSync(defaultPath)) {
      const profileData = fs.readFileSync(defaultPath, 'utf8');
      return JSON.parse(profileData);
    }
  } catch (error) {
    console.error(`Error loading default profile: ${error.message}`);
  }
  
  // Return minimal profile if default doesn't exist
  return {
    name: 'minimal',
    description: 'Minimal profile',
    commandAliases: {},
    hooks: {}
  };
}

/**
 * List all available profiles
 */
export function listProfiles() {
  try {
    const files = fs.readdirSync(PROFILES_DIR);
    const profiles = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const profilePath = path.join(PROFILES_DIR, file);
        try {
          const data = fs.readFileSync(profilePath, 'utf8');
          const profile = JSON.parse(data);
          profiles.push({
            name: profile.name || file.replace('.json', ''),
            description: profile.description || 'No description',
            file: file,
            aliasCount: Object.keys(profile.commandAliases || {}).length,
            hookCount: Object.keys(profile.hooks || {}).length
          });
        } catch (error) {
          console.error(`Error reading profile ${file}: ${error.message}`);
        }
      }
    }
    
    return profiles;
  } catch (error) {
    console.error(`Error listing profiles: ${error.message}`);
    return [];
  }
}

/**
 * Set the active profile
 */
export function setActiveProfile(profileName) {
  try {
    // Verify profile exists
    const profilePath = path.join(PROFILES_DIR, `${profileName}.json`);
    if (!fs.existsSync(profilePath)) {
      throw new Error(`Profile '${profileName}' does not exist`);
    }
    
    // Write to config file
    fs.writeFileSync(PROFILE_CONFIG_FILE, profileName);
    return true;
  } catch (error) {
    console.error(`Error setting active profile: ${error.message}`);
    return false;
  }
}

/**
 * Create a custom profile
 */
export function createProfile(name, config) {
  try {
    const profilePath = path.join(PROFILES_DIR, `${name}.json`);
    
    // Check if profile already exists
    if (fs.existsSync(profilePath)) {
      throw new Error(`Profile '${name}' already exists`);
    }
    
    const profile = {
      name: name,
      description: config.description || `Custom profile: ${name}`,
      commandAliases: config.commandAliases || {},
      hooks: config.hooks || {}
    };
    
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    return true;
  } catch (error) {
    console.error(`Error creating profile: ${error.message}`);
    return false;
  }
}

/**
 * Merge profiles (useful for extending base profiles)
 */
export function mergeProfiles(baseProfileName, extensions) {
  const baseProfile = loadProfile(baseProfileName);
  
  return {
    ...baseProfile,
    commandAliases: {
      ...baseProfile.commandAliases,
      ...extensions.commandAliases
    },
    hooks: {
      ...baseProfile.hooks,
      ...extensions.hooks
    }
  };
}