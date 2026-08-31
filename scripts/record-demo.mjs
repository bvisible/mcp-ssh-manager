#!/usr/bin/env node
/**
 * Record the control plane doing its job, as a video.
 *
 * The screenshots show what the screens look like. They cannot show the thing
 * the product is actually for: an agent asking to run `rm -rf` on production,
 * and a person stopping it. That is a sequence, so it needs to move.
 *
 * Same rig as the screenshots — a real Chrome over the DevTools protocol,
 * driven against scripts/demo-env.mjs — so the recording has the same property
 * that matters: nothing in it is staged in a video editor. Every frame is the
 * product responding to a click.
 *
 * Frames are pulled at a fixed cadence with Page.captureScreenshot rather than
 * pushed by Page.startScreencast. The screencast only emits on visual change
 * and proved wildly unreliable here — two identical runs produced 1111 frames
 * and 22 — which is not something to discover after publishing a video. Pulling
 * costs more per frame and yields a timeline we choose.
 *
 * Outputs:
 *   docs/videos/control-plane.mp4    full size, for linking
 *   docs/images/control-plane.gif    downscaled and animated, for the README
 *
 * Usage:
 *   node scripts/demo-env.mjs --port 7315 &
 *   node scripts/record-demo.mjs <url-with-token>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';

// Node has had a global WebSocket since 22; the shared eslint env predates it.
/* global WebSocket */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 9334;
const WIDTH = 1440;
const HEIGHT = 880;
/** Capture cadence. Ten a second is smooth enough for an interface and cheap. */
const FPS = 10;
const FRAME_MS = 1000 / FPS;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The story, in order.
 *
 * `do` is evaluated in the page; `hold` is how long to sit on the result. The
 * holds are long by software-demo standards on purpose — a reader needs time to
 * read a command before watching somebody refuse it.
 */
const click = text =>
  '(() => { const b = [...document.querySelectorAll(\'button\')]' +
  `.find(b => b.textContent.trim().replace(/\\d+$/, '') === ${JSON.stringify(text)}` +
  ` || b.textContent.includes(${JSON.stringify(text)}));` +
  ` if (!b) throw new Error('nothing to click: ' + ${JSON.stringify(text)}); b.click(); })()`;

const SCENES = [
  { name: 'the servers you gave it', act: null, hold: 2600 },
  { name: 'something is waiting', act: click('Waiting'), hold: 3800 },
  { name: 'refuse it', act: click('Refuse'), hold: 2600 },
  { name: 'watch one run', act: click('Live'), hold: 900 },
  { name: 'open the output', act: click('tail -f'), hold: 3600 },
  { name: 'both filesystems', act: click('Health'), hold: 200 },
  { name: 'probe on demand', act: click('Check every server'), hold: 7000 },
  { name: 'back to the servers', act: click('Servers'), hold: 1800 },
];

/** A minimal CDP client: one socket, numbered commands, awaited replies. */
class Devtools {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method) {
        for (const fn of this.listeners.get(message.method) || []) fn(message.params);
        return;
      }
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

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
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

async function main() {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: node scripts/record-demo.mjs <control-plane-url-with-token>');
    process.exit(1);
  }

  const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-frames-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'record-profile-'));
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
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  // Deliberately *not* `?shell=macos`. That mode reserves 28px at the top of
  // the rail for window buttons the desktop app draws over the content — right
  // for a screenshot that gets a window frame composited around it, wrong here,
  // where the video is shown edge to edge and the reserved strip reads as a
  // layout bug with nothing in it.
  await cdp.send('Page.navigate', { url: base });
  await sleep(2500);

  let shot = 0;
  let recording = true;
  // One capture in flight at a time: a slow frame delays the next tick rather
  // than queueing a second request behind it.
  const ticker = (async () => {
    while (recording) {
      const started = Date.now();
      try {
        const { data } = await cdp.send('Page.captureScreenshot',
          { format: 'jpeg', quality: 88, captureBeyondViewport: false });
        fs.writeFileSync(path.join(frames, `f${String(shot++).padStart(5, '0')}.jpg`),
          Buffer.from(data, 'base64'));
      } catch { /* the page is navigating; the next tick will get it */ }
      await sleep(Math.max(0, FRAME_MS - (Date.now() - started)));
    }
  })();

  for (const scene of SCENES) {
    if (scene.act) {
      const { exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: scene.act });
      if (exceptionDetails) throw new Error(`${scene.name}: ${exceptionDetails.text}`);
    }
    process.stdout.write(`  ${scene.name}\n`);
    await sleep(scene.hold);
  }

  recording = false;
  await ticker;
  chrome.kill();

  if (shot < 2) throw new Error('no frames captured');
  console.log(`  ${shot} images — ${(shot / FPS).toFixed(1)} s`);

  fs.mkdirSync(path.join(ROOT, 'docs', 'videos'), { recursive: true });
  const mp4 = path.join(ROOT, 'docs', 'videos', 'control-plane.mp4');
  const gif = path.join(ROOT, 'docs', 'images', 'control-plane.gif');

  const pattern = path.join(frames, 'f%05d.jpg');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', pattern,
    '-vf', 'scale=1440:-2:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart',
    '-r', '24', mp4]);

  // GIF, with a palette generated from this footage rather than the web-safe
  // default — the interface is mostly close greys and one orange, which is
  // exactly what a generic palette ruins. Homebrew's ffmpeg ships no WebP
  // encoder, and an APNG of the same clip is 8 MB against 600 KB here.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', pattern,
    '-vf', 'fps=12,scale=900:-2:flags=lanczos,split[a][b];' +
           '[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', gif]);

  for (const out of [mp4, gif]) {
    console.log(`  ${path.relative(ROOT, out).padEnd(34)} ${(fs.statSync(out).size / 1e6).toFixed(1)} Mo`);
  }

  fs.rmSync(frames, { recursive: true, force: true });
  await sleep(1200);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir */ }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
