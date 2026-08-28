// Lifecycle / process-teardown tests for the stdio MCP server.
//
// Regression guard for the orphan-process bug: a stdio MCP server is torn down
// by its host closing stdin (EOF) or sending SIGTERM, not by SIGINT. Before the
// fix the only handler was SIGINT, so normal teardown left the process alive
// (reparented to init), leaking one node process per session. These tests boot
// the real server and assert it exits cleanly — and fast — on each teardown path.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'index.js');

// Isolate from the developer's real .env / ~/.codex config: the test only cares
// about process lifetime, not about which servers get loaded.
// mkdtempSync, not a pid-based name: /tmp is shared, and a predictable path can
// be pre-created or symlinked by any other local account before we write it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-lifecycle-'));
const tmpEnv = path.join(tmpDir, 'test.env');
const tmpToml = path.join(tmpDir, 'test.toml');
fs.writeFileSync(tmpEnv, '');

let passed = 0;
let failed = 0;
function ok(label) { console.log(`[32m✓[0m ${label}`); passed++; }
function ko(label) { console.log(`[31m✗[0m ${label}`); failed++; }

// Boot the server, wait for it to come up, then run `teardown(child)` and measure
// time-to-exit. If the process is still alive after `killAfter` ms it is the
// orphan bug: we SIGKILL it and the scenario reports signal='SIGKILL'.
function bootAndTeardown(teardown, { bootMs = 800, killAfter = 4000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SSH_ENV_PATH: tmpEnv, SSH_CONFIG_PATH: tmpToml, SSH_LOG_LEVEL: 'ERROR' },
    });
    child.stderr.on('data', () => {}); // swallow boot/shutdown logs
    let exited = false;

    setTimeout(() => {
      const t0 = process.hrtime.bigint();
      const killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, killAfter);
      child.once('exit', (code, signal) => {
        exited = true;
        clearTimeout(killTimer);
        resolve({ code, signal, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
      });
      teardown(child);
    }, bootMs);
  });
}

const clean = (r) => r.code === 0 && r.signal == null;

async function main() {
  // 1. Host teardown closes our stdin (EOF). This is the path that used to leak.
  let r = await bootAndTeardown((c) => c.stdin.end());
  clean(r)
    ? ok(`exits cleanly on stdin EOF (${r.ms.toFixed(0)}ms, code 0)`)
    : ko(`stdin EOF did not exit cleanly: code=${r.code} signal=${r.signal} (${r.ms.toFixed(0)}ms) — orphaned?`);

  // 2. SIGTERM — the other standard teardown signal (e.g. process supervisors).
  r = await bootAndTeardown((c) => c.kill('SIGTERM'));
  clean(r)
    ? ok(`exits cleanly on SIGTERM (${r.ms.toFixed(0)}ms, code 0)`)
    : ko(`SIGTERM did not exit cleanly: code=${r.code} signal=${r.signal}`);

  // 3. SIGINT — the original (interactive Ctrl-C) path must still work.
  r = await bootAndTeardown((c) => c.kill('SIGINT'));
  clean(r)
    ? ok(`exits cleanly on SIGINT (${r.ms.toFixed(0)}ms, code 0)`)
    : ko(`SIGINT did not exit cleanly: code=${r.code} signal=${r.signal}`);

  // 4. Idempotent shutdown: overlapping signals (SIGTERM + stdin EOF) must not
  //    double-dispose or crash — a single clean exit is expected.
  r = await bootAndTeardown((c) => { c.kill('SIGTERM'); c.stdin.end(); });
  clean(r)
    ? ok(`idempotent on overlapping SIGTERM + stdin EOF (${r.ms.toFixed(0)}ms, code 0)`)
    : ko(`overlapping signals did not exit cleanly: code=${r.code} signal=${r.signal}`);

  fs.rmSync(tmpEnv, { force: true });
  fs.rmSync(tmpToml, { force: true });

  console.log(`\n${failed === 0 ? '✅' : '❌'} lifecycle tests: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
