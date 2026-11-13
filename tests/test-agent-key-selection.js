import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilteredAgent } from '../src/filtered-agent.js';
import { ed25519Pair } from './helpers/ssh2-keys.js';

const { BaseAgent, utils } = ssh2;

// FilteredAgent unit fixtures stay in memory and use no Agent sockets or network.
const firstPublic = ed25519Pair().public;
const selectedPublic = ed25519Pair().public;
const parsedFirst = utils.parseKey(firstPublic);
const parsedSelected = utils.parseKey(selectedPublic);
assert(!(parsedFirst instanceof Error));
assert(!(parsedSelected instanceof Error));
const target = Buffer.from(`${selectedPublic} configured-comment\n`);

class FakeAgent extends BaseAgent {
  constructor(identities = [parsedFirst, parsedSelected]) {
    super();
    this.identities = identities;
    this.signCalls = [];
    this.signature = Buffer.from('synthetic-signature');
  }
  getIdentities(callback) {
    queueMicrotask(() => callback(this.identityError ?? null, this.identities));
  }
  sign(pubKey, data, options, callback) {
    this.signCalls.push({ receiver: this, pubKey, data, options });
    queueMicrotask(() => callback(this.signError ?? null, this.signature));
  }
}

const identities = (agent) => new Promise((resolve, reject) => {
  agent.getIdentities((error, keys) => error ? reject(error) : resolve(keys));
});
const sign = (agent, publicKey, data, options) => new Promise((resolve, reject) => {
  agent.sign(publicKey, data, options, (error, signature) => error ? reject(error) : resolve(signature));
});
const keyBytes = (key) => {
  const parsed = typeof key === 'string' ? utils.parseKey(key) : key;
  assert(!(parsed instanceof Error));
  return parsed.getPublicSSH();
};

test('implements ssh2 BaseAgent and selects a non-first identity', { timeout: 2000 }, async () => {
  const delegate = new FakeAgent();
  const agent = new FilteredAgent(delegate, target);
  assert(agent instanceof BaseAgent);
  const keys = await identities(agent);
  assert.equal(keys.length, 1);
  assert.deepEqual(keyBytes(keys[0]), parsedSelected.getPublicSSH());
  assert.equal(delegate.identities.length, 2, 'delegate identity list remains intact');
});

test('matches public-key bytes despite different identity comments', { timeout: 2000 }, async () => {
  const agent = new FilteredAgent(new FakeAgent([
    `${firstPublic} first-comment`, `${selectedPublic} agent-comment`,
  ]), target);
  const keys = await identities(agent);
  assert.equal(keys.length, 1);
  assert.deepEqual(keyBytes(keys[0]), parsedSelected.getPublicSSH());
});

test('duplicate representations still expose a single matching identity', { timeout: 2000 }, async () => {
  const agent = new FilteredAgent(new FakeAgent([
    parsedFirst, parsedSelected, `${selectedPublic} duplicate`,
  ]), target);
  const keys = await identities(agent);
  assert.equal(keys.length, 1);
  assert.deepEqual(keyBytes(keys[0]), parsedSelected.getPublicSSH());
});

test('missing selected key fails instead of exposing another identity', { timeout: 2000 }, async () => {
  await assert.rejects(identities(new FilteredAgent(new FakeAgent([parsedFirst]), target)));
});

test('empty agent identity list fails closed', { timeout: 2000 }, async () => {
  await assert.rejects(identities(new FilteredAgent(new FakeAgent([]), target)));
});

test('delegate identity errors are propagated', { timeout: 2000 }, async () => {
  const delegate = new FakeAgent();
  delegate.identityError = new Error('synthetic agent unavailable');
  await assert.rejects(identities(new FilteredAgent(delegate, target)), (error) => {
    assert.equal(error, delegate.identityError);
    return true;
  });
});

test('invalid configured target fails without returning delegate identities', { timeout: 2000 }, async () => {
  for (const invalid of [Buffer.alloc(0), Buffer.from('not a public key'), Buffer.from('ssh-ed25519 !!!! invalid')]) {
    // Accept eager constructor validation or callback validation; both fail closed.
    await assert.rejects(async () => identities(new FilteredAgent(new FakeAgent(), invalid)));
  }
});

test('selected identity signing forwards buffers, options, receiver, and signature intact', { timeout: 2000 }, async () => {
  const delegate = new FakeAgent();
  const agent = new FilteredAgent(delegate, target);
  const [selected] = await identities(agent);
  const publicKey = keyBytes(selected);
  const data = Buffer.from('authentication challenge');
  const options = { hash: 'sha512', flags: 4 };
  const signature = await sign(agent, publicKey, data, options);
  assert.equal(signature, delegate.signature);
  assert.equal(delegate.signCalls.length, 1);
  const call = delegate.signCalls[0];
  assert.equal(call.receiver, delegate);
  assert.equal(call.pubKey, publicKey);
  assert.equal(call.data, data);
  assert.equal(call.options, options);
});

test('rejects signing for a different key without contacting delegate signer', { timeout: 2000 }, async () => {
  const delegate = new FakeAgent();
  const agent = new FilteredAgent(delegate, target);
  await identities(agent);
  await assert.rejects(sign(agent, parsedFirst.getPublicSSH(), Buffer.from('challenge'), {}));
  assert.equal(delegate.signCalls.length, 0);
});

test('malformed signing identity is rejected without contacting delegate signer', { timeout: 2000 }, async () => {
  const delegate = new FakeAgent();
  await assert.rejects(sign(new FilteredAgent(delegate, target), Buffer.from('invalid'), Buffer.from('challenge'), {}));
  assert.equal(delegate.signCalls.length, 0);
});

test('delegate signing failure is preserved', { timeout: 2000 }, async () => {
  const delegate = new FakeAgent();
  delegate.signError = new Error('synthetic signing denied');
  const agent = new FilteredAgent(delegate, target);
  await identities(agent);
  await assert.rejects(sign(agent, parsedSelected.getPublicSSH(), Buffer.from('challenge'), { hash: 'sha256' }), (error) => {
    assert.equal(error, delegate.signError);
    return true;
  });
});

// Capture the actual options constructed by SSHManager, without a connection.
// Each call restores SSH_AUTH_SOCK, including when validation rejects.
async function captureConnection(config, authSock) {
  const previous = process.env.SSH_AUTH_SOCK;
  if (authSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = authSock;
  try {
    const { default: SSHManager } = await import('../src/ssh-manager.js');
    const manager = new SSHManager({ host: 'fixture.invalid', user: 'fixture', hostKeyVerification: false, ...config });
    let captured;
    manager.client = new EventEmitter();
    manager.client.connect = (options) => {
      captured = options;
      queueMicrotask(() => manager.client.emit('ready'));
    };
    await manager.connect();
    return captured;
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  }
}

test('SSHManager rejects a selected Agent key without SSH_AUTH_SOCK', async () => {
  await assert.rejects(captureConnection({ agentPublicKeyPath: 'nonexistent-fixture.pub' }), /SSH_AUTH_SOCK/);
});

for (const conflict of [
  { forwardAgent: true },
  { keyPath: 'nonexistent-private-fixture' },
  { keypath: 'nonexistent-private-fixture' },
  { password: 'synthetic-password' },
  { certPath: 'nonexistent-certificate-fixture.pub' },
]) {
  test(`SSHManager rejects agentPublicKeyPath combined with ${Object.keys(conflict)[0]}`, async () => {
    await assert.rejects(captureConnection({
      agentPublicKeyPath: 'nonexistent-fixture.pub', ...conflict,
    }, '/fixture/agent.sock'), /cannot be combined|conflict|incompatible/i);
  });
}

test('SSHManager installs a FilteredAgent from the configured public file', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-agent-config-'));
  try {
    const publicPath = path.join(scratch, 'identity.pub');
    fs.writeFileSync(publicPath, target);
    const options = await captureConnection({ agentPublicKeyPath: publicPath }, '/fixture/agent.sock');
    assert(options.agent instanceof FilteredAgent);
    assert.equal(options.privateKey, undefined);
    assert.equal(options.password, undefined);
    assert.equal(options.agentForward, undefined);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('unconfigured selection preserves legacy Agent, password, and forwarding behavior', async () => {
  const options = await captureConnection({ password: 'synthetic-password', forwardAgent: true }, '/fixture/agent.sock');
  assert.equal(options.agent, '/fixture/agent.sock');
  assert.equal(options.password, 'synthetic-password');
  assert.equal(options.agentForward, true);
  const noAgent = await captureConnection({ password: 'synthetic-password', forwardAgent: true });
  assert.equal(noAgent.agent, undefined);
  assert.equal(noAgent.agentForward, undefined);
  assert.equal(noAgent.password, 'synthetic-password');
});

test('unconfigured selection preserves private-key authentication with an Agent', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-agent-config-'));
  try {
    const privatePath = path.join(scratch, 'ephemeral-key');
    const privateKey = ed25519Pair().private;
    fs.writeFileSync(privatePath, privateKey);
    const options = await captureConnection({ keyPath: privatePath }, '/fixture/agent.sock');
    assert.equal(options.agent, '/fixture/agent.sock');
    assert.deepEqual(options.privateKey, Buffer.from(privateKey));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
