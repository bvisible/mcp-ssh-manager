/**
 * SSH Session Manager
 * Manages persistent SSH sessions with state and context
 */

import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

// Map to store active sessions
const sessions = new Map();

function generateId() {
  return randomUUID().replace(/-/g, '');
}

// Terminal escape sequences a pty shell may print around its output: colours,
// cursor moves, bracketed-paste switches (CSI), window titles (OSC) and the
// two-character forms. Built from strings so the source holds no raw control
// character.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[()][A-Za-z0-9]`,
    `${ESC}[=>78DEHMNOZ\\\\^_c]`
  ].join('|'),
  'g'
);

/**
 * What the shell printed, without the terminal's decoration: no escape
 * sequences, LF line ends (a pty turns each LF into CRLF), and a carriage
 * return keeps what a terminal would still show, the text after the last one.
 * @param {string} text - Raw shell output
 * @returns {string} Plain text
 */
function plainText(text) {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => (line.includes('\r') ? line.split('\r').filter(Boolean).pop() ?? '' : line))
    .join('\n');
}

/**
 * Find a marker that stands alone on a line.
 *
 * The marker is never written whole. The command line that prints it spells
 * it as separate printf arguments, so a server that echoes what it is sent
 * (it may ignore the request to turn echo off) gives back a line that does not
 * contain the marker. Only the shell's real answer matches. Matching anywhere
 * in the text, as this used to, found the echoed line first.
 *
 * @param {string} text - Plain text to search
 * @param {string} marker - The marker, for example `cmd_<id>`
 * @returns {{index: number, length: number, status: number|null}|null} Where the line is, and the status it carries
 */
function findMarkerLine(text, marker) {
  const found = new RegExp(`^${marker}(?::(\\d+))?[ \\t]*$`, 'm').exec(text);
  if (!found) return null;
  return {
    index: found.index,
    length: found[0].length,
    status: found[1] === undefined ? null : Number.parseInt(found[1], 10)
  };
}

// Commands after which the working directory or the environment may differ.
const CONTEXT_COMMAND = /^\s*(?:cd|pushd|popd|export|unset|source|\.)(?:\s|$)/;

// Session states
const SESSION_STATES = {
  INITIALIZING: 'initializing',
  READY: 'ready',
  BUSY: 'busy',
  ERROR: 'error',
  CLOSED: 'closed'
};

class SSHSession {
  constructor(id, serverName, ssh) {
    this.id = id;
    this.serverName = serverName;
    this.ssh = ssh;
    this.state = SESSION_STATES.INITIALIZING;
    this.context = {
      cwd: null,
      env: {},
      history: [],
      variables: {}
    };
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.shell = null;
    this.outputBuffer = '';
    this.errorBuffer = '';
    // The prompt a server keeps printing when it will not stop (see initialize).
    this.prompt = '';
    /** @type {(() => void)|null} Called whenever the shell prints something */
    this.onShellData = null;
  }

  /**
   * Initialize the session with a shell
   */
  async initialize() {
    try {
      logger.info(`Initializing SSH session ${this.id}`, {
        server: this.serverName
      });

      // Start an interactive shell
      this.shell = await this.ssh.requestShell({
        term: 'xterm-256color',
        cols: 80,
        rows: 24,
        modes: {
          ECHO: 0
        }
      });

      // Setup event handlers
      this.shell.on('data', (data) => {
        this.outputBuffer += data.toString();
        this.lastActivity = new Date();
        this.onShellData?.();

        // Log output in verbose mode
        if (logger.verbose) {
          logger.debug(`Session ${this.id} output`, {
            data: data.toString().substring(0, 200)
          });
        }
      });

      this.shell.on('close', () => {
        logger.info(`Session ${this.id} shell closed`);
        this.state = SESSION_STATES.CLOSED;
        this.cleanup();
      });

      this.shell.stderr.on('data', (data) => {
        this.errorBuffer += data.toString();
        logger.warn(`Session ${this.id} stderr`, {
          error: data.toString()
        });
      });

      // The ECHO mode above is only a request, and a server may ignore it; a
      // prompt also comes back after every line, and bash's line editing prints
      // a newline and bracketed-paste codes around each line it reads. Ask the
      // shell itself to stop all of it, and wait for an explicit readiness
      // marker rather than a prompt. A shell that is not a shell (a bastion
      // menu) answers none of it, and reading the output no longer depends on it.
      const readyId = generateId();
      this.shell.write([
        'stty -echo 2>/dev/null',
        'PS1=\'\'; PS2=\'\'; PROMPT_COMMAND=\'\'',
        '[ -n "$ZSH_VERSION" ] && unsetopt zle',
        'set +o emacs +o vi 2>/dev/null',
        `printf '\\n%s%s\\n' ready_ ${readyId}`
      ].join('\n') + '\n');
      await this.waitUntil(
        () => findMarkerLine(plainText(this.outputBuffer), `ready_${readyId}`),
        5000,
        `ready_${readyId}`
      );

      // What is left after the marker is the shell's prompt, when it still
      // prints one. A fixed prompt is removed from the lines of every command's
      // output; one that changes (the directory in it) cannot be, so a shell
      // that ignores PS1 keeps its prompt in the output.
      await new Promise(resolve => setTimeout(resolve, 150));
      this.prompt = this.learnPrompt(readyId);

      // Allow context queries through standard execute flow
      this.state = SESSION_STATES.READY;

      // Get initial working directory
      await this.updateContext();

      logger.info(`Session ${this.id} initialized`, {
        server: this.serverName,
        cwd: this.context.cwd
      });

    } catch (error) {
      this.state = SESSION_STATES.ERROR;
      logger.error(`Failed to initialize session ${this.id}`, {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * The prompt the shell printed after the readiness marker, if any.
   * @param {string} readyId - Id of the readiness marker
   * @returns {string} The prompt, or an empty string
   */
  learnPrompt(readyId) {
    const text = plainText(this.outputBuffer);
    const marker = findMarkerLine(text, `ready_${readyId}`);
    if (!marker) return '';
    const after = text.slice(marker.index + marker.length).replace(/^\n/, '');
    // A prompt is one unfinished line; anything longer is output we do not know.
    return after.includes('\n') ? '' : after;
  }

  /**
   * Wait until `find` returns something, as the shell prints.
   * @param {() => any} find - Returns a truthy value once what is awaited has arrived
   * @param {number} timeout - Milliseconds to wait
   * @param {string} label - What is awaited, for the error
   * @returns {Promise<any>} Whatever `find` returned
   */
  waitUntil(find, timeout, label) {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.onShellData = null; };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`Timeout waiting for marker: ${label}`));
      }, timeout);
      const check = () => {
        const found = find();
        if (!found) return;
        done();
        resolve(found);
      };
      this.onShellData = check;
      check();
    });
  }

  /**
   * Wait for a marker in shell output
   */
  async waitForMarker(marker, timeout = 5000) {
    await this.waitUntil(() => findMarkerLine(plainText(this.outputBuffer), marker), timeout, marker);
    return true;
  }

  /**
   * What a command printed so far, and how it ended.
   *
   * The text between the command's start marker and its end marker, without
   * the terminal's escape sequences and without the prompt. Before the end
   * marker has arrived, only complete lines count.
   *
   * @param {string} id - The command's id
   * @returns {{text: string, done: boolean, exitCode: number|null}|null} Null until the start marker has arrived
   */
  readCommand(id) {
    const text = plainText(this.outputBuffer);
    const start = findMarkerLine(text, `start_${id}`);
    if (!start) return null;
    const from = start.index + start.length + (text[start.index + start.length] === '\n' ? 1 : 0);
    const rest = text.slice(from);
    const end = findMarkerLine(rest, `cmd_${id}`);
    let body;
    if (end) {
      body = rest.slice(0, end.index);
    } else {
      body = rest.slice(0, rest.lastIndexOf('\n') + 1);
    }
    if (this.prompt) {
      // The shell prints its prompt before reading each line it is sent, so
      // several can pile up in front of the text that follows them.
      const withoutPrompts = line => {
        let rest = line;
        while (rest.startsWith(this.prompt)) rest = rest.slice(this.prompt.length);
        return rest;
      };
      body = body.split('\n').map(withoutPrompts).join('\n');
    }
    return { text: body, done: Boolean(end), exitCode: end ? end.status : null };
  }

  /**
   * Send a command wrapped in markers and wait for it to finish.
   * Does not touch the session state: callers do.
   *
   * @param {string} command - The command line
   * @param {{timeout?: number, onOutput?: (text: string) => void}} [options] - `onOutput` receives the output as it arrives
   * @returns {Promise<{output: string, exitCode: number|null}>} The output, and the status the shell reported
   */
  async run(command, options = {}) {
    // Clear buffers
    this.outputBuffer = '';
    this.errorBuffer = '';

    const id = generateId();

    // Both markers are spelled as separate printf arguments (see findMarkerLine).
    this.shell.write(
      `set +e\nprintf '\\n%s%s\\n' start_ ${id}\n${command}\n__mcp_status=$?\nprintf '\\n%s%s:%s\\n' cmd_ ${id} "$__mcp_status"\n`
    );

    // Forward what the command prints while it runs. Only whole lines, and
    // never the trailing blank lines: the next chunk may continue them.
    let forwarded = '';
    const forward = (text) => {
      if (!options.onOutput) return;
      const shown = text.replace(/\n+$/, '');
      if (shown.length <= forwarded.length || !shown.startsWith(forwarded)) return;
      options.onOutput(shown.slice(forwarded.length));
      forwarded = shown;
    };

    const finished = await this.waitUntil(() => {
      const seen = this.readCommand(id);
      if (seen && !seen.done) forward(seen.text);
      return seen?.done ? seen : null;
    }, options.timeout || 30000, `cmd_${id}`);

    const output = finished.text.replace(/\n+$/, '');
    forward(output);
    return { output, exitCode: finished.exitCode };
  }

  /**
   * Read the working directory and a few variables back from the shell.
   * Does not touch the session state: callers do.
   */
  async refreshContext() {
    const pwdResult = await this.run('pwd');
    if (pwdResult.exitCode === 0) {
      this.context.cwd = pwdResult.output.trim();
    }

    // One value per line: PATH holds colons, so they cannot separate the three.
    const envResult = await this.run('printf \'%s\\n%s\\n%s\\n\' "$PATH" "$USER" "$HOME"');
    if (envResult.exitCode === 0) {
      const [PATH, USER, HOME] = envResult.output.split('\n');
      this.context.env = { PATH, USER, HOME };
    }
  }

  /**
   * Update session context (pwd, env)
   */
  async updateContext() {
    if (this.state !== SESSION_STATES.READY) {
      logger.warn(`Failed to update context for session ${this.id}`, {
        error: `Session ${this.id} is not ready (state: ${this.state})`
      });
      return;
    }
    this.state = SESSION_STATES.BUSY;
    try {
      await this.refreshContext();
      this.state = SESSION_STATES.READY;
    } catch (error) {
      this.state = SESSION_STATES.ERROR;
      logger.warn(`Failed to update context for session ${this.id}`, {
        error: error.message
      });
    }
  }

  /**
   * Execute a command in the session
   *
   * @param {string} command - The command line
   * @param {{timeout?: number, silent?: boolean, onOutput?: (text: string) => void}} [options] - `onOutput` receives the output as it arrives
   */
  async execute(command, options = {}) {
    if (this.state !== SESSION_STATES.READY) {
      throw new Error(`Session ${this.id} is not ready (state: ${this.state})`);
    }

    this.state = SESSION_STATES.BUSY;
    this.lastActivity = new Date();

    try {
      // Add to history unless silent
      if (!options.silent) {
        this.context.history.push({
          command,
          timestamp: new Date(),
          cwd: this.context.cwd
        });

        logger.info(`Session ${this.id} executing`, {
          command: command.substring(0, 100),
          server: this.serverName
        });
      }

      const { output, exitCode } = await this.run(command, options);

      // Update context if command might have changed it. The session is still
      // busy here, so this reads the shell directly: going through execute()
      // was refused ("not ready") and the context stayed as it was.
      if (CONTEXT_COMMAND.test(command)) {
        try {
          await this.refreshContext();
        } catch (error) {
          logger.warn(`Failed to update context for session ${this.id}`, {
            error: error.message
          });
        }
      }

      this.state = SESSION_STATES.READY;

      return {
        success: exitCode === 0,
        exitCode,
        output,
        error: this.errorBuffer,
        session: this.id
      };

    } catch (error) {
      this.state = SESSION_STATES.ERROR;
      logger.error(`Session ${this.id} execution failed`, {
        command,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Can a command be sent now?
   * @returns {boolean} True when the session is ready
   */
  isReady() {
    return this.state === SESSION_STATES.READY;
  }

  /**
   * Set session variable
   */
  setVariable(name, value) {
    this.context.variables[name] = value;
    this.lastActivity = new Date();
  }

  /**
   * Get session variable
   */
  getVariable(name) {
    return this.context.variables[name];
  }

  /**
   * Get session info
   */
  getInfo() {
    return {
      id: this.id,
      server: this.serverName,
      state: this.state,
      cwd: this.context.cwd,
      env: this.context.env,
      created: this.createdAt,
      lastActivity: this.lastActivity,
      historyCount: this.context.history.length,
      variables: Object.keys(this.context.variables)
    };
  }

  /**
   * Close the session
   */
  close() {
    logger.info(`Closing session ${this.id}`);

    if (this.shell) {
      this.shell.write('exit\n');
      this.shell.end();
      this.shell = null;
    }

    this.state = SESSION_STATES.CLOSED;
    this.cleanup();
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    sessions.delete(this.id);
    this.outputBuffer = '';
    this.errorBuffer = '';
    this.context.history = [];
  }
}

/**
 * Create a new SSH session
 */
export async function createSession(serverName, ssh) {
  const sessionId = `ssh_${Date.now()}_${randomUUID().substring(0, 8)}`;

  const session = new SSHSession(sessionId, serverName, ssh);
  sessions.set(sessionId, session);

  try {
    await session.initialize();

    logger.info('SSH session created', {
      id: sessionId,
      server: serverName
    });

    return session;
  } catch (error) {
    sessions.delete(sessionId);
    throw error;
  }
}

/**
 * Get an existing session
 */
export function getSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.state === SESSION_STATES.CLOSED) {
    throw new Error(`Session ${sessionId} is closed`);
  }

  return session;
}

/**
 * List all active sessions
 */
export function listSessions() {
  const activeSessions = [];

  for (const [, session] of sessions.entries()) {
    if (session.state !== SESSION_STATES.CLOSED) {
      activeSessions.push(session.getInfo());
    }
  }

  return activeSessions;
}

/**
 * Close a session
 */
export function closeSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  session.close();
  return true;
}

/**
 * Cleanup old sessions
 */
function cleanupSessions(maxAge = 30 * 60 * 1000) { // 30 minutes default
  const now = Date.now();
  let cleanedCount = 0;

  for (const [id, session] of sessions.entries()) {
    const age = now - session.lastActivity.getTime();

    if (age > maxAge) {
      logger.info(`Cleaning up inactive session ${id}`, {
        age: Math.floor(age / 1000) + 's'
      });
      session.close();
      cleanedCount++;
    }
  }

  return cleanedCount;
}

// Periodic cleanup of inactive sessions.
// unref() so this interval never keeps the process alive on its own (a stdio MCP
// server must exit when its transport closes, not be pinned by a background timer).
const sessionCleanup = setInterval(() => {
  const cleaned = cleanupSessions();
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} inactive sessions`);
  }
}, 5 * 60 * 1000); // Every 5 minutes
if (typeof sessionCleanup.unref === 'function') sessionCleanup.unref();
