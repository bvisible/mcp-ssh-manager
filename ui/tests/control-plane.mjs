// Started with a clean environment and a temporary cwd by the Playwright fixture.
import { ControlPlane } from '../../src/control-plane.js';
import { defaultSocketPath } from '../../src/approval.js';

const plane = new ControlPlane({ socketPath: defaultSocketPath(), port: 0, auditPaths: [] });
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
