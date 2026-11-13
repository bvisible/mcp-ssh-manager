// Regression test: a remote tunnel (ssh -R) must work through the real
// SSHManager. The tunnel manager called forwardIn / unforwardIn / on on the
// wrapper, which only had forwardOut, so ssh_tunnel_create with type "remote"
// always failed with "this.ssh.forwardIn is not a function". The tests that
// mention tunnels used a fake connection object that had the methods.
//
// A local ssh2 server stands in for the remote host: it accepts the
// tcpip-forward request, then sends one connection back through the tunnel to
// a local service, the way sshd does when something connects to the remote port.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-tunnel-'));
process.env.SSH_MANAGER_KNOWN_HOSTS = path.join(scratch, 'known_hosts');
process.env.SSH_MANAGER_HOME = path.join(scratch, 'home');
process.env.SSH_LOG_FILE = path.join(scratch, 'log');
process.env.SSH_HISTORY_FILE = path.join(scratch, 'history');
delete process.env.SSH_AUTH_SOCK;
const { connectServer } = await import('../src/ssh-connection.js');
const { createTunnel } = await import('../src/tunnel-manager.js');
const { default: SSHManager } = await import('../src/ssh-manager.js');

const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const sockets = new Set();
const requests = [];
let serverSide = null;

const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  serverSide = client;
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => {});
  client.on('authentication', context => context.accept());
  client.on('ready', () => client.on('session', accept => accept()));
  client.on('request', (accept, reject, name, info) => {
    requests.push({ name, host: info?.bindAddr, port: info?.bindPort });
    if (name === 'tcpip-forward' || name === 'cancel-tcpip-forward') accept?.();
    else reject?.();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

// The local service the remote port is forwarded to.
const received = [];
const service = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.on('data', chunk => { received.push(chunk.toString()); socket.write(`pong:${chunk}`); });
});
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
const localPort = service.address().port;

const servers = { t: { name: 't', host: '127.0.0.1', port: server.address().port, user: 'fixture', password: 'fixture' } };
let ssh;
try {
  // Before connecting, a remote forward fails cleanly instead of throwing.
  const idle = new SSHManager(servers.t);
  const early = await new Promise(resolve => idle.forwardIn('127.0.0.1', 18999, error => resolve(error)));
  assert.match(early.message, /Not connected/);
  ok('forwardIn on a connection that is not up reports an error to its callback');

  ssh = await connectServer('t', servers, { readyTimeout: 3000 });
  for (const method of ['forwardIn', 'unforwardIn', 'on', 'off']) assert.equal(typeof ssh[method], 'function', method);
  ok('SSHManager exposes forwardIn, unforwardIn, on and off');

  const tunnel = await createTunnel('t', ssh, { type: 'remote', localHost: '127.0.0.1', localPort, remoteHost: '127.0.0.1', remotePort: 18999 });
  assert.deepEqual(requests.find(r => r.name === 'tcpip-forward'), { name: 'tcpip-forward', host: '127.0.0.1', port: 18999 });
  assert.equal(ssh.client.listenerCount('tcp connection'), 1);
  ok('creating a remote tunnel asks the server to listen on the remote port');

  // The server announces a connection that arrived on the remote port.
  const answer = await new Promise((resolve, reject) => {
    serverSide.forwardOut('127.0.0.1', 18999, '198.51.100.7', 40000, (error, channel) => {
      if (error) { reject(error); return; }
      channel.once('data', chunk => resolve(chunk.toString()));
      channel.write('ping');
    });
  });
  assert.equal(answer, 'pong:ping');
  assert.deepEqual(received, ['ping']);
  ok('a connection arriving on the remote port reaches the local service and the answer comes back');

  tunnel.close();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(requests.some(r => r.name === 'cancel-tcpip-forward' && r.port === 18999), 'the forward is cancelled');
  assert.equal(ssh.client.listenerCount('tcp connection'), 0);
  ok('closing the tunnel cancels the forward and removes its listener from the shared connection');

  // A connection that is already gone must not make close() throw.
  const second = await createTunnel('t', ssh, { type: 'remote', localHost: '127.0.0.1', localPort, remoteHost: '127.0.0.1', remotePort: 19000 });
  ssh.dispose();
  assert.doesNotThrow(() => second.close());
  ok('closing a tunnel whose connection is already closed does not throw');

  console.log(`\n✅ remote tunnel tests passed (${passed} checks)`);
} finally {
  ssh?.dispose();
  for (const socket of sockets) { socket.end(); socket.destroy?.(); }
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => service.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
