#!/usr/bin/env node
/**
 * Does finishing the introduction actually finish it?
 *
 * The complaint was that the wizard came back on every launch. The cause is
 * that the control plane binds port 0, so the page is served from a different
 * `http://127.0.0.1:<port>` each time and `localStorage` — which is scoped to
 * an origin — starts empty. Preferences now live in the control plane, and this
 * proves it end to end rather than by inspection:
 *
 *   1. a plane on one port, with an empty vault directory
 *   2. the introduction is on screen
 *   3. close it
 *   4. a *second* plane, deliberately on another port, same directory
 *   5. the introduction must not come back
 *
 * Step 4 is the whole test. Restarting on the same port would prove nothing,
 * because that is the case that already worked.
 *
 * Chrome's --headless does not return on macOS 27 / Chrome 152, so this uses a
 * real window on a scratch profile. It takes focus for a few seconds.
 *
 * Usage: node scripts/test-preferences-persist.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { ControlPlane } from '../src/control-plane.js';

/* global WebSocket */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9344;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Devtools {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    });
  }

  static async connect(target) {
    const ws = new WebSocket(target);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('cannot reach Chrome')), { once: true });
    });
    return new Devtools(ws);
  }

  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }
}

async function targetUrl() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome never opened its debugging port');
}

/** Is the introduction on screen? Matched on its own words, not a class name. */
const WIZARD_SHOWN = `Boolean([...document.querySelectorAll('h2, h3, p, div')]
  .some(el => el.textContent?.trim() === 'You give your agents a shell'))`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
const planes = [];
let chrome = null;
let failures = 0;

function check(condition, label) {
  console.log(`  ${condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!condition) failures += 1;
}

async function startPlane() {
  const plane = new ControlPlane({
    socketPath: path.join(scratch, `p${planes.length}.sock`),
    port: 0,
    vaultPath: path.join(scratch, 'vault.json'),
  });
  planes.push(plane);
  const { url } = await plane.start();
  return { plane, url };
}

try {
  process.env.SSH_MANAGER_KEY_SOURCE = 'file';

  const first = await startPlane();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-profile-'));
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-features=Translate',
    '--window-size=1200,820',
    'about:blank',
  ], { stdio: 'ignore' });

  const cdp = await Devtools.connect(await targetUrl());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url: first.url });
  await sleep(2500);
  check(await cdp.evaluate(WIZARD_SHOWN), 'a first run shows the introduction');

  // Its close button, which is also what "Finish" ends up calling.
  await cdp.evaluate(`document.querySelector('button[aria-label="Close"]').click()`);
  await sleep(600);
  check(!(await cdp.evaluate(WIZARD_SHOWN)), 'closing it takes it off screen');

  const file = path.join(scratch, 'preferences.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  check(saved['ssh-manager.wizard-seen'] === 'true',
    `the choice reaches the control plane's file (${JSON.stringify(saved)})`);

  // The launch after. A different port, which is the whole point.
  await first.plane.stop();
  const second = await startPlane();
  check(new URL(second.url).port !== new URL(first.url).port,
    `the second plane is on another port (${new URL(first.url).port} → ${new URL(second.url).port}), or this proves nothing`);

  await cdp.send('Page.navigate', { url: second.url });
  await sleep(2500);
  check(!(await cdp.evaluate(WIZARD_SHOWN)), 'the introduction does NOT come back on the next launch');

  // And prove it is the control plane doing it, not storage. Emptying this
  // origin's localStorage and reloading leaves only one place the answer can
  // come from — if the introduction stays away, it came over HTTP.
  await cdp.evaluate('localStorage.clear()');
  await cdp.send('Page.navigate', { url: second.url });
  await sleep(2500);
  check(!(await cdp.evaluate(WIZARD_SHOWN)),
    'and stays away with localStorage emptied, so it is the control plane answering');
} finally {
  for (const plane of planes) {
    try { await plane.stop(); } catch { /* already stopped */ }
  }
  chrome?.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n✅ preferences persist across a restart' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
