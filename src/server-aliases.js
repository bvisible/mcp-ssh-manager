import path from 'path';
import { fileURLToPath } from 'url';
import { readUserState, writeUserState } from './user-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Server alias management
 * Allows using aliases like "prod" instead of full server names
 */

// Kept in the manager home; the package copy is read only as a fallback for a
// source checkout (see user-state.js, issue #87).
const ALIASES_NAME = 'server-aliases.json';
const LEGACY_ALIASES_FILE = path.join(__dirname, '..', '.server-aliases.json');

/**
 * Load server aliases from configuration file
 */
function loadAliases() {
  try {
    const state = readUserState(ALIASES_NAME, LEGACY_ALIASES_FILE);
    if (state) {
      return JSON.parse(state.text);
    }
  } catch (error) {
    console.error(`Warning: Could not load aliases: ${error.message}`);
  }
  return {};
}

/**
 * Save server aliases to configuration file
 */
function saveAliases(aliases) {
  try {
    writeUserState(ALIASES_NAME, JSON.stringify(aliases, null, 2));
    return true;
  } catch (error) {
    console.error(`Error saving aliases: ${error.message}`);
    return false;
  }
}

/**
 * Resolve server name from alias
 */
export function resolveServerName(nameOrAlias, servers) {
  const aliases = loadAliases();

  // A canonical name always identifies itself, even if an old alias has the
  // same spelling. Policy checks and connection lookup must agree on identity.
  const normalizedName = nameOrAlias.toLowerCase();
  if (Object.hasOwn(servers, normalizedName)) {
    return normalizedName;
  }

  if (Object.hasOwn(aliases, nameOrAlias)) {
    const target = String(aliases[nameOrAlias]).toLowerCase();
    return Object.hasOwn(servers, target) ? target : null;
  }

  // Try to find partial match
  const serverNames = Object.keys(servers);
  const matches = serverNames.filter(name => name.includes(normalizedName));

  if (matches.length === 1) {
    return matches[0];
  } else if (matches.length > 1) {
    throw new Error(
      `Ambiguous server name "${nameOrAlias}". Matches: ${matches.join(', ')}`
    );
  }

  // Check if nameOrAlias contains a domain that matches a server
  if (nameOrAlias.includes('.')) {
    const matchingServer = serverNames.find(name => {
      const serverHost = servers[name].host;
      return serverHost && (
        serverHost === nameOrAlias ||
        serverHost.includes(nameOrAlias) ||
        nameOrAlias.includes(serverHost)
      );
    });

    if (matchingServer) {
      return matchingServer;
    }
  }

  return null;
}

/**
 * Add or update an alias
 */
export function addAlias(alias, serverName) {
  const aliases = loadAliases();
  aliases[alias] = serverName;
  return saveAliases(aliases);
}

/**
 * Remove an alias
 */
export function removeAlias(alias) {
  const aliases = loadAliases();
  delete aliases[alias];
  return saveAliases(aliases);
}

/**
 * List all aliases with their targets
 */
export function listAliases() {
  const aliases = loadAliases();
  return Object.entries(aliases).map(([alias, target]) => ({
    alias,
    target
  }));
}
