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
import { ControlPlane } from '../src/control-plane.js';
import { requestDecision, buildRequest } from '../src/approval.js';
import { tunnelStatePath } from '../src/tunnel-manager.js';

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
    await testServerManagement();
    await testHealthProbe();
    await testOptionsAndHostKeys();
    await testPublishedTunnels();
    await testAnnouncementSurvivesAColdStart();
    await testPreferencesSurviveARestart();
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
