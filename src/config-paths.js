import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

/**
 * The same .env must be used by the MCP engine, CLI and optional control plane.
 * Keep the published engine's discovery order; SSH_MANAGER_ENV is the CLI's
 * existing explicit override and is accepted when SSH_ENV_PATH is absent.
 * @param {{ projectRoot?: string }} [options]
 * @returns {string}
 */
export function resolveEnvFilePath({
  projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
} = {}) {
  if (process.env.SSH_ENV_PATH) return process.env.SSH_ENV_PATH;
  if (process.env.SSH_MANAGER_ENV) return process.env.SSH_MANAGER_ENV;
  const managerHome = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
  const candidates = [
    path.join(managerHome, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(projectRoot, '.env'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || path.join(process.cwd(), '.env');
}

/** Read file-selected TOML settings just as the MCP entry point does.
 * @param {string} [envPath]
 */
export function resolveConfigOptions(envPath = resolveEnvFilePath()) {
  let values = {};
  try { values = dotenv.parse(fs.readFileSync(envPath)); } catch { /* The loader reports unreadable files. */ }
  return {
    envPath,
    tomlPath: process.env.SSH_CONFIG_PATH ?? values.SSH_CONFIG_PATH
      ?? path.join(os.homedir(), '.codex', 'ssh-config.toml'),
    preferToml: (process.env.PREFER_TOML_CONFIG ?? values.PREFER_TOML_CONFIG) === 'true',
  };
}
