// A Claude Code hook that stops an agent from opening an SSH connection from its
// own shell, and the code that installs it. Opt-in: nothing in this package
// calls it unless the user runs `ssh-manager guard install`.
//
// Why: the approval, the policy and the audit log of ssh-manager only see what
// goes through its MCP tools. An agent that also has a terminal can run `ssh
// host command` there and none of it applies. Idea from fyq163's fork, whose
// hook reminded the agent; this one can refuse, or ask the user each time.
//
// What it is not: a security boundary. It reads the command text, so a determined
// agent can get around it (an interpreter that opens the socket itself, a script
// it wrote earlier). It prevents the accident, and says why to the agent. The
// boundary is not giving that account SSH keys or an agent socket.
//
// This file is self-contained on purpose (node: modules only): `guard install`
// copies it to ~/.ssh-manager/hooks/ssh-guard.mjs, which Claude Code runs as the
// hook, so it must keep working without the package around it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_FILE_NAME = 'ssh-guard.mjs';
export const MODES = ['deny', 'ask'];

// ── finding an SSH connection in a shell command ────────────────────────────

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', '!', '{', '}', 'function']);
// Words that run the next command: skip them, and the options they take.
const WRAPPERS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S']),
  command: new Set(), exec: new Set(['-a']), builtin: new Set(), nohup: new Set(), time: new Set(['-f', '-o']),
  nice: new Set(['-n']), ionice: new Set(['-c', '-n', '-p']), setsid: new Set(), timeout: new Set(['-s', '-k']),
  xargs: new Set(['-I', '-n', '-P', '-d', '-a', '-L', '-s', '-E']), stdbuf: new Set(['-i', '-o', '-e']),
  caffeinate: new Set(['-t', '-w']), unbuffer: new Set(), watch: new Set(['-n', '-d']),
};
const REMOTE_COMMANDS = new Set(['ssh', 'scp', 'sftp', 'ssh-copy-id', 'autossh', 'mosh']);
const MAX_DEPTH = 4;

/**
 * Split a shell command into simple commands (lists of words, quotes removed),
 * following command substitutions and `sh -c` strings into theirs.
 * @param {string} input
 * @param {number} [depth]
 * @returns {string[][]}
 */
function simpleCommands(input, depth = 0) {
  /** @type {string[][]} */
  const commands = [];
  if (depth > MAX_DEPTH) return commands;
  /** @type {string[]} */
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => { if (inWord) { words.push(word); word = ''; inWord = false; } };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  const nested = text => { for (const inner of simpleCommands(text, depth + 1)) commands.push(inner); };
  const text = String(input ?? '');

  /** Index just past the `)` that closes a `$(` opened before `from`. */
  const closeParen = from => {
    let level = 1;
    for (let k = from; k < text.length; k++) {
      if (text[k] === '\\') { k++; continue; }
      if (text[k] === '(') level++;
      else if (text[k] === ')' && --level === 0) return k;
    }
    return text.length;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') { i++; continue; }
      word += text[i + 1] ?? ''; inWord = true; i++; continue;
    }
    if (c === '\'') {
      const end = text.indexOf('\'', i + 1);
      word += text.slice(i + 1, end === -1 ? text.length : end); inWord = true;
      i = end === -1 ? text.length : end; continue;
    }
    if (c === '"') {
      inWord = true;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') { word += text[i + 1] ?? ''; i++; continue; }
        if (text[i] === '$' && text[i + 1] === '(') { const end = closeParen(i + 2); nested(text.slice(i + 2, end)); word += '$(…)'; i = end; continue; }
        if (text[i] === '`') { const end = text.indexOf('`', i + 1); nested(text.slice(i + 1, end === -1 ? text.length : end)); word += '`…`'; i = end === -1 ? text.length : end; continue; }
        word += text[i];
      }
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const end = closeParen(i + 2); nested(text.slice(i + 2, end)); word += '$(…)'; inWord = true; i = end; continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1); nested(text.slice(i + 1, end === -1 ? text.length : end)); word += '`…`'; inWord = true; i = end === -1 ? text.length : end; continue;
    }
    if (c === '#' && !inWord) { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') { endCommand(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    word += c; inWord = true;
  }
  endCommand();

  // Strings that are commands themselves: sh -c '…', eval …
  for (const command of [...commands]) {
    const run = unwrap(command);
    if (!run.length) continue;
    const exe = path.basename(run[0]);
    if (SHELLS.has(exe)) {
      const flag = run.findIndex((w, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (flag !== -1 && run[flag + 1] !== undefined) nested(run[flag + 1]);
    } else if (exe === 'eval') {
      nested(run.slice(1).join(' '));
    }
  }
  return commands;
}

/**
 * The command a simple command really runs: assignments, reserved words,
 * redirections and wrappers such as sudo, env, time or xargs skipped.
 * @param {string[]} words
 * @returns {string[]}
 */
function unwrap(words) {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (RESERVED.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i++; continue; }
    if (/^\d*[<>]/.test(word)) { i += /^\d*(>>?|<|>&|<&)$/.test(word) ? 2 : 1; continue; }
    const wrapper = Object.hasOwn(WRAPPERS, path.basename(word)) ? WRAPPERS[path.basename(word)] : null;
    if (!wrapper) break;
    i++;
    const lookup = path.basename(word) === 'command';
    while (i < words.length) {
      const next = words[i];
      // `command -v ssh` looks the command up, it does not run it.
      if (lookup && (next === '-v' || next === '-V')) return [];
      if (wrapper.has(next)) { i += 2; continue; }
      if (next.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next) || /^\d+(\.\d+)?[smhd]?$/.test(next)) { i++; continue; }
      break;
    }
  }
  return words.slice(i);
}

/**
 * Whether a shell command opens an SSH connection from the shell.
 * @param {string} command
 * @returns {{ command: string, reason: string } | null}
 */
export function findRawSsh(command) {
  for (const simple of simpleCommands(command)) {
    const run = unwrap(simple);
    if (!run.length) continue;
    const exe = path.basename(run[0]);
    const args = run.slice(1);
    if (REMOTE_COMMANDS.has(exe)) {
      if (args.length && args.every(arg => ['-V', '-h', '-?', '--help', '--version'].includes(arg))) continue;
      return { command: exe, reason: `${exe} connects to a host from the shell` };
    }
    if (exe === 'rsync') {
      const remote = args.find(arg => /^(?:[^@\s/:]+@)?[A-Za-z0-9][A-Za-z0-9._-]+:(?!\/\/|:)/.test(arg));
      const shell = args.find(arg => arg === '-e' || arg === '--rsh' || arg.startsWith('--rsh=') || /^-[A-Za-z]*e[A-Za-z]*$/.test(arg));
      if (remote || shell) return { command: 'rsync', reason: 'rsync reaches a host over SSH from the shell' };
    }
  }
  return null;
}

// ── the hook ────────────────────────────────────────────────────────────────

/**
 * What the hook answers for the payload Claude Code sends before a tool runs:
 * null to let it through, else the PreToolUse answer.
 * @param {any} payload
 * @param {'deny'|'ask'} [mode]
 */
export function decide(payload, mode = 'deny') {
  if (payload?.tool_name !== 'Bash') return null;
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') return null;
  const found = findRawSsh(command);
  if (!found) return null;
  const message = `${found.reason}, which skips the approval, the policy and the audit log of ssh-manager. `
    + 'Use its MCP tools instead: ssh_execute for commands, ssh_upload and ssh_download for files, ssh_sync for rsync, '
    + 'ssh_tunnel_create for tunnels. If this really has to run in the shell, ask the user to run it.';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: mode === 'ask' ? 'ask' : 'deny',
      permissionDecisionReason: message,
    },
  };
}

/** Run as the hook: payload on stdin, answer on stdout, never a failure. */
async function runHook(argv) {
  const modeIndex = argv.indexOf('--mode');
  const mode = argv[modeIndex + 1] === 'ask' ? 'ask' : 'deny';
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  let answer = null;
  try { answer = decide(JSON.parse(text), mode); } catch { /* not ours to judge: let it through */ }
  if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
}

// ── installing it ───────────────────────────────────────────────────────────

/** Claude Code's user settings file. */
export function claudeSettingsPath(env = process.env, home = os.homedir()) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
}

export function hookScriptPath(home = os.homedir(), env = process.env) {
  return path.join(env.SSH_MANAGER_HOME || path.join(home, '.ssh-manager'), 'hooks', HOOK_FILE_NAME);
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} could not be read as JSON: change it by hand`);
  }
  return parsed;
}

function writeAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.ssh-manager-${process.pid}.tmp`;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* a new file: private */ }
  fs.writeFileSync(temporary, text, { mode });
  fs.renameSync(temporary, file);
}

const isOurs = hook => typeof hook?.command === 'string' && hook.command.includes(HOOK_FILE_NAME);

/** Where our hook is in a settings object, whatever else is around it. */
function ourHooks(settings) {
  const groups = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  return groups.flatMap(group => (Array.isArray(group?.hooks) ? group.hooks.filter(isOurs) : []));
}

/**
 * The command Claude Code runs; the quotes keep a path with spaces in one piece.
 * `node` is found on the PATH like any other command: a versioned install path
 * (Homebrew's Cellar, nvm) would break at the next Node upgrade, and a hook that
 * cannot start only fails open.
 */
export function hookCommand(script, mode, node = 'node') {
  return `${node} "${script}" --mode ${mode}`;
}

/**
 * Add the hook to Claude Code's settings and copy the script it runs. Replaces
 * a previous install, keeps every other setting and hook, and keeps a copy of
 * the file as it was the first time.
 * @param {{ mode?: 'deny'|'ask', settingsFile?: string, script?: string, node?: string }} [options]
 */
export function installGuard({ mode = 'deny', settingsFile = claudeSettingsPath(), script = hookScriptPath(), node = 'node' } = {}) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const settings = readSettings(settingsFile);
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error(`${settingsFile}: "hooks" is not an object: change it by hand`);
  }
  if (settings.hooks?.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) {
    throw new Error(`${settingsFile}: "hooks.PreToolUse" is not a list: change it by hand`);
  }

  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(fileURLToPath(import.meta.url), script);
  fs.chmodSync(script, 0o700);

  const backup = `${settingsFile}.ssh-manager.bak`;
  if (fs.existsSync(settingsFile) && !fs.existsSync(backup)) fs.copyFileSync(settingsFile, backup);

  stripOurs(settings);
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand(script, mode, node) }] });
  writeAtomically(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return { settingsFile, script, mode };
}

/** Take our hook out of a settings object, and the containers it leaves empty. */
function stripOurs(settings) {
  const groups = settings.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return 0;
  let removed = 0;
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) { kept.push(group); continue; }
    const rest = group.hooks.filter(hook => !isOurs(hook));
    removed += group.hooks.length - rest.length;
    if (rest.length) kept.push({ ...group, hooks: rest });
    else if (rest.length !== group.hooks.length) continue;
    else kept.push(group);
  }
  if (kept.length) settings.hooks.PreToolUse = kept;
  else delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

/**
 * Remove the hook. The copied script stays unless asked, so a second install
 * does not have to fetch it again.
 * @param {{ settingsFile?: string, script?: string, deleteScript?: boolean }} [options]
 */
export function removeGuard({ settingsFile = claudeSettingsPath(), script = hookScriptPath(), deleteScript = false } = {}) {
  const settings = readSettings(settingsFile);
  const removed = stripOurs(settings);
  if (removed) writeAtomically(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  if (deleteScript) fs.rmSync(script, { force: true });
  return { settingsFile, removed };
}

/** Whether the hook is installed, and in which mode. */
export function guardStatus({ settingsFile = claudeSettingsPath(), script = hookScriptPath() } = {}) {
  const hooks = ourHooks(readSettings(settingsFile));
  const command = hooks[0]?.command ?? '';
  return {
    settingsFile,
    installed: hooks.length > 0,
    mode: /--mode ask\b/.test(command) ? 'ask' : hooks.length ? 'deny' : null,
    scriptPresent: fs.existsSync(script),
    command: hooks.length ? command : null,
  };
}

// Run as the entry point under its installed name only: imported, or run as
// src/ssh-guard.js, it is a library. (Compared by name: a symlinked folder such
// as macOS's /var makes the same file show two different paths.)
if (process.argv[1] && path.basename(process.argv[1]) === HOOK_FILE_NAME) {
  runHook(process.argv.slice(2)).catch(() => {});
}
