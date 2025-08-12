#!/usr/bin/env node

// Test SSH command execution through MCP server
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔧 Testing SSH command execution through MCP...\n');

const serverPath = path.join(__dirname, 'src', 'index.js');
const server = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let requestId = 0;

// Handle server output
server.stdout.on('data', (data) => {
  try {
    const response = JSON.parse(data.toString());
    if (response.result) {
      console.log('✅ Response:', JSON.stringify(response.result, null, 2));
    } else if (response.error) {
      console.log('❌ Error:', response.error.message);
    }
  } catch (e) {
    // Ignore non-JSON output
  }
});

server.stderr.on('data', (data) => {
  const msg = data.toString();
  if (!msg.includes('MCP SSH Manager Server started') && !msg.includes('Available servers')) {
    console.log('ℹ️', msg.trim());
  }
});

// Initialize the server
setTimeout(() => {
  const initRequest = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '0.1.0',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    },
    id: ++requestId
  };
  
  server.stdin.write(JSON.stringify(initRequest) + '\n');
  
  // Test ssh_list_servers
  setTimeout(() => {
    console.log('\n📋 Testing ssh_list_servers...\n');
    
    const listRequest = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'ssh_list_servers',
        arguments: {}
      },
      id: ++requestId
    };
    
    server.stdin.write(JSON.stringify(listRequest) + '\n');
    
    // Test ssh_execute
    setTimeout(() => {
      console.log('\n🚀 Testing ssh_execute (ls -la)...\n');
      
      const execRequest = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'ssh_execute',
          arguments: {
            server: 'production',
            command: 'ls -la | head -5'
          }
        },
        id: ++requestId
      };
      
      server.stdin.write(JSON.stringify(execRequest) + '\n');
      
      // Test ssh_execute with working directory
      setTimeout(() => {
        console.log('\n📁 Testing ssh_execute with working directory...\n');
        
        const execCwdRequest = {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'ssh_execute',
            arguments: {
              server: 'production',
              command: 'pwd',
              cwd: '/home/user'
            }
          },
          id: ++requestId
        };
        
        server.stdin.write(JSON.stringify(execCwdRequest) + '\n');
        
        // Exit after tests
        setTimeout(() => {
          console.log('\n✅ All tests complete. Shutting down...');
          server.kill();
          process.exit(0);
        }, 2000);
      }, 2000);
    }, 2000);
  }, 1000);
}, 500);