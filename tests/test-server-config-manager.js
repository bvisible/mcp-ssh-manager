import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ServerConfigManager } from '../src/server-config-manager.js';

function writeToml(filePath, servers) {
  const content = Object.entries(servers).map(([name, server]) => `
[ssh_servers.${name}]
host = "${server.host}"
user = "${server.user}"
password = "${server.password}"
port = ${server.port}
description = "${server.description}"
`).join('\n');

  fs.writeFileSync(filePath, content, 'utf8');
}

function writeEnv(filePath, host) {
  fs.writeFileSync(filePath, [
    `SSH_SERVER_LAN_51_HOST=${host}`,
    'SSH_SERVER_LAN_51_USER=root',
    'SSH_SERVER_LAN_51_PASSWORD=123456',
    'SSH_SERVER_LAN_51_PORT=22',
    'SSH_SERVER_LAN_51_DESCRIPTION="LAN server from env"',
    ''
  ].join('\n'), 'utf8');
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-hot-reload-'));
  const tomlPath = path.join(tmpDir, 'ssh-config.toml');
  const envPath = path.join(tmpDir, '.env');

  writeToml(tomlPath, {
    lan_51: {
      host: '10.0.0.51',
      user: 'root',
      password: '123456',
      port: 22,
      description: 'LAN server 10.0.0.51'
    }
  });

  const manager = new ServerConfigManager({
    envPath,
    tomlPath,
    preferToml: false
  });

  let servers = await manager.loadInitial();
  assert.deepStrictEqual(Object.keys(servers), ['lan_51']);

  await new Promise(resolve => setTimeout(resolve, 1100));
  writeToml(tomlPath, {
    lan_51: {
      host: '10.0.0.51',
      user: 'root',
      password: '123456',
      port: 22,
      description: 'LAN server 10.0.0.51'
    },
    lan_52: {
      host: '10.0.0.52',
      user: 'root',
      password: '123456',
      port: 22,
      description: 'LAN server 10.0.0.52'
    }
  });

  servers = await manager.getServers();
  assert.deepStrictEqual(Object.keys(servers), ['lan_51', 'lan_52']);
  assert.strictEqual(servers.lan_52.host, '10.0.0.52');

  writeEnv(envPath, '10.0.0.151');
  await new Promise(resolve => setTimeout(resolve, 1100));

  servers = await manager.getServers();
  assert.strictEqual(servers.lan_51.host, '10.0.0.151');

  writeEnv(envPath, '10.0.0.152');
  await new Promise(resolve => setTimeout(resolve, 1100));

  servers = await manager.getServers();
  assert.strictEqual(servers.lan_51.host, '10.0.0.152');

  console.log('✅ server config manager tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
