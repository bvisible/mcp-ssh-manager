// Exercise the same filter against a real, isolated OpenSSH ssh-agent.
// No user keys, existing Agent socket, or external server are used.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ssh2 from 'ssh2';
import SSHManager from '../src/ssh-manager.js';
import { ed25519Pair } from './helpers/ssh2-keys.js';

test('select an identity from a real OpenSSH ssh-agent', { timeout: 15000 }, async t => {
  if (process.platform === 'win32'
    || spawnSync('sh', ['-c', 'command -v ssh-agent >/dev/null && command -v ssh-add >/dev/null']).status !== 0) {
    return t.skip('requires POSIX OpenSSH ssh-agent and ssh-add');
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-openssh-'));
  const socket = path.join(scratch, 'agent.sock');
  const env = { ...process.env, SSH_AUTH_SOCK: socket };
  const agent = spawn('ssh-agent', ['-D', '-a', socket], { env, stdio: 'ignore' });
  const oldSocket = process.env.SSH_AUTH_SOCK;
  let manager;
  let server;
  const clients = new Set();
  t.after(async () => {
    manager?.dispose();
    for (const client of clients) client.end();
    if (server?.address()) await new Promise(resolve => server.close(resolve));
    if (agent.exitCode === null) {
      const exited = once(agent, 'exit');
      agent.kill();
      await exited;
    }
    if (oldSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = oldSocket;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  for (let i = 0; !fs.existsSync(socket); i++) {
    if (agent.exitCode !== null || i >= 100) throw new Error('Test ssh-agent did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const keys = Array.from({ length: 3 }, () => ed25519Pair());
  for (const [i, key] of keys.entries()) {
    const file = path.join(scratch, `key-${i}`);
    fs.writeFileSync(file, key.private, { mode: 0o600 });
    execFileSync('ssh-add', [file], { env, stdio: 'pipe' });
  }
  const target = ssh2.utils.parseKey(keys.at(-1).public);
  const publicPath = path.join(scratch, 'selected.pub');
  fs.writeFileSync(publicPath, keys.at(-1).public);
  let verified = 0;
  const offered = [];
  server = new ssh2.Server({ hostKeys: [ed25519Pair().private] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', context => {
      if (context.method !== 'publickey') return context.reject(['publickey']);
      offered.push(context.key.data);
      if (!context.key.data.equals(target.getPublicSSH())) return context.reject(['publickey']);
      if (context.signature) {
        if (target.verify(context.blob, context.signature, context.hashAlgo) !== true) {
          return context.reject(['publickey']);
        }
        verified++;
      }
      context.accept();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  process.env.SSH_AUTH_SOCK = socket;
  manager = new SSHManager({
    host: '127.0.0.1', port: server.address().port, user: 'fixture',
    hostKeyVerification: false, agentPublicKeyPath: publicPath,
  });
  await manager.connect({ readyTimeout: 5000 });
  assert.equal(verified, 1);
  assert(offered.length > 0);
  for (const key of offered) assert.deepEqual(key, target.getPublicSSH());
});
