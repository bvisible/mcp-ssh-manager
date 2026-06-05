import * as dotenv from 'dotenv';
import TOML from '@iarna/toml';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';
import { VALID_MODES } from './policy.js';

// Parse a `;`-separated list of regex pattern strings. Empty entries are dropped.
// We do NOT compile here — that happens lazily in policy.js so config-loader stays
// free of regex error handling.
function parsePatternList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Normalize a mode string. Returns 'unrestricted' for any falsy/unknown input,
// after logging a warning when the input is set but invalid. This keeps existing
// configs (no MODE field) on the fast path.
function normalizeMode(raw, serverName) {
  if (raw === undefined || raw === null || raw === '') return 'unrestricted';
  const normalized = String(raw).toLowerCase().trim();
  if (!VALID_MODES.has(normalized)) {
    logger.warn(
      `Unknown security mode "${raw}" for server "${serverName}" — falling back to "unrestricted". Valid: ${[...VALID_MODES].join(', ')}.`
    );
    return 'unrestricted';
  }
  return normalized;
}

export class ConfigLoader {
  constructor() {
    this.servers = new Map();
    this.configSource = null;
  }

  /**
   * Load configuration from multiple sources with priority:
   * 1. Environment variables (highest priority)
   * 2. .env file
   * 3. TOML config file (lowest priority)
   */
  async load(options = {}) {
    const {
      envPath = path.join(process.cwd(), '.env'),
      tomlPath = process.env.SSH_CONFIG_PATH || path.join(os.homedir(), '.codex', 'ssh-config.toml'),
      preferToml = false
    } = options;

    // Clear existing servers
    this.servers.clear();

    // Load in reverse priority order (lowest to highest)
    let loadedFromToml = false;
    let loadedFromEnv = false;

    // Try loading TOML config first (lowest priority)
    if (fs.existsSync(tomlPath)) {
      try {
        await this.loadTomlConfig(tomlPath);
        loadedFromToml = true;
        logger.info(`Loaded SSH configuration from TOML: ${tomlPath}`);
      } catch (error) {
        logger.warn(`Failed to load TOML config: ${error.message}`);
      }
    }

    // Load .env file (higher priority, overwrites TOML)
    if (!preferToml && fs.existsSync(envPath)) {
      try {
        this.loadEnvConfig(envPath);
        loadedFromEnv = true;
        logger.info(`Loaded SSH configuration from .env: ${envPath}`);
      } catch (error) {
        logger.warn(`Failed to load .env config: ${error.message}`);
      }
    }

    // Load from environment variables (highest priority, overwrites everything)
    this.loadEnvironmentVariables();

    // Determine primary config source
    if (loadedFromEnv) {
      this.configSource = 'env';
    } else if (loadedFromToml) {
      this.configSource = 'toml';
    } else if (this.servers.size > 0) {
      this.configSource = 'environment';
    } else {
      this.configSource = null;
      logger.warn('No SSH server configurations found');
    }

    return this.servers;
  }

  /**
   * Load configuration from TOML file
   */
  async loadTomlConfig(tomlPath) {
    const content = fs.readFileSync(tomlPath, 'utf8');
    const config = TOML.parse(content);

    if (config.ssh_servers) {
      for (const [name, serverConfig] of Object.entries(config.ssh_servers)) {
        const normalizedName = name.toLowerCase();
        // allow_patterns / deny_patterns may be either a TOML array of strings
        // or a single `;`-separated string. Normalize to a string[] of regex
        // sources — compilation happens in policy.js.
        const tomlAllow = Array.isArray(serverConfig.allow_patterns)
          ? serverConfig.allow_patterns
          : parsePatternList(serverConfig.allow_patterns);
        const tomlDeny = Array.isArray(serverConfig.deny_patterns)
          ? serverConfig.deny_patterns
          : parsePatternList(serverConfig.deny_patterns);
        const mode = normalizeMode(serverConfig.mode, normalizedName);
        if (mode === 'restricted' && tomlAllow.length === 0) {
          logger.warn(
            `Server "${normalizedName}" is in "restricted" mode but has no allow_patterns — every command will be refused. Set allow_patterns to enable any execution.`
          );
        }

        this.servers.set(normalizedName, {
          name: normalizedName,
          host: serverConfig.host,
          user: serverConfig.user || serverConfig.username,
          password: serverConfig.password,
          keyPath: serverConfig.key_path || serverConfig.keypath || serverConfig.ssh_key,
          passphrase: serverConfig.passphrase,
          port: serverConfig.port || 22,
          defaultDir: serverConfig.default_dir || serverConfig.default_directory || serverConfig.cwd,
          sudoPassword: serverConfig.sudo_password,
          description: serverConfig.description,
          platform: serverConfig.platform ? serverConfig.platform.toLowerCase() : undefined,
          proxyJump: serverConfig.proxy_jump,
          proxyCommand: serverConfig.proxy_command || serverConfig.proxycommand,
          mode,
          allowPatterns: tomlAllow,
          denyPatterns: tomlDeny,
          auditLog: serverConfig.audit_log,
          source: 'toml'
        });
      }
    }
  }

  /**
   * Load configuration from .env file
   */
  loadEnvConfig(envPath) {
    const result = dotenv.config({ path: envPath, processEnv: {} });
    if (result.error) {
      throw result.error;
    }

    this.parseEnvVariables({
      ...process.env,
      ...(result.parsed || {})
    });
  }

  /**
   * Load configuration from environment variables
   */
  loadEnvironmentVariables() {
    this.parseEnvVariables(process.env);
  }

  /**
   * Parse environment variables for SSH server configurations
   */
  parseEnvVariables(env) {
    const serverPattern = /^SSH_SERVER_([A-Z0-9_]+)_HOST$/;
    const processedServers = new Set();

    for (const [key, value] of Object.entries(env)) {
      const match = key.match(serverPattern);
      if (match) {
        const serverName = match[1].toLowerCase();

        // Skip if already processed from a higher priority source
        if (processedServers.has(serverName)) continue;

        const envAllow = parsePatternList(env[`SSH_SERVER_${match[1]}_ALLOW_PATTERNS`]);
        const envDeny = parsePatternList(env[`SSH_SERVER_${match[1]}_DENY_PATTERNS`]);
        const mode = normalizeMode(env[`SSH_SERVER_${match[1]}_MODE`], serverName);
        if (mode === 'restricted' && envAllow.length === 0) {
          logger.warn(
            `Server "${serverName}" is in "restricted" mode but has no SSH_SERVER_${match[1]}_ALLOW_PATTERNS — every command will be refused. Set ALLOW_PATTERNS to enable any execution.`
          );
        }

        const server = {
          name: serverName,
          host: value,
          user: env[`SSH_SERVER_${match[1]}_USER`],
          password: env[`SSH_SERVER_${match[1]}_PASSWORD`],
          keyPath: env[`SSH_SERVER_${match[1]}_KEYPATH`],
          passphrase: env[`SSH_SERVER_${match[1]}_PASSPHRASE`],
          port: parseInt(env[`SSH_SERVER_${match[1]}_PORT`] || '22'),
          defaultDir: env[`SSH_SERVER_${match[1]}_DEFAULT_DIR`],
          sudoPassword: env[`SSH_SERVER_${match[1]}_SUDO_PASSWORD`],
          description: env[`SSH_SERVER_${match[1]}_DESCRIPTION`],
          platform: (env[`SSH_SERVER_${match[1]}_PLATFORM`] || '').toLowerCase() || undefined,
          proxyJump: env[`SSH_SERVER_${match[1]}_PROXYJUMP`],
          proxyCommand: env[`SSH_SERVER_${match[1]}_PROXYCOMMAND`],
          mode,
          allowPatterns: envAllow,
          denyPatterns: envDeny,
          auditLog: env[`SSH_SERVER_${match[1]}_AUDIT_LOG`],
          source: 'env'
        };

        this.servers.set(serverName, server);
        processedServers.add(serverName);
      }
    }
  }

  /**
   * Get server configuration by name
   */
  getServer(name) {
    return this.servers.get(name.toLowerCase());
  }

  /**
   * Get all server configurations
   */
  getAllServers() {
    return Array.from(this.servers.values());
  }

  /**
   * Check if server exists
   */
  hasServer(name) {
    return this.servers.has(name.toLowerCase());
  }

  /**
   * Export current configuration to TOML format
   */
  exportToToml() {
    const config = {
      ssh_servers: {}
    };

    for (const [name, server] of this.servers) {
      const serverConfig = {
        host: server.host,
        user: server.user,
        port: server.port
      };

      if (server.password) serverConfig.password = server.password;
      if (server.keyPath) serverConfig.key_path = server.keyPath;
      if (server.passphrase) serverConfig.passphrase = server.passphrase;
      if (server.defaultDir) serverConfig.default_dir = server.defaultDir;
      if (server.sudoPassword) serverConfig.sudo_password = server.sudoPassword;
      if (server.description) serverConfig.description = server.description;
      if (server.platform) serverConfig.platform = server.platform;
      if (server.proxyJump) serverConfig.proxy_jump = server.proxyJump;
      if (server.proxyCommand) serverConfig.proxy_command = server.proxyCommand;
      // Only emit security fields if they diverge from defaults — keeps generated
      // TOML files clean for users who never opted in.
      if (server.mode && server.mode !== 'unrestricted') serverConfig.mode = server.mode;
      if (server.allowPatterns && server.allowPatterns.length > 0) {
        serverConfig.allow_patterns = server.allowPatterns;
      }
      if (server.denyPatterns && server.denyPatterns.length > 0) {
        serverConfig.deny_patterns = server.denyPatterns;
      }
      if (server.auditLog) serverConfig.audit_log = server.auditLog;

      config.ssh_servers[name] = serverConfig;
    }

    return TOML.stringify(config);
  }

  /**
   * Export current configuration to .env format
   */
  exportToEnv() {
    const lines = ['# SSH Server Configuration'];
    lines.push('# Generated by MCP SSH Manager');
    lines.push('');

    for (const [name, server] of this.servers) {
      const upperName = name.toUpperCase();
      lines.push(`# Server: ${name}`);
      lines.push(`SSH_SERVER_${upperName}_HOST=${server.host}`);
      lines.push(`SSH_SERVER_${upperName}_USER=${server.user}`);
      if (server.password) lines.push(`SSH_SERVER_${upperName}_PASSWORD="${server.password}"`);
      if (server.keyPath) lines.push(`SSH_SERVER_${upperName}_KEYPATH=${server.keyPath}`);
      if (server.passphrase) lines.push(`SSH_SERVER_${upperName}_PASSPHRASE="${server.passphrase}"`);
      lines.push(`SSH_SERVER_${upperName}_PORT=${server.port || 22}`);
      if (server.defaultDir) lines.push(`SSH_SERVER_${upperName}_DEFAULT_DIR=${server.defaultDir}`);
      if (server.sudoPassword) lines.push(`SSH_SERVER_${upperName}_SUDO_PASSWORD="${server.sudoPassword}"`);
      if (server.description) lines.push(`SSH_SERVER_${upperName}_DESCRIPTION="${server.description}"`);
      if (server.platform) lines.push(`SSH_SERVER_${upperName}_PLATFORM=${server.platform}`);
      if (server.proxyJump) lines.push(`SSH_SERVER_${upperName}_PROXYJUMP=${server.proxyJump}`);
      if (server.proxyCommand) lines.push(`SSH_SERVER_${upperName}_PROXYCOMMAND=${server.proxyCommand}`);
      // Security fields — only emit when non-default to avoid clutter in
      // generated .env files for users who never opted in.
      if (server.mode && server.mode !== 'unrestricted') {
        lines.push(`SSH_SERVER_${upperName}_MODE=${server.mode}`);
      }
      if (server.allowPatterns && server.allowPatterns.length > 0) {
        lines.push(`SSH_SERVER_${upperName}_ALLOW_PATTERNS="${server.allowPatterns.join(';')}"`);
      }
      if (server.denyPatterns && server.denyPatterns.length > 0) {
        lines.push(`SSH_SERVER_${upperName}_DENY_PATTERNS="${server.denyPatterns.join(';')}"`);
      }
      if (server.auditLog) lines.push(`SSH_SERVER_${upperName}_AUDIT_LOG=${server.auditLog}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Save configuration to Codex TOML format
   */
  async saveToCodexConfig(codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')) {
    let config = {};

    // Load existing config if it exists
    if (fs.existsSync(codexConfigPath)) {
      const content = fs.readFileSync(codexConfigPath, 'utf8');
      config = TOML.parse(content);
    }

    // Add MCP server configuration
    if (!config.mcp_servers) {
      config.mcp_servers = {};
    }

    config.mcp_servers['ssh-manager'] = {
      command: 'node',
      args: [path.join(process.cwd(), 'src', 'index.js')],
      env: {
        SSH_CONFIG_PATH: path.join(os.homedir(), '.codex', 'ssh-config.toml')
      },
      startup_timeout_ms: 20000
    };

    // Write back to config file
    const tomlContent = TOML.stringify(config);
    fs.writeFileSync(codexConfigPath, tomlContent, 'utf8');

    logger.info(`Updated Codex configuration at ${codexConfigPath}`);
  }

  /**
   * Migrate .env configuration to TOML
   */
  async migrateEnvToToml(envPath, tomlPath) {
    // Load from .env
    this.servers.clear();
    this.loadEnvConfig(envPath);

    // Export to TOML
    const tomlContent = this.exportToToml();

    // Ensure directory exists
    const tomlDir = path.dirname(tomlPath);
    if (!fs.existsSync(tomlDir)) {
      fs.mkdirSync(tomlDir, { recursive: true });
    }

    // Write TOML file
    fs.writeFileSync(tomlPath, tomlContent, 'utf8');

    logger.info(`Migrated ${this.servers.size} servers from ${envPath} to ${tomlPath}`);
    return this.servers.size;
  }
}

// Export singleton instance
export const configLoader = new ConfigLoader();
