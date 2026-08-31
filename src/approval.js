// Human-in-the-loop approval — the v4 control plane hook.
//
// The engine can pause an action and ask a person before touching a machine.
// That is the one thing a command line cannot offer well and the whole reason
// the control plane exists: `readonly` mode is a blunt yes/no decided in
// advance, while approval is a decision taken with the actual command in view.
//
// How it stays out of the way:
//
//   * **Off unless asked for.** No `approval` setting on a server, no socket
//     listening → this module is never consulted and nothing changes.
//   * **It cannot wedge an agent.** Every wait has a deadline, and what happens
//     at the deadline is configurable. A crashed control plane must fail one
//     action, not hang the session forever.
//   * **Secrets never travel.** The request carries the same sanitized view the
//     audit log records, so a password cannot leak into a UI or its logs.
//
// Protocol: one JSON object per line over a local stream socket. The engine
// writes a request and waits for a reply carrying the same `id`. Newline-
// delimited JSON keeps a control plane implementable in any language, and
// debuggable with `nc`.

import net from 'net';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { READONLY_BLOCKED_TOOLS, COMMAND_BEARING_TOOLS } from './policy.js';
import { logger } from './logger.js';

/** Never ask (default — v3 behaviour). */
const ASK_NEVER = 'never';
/** Ask only for actions that change or destroy remote state. */
const ASK_DESTRUCTIVE = 'destructive';
/** Ask for everything that reaches a machine. */
const ASK_ALWAYS = 'always';

export const VALID_APPROVAL_MODES = new Set([ASK_NEVER, ASK_DESTRUCTIVE, ASK_ALWAYS]);

// sun_path limit for Unix domain sockets: 104 bytes on macOS/BSD, 108 on Linux.
// Take the smaller so a path that works on one platform works on both.
export const MAX_SOCKET_PATH = 104;

// Commands that destroy data or take a service down. Deliberately short: this
// decides what interrupts a human, and a list that cries wolf gets clicked
// through without reading, which is worse than no prompt at all.
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf]/,
  /\bdd\s+.*\bof=/,
  /\bmkfs(\.\w+)?\b/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\b(drop|truncate)\s+(database|table|schema)\b/i,
  /\bchown\s+-R\b/,
  /\bchmod\s+-R\s+0?777\b/,
  // No \b before -F: a space and a hyphen are both non-word characters,
  // so there is no word boundary between them and the pattern never matched.
  /\b(iptables|nft)\b.*\s(-F|--flush|flush)(\s|$)/,
  /:\(\)\s*\{.*\}\s*;/,
];

/**
 * Where the control plane listens.
 *
 * A Unix socket on POSIX, a named pipe on Windows. Both live outside the
 * project directory so a repository copy never carries one.
 * @returns {string} Socket path
 */
export function defaultSocketPath() {
  if (process.env.SSH_MANAGER_APPROVAL_SOCKET) return process.env.SSH_MANAGER_APPROVAL_SOCKET;
  if (process.platform === 'win32') return '\\\\.\\pipe\\mcp-ssh-manager-approval';
  const home = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
  return path.join(home, 'approval.sock');
}

/**
 * Approval mode for a server, defaulting to never.
 * @param {any} serverConfig - Resolved server config
 * @returns {string} One of VALID_APPROVAL_MODES
 */
export function approvalMode(serverConfig) {
  // Only the vault reaches this field: ConfigLoader does not read `approval`
  // from a .env, a TOML file or the environment. An environment variable would
  // be the easiest of all to set from inside a compromised shell.
  const raw = serverConfig?.approval ?? ASK_NEVER;
  const normalized = String(raw).toLowerCase();
  if (!VALID_APPROVAL_MODES.has(normalized)) {
    logger.warn(`Unknown approval mode "${raw}", falling back to "${ASK_NEVER}"`, {
      server: serverConfig?.name,
    });
    return ASK_NEVER;
  }
  return normalized;
}

/**
 * Would this action change remote state, or destroy something?
 *
 * Reuses the classification the security modes already rely on, so a tool
 * blocked by `readonly` is the same tool that prompts under `destructive`.
 *
 * @param {string} toolName - MCP tool name
 * @param {string} [command] - Command string, for command-bearing tools
 * @returns {boolean} True when the action deserves a human
 */
export function isDestructive(toolName, command) {
  if (READONLY_BLOCKED_TOOLS.has(toolName)) return true;
  if (COMMAND_BEARING_TOOLS.has(toolName) && typeof command === 'string') {
    return DESTRUCTIVE_COMMAND_PATTERNS.some(re => re.test(command));
  }
  return false;
}

/**
 * Does this action need a human's decision?
 * @param {any} serverConfig - Resolved server config
 * @param {string} toolName - MCP tool name
 * @param {string} [command] - Command string
 * @returns {boolean} True when approval must be requested
 */
export function needsApproval(serverConfig, toolName, command) {
  const mode = approvalMode(serverConfig);
  if (mode === ASK_NEVER) return false;
  if (mode === ASK_ALWAYS) return true;
  return isDestructive(toolName, command);
}

/**
 * Is a control plane listening?
 *
 * Checked before every request rather than cached: the UI can be started and
 * stopped at any time, and a stale "yes" would make the engine wait on a socket
 * nobody is reading.
 *
 * @param {string} [socketPath] - Socket to test
 * @returns {boolean} True when something is there to ask
 */
export function isControlPlaneListening(socketPath = defaultSocketPath()) {
  if (process.platform === 'win32') return true; // named pipes: only connect() can tell

  // Unix sockets cap their path at sun_path — 104 bytes on macOS/BSD, 108 on
  // Linux. Past it, bind() fails with a misleading EADDRINUSE on a path where
  // nothing is listening, which costs an hour to diagnose. Say it plainly.
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    logger.warn(
      `Approval socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH}-byte limit — `
      + 'no control plane can listen there. Set SSH_MANAGER_APPROVAL_SOCKET to a shorter path.',
      { socketPath }
    );
    return false;
  }

  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

/**
 * Ask the control plane to decide, and wait.
 *
 * @param {Object} request - What the human is being asked to approve
 * @param {Object} [options] - Socket path and deadline
 * @param {string} [options.socketPath] - Where to connect
 * @param {number} [options.timeoutMs] - How long to wait
 * @returns {Promise<{decision: 'allow'|'deny', reason?: string, source: string}>}
 *   `source` says who decided: the operator, or the timeout default.
 */
export function requestDecision(request, options = {}) {
  const socketPath = options.socketPath || defaultSocketPath();
  const timeoutMs = options.timeoutMs
    ?? Number(process.env.SSH_MANAGER_APPROVAL_TIMEOUT_MS || 120000);

  return new Promise(resolve => {
    let settled = false;
    /** @type {import('net').Socket|null} */
    let socket = null;

    // Every exit path goes through here, so the socket is closed exactly once
    // and a late reply can never resolve a promise twice.
    const finish = (decision, reason, source) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) { socket.removeAllListeners(); socket.destroy(); }
      resolve({ decision, reason, source });
    };

    const timer = setTimeout(() => {
      // The deadline is the safety net: a control plane that crashed mid-review,
      // or an operator who walked away, must not leave the agent hanging.
      finish('deny', `No decision within ${timeoutMs}ms`, 'timeout');
    }, timeoutMs);

    try {
      socket = net.createConnection(socketPath);
    } catch (error) {
      finish('deny', `Cannot reach the control plane: ${error.message}`, 'error');
      return;
    }

    let buffer = '';

    socket.on('connect', () => {
      socket?.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', chunk => {
      buffer += chunk.toString();
      // One JSON object per line; anything after the first complete line is
      // ignored, since one request has exactly one answer.
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (reply.id !== request.id) {
          finish('deny', 'Control plane replied about a different request', 'error');
          return;
        }
        finish(
          reply.decision === 'allow' ? 'allow' : 'deny',
          reply.reason,
          'operator'
        );
      } catch (error) {
        finish('deny', `Unreadable reply: ${error.message}`, 'error');
      }
    });

    socket.on('error', error => {
      // No listener, wrong permissions, socket removed mid-flight. Denying is
      // the safe reading: approval was requested and did not happen.
      finish('deny', `Control plane unreachable: ${error.message}`, 'error');
    });

    socket.on('close', () => {
      finish('deny', 'Control plane closed the connection without deciding', 'error');
    });
  });
}

/**
 * Build the request handed to the control plane.
 *
 * @param {any} serverConfig - Resolved server config
 * @param {string} toolName - MCP tool name
 * @param {any} sanitizedArgs - Arguments, already stripped of secrets
 * @param {string} [command] - Command string
 * @returns {Object} The request object
 */
export function buildRequest(serverConfig, toolName, sanitizedArgs, command) {
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    server: serverConfig?.name,
    host: serverConfig?.host,
    user: serverConfig?.user,
    mode: serverConfig?.mode || 'unrestricted',
    tool: toolName,
    command,
    destructive: isDestructive(toolName, command),
    args: sanitizedArgs,
  };
}
