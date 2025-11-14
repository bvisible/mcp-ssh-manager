/**
 * SSH Session Manager
 * Manages persistent SSH sessions with state and context
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';

// Map to store active sessions
const sessions = new Map();

// Session states
export const SESSION_STATES = {
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
        rows: 24
      });
      
      // Setup event handlers
      this.shell.on('data', (data) => {
        this.outputBuffer += data.toString();
        this.lastActivity = new Date();
        
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
      
      // Wait for shell prompt
      await this.waitForPrompt();
      
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
   * Wait for shell prompt
   */
  async waitForPrompt(timeout = 5000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      // Check if we have a prompt (ends with $ or # typically)
      if (this.outputBuffer.match(/[$#>]\s*$/)) {
        return true;
      }
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error('Timeout waiting for shell prompt');
  }
  
  /**
   * Update session context (pwd, env)
   */
  async updateContext() {
    try {
      // Get current directory
      const pwdResult = await this.execute('pwd', { silent: true });
      if (pwdResult.success) {
        this.context.cwd = pwdResult.output.trim();
      }
      
      // Get environment variables (selective)
      const envResult = await this.execute('echo $PATH:$USER:$HOME', { silent: true });
      if (envResult.success) {
        const [path, user, home] = envResult.output.trim().split(':');
        this.context.env = { PATH: path, USER: user, HOME: home };
      }
    } catch (error) {
      logger.warn(`Failed to update context for session ${this.id}`, {
        error: error.message
      });
    }
  }
  
  /**
   * Execute a command in the session
   */
  async execute(command, options = {}) {
    if (this.state !== SESSION_STATES.READY) {
      throw new Error(`Session ${this.id} is not ready (state: ${this.state})`);
    }
    
    this.state = SESSION_STATES.BUSY;
    this.lastActivity = new Date();
    
    try {
      // Clear buffers
      this.outputBuffer = '';
      this.errorBuffer = '';
      
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
      
      // Send command
      this.shell.write(command + '\n');
      
      // Wait for command to complete
      await this.waitForPrompt(options.timeout || 30000);
      
      // Parse output (remove command echo and prompt)
      let output = this.outputBuffer;
      
      // Remove the command echo (first line)
      const lines = output.split('\n');
      if (lines[0].includes(command)) {
        lines.shift();
      }
      
      // Remove the prompt (last line)
      const lastLine = lines[lines.length - 1];
      if (lastLine.match(/[$#>]\s*$/)) {
        lines.pop();
      }
      
      output = lines.join('\n').trim();
      
      // Check for command success (basic heuristic)
      const success = !this.errorBuffer && !output.includes('command not found');
      
      // Update context if command might have changed it
      if (command.startsWith('cd ') || command.startsWith('export ')) {
        await this.updateContext();
      }
      
      this.state = SESSION_STATES.READY;
      
      return {
        success,
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
  const sessionId = `ssh_${Date.now()}_${uuidv4().substring(0, 8)}`;
  
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
  
  for (const [id, session] of sessions.entries()) {
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
 * Close all sessions for a server
 */
export function closeServerSessions(serverName) {
  let closedCount = 0;
  
  for (const [id, session] of sessions.entries()) {
    if (session.serverName === serverName) {
      session.close();
      closedCount++;
    }
  }
  
  return closedCount;
}

/**
 * Cleanup old sessions
 */
export function cleanupSessions(maxAge = 30 * 60 * 1000) { // 30 minutes default
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

// Periodic cleanup of inactive sessions
setInterval(() => {
  const cleaned = cleanupSessions();
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} inactive sessions`);
  }
}, 5 * 60 * 1000); // Every 5 minutes

export default {
  createSession,
  getSession,
  listSessions,
  closeSession,
  closeServerSessions,
  cleanupSessions,
  SESSION_STATES
};
