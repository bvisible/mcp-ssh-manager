// A real SSH handshake through the standard OpenSSH Agent socket protocol.
// All keys are ephemeral; listeners use loopback and an isolated socket/pipe.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ssh2 from 'ssh2';

const { AgentProtocol, Server, createAgent, utils } = ssh2;
const hostKey = utils.generateKeyPairSync('ed25519').private;
const unrelated = Array.from({ length: 6 }, () => utils.parseKey(utils.generateKeyPairSync('ed25519').private));
// RSA exercises AgentProtocol's RSA-SHA2 signing flags as well as selection.
const targetPair = utils.generateKeyPairSync('rsa', { bits: 2048 });
const targetKey = utils.parseKey(targetPair.private);
const targetBytes = targetKey.getPublicSSH();
const allKeys = [...unrelated, targetKey];

async function fixture(t, keys) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-agent-wire-'));
  const publicPath = path.join(scratch, 'selected.pub');
  fs.writeFileSync(publicPath, `${targetPair.public} configured-comment\n`);
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\ssh-agent-selection-${process.pid}-${randomUUID()}`
    : path.join(scratch, 'agent.sock');
  const sockets = new Set();
  const managers = [];
  const requests = { identities: 0, signatures: [], authentication: [], verified: 0 };
  const oldSocket = process.env.SSH_AUTH_SOCK;
  const oldLog = process.env.SSH_LOG_FILE;
  process.env.SSH_AUTH_SOCK = socketPath;
  process.env.SSH_LOG_FILE = path.join(scratch, 'log');

  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };
  const agentServer = net.createServer(socket => {
    track(socket);
    const protocol = new AgentProtocol(false);
    protocol.on('error', () => socket.destroy());
    protocol.on('identities', request => {
      requests.identities++;
      protocol.getIdentitiesReply(request, keys);
    });
    protocol.on('sign', (request, publicKey, data, options) => {
      requests.signatures.push({ publicKey: publicKey.getPublicSSH(), hash: options.hash });
      const privateKey = keys.find(key => key.getPublicSSH().equals(publicKey.getPublicSSH()));
      if (!privateKey) return protocol.failureReply(request);
      const signature = privateKey.sign(data, options.hash);
      if (signature instanceof Error) return protocol.failureReply(request);
      protocol.signReply(request, signature);
    });
    socket.pipe(protocol).pipe(socket);
    socket.on('close', () => protocol.destroy());
  });
  const sshServer = new Server({ hostKeys: [hostKey] }, client => {
    track(client);
    client.on('authentication', context => {
      if (context.method !== 'publickey') return context.reject(['publickey']);
      requests.authentication.push(Buffer.from(context.key.data));
      if (!context.key.data.equals(targetBytes)) {
        context.reject(['publickey']);
        return;
      }
      if (context.signature) {
        if (targetKey.verify(context.blob, context.signature, context.hashAlgo) !== true) {
          return context.reject(['publickey']);
        }
        requests.verified++;
      }
      context.accept();
    });
  });
  t.after(async () => {
    for (const manager of managers) manager.dispose();
    for (const socket of sockets) {
      socket.end();
      socket.destroy?.();
    }
    await Promise.all([agentServer, sshServer].map(server => new Promise(resolve => {
      if (!server.address()) return resolve();
      server.close(resolve);
    })));
    if (oldSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = oldSocket;
    if (oldLog === undefined) delete process.env.SSH_LOG_FILE;
    else process.env.SSH_LOG_FILE = oldLog;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    agentServer.once('error', reject);
    agentServer.listen(socketPath, resolve);
  });
  await new Promise((resolve, reject) => {
    sshServer.once('error', reject);
    sshServer.listen(0, '127.0.0.1', resolve);
  });
  const { default: SSHManager } = await import('../src/ssh-manager.js');
  return {
    socketPath, requests,
    manager(select = true) {
      const manager = new SSHManager({
        host: '127.0.0.1', port: sshServer.address().port, user: 'fixture',
        hostKeyVerification: false,
        ...(select ? { agentPublicKeyPath: publicPath } : {}),
      });
      managers.push(manager);
      return manager;
    },
  };
}

test('Agent protocol advertises seven keys, but SSH authentication offers only the selected last key', { timeout: 15000 }, async t => {
  const { socketPath, requests, manager } = await fixture(t, allKeys);
  const advertised = await new Promise((resolve, reject) => {
    createAgent(socketPath).getIdentities((error, keys) => error ? reject(error) : resolve(keys));
  });
  assert.equal(advertised.length, 7, 'the underlying Agent remains unfiltered');
  assert.deepEqual(advertised.at(-1).getPublicSSH(), targetBytes);
  const connection = manager();
  await connection.connect({ readyTimeout: 5000 });
  assert.equal(connection.connected, true);
  assert(requests.authentication.length >= 1);
  for (const offered of requests.authentication) assert.deepEqual(offered, targetBytes);
  assert.equal(requests.verified, 1, 'the server cryptographically verified the Agent signature');
  assert.equal(requests.signatures.length, 1);
  assert.deepEqual(requests.signatures[0].publicKey, targetBytes);
  assert.match(requests.signatures[0].hash, /^sha(256|512)$/, 'RSA-SHA2 options survived Agent filtering');
});

test('selected identity absent from the real Agent fails before offering another key', { timeout: 15000 }, async t => {
  const { requests, manager } = await fixture(t, unrelated);
  await assert.rejects(manager().connect({ readyTimeout: 5000 }));
  assert(requests.identities >= 1);
  assert.deepEqual(requests.authentication, []);
  assert.deepEqual(requests.signatures, []);
  assert.equal(requests.verified, 0);
});

test('without configured selection the same Agent retains its original key order', { timeout: 15000 }, async t => {
  const { requests, manager } = await fixture(t, allKeys);
  await manager(false).connect({ readyTimeout: 5000 });
  assert(requests.authentication.length >= allKeys.length);
  for (let i = 0; i < unrelated.length; i++) {
    assert.deepEqual(requests.authentication[i], unrelated[i].getPublicSSH());
  }
  assert.equal(requests.verified, 1);
});
