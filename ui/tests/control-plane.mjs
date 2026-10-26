// Started with a clean environment and a temporary cwd by the Playwright fixture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlane } from '../../src/control-plane.js';
import { defaultSocketPath } from '../../src/approval.js';

/**
 * The desktop application, stood in for when a test asks for it: nothing is
 * downloaded or installed. The install walks through the real phases slowly
 * enough for a page to draw them, and "installs" by flipping a flag.
 */
function fakeDesktop() {
  let installed = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  return {
    status: () => ({
      supported: true,
      installed,
      path: installed ? '/Applications/SSH Manager.app' : null,
      version: installed ? '4.0.0-test' : null,
      method: 'auto',
    }),
    install: async ({ onProgress }) => {
      const total = 1000;
      onProgress({ phase: 'manifest', received: 0, total: 0 });
      await pause(200);
      for (const received of [0, 250, 500, 750, 1000]) {
        onProgress({ phase: 'download', file: 'SSH-Manager-4.0.0-test-arm64.zip', received, total });
        await pause(250);
      }
      onProgress({ phase: 'verify', received: total, total, passed: 'sha256' });
      await pause(200);
      onProgress({ phase: 'install', received: total, total });
      await pause(200);
      installed = true;
      return { path: '/Applications/SSH Manager.app', version: '4.0.0-test', downloaded: true };
    },
    open: async () => {},
    running: async () => false,
    platform: 'darwin',
  };
}

/**
 * The AI tools' world, kept inside the test's home: a desktop application laid
 * out as this platform's installer lays it out, npm's engine being this
 * checkout, and no `claude` or `codex` command, so every change lands in a file
 * the test can read.
 */
function fakeAgents() {
  const home = process.env.HOME;
  const root = process.platform === 'darwin'
    ? path.join(home, 'Applications', 'SSH Manager.app')
    : path.join(home, 'ssh-manager-app');
  const resources = process.platform === 'darwin' ? path.join(root, 'Contents', 'Resources') : path.join(root, 'resources');
  const binary = process.platform === 'darwin' ? path.join(root, 'Contents', 'MacOS', 'SSH Manager')
    : path.join(root, process.platform === 'win32' ? 'SSH Manager.exe' : 'ssh-manager');
  fs.mkdirSync(path.join(resources, 'engine', 'src'), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');
  fs.writeFileSync(path.join(resources, 'engine', 'src', 'index.js'), '');
  fs.writeFileSync(path.join(resources, 'engine', 'package.json'), JSON.stringify({ version: '4.0.0-test' }));
  const checkout = fileURLToPath(new URL('../../src/index.js', import.meta.url));
  return {
    home,
    desktop: () => ({ supported: true, installed: true, path: process.platform === 'darwin' ? root : binary, version: '4.0.0-test', method: 'auto' }),
    which: async name => ({ node: process.execPath, 'mcp-ssh-manager': checkout })[name] ?? null,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
}

/**
 * The desktop application's updater, stood in for when a test asks for it. It
 * walks the same states the real one does, slowly enough for a page to draw
 * them; "restarting" leaves a file behind instead of quitting anything.
 */
function fakeAppUpdates() {
  let state = { currentVersion: '4.0.0-beta.3', status: 'idle', channel: 'preview' };
  const listeners = new Set();
  const set = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  return {
    snapshot: () => state,
    check: async () => {
      set({ status: 'checking' });
      await pause(300);
      set({ status: 'available', version: '4.1.0', checkedAt: new Date().toISOString() });
    },
    download: async () => {
      for (const percent of [0, 40, 80, 100]) { set({ status: 'downloading', version: '4.1.0', percent }); await pause(250); }
      set({ status: 'ready', percent: 100 });
    },
    install: () => fs.writeFileSync(path.join(process.env.HOME, 'update-installed.flag'), '1'),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const offerDesktop = process.env.UI_TEST_OFFER_DESKTOP === '1';
const plane = new ControlPlane({
  socketPath: defaultSocketPath(),
  port: 0,
  auditPaths: [],
  agents: fakeAgents(),
  ...(process.env.UI_TEST_APP_UPDATES === '1' ? { appUpdates: fakeAppUpdates() } : {}),
  ...(offerDesktop ? { offerDesktop, desktop: fakeDesktop(), handoverMs: 60_000 } : {}),
});
const { url } = await plane.start();
process.send?.({ url });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await plane.stop();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
