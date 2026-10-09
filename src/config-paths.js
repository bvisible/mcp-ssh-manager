import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

/**
 * The directory that holds this user's settings and state: SSH_MANAGER_HOME,
 * or ~/.ssh-manager. Read at call time so a test or a host that sets the
 * variable after import still gets its own directory.
 * @returns {string}
 */
export function managerHome() {
  return process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
}

/**
 * Expand a leading `~` (alone or followed by a separator) to the home
 * directory, as a shell would. `keyPath.replace('~', home)` replaced the first
 * tilde anywhere, so `/srv/keys/~old/id` and `~user/id` came out wrong
 * (issue #89). Any other path is returned as written.
 * @param {string} value
 * @returns {string}
 */
export function expandHomePath(value) {
  const text = String(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || (path.sep === '\\' && text.startsWith('~\\'))) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

/**
 * Which .env the engine reads, and why.
 *
 * The same .env must be used by the MCP engine, CLI and optional control plane.
 * Keep the published engine's discovery order; SSH_MANAGER_ENV is the CLI's
 * existing explicit override and is accepted when SSH_ENV_PATH is absent.
 *
 * 3.8.5's engine never read SSH_MANAGER_ENV (only the CLI did), so a profile
 * that still exported it towards a file since deleted cost nothing until 4.0
 * honoured it, and then loaded zero servers without a word (issue #90). A
 * missing file named by SSH_MANAGER_ENV is therefore skipped, as 3.8.5 skipped
 * the variable, and reported in `ignored`. SSH_ENV_PATH was always the
 * engine's own override: a missing file there stays the choice, reported as
 * `missing`, so nothing is silently read in place of what was asked for.
 * @param {{ projectRoot?: string }} [options]
 * @returns {{path: string, variable: string|null, missing: boolean,
 *   ignored: {variable: string, path: string}|null}}
 */
export function envFileChoice({
  projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
} = {}) {
  if (process.env.SSH_ENV_PATH) {
    const file = process.env.SSH_ENV_PATH;
    return { path: file, variable: 'SSH_ENV_PATH', missing: !fs.existsSync(file), ignored: null };
  }
  let ignored = null;
  if (process.env.SSH_MANAGER_ENV) {
    const file = process.env.SSH_MANAGER_ENV;
    if (fs.existsSync(file)) return { path: file, variable: 'SSH_MANAGER_ENV', missing: false, ignored: null };
    ignored = { variable: 'SSH_MANAGER_ENV', path: file };
  }
  const candidates = [
    path.join(managerHome(), '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(projectRoot, '.env'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  // No file at all is a valid setup (servers from the environment or TOML).
  return { path: found || path.join(process.cwd(), '.env'), variable: null, missing: false, ignored };
}

/**
 * The .env path alone; see envFileChoice for the rules.
 * @param {{ projectRoot?: string }} [options]
 * @returns {string}
 */
export function resolveEnvFilePath(options) {
  return envFileChoice(options).path;
}

/**
 * A sentence for the operator when the configuration file was not what the
 * environment asked for, or null when it was.
 * @param {ReturnType<typeof envFileChoice>} choice
 * @returns {string|null}
 */
export function envFileProblem(choice) {
  if (choice.missing) {
    return `${choice.variable} names ${choice.path}, which does not exist: no server is loaded from a .env file`;
  }
  if (choice.ignored) {
    return `${choice.ignored.variable} names ${choice.ignored.path}, which does not exist; using ${choice.path} instead`;
  }
  return null;
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
