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

const offerDesktop = process.env.UI_TEST_OFFER_DESKTOP === '1';
const plane = new ControlPlane({
  socketPath: defaultSocketPath(),
  port: 0,
  auditPaths: [],
  agents: fakeAgents(),
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
