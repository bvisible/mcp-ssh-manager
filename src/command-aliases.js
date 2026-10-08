/**
 * Command Aliases System for MCP SSH Manager
 * Provides shortcuts for frequently used commands
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { loadProfile } from './profile-loader.js';
import { readUserState, writeUserState } from './user-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Custom aliases live in the manager home; the package copy is read only as a
// fallback for a source checkout (see user-state.js, issue #87).
const ALIASES_NAME = 'command-aliases.json';
const LEGACY_ALIASES_FILE = path.join(__dirname, '..', '.command-aliases.json');

// Get aliases from the active profile
let profileAliases = {};
try {
  const profile = loadProfile();
  profileAliases = profile.commandAliases || {};
} catch (error) {
  console.error(`Error loading profile aliases: ${error.message}`);
}

/**
 * Load command aliases from file
 */
export function loadCommandAliases() {
  try {
    // Start with profile aliases
    let aliases = { ...profileAliases };

    // Merge with custom aliases from file
    const state = readUserState(ALIASES_NAME, LEGACY_ALIASES_FILE);
    if (state) {
      aliases = { ...aliases, ...JSON.parse(state.text) };
    }

    return aliases;
  } catch (error) {
    console.error(`Error loading command aliases: ${error.message}`);
  }
  return profileAliases;
}

/**
 * Save command aliases to file
 */
function saveCommandAliases(aliases) {
  try {
    // Only save custom aliases (not from profile)
    const customAliases = {};
    for (const [key, value] of Object.entries(aliases)) {
      if (profileAliases[key] !== value) {
        customAliases[key] = value;
      }
    }

    writeUserState(ALIASES_NAME, JSON.stringify(customAliases, null, 2));
    return true;
  } catch (error) {
    console.error(`Error saving command aliases: ${error.message}`);
    return false;
  }
}

/**
 * Expand command if it's an alias
 */
export function expandCommandAlias(command) {
  const aliases = loadCommandAliases();

  // Check if the entire command is an alias
  if (aliases[command]) {
    return aliases[command];
  }

  // Check if the command starts with an alias
  const parts = command.split(' ');
  const firstPart = parts[0];

  if (aliases[firstPart]) {
    parts[0] = aliases[firstPart];
    return parts.join(' ');
  }

  return command;
}

/**
 * Add or update a command alias
 */
export function addCommandAlias(alias, command) {
  const aliases = loadCommandAliases();
  aliases[alias] = command;
  return saveCommandAliases(aliases);
}

/**
 * Remove a command alias
 */
export function removeCommandAlias(alias) {
  const aliases = loadCommandAliases();

  // Don't remove profile aliases, just reset them
  if (profileAliases[alias]) {
    aliases[alias] = profileAliases[alias];
  } else {
    delete aliases[alias];
  }

  return saveCommandAliases(aliases);
}

/**
 * List all command aliases
 */
export function listCommandAliases() {
  const aliases = loadCommandAliases();
  const result = [];

  for (const [alias, command] of Object.entries(aliases)) {
    result.push({
      alias,
      command,
      isFromProfile: profileAliases[alias] === command,
      isCustom: profileAliases[alias] !== command
    });
  }

  return result.sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Get suggested aliases based on command
 */
export function suggestAliases(command) {
  const suggestions = [];
  const aliases = loadCommandAliases();

  const commandLower = command.toLowerCase();

  for (const [alias, aliasCommand] of Object.entries(aliases)) {
    if (aliasCommand.toLowerCase().includes(commandLower) ||
        alias.toLowerCase().includes(commandLower)) {
      suggestions.push({ alias, command: aliasCommand });
    }
  }

  return suggestions;
}
