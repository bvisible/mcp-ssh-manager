// Public Agent identity selection must survive file and environment exports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import TOML from '@iarna/toml';
import dotenv from 'dotenv';
import { ConfigLoader } from '../src/config-loader.js';

test('TOML and environment exports retain per-server Agent selection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-agent-config-'));
  try {
    const file = path.join(dir, 'config.toml');
    const keyPath = '~/.ssh/test key.pub';
    fs.writeFileSync(file, TOML.stringify({ ssh_servers: {
      selected: { host: 'example.com', user: 'demo', agent_public_key_path: keyPath },
      unchanged: { host: 'example.org', user: 'demo' }
    } }));
    const loader = new ConfigLoader();
    await loader.loadTomlConfig(file);
    assert.equal(loader.servers.get('selected').agentPublicKeyPath, keyPath);
    assert.equal(loader.servers.get('unchanged').agentPublicKeyPath, undefined);
    const exported = TOML.parse(loader.exportToToml());
    assert.equal(exported.ssh_servers.selected.agent_public_key_path, keyPath);
    assert.ok(!('agent_public_key_path' in exported.ssh_servers.unchanged));
    const fromEnv = new ConfigLoader();
    fromEnv.parseEnvVariables(dotenv.parse(loader.exportToEnv()));
    assert.equal(fromEnv.servers.get('selected').agentPublicKeyPath, keyPath);
    assert.equal(fromEnv.servers.get('unchanged').agentPublicKeyPath, undefined);
    assert.ok(!('agent_public_key_path' in fromEnv.servers.get('selected')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('environment export preserves Windows path backslashes', () => {
  const loader = new ConfigLoader();
  const keyPath = String.raw`C:\new\remote keys\identity.pub`;
  loader.parseEnvVariables({
    SSH_SERVER_SELECTED_HOST: 'example.com',
    SSH_SERVER_SELECTED_USER: 'demo',
    SSH_SERVER_SELECTED_AGENT_PUBLIC_KEY_PATH: keyPath,
  });
  const exported = dotenv.parse(loader.exportToEnv());
  assert.equal(exported.SSH_SERVER_SELECTED_AGENT_PUBLIC_KEY_PATH, keyPath);
});
