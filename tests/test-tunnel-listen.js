// Regression test: binding a tunnel's local port must fail as a rejected
// promise, never as a process-wide crash.
//
// `net.Server#listen(port, host, cb)` only calls cb on success — a failed bind
// is emitted as an 'error' event. The tunnel code used to pass `(err) => ...`
// as that callback, so on EADDRINUSE (the everyday case: the port is already
// taken) nothing resolved the awaited promise AND the unhandled 'error' event
// made Node rethrow, killing the whole MCP server process along with every
// pooled SSH connection.
//
// This test reaching its final line at all is part of the assertion: an
// uncaught 'error' event would abort the run.
import assert from 'assert';
import net from 'net';
import { listenOrReject } from '../src/tunnel-manager.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const HOST = '127.0.0.1';

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Ask the OS for a free port, then hand it back.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function testResolvesOnSuccessfulBind() {
  const server = net.createServer();
  const port = await freePort();

  await listenOrReject(server, port, HOST);
  assert.strictEqual(server.listening, true, 'server must be listening after resolve');
  assert.strictEqual(server.address().port, port, 'bound to the requested port');

  await closeServer(server);
  ok('resolves once the port is actually bound');
}

async function testRejectsWhenPortIsTaken() {
  const blocker = net.createServer();
  const port = await freePort();
  await listenOrReject(blocker, port, HOST);

  const server = net.createServer();
  await assert.rejects(
    () => listenOrReject(server, port, HOST),
    (error) => {
      assert.strictEqual(error.code, 'EADDRINUSE', `expected EADDRINUSE, got ${error.code}`);
      return true;
    },
    'a taken port must reject, not crash the process'
  );

  assert.strictEqual(server.listening, false, 'the failed server is not listening');
  await closeServer(blocker);
  ok('rejects with EADDRINUSE instead of throwing an uncaught error');
}

// Both listeners are one-shot and each path removes the other, so a long-lived
// process creating many tunnels never accumulates listeners on a reused server.
async function testNoListenerLeak() {
  const server = net.createServer();
  const port = await freePort();

  await listenOrReject(server, port, HOST);
  assert.strictEqual(server.listenerCount('error'), 0, 'error listener removed after success');
  assert.strictEqual(server.listenerCount('listening'), 0, 'listening listener removed after success');

  await closeServer(server);

  const taken = net.createServer();
  const blockedPort = await freePort();
  await listenOrReject(taken, blockedPort, HOST);
  const failing = net.createServer();
  await assert.rejects(() => listenOrReject(failing, blockedPort, HOST));
  assert.strictEqual(failing.listenerCount('listening'), 0, 'listening listener removed after failure');
  await closeServer(taken);

  ok('leaves no dangling listeners on either outcome');
}

async function main() {
  await testResolvesOnSuccessfulBind();
  await testRejectsWhenPortIsTaken();
  await testNoListenerLeak();
  console.log(`\n✅ tunnel listen tests passed (${passed} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
