import path from 'path';
import crypto from 'crypto';
import { shellQuote } from './shell-quote.js';

/**
 * Deploy helper functions for secure file deployment
 */

/**
 * Generate a unique temporary filename
 */
export function getTempFilename(originalName) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  // The local name is only a hint for whoever reads /tmp: keep the characters
  // that need no quoting anywhere, so the name stays inert in every command.
  const safe = text => text.replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = safe(path.extname(originalName));
  const base = safe(path.basename(originalName, path.extname(originalName)));
  return `/tmp/${base}_${timestamp}_${random}${ext}`;
}

/**
 * Build deployment strategy based on target path and permissions
 */
export function buildDeploymentStrategy(remotePath, options = {}) {
  const {
    sudoPassword = null,
    owner = null,
    permissions = null,
    backup = true,
    restart = null
  } = options;

  const strategy = {
    steps: [],
    requiresSudo: false
  };

  // Every value below reaches the remote shell. Up to 3.8.5 the path sat in
  // double quotes, where $(…) still runs, and owner and permissions were bare.
  const target = shellQuote(remotePath);

  // Step 1: Backup existing file if requested
  if (backup) {
    strategy.steps.push({
      type: 'backup',
      command: `if [ -f ${target} ]; then cp ${target} ${target}.bak.$(date +%Y%m%d_%H%M%S); fi`
    });
  }

  // Step 2: Determine if we need sudo
  const needsSudo = remotePath.startsWith('/etc/') ||
                    remotePath.startsWith('/var/') ||
                    remotePath.startsWith('/usr/') ||
                    owner || permissions;

  if (needsSudo) {
    strategy.requiresSudo = true;
  }

  // A step that needs the sudo password carries it as `stdin`, never inside
  // `command`. Interpolating it (`echo "<pass>" | sudo -S …`) published the
  // password to the remote process list and /proc/<pid>/cmdline (issue #34).
  // See the ssh_execute_sudo handler for what -S -k -p '' each do.
  const sudoPrefix = sudoPassword ? 'sudo -S -k -p \'\' ' : 'sudo ';
  const withSudoStdin = (step) => (sudoPassword ? { ...step, stdin: `${sudoPassword}\n` } : step);

  // Step 3: Copy from temp to final location
  const copyCmd = needsSudo ?
    `${sudoPrefix}cp {{tempFile}} ${target}` :
    `cp {{tempFile}} ${target}`;

  strategy.steps.push(needsSudo ? withSudoStdin({
    type: 'copy',
    command: copyCmd
  }) : {
    type: 'copy',
    command: copyCmd
  });

  // Step 4: Set ownership if specified
  if (owner) {
    strategy.steps.push(withSudoStdin({
      type: 'chown',
      command: `${sudoPrefix}chown ${shellQuote(owner)} ${target}`
    }));
  }

  // Step 5: Set permissions if specified
  if (permissions) {
    strategy.steps.push(withSudoStdin({
      type: 'chmod',
      command: `${sudoPrefix}chmod ${shellQuote(permissions)} ${target}`
    }));
  }

  // Step 6: Restart service if specified
  if (restart) {
    strategy.steps.push({
      type: 'restart',
      command: restart
    });
  }

  // Step 7: Cleanup temp file
  strategy.steps.push({
    type: 'cleanup',
    command: 'rm -f {{tempFile}}'
  });

  return strategy;
}

/**
 * Parse deployment configuration from file path patterns
 * Examples:
 *   /home/user/app/file.js -> normal deploy
 *   /etc/nginx/sites-available/site -> needs sudo
 *   /var/www/html/index.html -> needs sudo
 */
export function detectDeploymentNeeds(remotePath) {
  const needs = {
    sudo: false,
    suggestedOwner: null,
    suggestedPerms: null
  };

  // System directories that typically need sudo
  if (remotePath.startsWith('/etc/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'root:root';
    needs.suggestedPerms = '644';
  } else if (remotePath.startsWith('/var/www/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'www-data:www-data';
    needs.suggestedPerms = '644';
  } else if (remotePath.includes('/nginx/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'root:root';
    needs.suggestedPerms = '644';
  } else if (remotePath.includes('/apache/') || remotePath.includes('/httpd/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'www-data:www-data';
    needs.suggestedPerms = '644';
  } else if (remotePath.includes('/frappe-bench/')) {
    // For ERPNext/Frappe deployments
    needs.sudo = false;
    needs.suggestedOwner = null; // Will be handled by the app
    needs.suggestedPerms = '644';
  }

  return needs;
}
