/**
 * Hooks System for MCP SSH Manager
 * Provides automation through pre/post execution hooks
 *
 * A hook action is one of:
 *   - `log`: appends a line to a file in SSH_MANAGER_HOME, in JavaScript,
 *     with no shell involved. The default `on-error` hook is one.
 *   - `command`: a shell command run on this machine.
 *   - `remoteCommand`: a shell command run on the server, when the caller
 *     hands the hook an open connection.
 *
 * Context values ({server}, {error}, ...) never become part of a command's
 * text. Up to 3.8.5 they were spliced in raw, and the default `on-error` hook
 * put the connection error inside double quotes: a server that disconnected
 * with `Bye $(touch /tmp/x)` ran that command on the machine running the MCP
 * server (GHSA-759m-wfpq-xmx3). Each placeholder is now replaced by a
 * reference to a shell variable that carries the value, and a shell does not
 * re-parse what a variable expands to.
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { loadProfile } from './profile-loader.js';
import { managerHome } from './config-paths.js';
import { shellQuote } from './shell-quote.js';
import { readUserState, writeUserState } from './user-state.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOKS_CONFIG_NAME = 'hooks.json';
// Where 3.8.5 and earlier kept the file, inside the package. Read only; see
// user-state.js. The package also used to ship a development copy of it,
// which turned on Frappe hooks for every npm user (issue #87).
const LEGACY_HOOKS_CONFIG_FILE = path.join(__dirname, '..', '.hooks-config.json');

// Get hooks from the active profile
let profileHooks = {};
try {
  const profile = loadProfile();
  profileHooks = profile.hooks || {};
} catch (error) {
  console.error(`Error loading profile hooks: ${error.message}`);
}

// Default hooks configuration (minimal, can be overridden by profiles)
const DEFAULT_HOOKS = {
  // Basic error handling
  'on-error': {
    enabled: true,
    description: 'Run when an error occurs',
    actions: [
      {
        type: 'log',
        name: 'log-error',
        file: 'errors.log',
        message: 'Error on {server}: {error}'
      }
    ]
  },
  // SSH key change hooks
  'pre-connect-key-change': {
    enabled: false,
    description: 'Run before accepting a changed SSH host key',
    actions: [
      {
        type: 'log',
        name: 'log-key-change',
        file: 'ssh-key-changes.log',
        message: 'SSH key change detected for {server} ({host}:{port})'
      }
    ]
  },
  'post-key-update': {
    enabled: false,
    description: 'Run after updating an SSH host key',
    actions: [
      {
        type: 'log',
        name: 'log-key-updated',
        file: 'ssh-key-changes.log',
        message: 'SSH key {action} for {server} ({host}:{port})'
      }
    ]
  }
};

const PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/** @param {any} value */
function isScalar(value) {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Name of the variable that carries a context value: `server` becomes
 * SSH_MANAGER_HOOK_SERVER, `backupId` becomes SSH_MANAGER_HOOK_BACKUP_ID.
 * Hook authors can also read these directly.
 * @param {string} key
 */
function hookVariable(key) {
  return `SSH_MANAGER_HOOK_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/**
 * Rewrite a POSIX shell command so that every {placeholder} found in `context`
 * becomes a reference to a variable holding the value, quoted for where it
 * sits: `"${V}"` in plain text, `${V}` inside double quotes, and `'"${V}"'`
 * inside single quotes. The quoting only keeps a value one word; safety does
 * not depend on it, since an expanded variable is never parsed as code, even
 * when a template nests quotes in ways this scanner reads imperfectly.
 *
 * Heredoc bodies get `${V}` when the delimiter is unquoted, since the body is
 * expanded but not re-parsed, and the value itself with line breaks removed
 * when it is quoted, since nothing expands there and a value cut into lines
 * could otherwise end the heredoc early.
 *
 * What stays the hook author's responsibility: handing a variable to
 * something that evaluates its text again (eval, sh -c, arithmetic).
 *
 * @param {string} template
 * @param {Record<string, any>} context
 * @returns {{command: string, values: Record<string, string>}}
 */
export function renderShellCommand(template, context = {}) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {{kind: string, parens: number}[]} */
  const frames = [{ kind: 'plain', parens: 0 }];
  /** @type {{delimiter: string, quoted: boolean, stripTabs: boolean}[]} */
  const heredocs = [];
  let out = '';

  /** @param {string} text @param {number} at */
  const placeholderAt = (text, at) => {
    if (text[at] !== '{' || text[at - 1] === '$') return null;
    const match = PLACEHOLDER.exec(text.slice(at));
    return match && Object.hasOwn(context, match[1]) && isScalar(context[match[1]])
      ? { key: match[1], length: match[0].length } : null;
  };
  /** @param {string} key */
  const reference = key => {
    const name = hookVariable(key);
    values[name] = String(context[key]);
    return name;
  };

  // Copy the heredoc bodies that start at `start`, rendering placeholders in
  // them, and return the index just past the last delimiter line.
  /** @param {number} start */
  const consumeHeredocs = start => {
    let at = start;
    for (const heredoc of heredocs.splice(0)) {
      while (at < template.length) {
        const end = template.indexOf('\n', at);
        const line = template.slice(at, end < 0 ? template.length : end);
        at = end < 0 ? template.length : end + 1;
        const bare = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
        let rendered = '';
        for (let p = 0; p < line.length; p++) {
          const placeholder = bare !== heredoc.delimiter && placeholderAt(line, p);
          if (!placeholder) { rendered += line[p]; continue; }
          rendered += heredoc.quoted
            ? String(context[placeholder.key]).replace(/[\r\n]+/g, ' ')
            : `\${${reference(placeholder.key)}}`;
          p += placeholder.length - 1;
        }
        out += rendered + (end < 0 ? '' : '\n');
        if (bare === heredoc.delimiter) break;
      }
    }
    return at;
  };

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    const frame = frames[frames.length - 1];
    const unquoted = frame.kind !== 'single' && frame.kind !== 'double';

    if (ch === '\n' && heredocs.length && unquoted) {
      out += ch;
      i = consumeHeredocs(i + 1) - 1;
      continue;
    }
    if (unquoted && ch === '<' && template[i + 1] === '<' && template[i + 2] !== '<') {
      // A heredoc operator: record its delimiter; the body starts on the next line.
      let at = i + 2;
      const stripTabs = template[at] === '-';
      if (stripTabs) at++;
      while (template[at] === ' ' || template[at] === '\t') at++;
      let delimiter = '';
      let quoted = false;
      while (at < template.length && !/[\s;&|<>()]/.test(template[at])) {
        const c = template[at];
        if (c === '\'' || c === '"') {
          const close = template.indexOf(c, at + 1);
          if (close < 0) break;
          delimiter += template.slice(at + 1, close);
          quoted = true;
          at = close + 1;
        } else if (c === '\\') {
          delimiter += template[at + 1] ?? '';
          quoted = true;
          at += 2;
        } else {
          delimiter += c;
          at++;
        }
      }
      if (delimiter) heredocs.push({ delimiter, quoted, stripTabs });
      out += template.slice(i, at);
      i = at - 1;
      continue;
    }

    if (frame.kind === 'single') {
      if (ch === '\'') frames.pop();
    } else if (ch === '\\') {
      out += template.slice(i, i + 2);
      i++;
      continue;
    } else if (frame.kind === 'double' && ch === '"') {
      frames.pop();
    } else if (frame.kind !== 'double' && (ch === '\'' || ch === '"')) {
      frames.push({ kind: ch === '\'' ? 'single' : 'double', parens: 0 });
    } else if (ch === '`') {
      if (frame.kind === 'backtick') frames.pop();
      else frames.push({ kind: 'backtick', parens: 0 });
    } else if (ch === '$' && template[i + 1] === '(') {
      frames.push({ kind: 'subst', parens: 0 });
      out += '$(';
      i++;
      continue;
    } else if (frame.kind === 'subst' && ch === '(') {
      frame.parens++;
    } else if (frame.kind === 'subst' && ch === ')') {
      if (frame.parens === 0) frames.pop();
      else frame.parens--;
    }

    const placeholder = placeholderAt(template, i);
    if (placeholder) {
      const name = reference(placeholder.key);
      if (frame.kind === 'single') out += `'"\${${name}}"'`;
      else if (frame.kind === 'double') out += `\${${name}}`;
      else out += `"\${${name}}"`;
      i += placeholder.length - 1;
      continue;
    }
    out += ch;
  }

  return { command: out, values };
}

/**
 * The cmd.exe counterpart, for local hooks on Windows. cmd expands %VAR%
 * before it parses a line, so a variable would not protect anything there.
 * Values are spliced in with every character cmd treats specially removed,
 * and wrapped in double quotes when the placeholder sits outside them.
 * @param {string} template
 * @param {Record<string, any>} context
 * @returns {string}
 */
export function renderCmdCommand(template, context = {}) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '"') quoted = !quoted;
    const match = ch === '{' && PLACEHOLDER.exec(template.slice(i));
    if (match && Object.hasOwn(context, match[1]) && isScalar(context[match[1]])) {
      const value = String(context[match[1]]).replace(/["%!^&|<>()\r\n]/g, '_');
      out += quoted ? value : `"${value}"`;
      i += match[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Plain-text substitution for `log` messages, which never reach a shell.
 * @param {string} template
 * @param {Record<string, any>} context
 */
function renderText(template, context) {
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.hasOwn(context, key) && isScalar(context[key]) ? String(context[key]) : whole);
}

/**
 * Append one line to a hook log. A relative file name lands in the manager
 * home, never in the working directory, which under an MCP client is whatever
 * project the user has open. The home is not created just for a log: without
 * it, the line still reaches stderr through the hook's own reporting.
 * @param {string} file
 * @param {string} message
 * @returns {string|null} The file written, or null when skipped
 */
function appendHookLog(file, message) {
  const home = managerHome();
  if (!path.isAbsolute(file) && !fs.existsSync(home)) return null;
  const target = path.resolve(home, file);
  // One entry per line: a newline from a server must not forge a second one,
  // and no other control character reaches the file either.
  const text = Array.from(message.replace(/[\r\n]+/g, ' '),
    c => (c < ' ' && c !== '\t') || c === '\u007f' ? '' : c).join('');
  fs.appendFileSync(target, `[${new Date().toISOString()}] ${text}\n`, { mode: 0o600 });
  return target;
}

/**
 * Initialize hooks. Nothing is written: defaults live in memory, and the
 * settings file appears only when a hook is changed.
 */
export async function initializeHooks() {
  return true;
}

/**
 * Read the user's hook settings, or null when there are none
 */
function readHooksFile() {
  const state = readUserState(HOOKS_CONFIG_NAME, LEGACY_HOOKS_CONFIG_FILE);
  return state ? JSON.parse(state.text) : null;
}

/**
 * Load hooks configuration
 */
export function loadHooksConfig() {
  // Copies, so toggling a hook never mutates the defaults held in memory.
  const hooks = structuredClone({ ...DEFAULT_HOOKS, ...profileHooks });
  try {
    const customHooks = readHooksFile() || {};

    // Deep merge hooks
    for (const [hookName, hookConfig] of Object.entries(customHooks)) {
      hooks[hookName] = hooks[hookName] ? { ...hooks[hookName], ...hookConfig } : hookConfig;
    }
  } catch (error) {
    console.error(`Error loading hooks config: ${error.message}`);
  }
  return hooks;
}

/**
 * Save hooks configuration
 */
function saveHooksConfig(config) {
  try {
    writeUserState(HOOKS_CONFIG_NAME, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch (error) {
    console.error(`Error saving hooks config: ${error.message}`);
    return false;
  }
}

/**
 * Execute a hook
 */
export async function executeHook(hookName, context = {}) {
  const config = loadHooksConfig();
  const hook = config[hookName];

  if (!hook || !hook.enabled) {
    return { success: true, skipped: true };
  }

  console.error(`🎣 Executing hook: ${hookName}`);
  const results = [];

  for (const action of hook.actions || []) {
    try {
      // Check environment variables if required
      if (action.requiresEnv) {
        const missingEnv = action.requiresEnv.filter(env => !process.env[env]);
        if (missingEnv.length > 0) {
          if (!action.optional) {
            throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
          }
          console.error(`  ⚠️  Skipping ${action.name}: missing env vars`);
          continue;
        }
      }

      // Execute action based on type
      const result = await executeAction(action, context);
      results.push(result);

      // Check validation results
      if (action.type === 'validation' && !result.success && !action.optional) {
        const errorMsg = action.errorMessage || `Validation failed: ${action.name}`;
        throw new Error(errorMsg);
      }

      console.error(`  ✅ ${action.name}: completed`);

    } catch (error) {
      if (!action.optional) {
        console.error(`  ❌ ${action.name}: ${error.message}`);
        return {
          success: false,
          hook: hookName,
          action: action.name,
          error: error.message,
          results
        };
      }
      console.error(`  ⚠️  ${action.name}: ${error.message} (optional, continuing)`);
    }
  }

  return {
    success: true,
    hook: hookName,
    results
  };
}

/**
 * Execute a single action
 */
async function executeAction(action, context) {
  const result = {
    action: action.name,
    type: action.type,
    timestamp: new Date().toISOString()
  };

  try {
    if (action.type === 'log') {
      const file = appendHookLog(action.file || 'hooks.log', renderText(action.message || '', context));
      result.success = true;
      result.output = file ? `logged to ${file}` : 'skipped: no manager home to write the log in';
    } else if (action.remoteCommand && context.sshConnection) {
      // The variables are set in the remote shell itself: an SSH exec request
      // cannot rely on the server accepting environment variables.
      const { command, values } = renderShellCommand(action.remoteCommand, context);
      const assignments = Object.entries(values).map(([name, value]) => `${name}=${shellQuote(value)}; `).join('');
      const remote = assignments ? `{ ${assignments}${command}\n}` : command;
      const output = await context.sshConnection.execCommand(remote, {
        cwd: context.cwd || context.defaultDir
      });

      result.output = output.stdout;
      result.error = output.stderr;
      result.success = output.code === 0;

      if (action.expectEmpty && output.stdout.trim()) {
        result.success = false;
      }
    } else if (action.command) {
      // Execute locally
      let command;
      let env = process.env;
      if (process.platform === 'win32') {
        command = renderCmdCommand(action.command, context);
      } else {
        const rendered = renderShellCommand(action.command, context);
        command = rendered.command;
        env = { ...process.env, ...rendered.values };
      }
      const { stdout, stderr } = await execAsync(command, { env });

      result.output = stdout;
      result.error = stderr;
      result.success = true;

      if (action.expectEmpty && stdout.trim()) {
        result.success = false;
      }
    }

    // Handle specific action types
    switch (action.type) {
    case 'backup':
      result.backupInfo = {
        timestamp: new Date().toISOString(),
        command: action.command || action.remoteCommand
      };
      break;

    case 'notification':
      result.notified = true;
      break;

    case 'validation':
      result.validated = result.success;
      break;

    case 'verification':
      result.verified = result.success;
      break;
    }

  } catch (error) {
    result.success = false;
    result.error = error.message;
  }

  return result;
}

/**
 * Add or update a hook
 */
export function addHook(hookName, hookConfig) {
  const config = loadHooksConfig();
  config[hookName] = hookConfig;
  return saveHooksConfig(config);
}

/**
 * Remove a hook
 */
export function removeHook(hookName) {
  const config = loadHooksConfig();
  delete config[hookName];
  return saveHooksConfig(config);
}

/**
 * Enable/disable a hook
 */
export function toggleHook(hookName, enabled) {
  const config = loadHooksConfig();
  if (config[hookName]) {
    config[hookName].enabled = enabled;
    return saveHooksConfig(config);
  }
  return false;
}

/**
 * List all hooks
 */
export function listHooks() {
  const config = loadHooksConfig();
  return Object.entries(config).map(([name, hook]) => ({
    name,
    enabled: hook.enabled,
    description: hook.description,
    actionCount: hook.actions ? hook.actions.length : 0
  }));
}
