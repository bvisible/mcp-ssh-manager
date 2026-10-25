// Started with a clean environment and a temporary cwd by the Playwright fixture.
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

const offerDesktop = process.env.UI_TEST_OFFER_DESKTOP === '1';
const plane = new ControlPlane({
  socketPath: defaultSocketPath(),
  port: 0,
  auditPaths: [],
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
