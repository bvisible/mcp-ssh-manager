/**
 * Profile Loader for SSH Manager
 * Loads configuration profiles for different project types
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readUserState, writeUserState } from './user-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
// The active profile is remembered in the manager home; the package copy is
// read only as a fallback for a source checkout (see user-state.js, issue #87).
const PROFILE_STATE_NAME = 'profile';
const LEGACY_PROFILE_CONFIG_FILE = path.join(__dirname, '..', '.ssh-manager-profile');

// A profile name becomes a file name under profiles/: nothing that could
// climb out of that directory and load some other JSON file as hooks.
const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Get the active profile name
 */
export function getActiveProfileName() {
  // 1. Check environment variable
  if (process.env.SSH_MANAGER_PROFILE) {
    return process.env.SSH_MANAGER_PROFILE;
  }

  // 2. Check configuration file
  try {
    const profileName = readUserState(PROFILE_STATE_NAME, LEGACY_PROFILE_CONFIG_FILE)?.text.trim();
    if (profileName) {
      return profileName;
    }
  } catch (error) {
    console.error(`Error reading profile config: ${error.message}`);
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
    if (PROFILE_NAME.test(name) && fs.existsSync(profilePath)) {
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
    if (!PROFILE_NAME.test(String(profileName)) || !fs.existsSync(profilePath)) {
      throw new Error(`Profile '${profileName}' does not exist`);
    }

    // Write to config file
    writeUserState(PROFILE_STATE_NAME, `${profileName}\n`);
    return true;
  } catch (error) {
    console.error(`Error setting active profile: ${error.message}`);
    return false;
  }
}
