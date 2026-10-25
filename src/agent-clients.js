// Which engine your AI tools run, and switching it — from the interface.
//
// The engine an agent talks to can come from two places, and both are first
// class:
//
//   npm   the `mcp-ssh-manager` package, installed with npm. What everyone used
//         before 4.0, and what anyone who likes it keeps using.
//   app   the copy of the same engine inside the desktop application, run by the
//         application's own runtime (`ELECTRON_RUN_AS_NODE=1`). No Node.js, no
//         npm: whoever installed only the application can still give their
//         agents SSH. It updates with the application.
//
// Nothing here runs by itself. The interface shows what each tool is set to,
// and changes it only when somebody presses the button for that tool. The entry
// is always called `ssh-manager`, as the README has always told people to name
// it; its other settings (environment variables such as SSH_CONFIG_PATH) are
// kept when the engine changes.
//
// Three tools, three configuration files:
//
//   Claude Code     ~/.claude.json, user scope — through the `claude` command
//                   when it is installed, because Claude Code rewrites that
//                   file itself and an edit beside it can be lost
//   Claude Desktop  claude_desktop_config.json — refused while it runs: it
//                   writes its configuration back on quit and would undo ours
//   Codex           ~/.codex/config.toml — the one table replaced in place, the
//                   rest of the file (comments included) left as it is

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import TOML from '@iarna/toml';
import { desktopStatus } from './desktop-install.js';

/** The name every tool knows the engine by. */
const ENTRY_NAME = 'ssh-manager';

/** The variable that makes the application's runtime behave as Node. */
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

/**
 * @typedef {Object} Engine
 * @property {'app'|'npm'} kind
 * @property {string} command - Absolute path of the program to start
 * @property {string[]} args - The engine's entry point
 * @property {Record<string, string>} env - Variables the engine needs to start
 * @property {string|null} version
 */

/**
 * @typedef {Object} ClientState
 * @property {'claude-code'|'claude-desktop'|'codex'} id
 * @property {string} name
 * @property {boolean} installed - The tool seems to be on this machine
 * @property {string} configPath
 * @property {'app'|'npm'|'other'|null} engine - What its ssh-manager entry runs; null when there is none
 * @property {string|null} version - The version of that engine, when it can be read
 */

/**
 * @typedef {Object} Context
 * @property {string} platform
 * @property {NodeJS.ProcessEnv} env
 * @property {string} home
 * @property {(command: string, args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} run
 * @property {() => import('./desktop-install.js').DesktopStatus} desktop
 * @property {(name: string) => Promise<string|null>} which - Resolves a command through the user's login shell
 */

/** @param {string} file */
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** @param {string} file */
function versionAt(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version || null; } catch { return null; }
}

/**
 * A JSON settings file, `{}` when there is none yet. One that does not parse is
 * refused rather than replaced: it holds everything else the tool keeps.
 * @param {string} file
 */
function readJsonConfig(file) {
  const text = readText(file);
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* refused below */ }
  throw Object.assign(new Error(`${file} could not be read as JSON: change it by hand`), { status: 409 });
}

/**
 * Write a file the way an editor would: to a temporary file beside it, then
 * renamed over it, so a crash never leaves half a configuration behind.
 * @param {string} file
 * @param {string} text
 */
function writeAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.ssh-manager-${process.pid}.tmp`;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* a new file: private */ }
  fs.writeFileSync(temporary, text, { mode });
  fs.renameSync(temporary, file);
}

/** The default runner: spawn, never a shell. */
function runCommand(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => resolve({ code: 127, stdout, stderr: error.message }));
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * The full path of a command as the user's own terminal would find it. An
 * application started from the Dock or the Start menu does not have the PATH a
 * terminal has, so `claude` or `node` installed with Homebrew or npm would be
 * invisible to it without this.
 * @param {string} name
 * @param {{platform: string, env: NodeJS.ProcessEnv, run: Context['run']}} context
 * @returns {Promise<string|null>}
 */
async function whichInLoginShell(name, { platform, env, run }) {
  if (platform === 'win32') {
    const { code, stdout } = await run('where.exe', [name]);
    const found = code === 0 ? stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
    // npm puts an extensionless shell script first, then a .cmd: an .exe, when
    // there is one, is the only kind that starts without a shell.
    return found.find(file => /\.exe$/i.test(file)) || found[0] || null;
  }
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  // A login shell first; an interactive one too when that finds nothing, for
  // the PATH set in ~/.zshrc or ~/.bashrc (nvm, fnm, volta).
  for (const flags of ['-lc', '-ilc']) {
    const { code, stdout } = await run(shell, [flags, `command -v ${name}`]);
    const found = code === 0 ? stdout.trim().split('\n').pop()?.trim() : '';
    if (found && path.isAbsolute(found)) return found;
  }
  return null;
}

/**
 * The engine inside the installed desktop application, run by its own runtime.
 * @param {Context} context
 * @returns {Engine|null}
 */
export function appEngine(context) {
  const status = context.desktop();
  if (!status.installed || !status.path) return null;
  // Started from its disk image, or moved aside by macOS because it was never
  // copied to Applications: a path that is gone at the next start.
  if (/^\/Volumes\/|\/AppTranslocation\//.test(status.path)) return null;
  let command;
  let resources;
  if (context.platform === 'darwin') {
    command = path.join(status.path, 'Contents', 'MacOS', 'SSH Manager');
    resources = path.join(status.path, 'Contents', 'Resources');
  } else if (context.platform === 'win32') {
    command = status.path;
    resources = path.join(path.dirname(status.path), 'resources');
  } else {
    // The .deb puts a link on the PATH; the application lives where it points.
    // An AppImage mounts itself somewhere new on every start, so nothing could
    // point inside it for long: no engine is offered from one.
    if (status.path.endsWith('.AppImage')) return null;
    try { command = fs.realpathSync(status.path); } catch { return null; }
    resources = path.join(path.dirname(command), 'resources');
  }
  const entry = path.join(resources, 'engine', 'src', 'index.js');
  if (!fs.existsSync(entry)) return null;
  return {
    kind: 'app',
    command,
    args: [entry],
    env: { [RUN_AS_NODE]: '1' },
    version: versionAt(path.join(resources, 'engine', 'package.json')) || status.version,
  };
}

/**
 * The engine installed with npm, started with the `node` it was installed for.
 * @param {Context} context
 * @returns {Promise<Engine|null>}
 */
async function npmEngine(context) {
  const bin = await context.which('mcp-ssh-manager');
  if (!bin) return null;
  let entry;
  try { entry = fs.realpathSync(bin); } catch { return null; }
  if (!/[\\/]src[\\/]index\.js$/.test(entry)) {
    // Windows has no links: a script beside the package, in the same prefix.
    entry = path.join(path.dirname(bin), 'node_modules', 'mcp-ssh-manager', 'src', 'index.js');
    if (!fs.existsSync(entry)) return null;
  }
  const node = await context.which('node');
  if (!node) return null;
  return {
    kind: 'npm',
    command: node,
    args: [entry],
    env: {},
    version: versionAt(path.join(path.dirname(path.dirname(entry)), 'package.json')),
  };
}

/**
 * Which engine an existing entry runs.
 * @param {{command?: string, args?: string[], env?: Record<string, string>}|null|undefined} entry
 * @returns {{engine: 'app'|'npm'|'other'|null, version: string|null}}
 */
export function describeEntry(entry) {
  if (!entry || typeof entry !== 'object') return { engine: null, version: null };
  const parts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter(Boolean).map(String);
  const script = parts.find(part => /[\\/]src[\\/]index\.js$/.test(part));
  const root = script ? path.dirname(path.dirname(script)) : null;
  const version = root ? versionAt(path.join(root, 'package.json')) : null;
  if (entry.env?.[RUN_AS_NODE] === '1' && parts.some(part => /[\\/](resources|Resources)[\\/]engine[\\/]/.test(part))) {
    return { engine: 'app', version };
  }
  if (parts.some(part => /mcp-ssh-manager/.test(part))) return { engine: 'npm', version };
  return { engine: 'other', version };
}

/**
 * The entry to write for an engine, keeping the settings of the one it replaces.
 * @param {Engine} engine
 * @param {{env?: Record<string, string>}|null|undefined} previous
 */
function entryFor(engine, previous) {
  const env = { ...(previous?.env || {}) };
  delete env[RUN_AS_NODE];
  return { command: engine.command, args: engine.args, env: { ...env, ...engine.env } };
}

// --- Claude Code ------------------------------------------------------------

const claudeCode = {
  id: /** @type {const} */ ('claude-code'),
  name: 'Claude Code',
  /** @param {Context} context */
  configPath: context => path.join(context.home, '.claude.json'),
  /** @param {Context} context */
  read(context) {
    const text = readText(this.configPath(context));
    if (text === null) return { exists: false, entry: null };
    try { return { exists: true, entry: JSON.parse(text).mcpServers?.[ENTRY_NAME] ?? null }; } catch { return { exists: true, entry: null }; }
  },
  /** @param {Context} context */
  async installed(context) {
    return this.read(context).exists || Boolean(await context.which('claude'));
  },
  /**
   * @param {Context} context
   * @param {Engine} engine
   */
  async write(context, engine) {
    const previous = this.read(context).entry;
    const entry = { type: 'stdio', ...entryFor(engine, previous) };
    const claude = await context.which('claude');
    if (claude && (context.platform !== 'win32' || /\.exe$/i.test(claude))) {
      // Claude Code's own command, so its own process is the one that writes
      // the file it keeps rewriting.
      await context.run(claude, ['mcp', 'remove', ENTRY_NAME, '--scope', 'user']);
      const added = await context.run(claude, ['mcp', 'add-json', ENTRY_NAME, JSON.stringify(entry), '--scope', 'user']);
      if (added.code !== 0) {
        if (previous) await context.run(claude, ['mcp', 'add-json', ENTRY_NAME, JSON.stringify(previous), '--scope', 'user']);
        throw new Error(`claude mcp add-json failed: ${(added.stderr || added.stdout).trim()}`);
      }
      return;
    }
    const file = this.configPath(context);
    const config = readJsonConfig(file);
    config.mcpServers = { ...(config.mcpServers || {}), [ENTRY_NAME]: entry };
    writeAtomically(file, `${JSON.stringify(config, null, 2)}\n`);
  },
};

// --- Claude Desktop ---------------------------------------------------------

const claudeDesktop = {
  id: /** @type {const} */ ('claude-desktop'),
  name: 'Claude Desktop',
  /** @param {Context} context */
  configPath(context) {
    if (context.platform === 'darwin') return path.join(context.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (context.platform === 'win32') return path.join(context.env.APPDATA || path.join(context.home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    return path.join(context.env.XDG_CONFIG_HOME || path.join(context.home, '.config'), 'Claude', 'claude_desktop_config.json');
  },
  /** @param {Context} context */
  read(context) {
    const text = readText(this.configPath(context));
    if (text === null) return { exists: fs.existsSync(path.dirname(this.configPath(context))), entry: null };
    try { return { exists: true, entry: JSON.parse(text).mcpServers?.[ENTRY_NAME] ?? null }; } catch { return { exists: true, entry: null }; }
  },
  /** @param {Context} context */
  async installed(context) { return this.read(context).exists; },
  /**
   * Claude Desktop writes its configuration back when it quits: an edit made
   * while it runs is undone. Asking first is the only reliable order.
   * @param {Context} context
   */
  async busy(context) {
    const running = context.platform === 'win32'
      ? (await context.run('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq Claude.exe'])).stdout.includes('"Claude.exe"')
      : (await context.run('ps', ['-A', '-o', 'command='])).stdout.split('\n').some(line =>
        context.platform === 'darwin' ? line.includes('/Claude.app/Contents/MacOS/Claude') : /(^|\/)claude-desktop(\s|$)/.test(line));
    return running ? 'Quit Claude Desktop first: it rewrites its settings when it closes and would undo this.' : null;
  },
  /**
   * @param {Context} context
   * @param {Engine} engine
   */
  async write(context, engine) {
    const file = this.configPath(context);
    const config = readJsonConfig(file);
    const previous = config.mcpServers?.[ENTRY_NAME];
    config.mcpServers = { ...(config.mcpServers || {}), [ENTRY_NAME]: entryFor(engine, previous) };
    writeAtomically(file, `${JSON.stringify(config, null, 2)}\n`);
  },
};

// --- Codex ------------------------------------------------------------------

/** A TOML string: JSON's escaping is a subset TOML's basic strings accept. */
const tomlString = value => JSON.stringify(String(value));

/**
 * The text with its `[mcp_servers.ssh-manager…]` tables replaced by `block`,
 * where the first of them stood (at the end when there was none). Everything
 * else is left as written, including the comments that introduce the next table.
 * @param {string} text
 * @param {string} block
 */
function replaceCodexEntry(text, block) {
  const ours = /^\s*\[\s*mcp_servers\s*\.\s*(?:"ssh-manager"|ssh-manager)(?:\s*\.[^\]]*)?\s*\]\s*(?:#.*)?$/;
  const table = /^\s*\[\[?[^[\]=]*\]\]?\s*(?:#.*)?$/;
  const out = [];
  /** @type {string[]} */
  let held = []; // comments and blank lines at the end of our table: they may belong to the next one
  let skipping = false;
  let at = -1;
  for (const line of text.split('\n')) {
    if (table.test(line)) {
      const mine = ours.test(line);
      if (skipping && !mine) out.push(...held);
      held = [];
      skipping = mine;
      if (mine && at < 0) at = out.length;
    }
    if (!skipping) out.push(line);
    else if (/^\s*(?:#.*)?$/.test(line)) held.push(line);
    else held = [];
  }
  if (at < 0) {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out.push('');
    at = out.length;
  }
  out.splice(at, 0, ...block.split('\n'), '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

const codex = {
  id: /** @type {const} */ ('codex'),
  name: 'Codex',
  /** @param {Context} context */
  configPath: context => path.join(context.env.CODEX_HOME || path.join(context.home, '.codex'), 'config.toml'),
  /** @param {Context} context */
  read(context) {
    const text = readText(this.configPath(context));
    if (text === null) return { exists: fs.existsSync(path.dirname(this.configPath(context))), entry: null };
    try {
      const parsed = /** @type {any} */ (TOML.parse(text));
      return { exists: true, entry: parsed.mcp_servers?.[ENTRY_NAME] ?? null };
    } catch {
      return { exists: true, entry: null };
    }
  },
  /** @param {Context} context */
  async installed(context) { return this.read(context).exists || Boolean(await context.which('codex')); },
  /**
   * @param {Context} context
   * @param {Engine} engine
   */
  async write(context, engine) {
    const file = this.configPath(context);
    const text = readText(file) ?? '';
    const { command, args, env } = entryFor(engine, this.read(context).entry);
    const block = [
      `[mcp_servers.${ENTRY_NAME}]`,
      `command = ${tomlString(command)}`,
      `args = [${args.map(tomlString).join(', ')}]`,
      ...(Object.keys(env).length
        ? [`env = { ${Object.entries(env).map(([key, value]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)} = ${tomlString(value)}`).join(', ')} }`]
        : []),
    ].join('\n');
    const next = replaceCodexEntry(text, block);
    try {
      TOML.parse(next); // never write a file Codex could not read
    } catch {
      throw Object.assign(new Error(`${file} could not be changed safely (it does not parse, or names ssh-manager in a form this does not edit): change it by hand`), { status: 409 });
    }
    writeAtomically(file, next);
  },
};

const CLIENTS = [claudeCode, claudeDesktop, codex];

/**
 * @param {Partial<Context>} [overrides] - Stand-ins for the tests
 * @returns {Context}
 */
export function agentContext(overrides = {}) {
  /** @type {Context} */
  const context = {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    run: runCommand,
    desktop: () => desktopStatus(),
    which: name => whichInLoginShell(name, context),
    ...overrides,
  };
  return context;
}

/**
 * Every tool, what its ssh-manager entry runs, and which engines are on offer.
 * @param {Context} [context]
 * @returns {Promise<{engines: {app: Engine|null, npm: Engine|null}, clients: ClientState[]}>}
 */
export async function agentsStatus(context = agentContext()) {
  const [app, npm] = [appEngine(context), await npmEngine(context)];
  const clients = [];
  for (const client of CLIENTS) {
    const { entry } = client.read(context);
    const { engine, version } = describeEntry(entry);
    clients.push({
      id: client.id,
      name: client.name,
      installed: await client.installed(context),
      configPath: client.configPath(context),
      engine,
      version,
    });
  }
  return { engines: { app, npm }, clients };
}

/**
 * Point one tool's ssh-manager entry at an engine.
 * @param {string} clientId
 * @param {'app'|'npm'} kind
 * @param {Context} [context]
 * @returns {Promise<ClientState>}
 */
export async function useEngine(clientId, kind, context = agentContext()) {
  const client = CLIENTS.find(item => item.id === clientId);
  if (!client) throw Object.assign(new Error(`Unknown tool: ${clientId}`), { status: 404 });
  const engine = kind === 'app' ? appEngine(context) : kind === 'npm' ? await npmEngine(context) : null;
  if (!engine) {
    throw Object.assign(new Error(kind === 'app'
      ? 'The desktop application is not installed here, or its engine cannot be started from outside it'
      : 'mcp-ssh-manager is not installed with npm here'), { status: 409 });
  }
  // Only Claude Desktop has a reason to refuse: it undoes edits made while it runs.
  const busy = 'busy' in client ? await client.busy(context) : null;
  if (busy) throw Object.assign(new Error(busy), { status: 409 });
  await client.write(context, engine);
  const status = await agentsStatus(context);
  return /** @type {ClientState} */ (status.clients.find(item => item.id === clientId));
}
