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

class ServerGroups {
  constructor() {
    this.groups = this.loadGroups();
  }

  /**
   * Load groups from file
   */
  loadGroups() {
    try {
      if (fs.existsSync(GROUPS_FILE)) {
        const data = fs.readFileSync(GROUPS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.warn('Failed to load server groups', { error: error.message });
    }

    // Return default groups
    return {
      all: {
        description: 'All configured servers',
        servers: [],
        dynamic: true  // Will be populated from server config
      },
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

      fs.writeFileSync(GROUPS_FILE, JSON.stringify(groupsToSave, null, 2));
      logger.info('Server groups saved', { count: Object.keys(groupsToSave).length });
      return true;
    } catch (error) {
      logger.error('Failed to save server groups', { error: error.message });
      return false;
    }
  }

  /**
   * Get a group by name
   */
  getGroup(name) {
    const group = this.groups[name.toLowerCase()];

    if (!group) {
      throw new Error(`Group '${name}' not found`);
    }

    // For 'all' group, return all configured servers
    if (name.toLowerCase() === 'all' && group.dynamic) {
      return {
        ...group,
        servers: this.getAllServers()
      };
    }

    return group;
  }

  /**
   * Get all configured servers
   */
  getAllServers() {
    // This will be populated from the main server config
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
    const group = this.groups[groupName];

    if (!group) {
      throw new Error(`Group '${name}' not found`);
    }

    if (group.dynamic) {
      throw new Error(`Cannot update dynamic group '${name}'`);
    }

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
    const group = this.groups[groupName];

    if (!group) {
      throw new Error(`Group '${name}' not found`);
    }

    if (group.dynamic) {
      throw new Error(`Cannot delete dynamic group '${name}'`);
    }

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
    const group = this.groups[groupName];

    if (!group) {
      throw new Error(`Group '${name}' not found`);
    }

    if (group.dynamic) {
      throw new Error(`Cannot modify dynamic group '${name}'`);
    }

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
    const group = this.groups[groupName];

    if (!group) {
      throw new Error(`Group '${name}' not found`);
    }

    if (group.dynamic) {
      throw new Error(`Cannot modify dynamic group '${name}'`);
    }

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
    const groups = [];

    for (const [name, group] of Object.entries(this.groups)) {
      // Populate dynamic groups
      if (group.dynamic && name === 'all') {
        group.servers = this.getAllServers();
      }

      groups.push({
        name,
        ...group,
        serverCount: group.servers.length
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
export const createGroup = (name, servers, options) => serverGroups.createGroup(name, servers, options);
export const updateGroup = (name, updates) => serverGroups.updateGroup(name, updates);
export const deleteGroup = (name) => serverGroups.deleteGroup(name);
export const addServersToGroup = (name, servers) => serverGroups.addServers(name, servers);
export const removeServersFromGroup = (name, servers) => serverGroups.removeServers(name, servers);
export const listGroups = () => serverGroups.listGroups();
export const executeOnGroup = (name, executor, options) => serverGroups.executeOnGroup(name, executor, options);
