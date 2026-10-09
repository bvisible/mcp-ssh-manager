// What a failed authentication says (issue #88).
//
// With SSH_AUTH_SOCK set, ssh2 tries the agent's keys after a refused
// password. Against OpenSSH that ends in the server's "Too many
// authentication failures" (MaxAuthTries) and the refused password, the real
// cause, never reached the user. The order is kept (an agent key that works
// must still work, as in 3.8.5); the error now names what was refused, and a
// method the server does not offer is no longer sent at all.
//
// Each case runs a real ssh2 server on the loopback. The agent case starts a
// real ssh-agent, so it is skipped where there is none (Windows runners).
import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ssh2 from 'ssh2';
import SSHManager from '../src/ssh-manager.js';

const { Server } = ssh2;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-auth-'));
process.env.SSH_MANAGER_KNOWN_HOSTS = path.join(scratch, 'known_hosts');
const cleanup = [];
let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const hostKey = path.join(scratch, 'host_key');
execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', hostKey, '-N', '', '-q']);

/**
 * A server that offers `offered` after the initial `none` request and accepts
 * nothing, recording every method a client sends.
 * @param {string[]} offered
 */
function startServer(offered) {
  const seen = [];
  const server = new Server({ hostKeys: [fs.readFileSync(hostKey)] }, client => {
    client.on('authentication', ctx => {
      seen.push(ctx.method);
      ctx.reject(offered);
    });
    client.on('error', () => { /* the client giving up is the point */ });
  });
  cleanup.push(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen })));
}

/** @param {Record<string, any>} config */
async function failure(config) {
  const manager = new SSHManager({ host: '127.0.0.1', user: 'deploy', ...config });
  try {
    await manager.connect({ readyTimeout: 10000 });
  } catch (error) {
    return error;
  } finally {
    manager.client.end();
  }
  assert.fail('authentication should have failed');
}

const savedAgent = process.env.SSH_AUTH_SOCK;
try {
  delete process.env.SSH_AUTH_SOCK;

  {
    const { port, seen } = await startServer(['publickey', 'password']);
    const error = await failure({ port, password: 'wrong' });
    assert.match(error.message, /^Authentication failed for deploy@127\.0\.0\.1:\d+: the password was refused \(/);
    assert.ok(error.message.includes('All configured authentication methods failed'), 'the original words stay');
    assert.deepEqual(seen, ['none', 'password']);
    ok('a refused password is named as such');
  }

  {
    const { port, seen } = await startServer(['publickey']);
    const error = await failure({ port, password: 'secret' });
    assert.match(error.message, /the server does not accept passwords \(it offers: publickey\)/);
    assert.deepEqual(seen, ['none'], 'a password the server does not accept is never sent');
    ok('a server that takes no passwords is said to take none, and never receives one');
  }

  {
    const key = path.join(scratch, 'client_key');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '', '-q']);
    const { port, seen } = await startServer(['publickey']);
    const error = await failure({ port, keyPath: key });
    assert.match(error.message, /the configured key was refused/);
    assert.deepEqual(seen, ['none', 'publickey']);
    ok('a refused key is named as such');
  }

  const agent = process.platform === 'win32' ? null : spawnSync('ssh-agent', ['-s'], { encoding: 'utf8' });
  if (agent && agent.status === 0) {
    const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(agent.stdout)[1];
    const pid = /SSH_AGENT_PID=(\d+);/.exec(agent.stdout)[1];
    cleanup.push(() => { try { process.kill(Number(pid)); } catch { /* gone */ } });
    for (let i = 0; i < 3; i++) {
      const key = path.join(scratch, `agent_key_${i}`);
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '', '-q']);
      execFileSync('ssh-add', ['-q', key], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: 'ignore' });
    }
    process.env.SSH_AUTH_SOCK = sock;
    const { port, seen } = await startServer(['publickey', 'password']);
    const error = await failure({ port, password: 'wrong' });
    assert.match(error.message, /the password was refused; no ssh-agent key was accepted/);
    assert.deepEqual(seen.slice(0, 2), ['none', 'password'], 'the password still goes first');
    assert.equal(seen.filter(method => method === 'publickey').length, 3, 'then every agent key, as before');
    ok('password then agent keys, in the 3.8.5 order, and the error says both were refused');
  } else {
    console.log('- skipped the ssh-agent case: no ssh-agent on this runner');
  }
} finally {
  if (savedAgent === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = savedAgent;
  for (const step of cleanup.reverse()) step();
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n✅ authentication error tests passed (${passed} checks)`);
