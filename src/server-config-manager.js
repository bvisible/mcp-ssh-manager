import fs from 'fs';
import { ConfigLoader } from './config-loader.js';
import { logger } from './logger.js';

export class ServerConfigManager {
  constructor({ envPath, tomlPath, preferToml = false, configLoader = new ConfigLoader() }) {
    this.envPath = envPath;
    this.tomlPath = tomlPath;
    this.preferToml = preferToml;
    this.configLoader = configLoader;
    this.servers = {};
    this.fileSignature = null;
  }

  async loadInitial() {
    await this.reload();
    return this.servers;
  }

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
