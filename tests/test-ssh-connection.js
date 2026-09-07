// Shared MCP/UI transport: local ssh2 servers stand in for every hop. Exec
// requests only return a fixed marker; no shell or production host is involved.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import ssh2 from 'ssh2';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-proxy-'));
process.env.SSH_MANAGER_KNOWN_HOSTS = path.join(scratch, 'known_hosts');
process.env.SSH_LOG_FILE = path.join(scratch, 'log');
process.env.SSH_HISTORY_FILE = path.join(scratch, 'history');
delete process.env.SSH_AUTH_SOCK;
const { connectServer, connectSSH } = await import('../src/ssh-connection.js');
const { default: SSHManager } = await import('../src/ssh-manager.js');
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const resources = [];
const sockets = new Set();
const allowedPorts = new Set();
let passed = 0;
const ok = label => { passed++; console.log(`✓ ${label}`); };

async function host() {
  const forwarded = [];
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => {
      client.on('session', accept => accept().on('exec', acceptExec => {
        const stream = acceptExec(); stream.write('fixture-through-proxy\n'); stream.exit(0); stream.end();
      }));
      client.on('tcpip', (accept, reject, info) => {
        if (!allowedPorts.has(info.destPort)) { reject(); return; }
        forwarded.push(info);
        const socket = net.connect(info.destPort, '127.0.0.1');
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.once('connect', () => {
          const channel = accept();
          socket.pipe(channel).pipe(socket);
          channel.on('close', () => socket.destroy());
          channel.on('error', () => socket.destroy());
        });
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  allowedPorts.add(port); resources.push(server);
  return { port, forwarded };
}

try {
  const target = await host();
  const middle = await host();
  const outer = await host();
  const base = { user: 'fixture', password: 'fixture' };
  const servers = {
    outer: { ...base, name: 'outer', host: '127.0.0.1', port: outer.port },
    middle: { ...base, name: 'middle', host: 'middle.fixture.invalid', port: middle.port, proxyJump: 'outer' },
    target: { ...base, name: 'target', host: 'target.fixture.invalid', port: target.port, proxyJump: 'middle' },
  };
  const standalone = await connectServer('target', servers, { readyTimeout: 3000 });
  assert.match((await standalone.execCommand('fixture')).stdout, /fixture-through-proxy/);
  assert.equal(outer.forwarded.length, 1);
  assert.equal(middle.forwarded.length, 1);
  assert.equal(outer.forwarded[0].destIP, 'middle.fixture.invalid');
  assert.equal(outer.forwarded[0].destPort, middle.port);
  assert.equal(middle.forwarded[0].destPort, target.port);
  const ownedMiddle = standalone.jumpConnection;
  const ownedOuter = ownedMiddle.jumpConnection;
  standalone.dispose();
  assert.equal(standalone.connected, false);
  assert.equal(ownedMiddle.connected, false);
  assert.equal(ownedOuter.connected, false);
  ok('standalone UI connection traverses two jumps and disposal releases the owned chain');

  const pooledJump = await connectServer('outer', servers, { readyTimeout: 3000 });
  const pooledTarget = new SSHManager({ ...servers.target, proxyJump: 'outer' });
  const directViaOuter = { ...servers, target: pooledTarget.config };
  const resolved = [];
  const jumpName = await connectSSH(pooledTarget, directViaOuter, { readyTimeout: 3000,
    resolveJump: async name => { resolved.push(name); return pooledJump; } });
  assert.equal(jumpName, 'outer'); assert.deepEqual(resolved, ['outer']);
  assert.match((await pooledTarget.execCommand('fixture')).stdout, /fixture-through-proxy/);
  pooledTarget.dispose();
  assert.equal(pooledJump.connected, true);
  pooledJump.dispose();
  ok('MCP transport uses the same jump setup while leaving caller-owned pooled jumps open');

  await assert.rejects(connectServer('target', { ...servers, outer: { ...servers.outer, proxyJump: 'target' } }), /Circular/);
  await assert.rejects(connectServer('target', { ...servers, target: { ...servers.target, proxyJump: 'missing' } }), /not found/);
  ok('missing and circular jump definitions are rejected before connecting');

  const proxyScript = path.join(scratch, 'proxy.cjs');
  fs.writeFileSync(proxyScript, `const net=require('node:net'); const s=net.connect(${target.port},'127.0.0.1'); process.stdin.pipe(s).pipe(process.stdout); s.on('close',()=>process.exit(0)); s.on('error',()=>process.exit(1));`);
  const proxyCommand = `"${process.execPath}" "${proxyScript}"`;
  const proxied = await connectServer('proxy', { proxy: { ...base, host: 'command.fixture.invalid', port: target.port, proxyCommand } }, { readyTimeout: 3000 });
  assert.match((await proxied.execCommand('fixture')).stdout, /fixture-through-proxy/);
  proxied.dispose();
  ok('ProxyCommand carries the same authenticated SSH handshake and fixed fixture command');
  console.log(`\nSSH connection setup: ${passed} checks passed`);
} finally {
  for (const socket of sockets) { socket.end(); socket.destroy?.(); }
  for (const server of resources) await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
