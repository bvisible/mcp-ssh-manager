import fs from 'fs';
import { ConfigLoader } from './config-loader.js';
import { logger } from './logger.js';

/** @typedef {import('./config-loader.js').ServerConfig} ServerConfig */

export class ServerConfigManager {
  constructor({ envPath, tomlPath, preferToml = false, configLoader = new ConfigLoader() }) {
    this.envPath = envPath;
    this.tomlPath = tomlPath;
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
        preferToml: this.preferToml
      });

      /** @type {Record<string, ServerConfig>} */
      const nextServers = {};
      for (const [name, config] of loadedServers) {
        nextServers[name] = config;
      }

      this.servers = nextServers;
      this.fileSignature = this.getFileSignature();
      return this.servers;
    } catch (error) {
      this.servers = previousServers;
      this.fileSignature = previousSignature;
      logger.error('Failed to reload server configuration', { error: error.message });
      return this.servers;
    }
  }

  getFileSignature() {
    return [
      this.getSingleFileSignature(this.tomlPath),
      this.getSingleFileSignature(this.envPath)
    ].join('|');
  }

  getSingleFileSignature(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return `${filePath || ''}:missing`;
    }

    const stats = fs.statSync(filePath);
    return `${filePath}:${stats.mtimeMs}:${stats.size}`;
  }
}
