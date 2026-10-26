// The desktop application's own updates, as the control plane offers them to the
// window: GET /api/app-update and the three things a person can do about it
// (check, download, install), with the changes pushed on the event stream.
//
// The application's main process hands the control plane a provider. Here a
// stand-in plays it; nothing is downloaded and nothing restarts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ControlPlane } from '../src/control-plane.js';

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const home = fs.mkdtempSync('/tmp/au-');
process.env.SSH_MANAGER_HOME = home;
process.env.SSH_MANAGER_KEY_SOURCE = 'file';

function fakeUpdates(initial = {}) {
  let state = { currentVersion: '4.0.0-beta.3', status: 'idle', channel: 'preview', ...initial };
  const listeners = new Set();
  const calls = [];
  const set = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
  return {
    calls, listeners, set,
    snapshot: () => state,
    check: async () => { calls.push('check'); set({ status: 'available', version: '4.1.0', checkedAt: '2026-10-26T10:00:00.000Z' }); },
    download: async () => { calls.push('download'); set({ status: 'downloading', percent: 50 }); set({ status: 'ready', percent: 100 }); },
    install: () => { calls.push('install'); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

async function start(options = {}) {
  const plane = new ControlPlane({ socketPath: path.join(home, `p${Math.random().toString(36).slice(2, 6)}.sock`), port: 0, auditPaths: [], vaultPath: path.join(home, 'vault.json'), ...options });
  const { url } = await plane.start();
  const base = new URL(url);
  const call = (route, init) => fetch(`${base.origin}${route}?${base.searchParams}`, init);
  return { plane, base, call };
}

try {
  // ── outside the application ─────────────────────────────────────────────
  {
    const { plane, call } = await start();
    assert.equal((await call('/api/app-update')).status, 404);
    assert.equal((await call('/api/app-update/check', { method: 'POST' })).status, 404);
    await plane.stop();
  }
  ok('without an application behind it (a browser tab, ssh-manager control) the endpoints do not exist');

  // ── inside it ───────────────────────────────────────────────────────────
  const updates = fakeUpdates();
  const { plane, base, call } = await start({ appUpdates: updates });
  try {
    assert.equal((await fetch(`${base.origin}/api/app-update`)).status, 401, 'token required like every other endpoint');
    let response = await call('/api/app-update');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { currentVersion: '4.0.0-beta.3', status: 'idle', channel: 'preview' });
    ok('GET reports the running version, the state and the channel, and needs the token');

    // Refused before anything happens: nothing to download, nothing to install.
    for (const action of ['download', 'install']) {
      response = await call(`/api/app-update/${action}`, { method: 'POST' });
      assert.equal(response.status, 409, action);
    }
    assert.deepEqual(updates.calls, [], 'a refused action never reaches the application');
    ok('download and install are refused (409) until there is an update to act on');

    response = await call('/api/app-update/check', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(updates.calls, ['check']);
    const found = await response.json();
    assert.equal(found.status, 'available');
    assert.equal(found.version, '4.1.0');
    ok('check asks the application and answers with what it found');

    // The event stream: a change nobody asked for (a background check finding
    // something) must reach an open window.
    const controller = new AbortController();
    const stream = await call('/api/events', { signal: controller.signal });
    const reader = stream.body.getReader();
    const events = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const line = frame.split('\n').find(row => row.startsWith('data:'));
            if (line) { try { events.push(JSON.parse(line.slice(5))); } catch { /* a comment frame */ } }
          }
        }
      } catch { /* aborted below */ }
    })();
    await pause(100);
    updates.set({ status: 'downloading', percent: 40 });
    await pause(150);
    const pushed = events.find(event => event.type === 'app-update' && event.status === 'downloading');
    assert.ok(pushed, `the change is pushed on the stream (saw ${JSON.stringify(events.map(e => e.type))})`);
    assert.equal(pushed.percent, 40);
    assert.equal(pushed.currentVersion, '4.0.0-beta.3');
    controller.abort();
    await reading;
    ok('a change made by the application reaches an open window on the event stream');

    updates.set({ status: 'available', percent: 0 });
    response = await call('/api/app-update/download', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ready');
    assert.ok(updates.calls.includes('download'));
    ok('download runs once an update is on offer and answers with the final state');

    response = await call('/api/app-update/install', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, restarting: true });
    assert.ok(!updates.calls.includes('install'), 'the answer goes out before the application quits');
    await pause(400);
    assert.ok(updates.calls.includes('install'));
    ok('install answers first, then asks the application to quit and install');

    // A provider that fails: the window gets the reason and the current state.
    updates.check = async () => { throw new Error('Updates are turned off in this build'); };
    response = await call('/api/app-update/check', { method: 'POST' });
    assert.equal(response.status, 500);
    const failure = await response.json();
    assert.match(failure.error, /turned off/);
    assert.equal(failure.snapshot.currentVersion, '4.0.0-beta.3');
    ok('a failing check is reported with its reason and the state it left');

    assert.equal((await call('/api/app-update/uninstall', { method: 'POST' })).status, 404);
    ok('only the three actions exist');
  } finally {
    await plane.stop();
  }
  assert.equal(updates.listeners.size, 0, 'stopping the control plane unsubscribes from the application');
  ok('stopping the control plane stops listening to the application');

  console.log(`\n✅ application update tests passed (${passed} checks)`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
}
