/**
 * Hooks System for MCP SSH Manager
 * Provides automation through pre/post execution hooks
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { loadProfile } from './profile-loader.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOKS_CONFIG_FILE = path.join(__dirname, '..', '.hooks-config.json');
const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

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
        type: 'notification',
        name: 'log-error',
        command: 'echo "[$(date)] Error on {server}: {error}" >> errors.log'
      }
    ]
  }
};

/**
 * Initialize hooks directory and configuration
 */
export async function initializeHooks() {
  // Create hooks directory if it doesn't exist
  if (!fs.existsSync(HOOKS_DIR)) {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
  }
  
  // Merge profile hooks with defaults
  const mergedHooks = { ...DEFAULT_HOOKS, ...profileHooks };
  
  // Create hooks configuration if it doesn't exist
  if (!fs.existsSync(HOOKS_CONFIG_FILE)) {
    saveHooksConfig(mergedHooks);
  }
  
  return true;
}

/**
 * Load hooks configuration
 */
export function loadHooksConfig() {
  try {
    // Start with profile hooks
    let hooks = { ...profileHooks };
    
    // Merge with custom hooks from file
    if (fs.existsSync(HOOKS_CONFIG_FILE)) {
      const data = fs.readFileSync(HOOKS_CONFIG_FILE, 'utf8');
      const customHooks = JSON.parse(data);
      
      // Deep merge hooks
      for (const [hookName, hookConfig] of Object.entries(customHooks)) {
        if (hooks[hookName]) {
          // Merge existing hook
          hooks[hookName] = {
            ...hooks[hookName],
            ...hookConfig
          };
        } else {
          // Add new hook
          hooks[hookName] = hookConfig;
        }
      }
    }
    
    return hooks;
  } catch (error) {
    console.error(`Error loading hooks config: ${error.message}`);
  }
  return { ...DEFAULT_HOOKS, ...profileHooks };
}

/**
 * Save hooks configuration
 */
export function saveHooksConfig(config) {
  try {
    fs.writeFileSync(HOOKS_CONFIG_FILE, JSON.stringify(config, null, 2));
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
  
  for (const action of hook.actions) {
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
      
      // Replace placeholders in command
      let command = action.command || action.remoteCommand || '';
      for (const [key, value] of Object.entries(context)) {
        command = command.replace(new RegExp(`{${key}}`, 'g'), value);
      }
      
      // Execute action based on type
      const result = await executeAction(action, command, context);
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
async function executeAction(action, command, context) {
  const result = {
    action: action.name,
    type: action.type,
    timestamp: new Date().toISOString()
  };
  
  try {
    if (action.remoteCommand && context.sshConnection) {
      // Execute on remote server
      const output = await context.sshConnection.execCommand(command, {
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
      const { stdout, stderr } = await execAsync(command);
      
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
          command: command
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

/**
 * Create a custom hook script
 */
export async function createHookScript(scriptName, scriptContent) {
  const scriptPath = path.join(HOOKS_DIR, scriptName);
  
  try {
    fs.writeFileSync(scriptPath, scriptContent);
    fs.chmodSync(scriptPath, '755');
    return scriptPath;
  } catch (error) {
    throw new Error(`Failed to create hook script: ${error.message}`);
  }
}