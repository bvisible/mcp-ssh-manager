// Tests for the v4 control plane.
//
// This process approves root shell commands, so its access control is not a
// nicety: an unauthenticated HTTP server on localhost is reachable by every
// process on the machine **and by any web page the user has open**, since a page
// can POST to 127.0.0.1. Most of what follows is about that.
//
// The rest covers the promise the UI makes: a decision taken in the browser
// actually unblocks the engine waiting on the socket.
import assert from 'assert';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import http from 'http';
import { ControlPlane } from '../src/control-plane.js';
import { requestDecision, buildRequest } from '../src/approval.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// Short path: Unix sockets cap sun_path at 104 bytes, and the scratch dirs this
// project uses are already close to it.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
/** @type {ControlPlane[]} */
const planes = [];

async function startPlane(options = {}) {
  const plane = new ControlPlane({
    socketPath: path.join(scratch, `s${planes.length}.sock`),
    port: 0,
    ...options,
  });
  planes.push(plane);
  const { url } = await plane.start();
  return { plane, url, base: url.split('/?')[0] };
}

/**
 * @param {string} base - http://127.0.0.1:PORT
 * @param {string} pathAndQuery - e.g. /api/state?token=…
 * @param {Object} [init] - fetch init
 */
function call(base, pathAndQuery, init = {}) {
  return fetch(`${base}${pathAndQuery}`, init);
}

/**
 * Raw request, because fetch() refuses to let a caller set Host — it is a
 * forbidden header there. Testing the rebinding guard requires sending a Host
 * the server did not choose, which only a hand-built request can do.
 *
 * @param {number} port - Port to hit
 * @param {string} pathAndQuery - Path with query string
 * @param {string} host - Host header to send
 * @returns {Promise<{status: number, body: string}>}
 */
function rawGet(port, pathAndQuery, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathAndQuery, method: 'GET', headers: { Host: host } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function testTokenIsRequired() {
  const { plane, base } = await startPlane();

  const noToken = await call(base, '/api/state');
  assert.strictEqual(noToken.status, 401, 'no token must be refused');

  const wrongToken = await call(base, '/api/state?token=wrong');
  assert.strictEqual(wrongToken.status, 401, 'a wrong token must be refused');

  // Same length as the real one: guards against a comparison that only checks
  // length, and exercises the constant-time path.
  const sameLength = await call(base, `/api/state?token=${'0'.repeat(plane.token.length)}`);
  assert.strictEqual(sameLength.status, 401, 'a same-length wrong token must be refused');

  const good = await call(base, `/api/state?token=${plane.token}`);
  assert.strictEqual(good.status, 200, 'the real token must work');
  ok('every endpoint requires the token, including a same-length impostor');

  // The decision endpoint is the dangerous one: it must not be reachable
  // without the token even with a well-formed body.
  const decide = await call(base, '/api/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'x', decision: 'allow' }),
  });
  assert.strictEqual(decide.status, 401, 'approving without the token must be refused');
  ok('approving without the token is refused');
}

async function testDnsRebindingIsBlocked() {
  const { plane, base } = await startPlane();

  // A hostile page can point its own domain at 127.0.0.1 and reach this server
  // with the browser's cooperation. The Host header is what separates that from
  // a genuine local request.
  const port = plane.httpServer.address().port;
  const rebound = await rawGet(port, `/api/state?token=${plane.token}`, 'evil.example.com');
  assert.strictEqual(rebound.status, 403, 'a foreign Host header must be refused');
  ok('a request carrying a foreign Host header is refused (DNS rebinding)');

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const res = await rawGet(port, `/api/state?token=${plane.token}`, host);
    assert.strictEqual(res.status, 200, `${host} must be accepted`);
  }
  ok('loopback Host headers are accepted');
}

async function testBindsLoopbackOnly() {
  const { plane } = await startPlane();
  const address = plane.httpServer.address();
  assert.strictEqual(address.address, '127.0.0.1',
    `the server must bind 127.0.0.1, got ${address.address} — anything else exposes it to the network`);
  ok('the HTTP server binds 127.0.0.1, never 0.0.0.0');
}

async function testDecisionUnblocksTheEngine() {
  const { plane, base } = await startPlane();

  // The engine's side: a real requestDecision against the real socket.
  const enginePromise = requestDecision(
    buildRequest({ name: 'prod', host: 'p.internal' }, 'ssh_execute', {}, 'rm -rf /var/www'),
    { socketPath: plane.socketPath, timeoutMs: 5000 }
  );

  // Wait for it to show up in the queue, as a human would.
  await new Promise(resolve => setTimeout(resolve, 200));
  const state = await (await call(base, `/api/state?token=${plane.token}`)).json();
  assert.strictEqual(state.pending.length, 1, 'the request must be queued for a human');
  assert.strictEqual(state.pending[0].command, 'rm -rf /var/www');
  assert.strictEqual(state.pending[0].destructive, true);
  ok('a waiting request appears in the queue with its command and severity');

  const decided = await call(base, `/api/decide?token=${plane.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: state.pending[0].id, decision: 'deny', reason: 'not tonight' }),
  });
  assert.strictEqual(decided.status, 200);

  const outcome = await enginePromise;
  assert.strictEqual(outcome.decision, 'deny', 'the engine must receive the refusal');
  assert.strictEqual(outcome.reason, 'not tonight', 'the reason must reach the engine');
  assert.strictEqual(outcome.source, 'operator');
  ok('a refusal in the UI reaches the engine, reason included');

  // And the decision is recorded, so the timeline is not just approvals in flight.
  const after = await (await call(base, `/api/state?token=${plane.token}`)).json();
  assert.strictEqual(after.pending.length, 0, 'the queue must empty');
  assert.ok(after.timeline.some(e => e.command === 'rm -rf /var/www' && !e.allowed),
    'the refusal must appear in the timeline');
  ok('the queue empties and the decision lands in the timeline');
}

async function testApproval() {
  const { plane, base } = await startPlane();
  const enginePromise = requestDecision(
    buildRequest({ name: 'prod' }, 'ssh_deploy', {}, undefined),
    { socketPath: plane.socketPath, timeoutMs: 5000 }
  );
  await new Promise(resolve => setTimeout(resolve, 200));
  const state = await (await call(base, `/api/state?token=${plane.token}`)).json();
  await call(base, `/api/decide?token=${plane.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: state.pending[0].id, decision: 'allow' }),
  });
  const outcome = await enginePromise;
  assert.strictEqual(outcome.decision, 'allow');
  ok('an approval in the UI lets the engine proceed');
}

async function testDecidingTwiceIsRefused() {
  const { plane, base } = await startPlane();
  const enginePromise = requestDecision(
    buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'x'),
    { socketPath: plane.socketPath, timeoutMs: 5000 }
  );
  await new Promise(resolve => setTimeout(resolve, 200));
  const state = await (await call(base, `/api/state?token=${plane.token}`)).json();
  const id = state.pending[0].id;

  const body = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, decision: 'deny' }) };
  const first = await call(base, `/api/decide?token=${plane.token}`, body);
  assert.strictEqual(first.status, 200);
  await enginePromise;

  // Two browser tabs, two clicks. The second must not write to a closed socket.
  const second = await call(base, `/api/decide?token=${plane.token}`, body);
  assert.strictEqual(second.status, 409, 'deciding twice must be refused, not crash');
  ok('a second decision on the same request is refused cleanly');
}

async function testShutdownDoesNotStrandTheEngine() {
  const { plane } = await startPlane();
  const enginePromise = requestDecision(
    buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'x'),
    { socketPath: plane.socketPath, timeoutMs: 8000 }
  );
  await new Promise(resolve => setTimeout(resolve, 200));

  // Closing the window must not leave an agent hanging until its own timeout.
  await plane.stop();
  const outcome = await enginePromise;
  assert.strictEqual(outcome.decision, 'deny', 'shutdown must refuse anything pending');
  ok('stopping the control plane refuses pending requests instead of stranding them');
}

async function testAuditTailFeedsTheTimeline() {
  const auditPath = path.join(scratch, 'audit.jsonl');
  fs.writeFileSync(auditPath, '');
  const { plane, base } = await startPlane({ auditPaths: [auditPath] });

  fs.appendFileSync(auditPath, `${JSON.stringify({
    ts: new Date().toISOString(), server: 'web1', tool: 'ssh_execute',
    args: { command: 'uptime' }, allowed: true,
  })}\n`);
  // Malformed lines must not stop the reader.
  fs.appendFileSync(auditPath, 'not json at all\n');

  await new Promise(resolve => setTimeout(resolve, 1400));
  const state = await (await call(base, `/api/state?token=${plane.token}`)).json();
  assert.ok(state.timeline.some(e => e.server === 'web1' && e.tool === 'ssh_execute'),
    'an audited action must appear in the timeline without any approval');
  ok('the timeline follows the audit log, and survives a malformed line');
}

async function testUiIsServedWithoutExternalResources() {
  const { plane, base } = await startPlane();
  const res = await call(base, `/?token=${plane.token}`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();

  // The page holds a token that approves root commands: it must not be cached,
  // and must not pull anything from the network.
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html),
    'the page must not load anything from the network');
  assert.ok(res.headers.get('content-security-policy')?.includes("default-src 'none'"),
    'a restrictive CSP must be set');
  ok('the page is served no-store, with a strict CSP and no external resources');
}

async function main() {
  try {
    await testTokenIsRequired();
    await testDnsRebindingIsBlocked();
    await testBindsLoopbackOnly();
    await testDecisionUnblocksTheEngine();
    await testApproval();
    await testDecidingTwiceIsRefused();
    await testShutdownDoesNotStrandTheEngine();
    await testAuditTailFeedsTheTimeline();
    await testUiIsServedWithoutExternalResources();
    console.log(`\n✅ control plane tests passed (${passed} checks)`);
  } finally {
    for (const plane of planes) {
      try { await plane.stop(); } catch { /* already stopped */ }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
