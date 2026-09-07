#!/usr/bin/env node
/**
 * Take the README screenshots, the same way every time.
 *
 * Screenshots rot: a rail gets an item, a colour changes, and the pictures
 * quietly describe a version nobody is running. They also leak — an early set
 * in this repo had to be thrown away because it showed the author's real home
 * directory in the file browser. Both problems come from screenshots being
 * taken by hand.
 *
 * So this drives a real Chrome over the DevTools protocol against
 * scripts/demo-env.mjs, at a fixed viewport and deviceScaleFactor 2, and writes
 * PNGs whose only inputs are the demo personas. Re-running it after a UI change
 * regenerates the whole set.
 *
 * Two variants per view, because the product genuinely runs two ways:
 *
 *   browser  a tab on the local control plane
 *   app      the packaged desktop build, which appends `?shell=macos`; the rail
 *            then leaves room at the top for the window buttons
 *
 * The window frames are drawn afterwards by scripts/frame-screenshots.py.
 *
 * Chrome's --headless does not return on macOS 27 / Chrome 152, so this uses a
 * real window on a scratch profile instead. It steals focus for a few seconds.
 *
 * Usage:
 *   node scripts/demo-env.mjs --port 7315 &        # in another shell
 *   node scripts/capture-screenshots.mjs <url-with-token>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

// Node has had a global WebSocket since 22; the shared eslint env predates it.
/* global WebSocket */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docs', 'images', '.raw');
const PORT = 9333;
const WIDTH = 1440;
const HEIGHT = 880;

/**
 * The views worth showing, and how to reach each one.
 *
 * The interface keeps the current view in a store, not in the URL, so these
 * click rather than navigate. Matching on the rail item's own text means a
 * renamed view breaks the capture loudly instead of silently re-shooting the
 * server list five times.
 */
// The count badge is inside the button, so its textContent is 'Waiting1' the
// moment anything is pending — an exact match silently re-shot the server list.
// Matched on the accessible name, not the visible text: the rail is collapsed
// by default now, so its items show an icon and nothing else. The old text
// match found nothing and the capture died on the second view.
const rail = label =>
  `(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]');`
  + ` if (!b) throw new Error('no rail item ' + ${JSON.stringify(label)}); b.click(); })()`;

const VIEWS = [
  { name: 'v4-servers', reach: 'null', settle: 1200 },
  { name: 'v4-terminal', reach: rail('Terminal'), settle: 1400 },
  { name: 'v4-waiting', reach: rail('Waiting'), settle: 1200 },
  // Health probes when asked, so the screenshot needs the button pressed as well
  // as the view opened — otherwise it is a picture of 'Nothing probed yet'.
  { name: 'v4-health',
    reach: rail('Health') + '; await new Promise(r => setTimeout(r, 600));' +
      '[...document.querySelectorAll(\'button\')].find(b => /Check every server/.test(b.textContent))?.click()',
    settle: 8000, awaitPromise: true },
  // The output lives behind a disclosure row; a collapsed Live view shows a
  // command name and nothing of what makes the screen worth having.
  { name: 'v4-live',
    reach: rail('Live') + '; await new Promise(r => setTimeout(r, 800));' +
      '[...document.querySelectorAll(\'button\')]' +
      '.find(b => b.textContent.includes(\'tail -f\')).click()',
    settle: 1800, awaitPromise: true },
  // Not a rail item: the browser opens from a server card. The second one is
  // `production`, which has the deepest tree in the demo.
  { name: 'v4-files',
    reach: 'document.querySelectorAll(\'[aria-label="Browse files"]\')[1]?.click() ?? null',
    settle: 3500 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A minimal CDP client: one socket, numbered commands, awaited replies. */
class Devtools {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      }
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
}

async function targetUrl() {
  // Chrome takes a moment to open the port after launch.
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

async function main() {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: node scripts/capture-screenshots.mjs <control-plane-url-with-token>');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-profile-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-features=Translate',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const cdp = await Devtools.connect(await targetUrl());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // The viewport, not the window: no chrome, no scrollbar, and 2x so the PNG
  // survives being shown at half size on a high-density display.
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });

  for (const variant of ['browser', 'app']) {
    const url = variant === 'app'
      ? base + (base.includes('?') ? '&' : '?') + 'shell=macos'
      : base;
    for (const view of VIEWS) {
      // Reload for each view: clicking from a known starting point beats
      // unwinding whatever the previous view left open.
      await cdp.send('Page.navigate', { url });
      await sleep(1500);
      const { exceptionDetails } = await cdp.send('Runtime.evaluate', {
        expression: view.awaitPromise ? `(async () => { ${view.reach} })()` : view.reach,
        awaitPromise: Boolean(view.awaitPromise),
      });
      if (exceptionDetails) throw new Error(`${view.name}: ${exceptionDetails.text}`);
      await sleep(view.settle);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${view.name}-${variant}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  ${path.basename(file).padEnd(30)} ${(fs.statSync(file).size / 1024).toFixed(0)} Ko`);
    }
  }

  chrome.kill();
  // Chrome keeps writing to its profile for a moment after the signal; removing
  // it immediately races and throws ENOTEMPTY on a run that otherwise worked.
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
