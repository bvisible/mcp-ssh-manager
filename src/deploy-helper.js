import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Deploy helper functions for secure file deployment
 */

/**
 * Generate a unique temporary filename
 */
export function getTempFilename(originalName) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
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

  // Step 1: Backup existing file if requested
  if (backup) {
    strategy.steps.push({
      type: 'backup',
      command: `if [ -f "${remotePath}" ]; then cp "${remotePath}" "${remotePath}.bak.$(date +%Y%m%d_%H%M%S)"; fi`
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

  // Step 3: Copy from temp to final location
  const copyCmd = needsSudo && sudoPassword ? 
    `echo "${sudoPassword}" | sudo -S cp {{tempFile}} "${remotePath}"` :
    needsSudo ?
    `sudo cp {{tempFile}} "${remotePath}"` :
    `cp {{tempFile}} "${remotePath}"`;

  strategy.steps.push({
    type: 'copy',
    command: copyCmd
  });

  // Step 4: Set ownership if specified
  if (owner) {
    const chownCmd = sudoPassword ?
      `echo "${sudoPassword}" | sudo -S chown ${owner} "${remotePath}"` :
      `sudo chown ${owner} "${remotePath}"`;
    
    strategy.steps.push({
      type: 'chown',
      command: chownCmd
    });
  }

  // Step 5: Set permissions if specified
  if (permissions) {
    const chmodCmd = sudoPassword ?
      `echo "${sudoPassword}" | sudo -S chmod ${permissions} "${remotePath}"` :
      `sudo chmod ${permissions} "${remotePath}"`;
    
    strategy.steps.push({
      type: 'chmod',
      command: chmodCmd
    });
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

/**
 * Create batch deployment script for multiple files
 */
export function createBatchDeployScript(deployments) {
  const script = ['#!/bin/bash', 'set -e', ''];
  
  script.push('# Batch deployment script');
  script.push(`# Generated at ${new Date().toISOString()}`);
  script.push('');
  
  deployments.forEach((deploy, index) => {
    script.push(`# File ${index + 1}: ${deploy.localPath} -> ${deploy.remotePath}`);
    deploy.strategy.steps.forEach(step => {
      if (step.type !== 'cleanup') {
        script.push(step.command.replace('{{tempFile}}', deploy.tempFile));
      }
    });
    script.push('');
  });
  
  // Cleanup all temp files at the end
  script.push('# Cleanup temporary files');
  deployments.forEach(deploy => {
    script.push(`rm -f ${deploy.tempFile}`);
  });
  
  return script.join('\n');
}