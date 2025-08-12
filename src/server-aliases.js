import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Server alias management
 * Allows using aliases like "prod" instead of full server names
 */

const ALIASES_FILE = path.join(__dirname, '..', '.server-aliases.json');

/**
 * Load server aliases from configuration file
 */
export function loadAliases() {
  try {
    if (fs.existsSync(ALIASES_FILE)) {
      const content = fs.readFileSync(ALIASES_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`Warning: Could not load aliases: ${error.message}`);
  }
  return {};
}

/**
 * Save server aliases to configuration file
 */
export function saveAliases(aliases) {
  try {
    fs.writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2));
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
  
  // Check if it's an alias
  if (aliases[nameOrAlias]) {
    return aliases[nameOrAlias];
  }
  
  // Check if it's a direct server name
  const normalizedName = nameOrAlias.toLowerCase();
  if (servers[normalizedName]) {
    return normalizedName;
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
 * Create default aliases based on common patterns
 */
export function createDefaultAliases(servers) {
  const aliases = {};
  
  Object.entries(servers).forEach(([name, config]) => {
    // Create short aliases for common patterns
    if (name.includes('production')) {
      aliases['prod'] = name;
    } else if (name.includes('staging')) {
      aliases['stage'] = name;
    } else if (name.includes('development')) {
      aliases['dev'] = name;
    } else if (name.includes('testing')) {
      aliases['test'] = name;
    }
    
    // Create aliases from hostname patterns
    const host = config.host;
    if (host) {
      // Extract subdomain as potential alias
      const subdomain = host.split('.')[0];
      if (subdomain && subdomain !== 'www' && !aliases[subdomain]) {
        aliases[subdomain] = name;
      }
    }
  });
  
  return aliases;
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