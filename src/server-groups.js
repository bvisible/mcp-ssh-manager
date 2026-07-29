/**
 * Server Groups Management
 * Manages groups of servers for batch operations
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default groups file location
const GROUPS_FILE = path.join(__dirname, '..', '.server-groups.json');

// Group execution strategies
const EXECUTION_STRATEGIES = {
  PARALLEL: 'parallel',      // Execute on all servers at once
  SEQUENTIAL: 'sequential',  // Execute one by one
  ROLLING: 'rolling'        // Execute with delay between servers
};

export class ServerGroups {
  constructor(options = {}) {
    // Both options exist so this class can be instantiated in isolation (tests,
    // embedding). The exported singleton below keeps the historical defaults.
    this.groupsFile = options.groupsFile || GROUPS_FILE;
    this.serverConfigProvider = typeof options.serverConfigProvider === 'function'
      ? options.serverConfigProvider
      : null;
    this.groups = this.loadGroups();
  }

  /**
   * Inject an accessor to the loaded SSH server configuration.
   * Without it this module can only see servers declared in the environment,
   * which misses every TOML-defined server.
   */
  setServerConfigProvider(provider) {
    this.serverConfigProvider = typeof provider === 'function' ? provider : null;
  }

  /**
   * Current SSH server configurations, keyed by server name.
   * Empty when no provider has been injected.
   */
  getServerConfigs() {
    if (!this.serverConfigProvider) return {};

    try {
      return this.serverConfigProvider() || {};
    } catch (error) {
      logger.warn('Failed to read SSH server configuration for groups', { error: error.message });
      return {};
    }
  }

  /**
   * Built-in groups whose membership is computed, never stored.
   */
  getDynamicGroups() {
    return {
      all: {
        description: 'All configured servers',
        servers: [],
        dynamic: true  // Will be populated from server config
      }
    };
  }

  /**
   * Load groups from file
   */
  loadGroups() {
    try {
      if (fs.existsSync(this.groupsFile)) {
        const data = fs.readFileSync(this.groupsFile, 'utf8');
        const stored = JSON.parse(data);

        // Dynamic groups are deliberately never persisted (see saveGroups), so
        // they are missing from every file written after the first group edit.
        // Re-inject them, otherwise 'all' disappears for good the moment a user
        // creates a group. They cannot be deleted on purpose either, so nothing
        // the user did is being undone here.
        return { ...this.getDynamicGroups(), ...stored };
      }
    } catch (error) {
      logger.warn('Failed to load server groups', { error: error.message });
    }

    // Return default groups
    return {
      ...this.getDynamicGroups(),
      production: {
        description: 'Production servers',
        servers: [],
        strategy: EXECUTION_STRATEGIES.ROLLING,
        delay: 5000  // 5 seconds between servers
      },
      staging: {
        description: 'Staging/test servers',
        servers: [],
        strategy: EXECUTION_STRATEGIES.PARALLEL
      },
      development: {
        description: 'Development servers',
        servers: [],
        strategy: EXECUTION_STRATEGIES.PARALLEL
      }
    };
  }

  /**
   * Save groups to file
   */
  saveGroups() {
    try {
      // Don't save dynamic groups
      const groupsToSave = {};
      for (const [name, group] of Object.entries(this.groups)) {
        if (!group.dynamic) {
          groupsToSave[name] = group;
        }
      }

      fs.writeFileSync(this.groupsFile, JSON.stringify(groupsToSave, null, 2));
      logger.info('Server groups saved', { count: Object.keys(groupsToSave).length });
      return true;
    } catch (error) {
      logger.error('Failed to save server groups', { error: error.message });
      return false;
    }
  }

  /**
   * Groups derived from the per-server `group` field of the SSH configuration.
   * Returns a Map of group name -> server names. Group names are lowercased, so
   * `group = "Production"` and `group = "production"` land in the same group.
   */
  getConfigGroups() {
    const derived = new Map();

    for (const [name, config] of Object.entries(this.getServerConfigs())) {
      const label = typeof config?.group === 'string' ? config.group.trim() : '';
      if (!label) continue;

      const groupName = label.toLowerCase();
      const serverName = String(config.name || name).toLowerCase();
      const members = derived.get(groupName) || [];
      if (!members.includes(serverName)) members.push(serverName);
      derived.set(groupName, members);
    }

    return derived;
  }

  /**
   * Members of a group, merging the explicit `.server-groups.json` list with
   * every server whose config carries a matching `group` field. Membership is a
   * union: tagging a server in the SSH config adds it to the group without
   * touching the stored list, and the stored list keeps working on its own.
   */
  resolveMembers(groupName, explicitServers = [], derived = this.getConfigGroups()) {
    const members = [];

    for (const server of [...explicitServers, ...(derived.get(groupName) || [])]) {
      const normalized = String(server).toLowerCase();
      if (!members.includes(normalized)) members.push(normalized);
    }

    return members;
  }

  /**
   * Get a group by name
   */
  getGroup(name) {
    const groupName = name.toLowerCase();
    const group = this.groups[groupName];
    const derived = this.getConfigGroups();
    const derivedMembers = derived.get(groupName) || [];

    if (!group) {
      // Group declared only through the `group` field of the SSH configuration.
      if (derivedMembers.length === 0) {
        throw new Error(`Group '${name}' not found`);
      }

      return {
        description: `Servers configured with group = "${groupName}"`,
        servers: derivedMembers,
        strategy: EXECUTION_STRATEGIES.PARALLEL,
        dynamic: true,
        fromConfig: true
      };
    }

    // For 'all' group, return all configured servers
    if (groupName === 'all' && group.dynamic) {
      return {
        ...group,
        servers: this.getAllServers()
      };
    }

    if (derivedMembers.length === 0) {
      return group;
    }

    return {
      ...group,
      servers: this.resolveMembers(groupName, group.servers, derived),
      fromConfig: true
    };
  }

  /**
   * Resolve a group for mutation, rejecting the ones that are not editable.
   * `verb` only shapes the error message ("Cannot update dynamic group ...").
   */
  getMutableGroup(name, verb) {
    const groupName = name.toLowerCase();
    const group = this.groups[groupName];

    if (!group) {
      if (this.getConfigGroups().has(groupName)) {
        throw new Error(
          `Group '${name}' comes from the 'group' field of your SSH server configuration and cannot be edited here. ` +
          'Change the group of the servers themselves in your .env/TOML config, or use a different group name.'
        );
      }

      throw new Error(`Group '${name}' not found`);
    }

    if (group.dynamic) {
      throw new Error(`Cannot ${verb} dynamic group '${name}'`);
    }

    return group;
  }

  /**
   * Get all configured servers
   */
  getAllServers() {
    const configured = Object.keys(this.getServerConfigs());
    if (configured.length > 0) {
      return configured.map(name => name.toLowerCase());
    }

    // No provider injected: fall back to scanning the environment. This only
    // sees .env servers, never TOML ones — hence the provider.
    const servers = [];

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SSH_SERVER_') && key.endsWith('_HOST')) {
        const serverName = key.replace('SSH_SERVER_', '').replace('_HOST', '').toLowerCase();
        servers.push(serverName);
      }
    }

    return servers;
  }

  /**
   * Create a new group
   */
  createGroup(name, servers = [], options = {}) {
    const groupName = name.toLowerCase();

    if (this.groups[groupName] && !options.overwrite) {
      throw new Error(`Group '${name}' already exists`);
    }

    this.groups[groupName] = {
      description: options.description || `Group: ${name}`,
      servers: servers,
      strategy: options.strategy || EXECUTION_STRATEGIES.PARALLEL,
      delay: options.delay || 0,
      stopOnError: options.stopOnError || false,
      created: new Date().toISOString()
    };

    this.saveGroups();

    logger.info('Server group created', {
      name: groupName,
      servers: servers.length,
      strategy: this.groups[groupName].strategy
    });

    return this.groups[groupName];
  }

  /**
   * Update a group
   */
  updateGroup(name, updates) {
    const groupName = name.toLowerCase();
    const group = this.getMutableGroup(name, 'update');

    // Update group properties
    if (updates.servers !== undefined) {
      group.servers = updates.servers;
    }
    if (updates.description !== undefined) {
      group.description = updates.description;
    }
    if (updates.strategy !== undefined) {
      group.strategy = updates.strategy;
    }
    if (updates.delay !== undefined) {
      group.delay = updates.delay;
    }
    if (updates.stopOnError !== undefined) {
      group.stopOnError = updates.stopOnError;
    }

    group.updated = new Date().toISOString();

    this.saveGroups();

    logger.info('Server group updated', {
      name: groupName,
      updates: Object.keys(updates)
    });

    return group;
  }

  /**
   * Delete a group
   */
  deleteGroup(name) {
    const groupName = name.toLowerCase();
    this.getMutableGroup(name, 'delete');

    delete this.groups[groupName];
    this.saveGroups();

    logger.info('Server group deleted', { name: groupName });

    return true;
  }

  /**
   * Add servers to a group
   */
  addServers(name, servers) {
    const groupName = name.toLowerCase();
    const group = this.getMutableGroup(name, 'modify');

    // Add servers (avoid duplicates)
    const currentServers = new Set(group.servers);
    servers.forEach(server => currentServers.add(server.toLowerCase()));
    group.servers = Array.from(currentServers);

    this.saveGroups();

    logger.info('Servers added to group', {
      group: groupName,
      added: servers.length,
      total: group.servers.length
    });

    return group;
  }

  /**
   * Remove servers from a group
   */
  removeServers(name, servers) {
    const groupName = name.toLowerCase();
    const group = this.getMutableGroup(name, 'modify');

    // Remove servers
    const toRemove = new Set(servers.map(s => s.toLowerCase()));
    group.servers = group.servers.filter(s => !toRemove.has(s));

    this.saveGroups();

    logger.info('Servers removed from group', {
      group: groupName,
      removed: servers.length,
      remaining: group.servers.length
    });

    return group;
  }

  /**
   * List all groups
   */
  listGroups() {
    const derived = this.getConfigGroups();
    const groups = [];

    for (const [name, group] of Object.entries(this.groups)) {
      // Populate dynamic groups
      const servers = group.dynamic && name === 'all'
        ? this.getAllServers()
        : this.resolveMembers(name, group.servers, derived);

      groups.push({
        name,
        ...group,
        servers,
        serverCount: servers.length,
        ...((derived.get(name) || []).length > 0 ? { fromConfig: true } : {})
      });
    }

    // Groups that exist only through the `group` field of the SSH configuration
    for (const [name, servers] of derived) {
      if (this.groups[name]) continue;

      groups.push({
        name,
        description: `Servers configured with group = "${name}"`,
        servers,
        serverCount: servers.length,
        strategy: EXECUTION_STRATEGIES.PARALLEL,
        dynamic: true,
        fromConfig: true
      });
    }

    return groups;
  }

  /**
   * Execute command on group with strategy
   */
  async executeOnGroup(groupName, executor, options = {}) {
    const group = this.getGroup(groupName);
    const results = [];
    const strategy = options.strategy || group.strategy || EXECUTION_STRATEGIES.PARALLEL;
    const delay = options.delay || group.delay || 0;
    const stopOnError = options.stopOnError !== undefined ? options.stopOnError : group.stopOnError;

    logger.info('Executing on server group', {
      group: groupName,
      servers: group.servers.length,
      strategy,
      delay
    });

    switch (strategy) {
    case EXECUTION_STRATEGIES.PARALLEL: {
      // Execute on all servers simultaneously
      const promises = group.servers.map(async (server) => {
        try {
          const result = await executor(server);
          return { server, success: true, result };
        } catch (error) {
          logger.error(`Execution failed on ${server}`, { error: error.message });
          return { server, success: false, error: error.message };
        }
      });

      const parallelResults = await Promise.all(promises);
      results.push(...parallelResults);
      break;
    }

    case EXECUTION_STRATEGIES.SEQUENTIAL:
    case EXECUTION_STRATEGIES.ROLLING:
      // Execute one by one
      for (const server of group.servers) {
        try {
          const result = await executor(server);
          results.push({ server, success: true, result });

          // Add delay for rolling strategy
          if (strategy === EXECUTION_STRATEGIES.ROLLING && delay > 0) {
            logger.debug(`Waiting ${delay}ms before next server`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } catch (error) {
          logger.error(`Execution failed on ${server}`, { error: error.message });
          results.push({ server, success: false, error: error.message });

          // Stop on error if configured
          if (stopOnError) {
            logger.warn('Stopping execution due to error', { server });
            break;
          }
        }
      }
      break;

    default:
      throw new Error(`Unknown execution strategy: ${strategy}`);
    }

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    logger.info('Group execution completed', {
      group: groupName,
      successful,
      failed,
      total: results.length
    });

    return {
      group: groupName,
      strategy,
      results,
      summary: {
        total: results.length,
        successful,
        failed
      }
    };
  }
}

// Export singleton instance
const serverGroups = new ServerGroups();

// Export convenience functions
export const setServerConfigProvider = (provider) => serverGroups.setServerConfigProvider(provider);
export const getGroup = (name) => serverGroups.getGroup(name);
export const createGroup = (name, servers, options) => serverGroups.createGroup(name, servers, options);
export const updateGroup = (name, updates) => serverGroups.updateGroup(name, updates);
export const deleteGroup = (name) => serverGroups.deleteGroup(name);
export const addServersToGroup = (name, servers) => serverGroups.addServers(name, servers);
export const removeServersFromGroup = (name, servers) => serverGroups.removeServers(name, servers);
export const listGroups = () => serverGroups.listGroups();
export const executeOnGroup = (name, executor, options) => serverGroups.executeOnGroup(name, executor, options);
