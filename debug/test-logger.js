#!/usr/bin/env node

/**
 * Test script for the logger system
 * Run with different environment variables to test different modes:
 * 
 * SSH_VERBOSE=true node debug/test-logger.js
 * SSH_LOG_LEVEL=DEBUG node debug/test-logger.js
 * SSH_LOG_LEVEL=ERROR node debug/test-logger.js
 */

import { logger, LOG_LEVELS } from '../src/logger.js';

console.log('🧪 Testing Logger System');
console.log('========================');
console.log(`Current log level: ${process.env.SSH_LOG_LEVEL || 'INFO'}`);
console.log(`Verbose mode: ${process.env.SSH_VERBOSE === 'true' ? 'ON' : 'OFF'}`);
console.log('');

// Test different log levels
console.log('📝 Testing log levels:');
logger.debug('This is a DEBUG message', { extra: 'debug data' });
logger.info('This is an INFO message', { server: 'test-server' });
logger.warn('This is a WARNING message', { issue: 'potential problem' });
logger.error('This is an ERROR message', { error: 'test error' });

console.log('\n📡 Testing connection logs:');
logger.logConnection('test-server', 'established', {
  host: '192.168.1.1',
  port: 22,
  method: 'password'
});
logger.logConnection('test-server', 'reused');
logger.logConnection('test-server', 'failed', { error: 'Connection timeout' });
logger.logConnection('test-server', 'closed');

console.log('\n⚡ Testing command logs:');
const startTime = logger.logCommand('test-server', 'ls -la /home', '/home');
setTimeout(() => {
  logger.logCommandResult('test-server', 'ls -la /home', startTime, {
    code: 0,
    stdout: 'file1.txt\nfile2.txt',
    stderr: ''
  });
}, 100);

setTimeout(() => {
  const startTime2 = logger.logCommand('test-server', 'rm -rf /important', '/');
  logger.logCommandResult('test-server', 'rm -rf /important', startTime2, {
    code: 1,
    stdout: '',
    stderr: 'Permission denied'
  });
}, 200);

console.log('\n📦 Testing transfer logs:');
logger.logTransfer('upload', 'test-server', '/local/file.txt', '/remote/file.txt');
setTimeout(() => {
  logger.logTransfer('upload', 'test-server', '/local/file.txt', '/remote/file.txt', {
    success: true,
    size: 1024,
    duration: '150ms'
  });
}, 300);

logger.logTransfer('download', 'test-server', '/remote/big.zip', '/local/big.zip');
setTimeout(() => {
  logger.logTransfer('download', 'test-server', '/remote/big.zip', '/local/big.zip', {
    success: false,
    error: 'Connection lost'
  });
}, 400);

// Test command history
setTimeout(() => {
  console.log('\n📜 Testing command history:');
  const history = logger.getHistory(5);
  console.log(`Last ${history.length} commands:`);
  history.forEach(entry => {
    console.log(`  - [${entry.timestamp}] ${entry.server}: ${entry.command?.substring(0, 50)} - ${entry.success ? '✅' : '❌'}`);
  });
  
  console.log('\n✅ Logger test complete!');
  console.log(`Log file: ${process.env.SSH_LOG_FILE || '.ssh-manager.log'}`);
  console.log(`History file: .ssh-command-history.json`);
}, 500);