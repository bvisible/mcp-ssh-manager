import fs from 'fs';
import { ConfigLoader } from './config-loader.js';
import { logger } from './logger.js';
import os from 'os';
import path from 'path';
import { resolveEnvFilePath } from './config-paths.js';
import { defaultVaultPath } from './secret-store.js';

/** @typedef {import('./config-loader.js').ServerConfig} ServerConfig */

export class ServerConfigManager {
  constructor({ envPath = resolveEnvFilePath(),
    tomlPath = process.env.SSH_CONFIG_PATH || path.join(os.homedir(), '.codex', 'ssh-config.toml'),
    vaultPath = defaultVaultPath(), preferToml = false, configLoader = new ConfigLoader() } = {}) {
    this.envPath = envPath;
    this.tomlPath = tomlPath;
    this.vaultPath = vaultPath;
    this.preferToml = preferToml;
    this.configLoader = configLoader;
    /**
     * Loaded servers keyed by normalized name. camelCase fields only — see the
     * ServerConfig typedef in config-loader.js.
     * @type {Record<string, ServerConfig>}
     */
    this.servers = {};
    /** @type {string|null} */
    this.fileSignature = null;
    /** @type {Error|null} Blocks cached configuration after a vault read failure. */
    this.configError = null;
  }

  /** @returns {Promise<Record<string, ServerConfig>>} */
  async loadInitial() {
    await this.reload();
    return this.servers;
  }

  /** @returns {Promise<Record<string, ServerConfig>>} */
  async getServers() {
    if (this.hasFileBackedConfigChanged()) {
      await this.reload();
    }

    if (this.configError) throw this.configError;
    return this.servers;
  }

  hasFileBackedConfigChanged() {
    const currentSignature = this.getFileSignature();
    return this.fileSignature !== currentSignature;
  }

  async reload() {
    const previousServers = this.servers;
    const previousSignature = this.fileSignature;

    try {
      const loadedServers = await this.configLoader.load({
        envPath: this.envPath,
        tomlPath: this.tomlPath,
        vaultPath: this.vaultPath,
        preferToml: this.preferToml
      });

      /** @type {Record<string, ServerConfig>} */
      const nextServers = {};
      for (const [name, config] of loadedServers) {
        nextServers[name] = config;
      }

      this.servers = nextServers;
      this.configError = null;
      this.fileSignature = this.getFileSignature();
      return this.servers;
    } catch (error) {
      if (error.code === 'VAULT_UNREADABLE') {
        // Do not keep an older permissive snapshot after vault adoption fails.
        // Remember the failure even when the files stay unchanged, and retry
        // automatically after recovery changes the vault or its key.
        this.servers = {};
        this.configError = error;
        this.fileSignature = this.getFileSignature();
        throw error;
      }
      this.servers = previousServers;
      this.fileSignature = previousSignature;
      logger.error('Failed to reload server configuration', { error: error.message });
      if (this.configError) throw this.configError;
      return this.servers;
    }
  }

  getFileSignature() {
    return [
      this.getSingleFileSignature(this.tomlPath),
      this.getSingleFileSignature(this.envPath),
      this.getSingleFileSignature(this.vaultPath),
      this.getSingleFileSignature(path.join(path.dirname(defaultVaultPath()), 'vault.key'))
    ].join('|');
  }

  getSingleFileSignature(filePath) {
    if (!filePath) return ':missing';
    try {
      const stats = fs.statSync(filePath);
      return `${filePath}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
    } catch (error) {
      if (error.code === 'ENOENT') return `${filePath}:missing`;
      throw error;
    }
  }
}
