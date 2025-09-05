/**
 * Logger module for MCP SSH Manager
 * Provides structured logging with levels and optional verbose mode
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log levels
export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Colors for terminal output
const COLORS = {
  DEBUG: '\x1b[36m', // Cyan
  INFO: '\x1b[32m',  // Green
  WARN: '\x1b[33m',  // Yellow
  ERROR: '\x1b[31m', // Red
  RESET: '\x1b[0m'
};

// Icons for each level
const ICONS = {
  DEBUG: '🔍',
  INFO: '✅',
  WARN: '⚠️',
  ERROR: '❌'
};

class Logger {
  constructor() {
    // Set log level from environment variable
    const envLevel = process.env.SSH_LOG_LEVEL?.toUpperCase() || 'INFO';
    this.currentLevel = LOG_LEVELS[envLevel] ?? LOG_LEVELS.INFO;
    
    // Enable verbose mode from environment
    this.verbose = process.env.SSH_VERBOSE === 'true';
    
    // Log file path
    this.logFile = process.env.SSH_LOG_FILE || path.join(__dirname, '..', '.ssh-manager.log');
    
    // Command history file
    this.historyFile = path.join(__dirname, '..', '.ssh-command-history.json');
    
    // Initialize command history
    this.commandHistory = this.loadCommandHistory();
  }
  
  /**
   * Load command history from file
   */
  loadCommandHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      // Ignore errors, start with empty history
    }
    return [];
  }
  
  /**
   * Save command to history
   */
  saveCommandToHistory(command, server, result) {
    const entry = {
      timestamp: new Date().toISOString(),
      server,
      command,
      success: result.success,
      duration: result.duration,
      error: result.error
    };
    
    this.commandHistory.push(entry);
    
    // Keep only last 1000 commands
    if (this.commandHistory.length > 1000) {
      this.commandHistory = this.commandHistory.slice(-1000);
    }
    
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.commandHistory, null, 2));
    } catch (error) {
      // Ignore write errors
    }
  }
  
  /**
   * Format log message with timestamp and level
   */
  formatMessage(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const levelName = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === level) || 'INFO';
    
    // Console format with colors
    const consoleFormat = `${COLORS[levelName]}${ICONS[levelName]} [${timestamp}] [${levelName}]${COLORS.RESET} ${message}`;
    
    // File format without colors
    const fileFormat = `[${timestamp}] [${levelName}] ${message}`;
    
    // Add data if present
    let dataStr = '';
    if (Object.keys(data).length > 0) {
      dataStr = '\n  ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ');
    }
    
    return {
      console: consoleFormat + (this.verbose && dataStr ? dataStr : ''),
      file: fileFormat + dataStr
    };
  }
  
  /**
   * Main log function
   */
  log(level, message, data = {}) {
    // Check if we should log this level
    if (level < this.currentLevel) {
      return;
    }
    
    const formatted = this.formatMessage(level, message, data);
    
    // Output to stderr for proper MCP logging
    console.error(formatted.console);
    
    // Also write to file
    try {
      fs.appendFileSync(this.logFile, formatted.file + '\n');
    } catch (error) {
      // Ignore file write errors
    }
  }
  
  // Convenience methods
  debug(message, data) {
    this.log(LOG_LEVELS.DEBUG, message, data);
  }
  
  info(message, data) {
    this.log(LOG_LEVELS.INFO, message, data);
  }
  
  warn(message, data) {
    this.log(LOG_LEVELS.WARN, message, data);
  }
  
  error(message, data) {
    this.log(LOG_LEVELS.ERROR, message, data);
  }
  
  /**
   * Log SSH command execution
   */
  logCommand(server, command, cwd = null) {
    const logData = {
      server,
      command: this.verbose ? command : command.substring(0, 100) + (command.length > 100 ? '...' : ''),
      cwd
    };
    
    if (this.verbose) {
      this.debug(`Executing SSH command`, logData);
    } else {
      this.info(`SSH execute on ${server}`, { command: logData.command });
    }
    
    return Date.now(); // Return start time for duration calculation
  }
  
  /**
   * Log SSH command result
   */
  logCommandResult(server, command, startTime, result) {
    const duration = Date.now() - startTime;
    
    const resultData = {
      success: !result.code,
      duration: `${duration}ms`,
      error: result.code ? result.stderr : undefined
    };
    
    // Save to history
    this.saveCommandToHistory(command, server, resultData);
    
    if (result.code) {
      this.error(`Command failed on ${server}`, resultData);
    } else if (this.verbose) {
      this.debug(`Command completed on ${server}`, resultData);
    }
  }
  
  /**
   * Log SSH connection events
   */
  logConnection(server, event, data = {}) {
    const message = `SSH connection ${event}: ${server}`;
    
    switch (event) {
      case 'established':
        this.info(message, data);
        break;
      case 'reused':
        this.debug(message, data);
        break;
      case 'closed':
        this.info(message, data);
        break;
      case 'failed':
        this.error(message, data);
        break;
      default:
        this.debug(message, data);
    }
  }
  
  /**
   * Log file transfer operations
   */
  logTransfer(operation, server, source, destination, result = null) {
    const data = { server, source, destination };
    
    if (result) {
      data.success = result.success;
      data.size = result.size;
      data.duration = result.duration;
    }
    
    const message = `File ${operation} ${result ? (result.success ? 'completed' : 'failed') : 'started'}`;
    
    if (result && !result.success) {
      this.error(message, data);
    } else {
      this.info(message, data);
    }
  }
  
  /**
   * Get command history
   */
  getHistory(limit = 100) {
    return this.commandHistory.slice(-limit);
  }
  
  /**
   * Clear logs and history
   */
  clear() {
    this.commandHistory = [];
    try {
      fs.writeFileSync(this.historyFile, '[]');
      fs.writeFileSync(this.logFile, '');
      this.info('Logs and history cleared');
    } catch (error) {
      this.error('Failed to clear logs', { error: error.message });
    }
  }
}

// Export singleton instance
export const logger = new Logger();

// Export for convenience
export const { debug, info, warn, error } = logger;
export default logger;