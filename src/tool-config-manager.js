/**
 * Tool Configuration Manager
 *
 * Manages tool enablement configuration stored in JSON format.
 * Handles loading, saving, and querying tool configuration.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';
import { TOOL_GROUPS, findToolGroup, getAllTools } from './tool-registry.js';

/**
 * Configuration file location
 * User-global only: ~/.ssh-manager/tools-config.json
 */
const CONFIG_DIR = path.join(os.homedir(), '.ssh-manager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'tools-config.json');

/**
 * Tool Configuration Manager Class
 */
class ToolConfigManager {
  constructor() {
    this.config = null;
    this.configPath = CONFIG_FILE;
  }

  /**
   * Load tool configuration from file
   * @returns {Promise<Object>} Configuration object
   */
  async load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(content);

        // Validate config structure
        if (!this.validateConfig(this.config)) {
          logger.warn('Invalid tool configuration, using defaults');
          this.config = this.getDefaultConfig();
        } else {
          logger.info(`Tool configuration loaded from ${this.configPath}`);
          logger.info(`Mode: ${this.config.mode}, Enabled tools: ${this.getEnabledTools().length}/37`);
        }
      } else {
        // No config file - default to all tools enabled
        logger.info('No tool configuration found, enabling all tools (default)');
        logger.info('Run "ssh-manager tools configure" to optimize and reduce context usage');
        this.config = this.getDefaultConfig();
      }
    } catch (error) {
      logger.error(`Failed to load tool configuration: ${error.message}`);
      logger.info('Using default configuration (all tools enabled)');
      this.config = this.getDefaultConfig();
    }

    return this.config;
  }

  /**
   * Get default configuration (all tools enabled)
   * @returns {Object} Default configuration
   */
  getDefaultConfig() {
    return {
      version: '1.0',
      mode: 'all',
      groups: {
        core: { enabled: true },
        sessions: { enabled: true },
        monitoring: { enabled: true },
        backup: { enabled: true },
        database: { enabled: true },
        advanced: { enabled: true }
      },
      tools: {},
      _comment: 'Tool configuration for MCP SSH Manager. Run "ssh-manager tools configure" to customize.'
    };
  }

  /**
   * Validate configuration structure
   * @param {Object} config - Configuration to validate
   * @returns {boolean} True if valid
   */
  validateConfig(config) {
    if (!config || typeof config !== 'object') {
      return false;
    }

    // Check required fields
    if (!config.version || !config.mode) {
      return false;
    }

    // Validate mode
    if (!['all', 'minimal', 'custom'].includes(config.mode)) {
      return false;
    }

    // Check groups structure
    if (config.mode === 'custom' && !config.groups) {
      return false;
    }

    return true;
  }

  /**
   * Check if a specific tool is enabled
   * @param {string} toolName - Name of the tool
   * @returns {boolean} True if enabled
   */
  isToolEnabled(toolName) {
    if (!this.config) {
      return true; // Default to enabled if no config loaded
    }

    // Mode: all - everything enabled
    if (this.config.mode === 'all') {
      return true;
    }

    // Check individual tool override first
    if (this.config.tools && toolName in this.config.tools) {
      return this.config.tools[toolName];
    }

    // Mode: minimal - only core tools
    if (this.config.mode === 'minimal') {
      const group = findToolGroup(toolName);
      return group === 'core';
    }

    // Mode: custom - check group setting
    if (this.config.mode === 'custom') {
      const group = findToolGroup(toolName);
      if (group && this.config.groups && group in this.config.groups) {
        return this.config.groups[group].enabled;
      }
    }

    // Default to enabled if group not found (for new tools in updates)
    return true;
  }

  /**
   * Get array of all enabled tool names
   * @returns {string[]} Array of enabled tool names
   */
  getEnabledTools() {
    const allTools = getAllTools();
    return allTools.filter(tool => this.isToolEnabled(tool));
  }

  /**
   * Get array of all disabled tool names
   * @returns {string[]} Array of disabled tool names
   */
  getDisabledTools() {
    const allTools = getAllTools();
    return allTools.filter(tool => !this.isToolEnabled(tool));
  }

  /**
   * Check if a group is enabled
   * @param {string} groupName - Name of the group
   * @returns {boolean} True if enabled
   */
  isGroupEnabled(groupName) {
    if (!this.config) {
      return true;
    }

    if (this.config.mode === 'all') {
      return true;
    }

    if (this.config.mode === 'minimal') {
      return groupName === 'core';
    }

    if (this.config.mode === 'custom' && this.config.groups) {
      return this.config.groups[groupName]?.enabled ?? true;
    }

    return true;
  }

  /**
   * Save configuration to file
   * @returns {Promise<boolean>} True if saved successfully
   */
  async save() {
    try {
      // Ensure config directory exists
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      // Write config file
      const content = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, content, 'utf8');

      logger.info(`Tool configuration saved to ${this.configPath}`);
      return true;
    } catch (error) {
      logger.error(`Failed to save tool configuration: ${error.message}`);
      return false;
    }
  }

  /**
   * Enable a tool group
   * @param {string} groupName - Name of the group to enable
   * @returns {Promise<boolean>} True if successful
   */
  async enableGroup(groupName) {
    if (!TOOL_GROUPS[groupName]) {
      logger.error(`Unknown tool group: ${groupName}`);
      return false;
    }

    // Ensure we're in custom mode
    if (this.config.mode !== 'custom') {
      this.config.mode = 'custom';
    }

    // Initialize groups if needed
    if (!this.config.groups) {
      this.config.groups = {};
    }

    // Enable the group
    this.config.groups[groupName] = { enabled: true };

    logger.info(`Enabled tool group: ${groupName}`);
    return await this.save();
  }

  /**
   * Disable a tool group
   * @param {string} groupName - Name of the group to disable
   * @returns {Promise<boolean>} True if successful
   */
  async disableGroup(groupName) {
    if (!TOOL_GROUPS[groupName]) {
      logger.error(`Unknown tool group: ${groupName}`);
      return false;
    }

    if (groupName === 'core') {
      logger.error('Cannot disable core group (required for basic functionality)');
      return false;
    }

    // Ensure we're in custom mode
    if (this.config.mode !== 'custom') {
      this.config.mode = 'custom';
    }

    // Initialize groups if needed
    if (!this.config.groups) {
      this.config.groups = {};
    }

    // Disable the group
    this.config.groups[groupName] = { enabled: false };

    logger.info(`Disabled tool group: ${groupName}`);
    return await this.save();
  }

  /**
   * Enable a specific tool (individual override)
   * @param {string} toolName - Name of the tool to enable
   * @returns {Promise<boolean>} True if successful
   */
  async enableTool(toolName) {
    const allTools = getAllTools();
    if (!allTools.includes(toolName)) {
      logger.error(`Unknown tool: ${toolName}`);
      return false;
    }

    // Initialize tools object if needed
    if (!this.config.tools) {
      this.config.tools = {};
    }

    // Enable the tool
    this.config.tools[toolName] = true;

    logger.info(`Enabled tool: ${toolName}`);
    return await this.save();
  }

  /**
   * Disable a specific tool (individual override)
   * @param {string} toolName - Name of the tool to disable
   * @returns {Promise<boolean>} True if successful
   */
  async disableTool(toolName) {
    const allTools = getAllTools();
    if (!allTools.includes(toolName)) {
      logger.error(`Unknown tool: ${toolName}`);
      return false;
    }

    // Check if it's a core tool
    if (TOOL_GROUPS.core.includes(toolName)) {
      logger.warn(`Disabling core tool: ${toolName} (may limit functionality)`);
    }

    // Initialize tools object if needed
    if (!this.config.tools) {
      this.config.tools = {};
    }

    // Disable the tool
    this.config.tools[toolName] = false;

    logger.info(`Disabled tool: ${toolName}`);
    return await this.save();
  }

  /**
   * Set configuration mode
   * @param {string} mode - Mode to set ('all', 'minimal', 'custom')
   * @returns {Promise<boolean>} True if successful
   */
  async setMode(mode) {
    if (!['all', 'minimal', 'custom'].includes(mode)) {
      logger.error(`Invalid mode: ${mode}`);
      return false;
    }

    this.config.mode = mode;
    logger.info(`Set tool configuration mode to: ${mode}`);
    return await this.save();
  }

  /**
   * Reset configuration to defaults
   * @returns {Promise<boolean>} True if successful
   */
  async reset() {
    this.config = this.getDefaultConfig();
    logger.info('Reset tool configuration to defaults (all tools enabled)');
    return await this.save();
  }

  /**
   * Get configuration summary
   * @returns {Object} Summary object
   */
  getSummary() {
    const enabledTools = this.getEnabledTools();
    const disabledTools = this.getDisabledTools();

    return {
      mode: this.config.mode,
      configPath: this.configPath,
      totalTools: 37,
      enabledCount: enabledTools.length,
      disabledCount: disabledTools.length,
      groups: Object.keys(TOOL_GROUPS).map(groupName => ({
        name: groupName,
        enabled: this.isGroupEnabled(groupName),
        toolCount: TOOL_GROUPS[groupName].length
      }))
    };
  }

  /**
   * Export Claude Code auto-approval configuration
   * @returns {Object} Auto-approval config snippet
   */
  exportClaudeCodeConfig() {
    const enabledTools = this.getEnabledTools();

    const autoApprovalPatterns = enabledTools.map(tool => `mcp__ssh-manager__${tool}`);

    return {
      comment: 'Add these patterns to autoApprove.tools in claude_code_config.json',
      patterns: autoApprovalPatterns,
      exampleConfig: {
        autoApprove: {
          tools: autoApprovalPatterns
        }
      }
    };
  }
}

/**
 * Singleton instance
 */
let toolConfigInstance = null;

/**
 * Load tool configuration (singleton)
 * @returns {Promise<ToolConfigManager>} Configuration manager instance
 */
export async function loadToolConfig() {
  if (!toolConfigInstance) {
    toolConfigInstance = new ToolConfigManager();
    await toolConfigInstance.load();
  }
  return toolConfigInstance;
}

/**
 * Check if a tool is enabled (convenience function)
 * @param {string} toolName - Name of the tool
 * @returns {boolean} True if enabled
 */
export function isToolEnabled(toolName) {
  if (!toolConfigInstance) {
    return true; // Default to enabled before config is loaded
  }
  return toolConfigInstance.isToolEnabled(toolName);
}
