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
import os from 'os';
import path from 'path';
import http from 'http';
import { ControlPlane, contentDisposition } from '../src/control-plane.js';
import { requestDecision, buildRequest } from '../src/approval.js';
import { tunnelStatePath } from '../src/tunnel-manager.js';
import { streamSocketPath } from '../src/live-stream.js';
import net from 'net';

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

/**
 * Read server-sent events off a raw request until `want` of them arrive or the
 * deadline passes. EventSource is a browser API; this is the same wire format
 * read by hand.
 *
 * @param {number} port - Port to hit
 * @param {string} token - Plane token
 * @param {number} want - How many data frames to wait for
 * @param {number} ms - How long to wait
 * @returns {Promise<{events: any[], close: () => void}>}
 */
function openEventStream(port, token, want, ms) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/events?token=${token}`, method: 'GET' },
      res => {
        /** @type {any[]} */
        const events = [];
        let buffer = '';
        const done = () => resolve({ events, close: () => req.destroy() });
        const timer = setTimeout(done, ms);
        timer.unref?.();
        res.on('data', chunk => {
          buffer += chunk;
          for (const frame of buffer.split('\n\n')) {
            if (!frame.startsWith('data: ')) continue;
            events.push(JSON.parse(frame.slice(6)));
          }
          buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
          if (events.length >= want) { clearTimeout(timer); done(); }
        });
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
  const { plane } = await startPlane();

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

/**
 * Quitting the desktop application awaits stop(), and stop() awaited every
 * connection its servers had accepted — including ones that never end on their
 * own. An MCP engine connected to the approval or live-stream socket kept the
 * application open indefinitely after Quit, which is exactly the situation
 * while an agent is using it. The packaged app hung on quit in two launches
 * out of four before this was fixed.
 */
async function testStopDoesNotWaitOnOpenConnections() {
  const { plane, url } = await startPlane();
  const port = Number(new URL(url).port);
  const connect = target => new Promise((resolve, reject) => {
    const socket = net.connect(target);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
  const approval = await connect(plane.socketPath);   // an engine between requests
  const stream = await connect(streamSocketPath());    // an engine publishing output
  const events = await openEventStream(port, plane.token, 0, 50); // a page, stream still open

  const started = Date.now();
  const outcome = await Promise.race([
    plane.stop().then(() => 'returned'),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 3000)),
  ]);
  const elapsed = Date.now() - started;
  // Disconnect before asserting: if stop() is stuck, this is what lets it
  // finish, so a regression fails here in three seconds instead of hanging
  // the whole suite on the cleanup's second stop().
  for (const socket of [approval, stream]) socket.destroy();
  events.close();
  assert.strictEqual(outcome, 'returned', 'stop() must not wait on connections that never end by themselves');
  ok(`stop() returns with engines connected to both sockets and a page listening (${elapsed} ms)`);
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

  // An entry the engine is still writing. The offset used to move past the
  // half already on disk, so neither half ever parsed and the entry was lost.
  const entry = JSON.stringify({
    ts: new Date().toISOString(), server: 'db2', tool: 'ssh_db_dump', args: {}, allowed: true,
  });
  const half = Math.floor(entry.length / 2);
  fs.appendFileSync(auditPath, entry.slice(0, half));
  await new Promise(resolve => setTimeout(resolve, 1400));
  fs.appendFileSync(auditPath, `${entry.slice(half)}\n`);
  await new Promise(resolve => setTimeout(resolve, 1400));
  const later = await (await call(base, `/api/state?token=${plane.token}`)).json();
  assert.strictEqual(later.timeline.filter(e => e.server === 'db2').length, 1,
    'a line read while half-written must be read once it is complete, exactly once');
  ok('an audit line caught half-written is read once complete, not lost');
}

/** A remote filename becomes a header; it must never break or reject one. */
async function testContentDispositionForRemoteNames() {
  const cases = ['report.pdf', 'q"uote\\back.txt', 'crlf\r\nSet-Cookie: x=1', 'naïve 📄.log', '\u0000\u001f'];
  for (const name of cases) {
    const header = contentDisposition(name);
    assert.doesNotThrow(() => http.validateHeaderValue('content-disposition', header), `header rejected for ${JSON.stringify(name)}`);
    assert.ok(!/[\r\n]/.test(header), 'no line break may survive into a header');
    const quoted = header.match(/filename="([^"]*)"/)[1];
    assert.ok(/^[\x20-\x7e]*$/.test(quoted) && !/["\\]/.test(quoted), `fallback name must be plain ASCII: ${quoted}`);
    const exact = decodeURIComponent(header.match(/filename\*=UTF-8''(.*)$/)[1]);
    assert.strictEqual(exact, name, 'filename* must carry the exact name');
  }
  assert.strictEqual(contentDisposition('report.pdf'), `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  ok('remote filenames make valid Content-Disposition headers, exact name kept in filename*');
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
  assert.ok(res.headers.get('content-security-policy')?.includes('default-src \'none\''),
    'a restrictive CSP must be set');
  ok('the page is served no-store, with a strict CSP and no external resources');
}

async function testServerManagement() {
  // The vault the control plane manages: isolated, file key, never the real one.
  process.env.SSH_MANAGER_KEY_SOURCE = 'file';
  process.env.SSH_MANAGER_HOME = scratch;
  const vaultPath = path.join(scratch, 'managed.json');
  const { plane, base } = await startPlane({ vaultPath });
  const q = `token=${plane.token}`;

  const post = payload => call(base, `/api/servers?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const empty = await (await call(base, `/api/servers?${q}`)).json();
  assert.deepStrictEqual(empty.servers, [], 'a fresh vault must list nothing');
  ok('an empty vault lists no server');

  const created = await post({
    name: 'prod', host: 'prod.internal', user: 'deploy', port: 22,
    password: 'top-secret-42', sudoPassword: 'sudo-99', mode: 'readonly', approval: 'destructive',
  });
  assert.strictEqual(created.status, 200);
  ok('a server can be created from the UI');

  // The most important property of this endpoint: it must never hand a
  // credential back to the page.
  const listed = await (await call(base, `/api/servers?${q}`)).json();
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes('top-secret-42'), 'the password must never reach the page');
  assert.ok(!serialized.includes('sudo-99'), 'the sudo password must never reach the page');
  assert.strictEqual(listed.servers[0].hasPassword, true, 'the page must still know a password is set');
  assert.strictEqual(listed.servers[0].host, 'prod.internal');
  assert.strictEqual(listed.servers[0].mode, 'readonly');
  ok('listing exposes what is set but never a secret value');

  // And the vault really holds them, encrypted.
  const onDisk = fs.readFileSync(vaultPath, 'utf8');
  assert.ok(!onDisk.includes('top-secret-42'), 'the password must be encrypted at rest');
  ok('what the UI saved is encrypted on disk');

  // Editing without resending the password must keep it — the form cannot show
  // a secret, so it must not demand one back.
  const edited = await post({ name: 'prod', host: 'prod.internal', user: 'deploy', port: 2222 });
  assert.strictEqual(edited.status, 200);
  const { ConfigLoader } = await import('../src/config-loader.js');
  const loaded = await new ConfigLoader().load({ envPath: '/nonexistent', tomlPath: '/nonexistent', vaultPath });
  assert.strictEqual(loaded.get('prod').port, 2222, 'the edit must apply');
  assert.strictEqual(loaded.get('prod').password, 'top-secret-42',
    'editing another field must not wipe the stored password');
  ok('editing a server keeps secrets that were not resent');

  for (const bad of [{ host: 'x' }, { name: 'has space', host: 'x' }, { name: 'ok' }]) {
    const res = await post(bad);
    assert.strictEqual(res.status, 400, `must reject ${JSON.stringify(bad)}`);
  }
  ok('a missing name, a bad name and a missing host are all rejected');

  const del = await call(base, `/api/servers?${q}&name=prod`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  const gone = await (await call(base, `/api/servers?${q}`)).json();
  assert.deepStrictEqual(gone.servers, [], 'the server must be gone');
  const missing = await call(base, `/api/servers?${q}&name=prod`, { method: 'DELETE' });
  assert.strictEqual(missing.status, 404, 'deleting twice must 404, not pretend it worked');
  ok('deleting works and is honest about whether it deleted anything');

  // Managing servers is as dangerous as approving commands.
  const noToken = await call(base, '/api/servers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', host: 'y' }),
  });
  assert.strictEqual(noToken.status, 401, 'creating a server without the token must be refused');
  const delNoToken = await call(base, '/api/servers?name=x', { method: 'DELETE' });
  assert.strictEqual(delNoToken.status, 401, 'deleting without the token must be refused');
  ok('server management requires the token, like everything else');
}

async function testHealthProbe() {
  process.env.SSH_MANAGER_KEY_SOURCE = 'file';
  process.env.SSH_MANAGER_HOME = scratch;
  const vaultPath = path.join(scratch, 'health.json');
  const { plane, base } = await startPlane({ vaultPath });
  const q = `token=${plane.token}`;

  const none = await (await call(base, `/api/health?${q}`, { method: 'POST' })).json();
  assert.deepStrictEqual(none.results, [], 'an empty vault must probe nothing rather than error');
  ok('probing with no server returns an empty result, not an error');

  // 203.0.113.x is TEST-NET-3: reserved for documentation, guaranteed not to
  // route anywhere. The probe must report it, not hang or throw.
  plane.store.setServer('ghost', { host: '203.0.113.99', user: 'nobody', password: 'x' });
  plane.store.setServer('ghost2', { host: '203.0.113.98', user: 'nobody', password: 'x' });

  const started = Date.now();
  const res = await call(base, `/api/health?${q}`, { method: 'POST' });
  const body = await res.json();
  const elapsed = Date.now() - started;

  assert.strictEqual(res.status, 200, 'an unreachable server is a result, not an HTTP error');
  assert.strictEqual(body.results.length, 2, 'both servers must be reported');
  for (const result of body.results) {
    assert.strictEqual(result.reachable, false, 'a TEST-NET address cannot be reachable');
    assert.ok(result.error, 'the reason must be reported so the screen can show it');
    assert.ok(typeof result.tookMs === 'number', 'how long it took must be reported');
  }
  ok(`unreachable servers are reported as results, with a reason (${elapsed} ms for two)`);

  // Probed in parallel: two unreachable hosts must not take twice as long as
  // one, or a dashboard over ten servers would be unusable.
  const oneStarted = Date.now();
  await call(base, `/api/health?${q}&name=ghost`, { method: 'POST' });
  const oneElapsed = Date.now() - oneStarted;
  assert.ok(elapsed < oneElapsed * 1.8,
    `two servers (${elapsed} ms) must not cost twice one (${oneElapsed} ms) — probes must run in parallel`);
  ok('servers are probed in parallel, so one slow host does not hold up the rest');

  const named = await (await call(base, `/api/health?${q}&name=ghost`, { method: 'POST' })).json();
  assert.strictEqual(named.results.length, 1, 'naming a server must probe only that one');
  assert.strictEqual(named.results[0].server, 'ghost');
  ok('a single server can be probed by name');

  const noToken = await call(base, '/api/health', { method: 'POST' });
  assert.strictEqual(noToken.status, 401, 'probing must require the token like everything else');
  ok('health probing requires the token');
}

async function testOptionsAndHostKeys() {
  const { plane, base } = await startPlane({ vaultPath: path.join(scratch, 'opts.json') });
  const q = `token=${plane.token}`;

  const res = await call(base, `/api/options?${q}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.groups), 'groups must be an array even when there are none');
  assert.ok(Array.isArray(body.hostKeys), 'hostKeys must be an array even when known_hosts is absent');
  ok('options are served, with empty arrays rather than errors when nothing exists');

  // Forgetting a host key is how a changed-key warning gets silenced, so it
  // must be honest about whether it did anything.
  const missing = await call(base, `/api/hostkey?${q}&host=nothing.invalid&port=22`, { method: 'DELETE' });
  assert.strictEqual(missing.status, 404, 'forgetting an unknown host must 404, not pretend');
  const noHost = await call(base, `/api/hostkey?${q}`, { method: 'DELETE' });
  assert.strictEqual(noHost.status, 400, 'no host named must be rejected');
  ok('forgetting a host key is honest about unknown and missing hosts');

  const noToken = await call(base, '/api/options');
  assert.strictEqual(noToken.status, 401);
  const delNoToken = await call(base, '/api/hostkey?host=x', { method: 'DELETE' });
  assert.strictEqual(delNoToken.status, 401, 'forgetting a host key without the token must be refused');
  ok('options and host-key removal require the token');
}

async function testPublishedTunnels() {
  process.env.SSH_MANAGER_HOME = scratch;
  const { plane, base } = await startPlane({ vaultPath: path.join(scratch, 'tun.json') });
  const q = `token=${plane.token}`;
  // The real path helper, not a hard-coded copy of it: if the location changes,
  // this test must move with it rather than silently testing nothing.
  const statePath = tunnelStatePath();

  const empty = await (await call(base, `/api/options?${q}`)).json();
  assert.deepStrictEqual(empty.tunnels, [], 'no state file means no tunnels');
  assert.strictEqual(empty.tunnelsStale, false, 'a missing file is not stale, it is empty');
  ok('with no published state, no tunnel is shown and nothing is called stale');

  // A live engine publishing two tunnels: this process is alive, so they count.
  fs.writeFileSync(statePath, JSON.stringify({
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    tunnels: [
      { id: 't1', serverName: 'prod', type: 'local', localPort: 8080, state: 'open' },
      { id: 't2', serverName: 'db1', type: 'socks', localPort: 1080, state: 'open' },
    ],
  }));
  const live = await (await call(base, `/api/options?${q}`)).json();
  assert.strictEqual(live.tunnels.length, 2, 'tunnels published by a running process must be shown');
  assert.strictEqual(live.tunnelsStale, false);
  ok('tunnels published by a running engine are shown');

  // The case that matters: the engine died and left its file behind. Showing
  // those as open would tell an operator a port is forwarded when it is not.
  fs.writeFileSync(statePath, JSON.stringify({
    pid: 999999, // not a running process
    updatedAt: new Date().toISOString(),
    tunnels: [{ id: 't3', serverName: 'prod', type: 'local', localPort: 8080, state: 'open' }],
  }));
  const stale = await (await call(base, `/api/options?${q}`)).json();
  assert.deepStrictEqual(stale.tunnels, [], 'a stale file must yield no tunnels');
  assert.strictEqual(stale.tunnelsStale, true, 'and must say so, rather than looking empty');
  ok('a state file left by a dead process is reported stale, never shown as open');

  fs.writeFileSync(statePath, 'not json at all');
  const broken = await (await call(base, `/api/options?${q}`)).json();
  assert.deepStrictEqual(broken.tunnels, [], 'an unreadable file must not break the options screen');
  ok('an unreadable state file degrades to no tunnels');
  fs.rmSync(statePath, { force: true });
}

/**
 * A file dropped on a *cold* Dock icon launches the application, so the shell
 * announces it a second or two before the interface has a stream open. Sending
 * it to nobody and moving on lost the drop entirely — reproduced on the
 * packaged 4.0.0: warm drops opened the dialog, cold ones vanished.
 */
async function testAnnouncementSurvivesAColdStart() {
  const { plane, url } = await startPlane();
  const port = Number(new URL(url).port);

  // Nobody is listening yet — this is the cold start.
  plane.announce({ type: 'dropped-files', paths: ['/tmp/runbook.md'] });
  assert.strictEqual(plane.subscribers.size, 0, 'no page should be connected yet');

  const first = await openEventStream(port, plane.token, 1, 2000);
  assert.deepStrictEqual(
    first.events,
    [{ type: 'dropped-files', paths: ['/tmp/runbook.md'] }],
    'the first page to connect must be handed what it missed'
  );
  ok('an announcement made before any page exists reaches the first one that opens');

  // Once delivered it is gone: opening a second window must not re-ask.
  const second = await openEventStream(port, plane.token, 1, 400);
  assert.deepStrictEqual(second.events, [], 'a held event must be delivered once, not replayed');
  ok('a held announcement is handed over once, not to every page that opens');
  second.close();

  // And with somebody listening, nothing is held back for later.
  plane.announce({ type: 'dropped-files', paths: ['/tmp/notes.txt'] });
  assert.strictEqual(plane.undelivered.length, 0, 'a delivered event must not also be buffered');
  const third = await openEventStream(port, plane.token, 1, 400);
  assert.deepStrictEqual(third.events, [], 'nothing should be waiting once a page is connected');
  ok('an announcement with a page connected is not also queued for the next one');
  third.close();
  first.close();
}

/**
 * What the interface remembers about itself.
 *
 * It cannot use `localStorage`: the plane binds port 0, so the page's origin is
 * a different `http://127.0.0.1:<port>` on every launch and browser storage is
 * scoped to an origin. Everything was silently forgotten each time — the
 * introduction came back however carefully it had been finished.
 */
async function testPreferencesSurviveARestart() {
  const vaultPath = path.join(scratch, 'prefs-vault.json');
  const first = await startPlane({ vaultPath });
  const q = `token=${first.plane.token}`;

  const empty = await (await call(first.base, `/api/preferences?${q}`)).json();
  assert.deepStrictEqual(empty.preferences, {}, 'a first run has no preferences, not an error');

  const saved = await call(first.base, `/api/preferences?${q}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 'ssh-manager.wizard-seen': 'true' }),
  });
  assert.strictEqual(saved.status, 200, 'saving a preference must succeed');

  // A second screen remembering something else must not erase the first.
  await call(first.base, `/api/preferences?${q}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 'ssh-manager.theme': 'dark' }),
  });

  // A different plane, on a different port — which is exactly what the next
  // launch of the application is.
  const second = await startPlane({ vaultPath });
  assert.notStrictEqual(second.base, first.base, 'the second plane must be on another port, or this proves nothing');
  const carried = await (await call(second.base, `/api/preferences?token=${second.plane.token}`)).json();
  assert.deepStrictEqual(
    carried.preferences,
    { 'ssh-manager.wizard-seen': 'true', 'ssh-manager.theme': 'dark' },
    'preferences must survive a restart on a different port, and merge rather than replace'
  );
  ok('preferences survive a restart on a different port, and one screen does not erase another');

  const noToken = await call(second.base, '/api/preferences');
  assert.strictEqual(noToken.status, 401, 'reading preferences must require the token');
  const badBody = await call(second.base, `/api/preferences?token=${second.plane.token}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(['not', 'an', 'object']),
  });
  assert.strictEqual(badBody.status, 400, 'an array is not a set of preferences');
  ok('preferences require the token and refuse anything that is not an object');
}

/**
 * A stand-in for desktop-install.js: an installer that reports progress, waits
 * for the test to let it finish, and an `open` that records what it opened.
 *
 * @param {{installed?: boolean, supported?: boolean, method?: string|null, platform?: string, failWith?: string}} [options]
 */
function fakeDesktop({ installed = false, supported = true, method = 'auto', platform = 'darwin', failWith = '' } = {}) {
  const app = '/Applications/SSH Manager.app';
  let state = { supported, installed, path: installed ? app : null, version: installed ? '4.0.0' : null, method };
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  const calls = { install: 0, /** @type {{path: string, planeListening: boolean}[]} */ open: [] };
  /** @type {ControlPlane|null} */
  let plane = null;
  return {
    calls,
    release: () => release(),
    watch: (/** @type {ControlPlane} */ p) => { plane = p; },
    hooks: {
      status: () => ({ ...state }),
      install: async ({ onProgress }) => {
        calls.install++;
        onProgress({ phase: 'manifest', received: 0, total: 0 });
        onProgress({ phase: 'download', received: 0, total: 1000, file: 'SSH-Manager-4.0.0-arm64.zip' });
        await gate;
        if (failWith) throw new Error(failWith);
        onProgress({ phase: 'download', received: 1000, total: 1000, file: 'SSH-Manager-4.0.0-arm64.zip' });
        onProgress({ phase: 'verify', received: 1000, total: 1000, passed: 'sha256' });
        onProgress({ phase: 'install', received: 1000, total: 1000 });
        state = { ...state, installed: true, path: app, version: '4.0.0' };
        return { path: app, version: '4.0.0' };
      },
      open: async ({ path: target }) => {
        calls.open.push({ path: target, planeListening: Boolean(plane?.httpServer?.listening) });
      },
      running: async () => false,
      platform,
    },
  };
}

/** Resolve once a page's event stream is attached, so nothing is missed. */
async function subscribed(plane) {
  for (let i = 0; i < 100 && plane.subscribers.size === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
}

async function testDesktopEndpointsAbsentUnlessOffered() {
  const { plane, base } = await startPlane();
  const q = `token=${plane.token}`;
  for (const [method, route] of [['GET', '/api/desktop'], ['POST', '/api/desktop/install'], ['POST', '/api/desktop/open']]) {
    const response = await call(base, `${route}?${q}`, { method });
    assert.strictEqual(response.status, 404, `${method} ${route} must not exist unless the plane offers the app`);
  }
  const options = await (await call(base, `/api/options?${q}`)).json();
  assert.strictEqual(options.offerDesktop, false, 'the page must be told there is nothing to offer');
  ok('without offerDesktop (the desktop app itself, any embedder) the desktop endpoints do not exist');
}

async function testDesktopInstallStreamsProgressThenHandsOver() {
  const fake = fakeDesktop();
  /** @type {() => void} */
  let handedOver = () => {};
  const stopped = new Promise(resolve => { handedOver = () => resolve(undefined); });
  const { plane, base, url } = await startPlane({ offerDesktop: true, desktop: fake.hooks, handoverMs: 50, onHandover: () => handedOver() });
  fake.watch(plane);
  const port = Number(new URL(url).port);
  const q = `token=${plane.token}`;

  const options = await (await call(base, `/api/options?${q}`)).json();
  assert.strictEqual(options.offerDesktop, true);
  const before = await (await call(base, `/api/desktop?${q}`)).json();
  assert.deepStrictEqual(
    { supported: before.supported, installed: before.installed, method: before.method, installing: before.installing, phase: before.phase, error: before.error },
    { supported: true, installed: false, method: 'auto', installing: false, phase: null, error: null }
  );
  assert.strictEqual(before.engineVersion, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  ok('GET /api/desktop: the status, the engine version, and no installation running');

  for (const route of ['/api/desktop', '/api/desktop/install', '/api/desktop/open']) {
    const response = await call(base, route, { method: route === '/api/desktop' ? 'GET' : 'POST' });
    assert.strictEqual(response.status, 401, `${route} must require the token like everything else`);
  }
  ok('the desktop endpoints require the token');

  const stream = openEventStream(port, plane.token, 7, 5000);
  await subscribed(plane);
  const accepted = await call(base, `/api/desktop/install?${q}`, { method: 'POST' });
  assert.strictEqual(accepted.status, 202, 'the install starts in the background');
  const again = await call(base, `/api/desktop/install?${q}`, { method: 'POST' });
  assert.strictEqual(again.status, 409, 'one installation at a time');
  const opening = await call(base, `/api/desktop/open?${q}`, { method: 'POST' });
  assert.strictEqual(opening.status, 409, 'nothing to open while it installs');
  const during = await (await call(base, `/api/desktop?${q}`)).json();
  assert.strictEqual(during.installing, true);
  assert.strictEqual(during.phase, 'download');
  assert.strictEqual(during.total, 1000, 'a page opened mid-download can draw the bar');
  assert.strictEqual(fake.calls.install, 1);
  ok('POST /api/desktop/install answers 202, and a second one while it runs is a 409');

  fake.release();
  const { events } = await stream;
  const desktop = events.filter(event => event.type === 'desktop');
  assert.deepStrictEqual(desktop.map(event => event.phase),
    ['manifest', 'download', 'download', 'verify', 'install', 'open', 'handover']);
  for (const event of desktop) {
    assert.strictEqual(typeof event.received, 'number');
    assert.strictEqual(typeof event.total, 'number');
  }
  assert.deepStrictEqual(desktop[2], { phase: 'download', received: 1000, total: 1000, file: 'SSH-Manager-4.0.0-arm64.zip', type: 'desktop' });
  assert.strictEqual(desktop[3].passed, 'sha256');
  assert.strictEqual(desktop[6].stopsInMs, 50);
  assert.match(desktop[6].message, /Continued in the desktop app/);
  ok('progress reaches the page as {type: "desktop", phase, received, total}, ending with the hand-over');

  await stopped;
  assert.deepStrictEqual(fake.calls.open, [{ path: '/Applications/SSH Manager.app', planeListening: true }],
    'on macOS the app is opened first, while this plane still runs');
  assert.strictEqual(plane.httpServer.listening, false, 'the plane stops itself after the hand-over');
  ok('after installing, the app is opened and the browser control plane stops itself a moment later');
}

async function testDesktopInstallFailureIsReported() {
  const fake = fakeDesktop({ failWith: 'SHA-256 does not match release v4.0.0: nothing was installed' });
  const { plane, base, url } = await startPlane({ offerDesktop: true, desktop: fake.hooks, handoverMs: 50 });
  const port = Number(new URL(url).port);
  const q = `token=${plane.token}`;

  const stream = openEventStream(port, plane.token, 3, 5000);
  await subscribed(plane);
  assert.strictEqual((await call(base, `/api/desktop/install?${q}`, { method: 'POST' })).status, 202);
  fake.release();
  const { events } = await stream;
  assert.deepStrictEqual(events.at(-1), {
    phase: 'error', error: 'SHA-256 does not match release v4.0.0: nothing was installed', type: 'desktop', received: 0, total: 1000,
  });
  const after = await (await call(base, `/api/desktop?${q}`)).json();
  assert.strictEqual(after.installing, false);
  assert.strictEqual(after.phase, 'error');
  assert.match(after.error, /SHA-256/);
  assert.deepStrictEqual(fake.calls.open, [], 'nothing is opened after a failure');
  assert.strictEqual(plane.httpServer.listening, true, 'and the browser control plane keeps running');
  assert.strictEqual((await call(base, `/api/desktop/install?${q}`, { method: 'POST' })).status, 202, 'a failure can be retried');
  ok('a failed install is reported on the stream and in GET /api/desktop; the plane stays up and can retry');
}

async function testDesktopRefusalsWithoutAnInstaller() {
  const terminal = fakeDesktop({ method: 'terminal' });
  const deb = await startPlane({ offerDesktop: true, desktop: terminal.hooks });
  const refused = await call(deb.base, `/api/desktop/install?token=${deb.plane.token}`, { method: 'POST' });
  assert.strictEqual(refused.status, 400);
  assert.deepStrictEqual(
    (({ method, command }) => ({ method, command }))(await refused.json()),
    { method: 'terminal', command: 'ssh-manager app' }
  );
  assert.strictEqual(terminal.calls.install, 0);
  ok('the .deb route (sudo) is refused from the page and points to `ssh-manager app`');

  const none = fakeDesktop({ supported: false, method: null });
  const other = await startPlane({ offerDesktop: true, desktop: none.hooks });
  const unsupported = await call(other.base, `/api/desktop/install?token=${other.plane.token}`, { method: 'POST' });
  assert.strictEqual(unsupported.status, 400);
  assert.match((await unsupported.json()).releases, /github\.com\/bvisible\/mcp-ssh-manager\/releases/);
  const notInstalled = await call(other.base, `/api/desktop/open?token=${other.plane.token}`, { method: 'POST' });
  assert.strictEqual(notInstalled.status, 409, 'nothing to open when nothing is installed');
  ok('an unsupported platform gets the releases page, and opening an app that is not installed is a 409');
}

async function testDesktopOpenHandsOver() {
  const fake = fakeDesktop({ installed: true });
  /** @type {() => void} */
  let handedOver = () => {};
  const stopped = new Promise(resolve => { handedOver = () => resolve(undefined); });
  const { plane, base } = await startPlane({ offerDesktop: true, desktop: fake.hooks, handoverMs: 400, onHandover: () => handedOver() });
  fake.watch(plane);
  const opened = await call(base, `/api/desktop/open?token=${plane.token}`, { method: 'POST' });
  assert.strictEqual(opened.status, 200);
  assert.deepStrictEqual(await opened.json(), { ok: true, stopsInMs: 400 });
  // A page that asks again — or asks to open after an install that already
  // hands over by itself — is told it is under way, and nothing opens twice.
  const again = await call(base, `/api/desktop/open?token=${plane.token}`, { method: 'POST' });
  assert.strictEqual(again.status, 200);
  const { stopsInMs } = await again.json();
  assert.ok(stopsInMs >= 0 && stopsInMs <= 400, 'the time left before the plane stops');
  await stopped;
  assert.strictEqual(fake.calls.install, 0, 'opening never downloads');
  assert.deepStrictEqual(fake.calls.open, [{ path: '/Applications/SSH Manager.app', planeListening: true }]);
  assert.strictEqual(plane.httpServer.listening, false);
  ok('POST /api/desktop/open opens the installed app once, even when asked twice, then the plane stops itself');

  // A Windows named pipe cannot be bound twice: the plane must let go first.
  const windows = fakeDesktop({ installed: true, platform: 'win32' });
  let windowsDone = () => {};
  const windowsStopped = new Promise(resolve => { windowsDone = () => resolve(undefined); });
  const second = await startPlane({ offerDesktop: true, desktop: windows.hooks, handoverMs: 50, onHandover: () => windowsDone() });
  windows.watch(second.plane);
  assert.strictEqual((await call(second.base, `/api/desktop/open?token=${second.plane.token}`, { method: 'POST' })).status, 200);
  assert.deepStrictEqual(windows.calls.open, [], 'on Windows nothing is opened while the plane holds the pipe');
  await windowsStopped;
  assert.deepStrictEqual(windows.calls.open, [{ path: '/Applications/SSH Manager.app', planeListening: false }]);
  ok('on Windows the plane stops first and opens the app after, freeing the pipe the app needs');
}

/**
 * The hand-over in practice: the desktop application binds the approval socket
 * while `ssh-manager control` still runs, then the browser control plane stops.
 * stop() used to unlink whatever was at its socket path — by then the
 * application's socket — leaving the application listening where no engine
 * could find it.
 */
async function testStopLeavesAnotherPlanesSocket() {
  const socketPath = path.join(scratch, 'shared.sock');
  const browser = await startPlane({ socketPath });
  const app = await startPlane({ socketPath });
  await browser.plane.stop();
  assert.ok(fs.statSync(socketPath).isSocket(), 'the second plane\'s approval socket must survive the first one stopping');
  assert.ok(fs.statSync(streamSocketPath()).isSocket(), 'and so must its live-stream socket');

  const enginePromise = requestDecision(
    buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'uptime'),
    { socketPath, timeoutMs: 5000 }
  );
  await new Promise(resolve => setTimeout(resolve, 200));
  const state = await (await call(app.base, `/api/state?token=${app.plane.token}`)).json();
  assert.strictEqual(state.pending.length, 1, 'an engine must still reach the plane that took over');
  await call(app.base, `/api/decide?token=${app.plane.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: state.pending[0].id, decision: 'allow' }),
  });
  assert.strictEqual((await enginePromise).decision, 'allow');

  await app.plane.stop();
  assert.strictEqual(fs.existsSync(socketPath), false, 'a plane still removes its own socket when it stops');
  ok('stopping a control plane leaves a socket another plane has since bound at the same path');
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
    await testStopDoesNotWaitOnOpenConnections();
    await testAuditTailFeedsTheTimeline();
    await testContentDispositionForRemoteNames();
    await testUiIsServedWithoutExternalResources();
    await testServerManagement();
    await testHealthProbe();
    await testOptionsAndHostKeys();
    await testPublishedTunnels();
    await testAnnouncementSurvivesAColdStart();
    await testPreferencesSurviveARestart();
    await testDesktopEndpointsAbsentUnlessOffered();
    await testDesktopInstallStreamsProgressThenHandsOver();
    await testDesktopInstallFailureIsReported();
    await testDesktopRefusalsWithoutAnInstaller();
    await testDesktopOpenHandsOver();
    await testStopLeavesAnotherPlanesSocket();
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
