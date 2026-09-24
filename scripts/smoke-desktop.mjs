#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

// Generous on purpose. The first launch of a freshly built, unsigned Windows
// application on a CI runner is slow — 3 s on 2026-09-07, 40 s on 2026-09-24 for
// the same code — and every stage inside the application keeps its own tighter
// limit. This one only has to catch a process that stopped making progress.
const LAUNCH_LIMIT_MS = 120000;

const executable = process.argv[2];
assert.ok(executable && fs.existsSync(executable), 'Pass a packaged application executable');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-release-'));
const resultFile = path.join(scratch, 'result.json');
const progressFile = `${resultFile}.progress`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_')));
Object.assign(env, {
  SSH_MANAGER_HOME: scratch, SSH_MANAGER_KEY_SOURCE: 'file',
  SSH_MANAGER_APPROVAL_SOCKET: process.platform === 'win32'
    ? `\\\\.\\pipe\\mcp-ssh-${path.basename(scratch)}` : path.join(scratch, 'approval.sock'),
  SSH_CONFIG_PATH: path.join(scratch, 'empty.toml'), SSH_ENV_PATH: path.join(scratch, 'empty.env'),
  SSH_RELEASE_SMOKE_RESULT: resultFile,
});
fs.writeFileSync(env.SSH_ENV_PATH, '');
fs.writeFileSync(env.SSH_CONFIG_PATH, '');

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

let child = null;
let failure = null;
const started = Date.now();
try {
  await new Promise((resolve, reject) => {
    child = spawn(path.resolve(executable), ['--release-smoke-test'], { env, cwd: scratch, stdio: 'inherit' });
    const timeout = setTimeout(() => {
      // Say which half hung. A written result means every check passed and the
      // application then failed to exit; no result means it stopped inside one.
      const reported = read(resultFile);
      reject(new Error(reported
        ? `Packaged application passed its checks but did not exit within ${LAUNCH_LIMIT_MS / 1000} s (it hangs while quitting): ${reported}`
        : `Packaged application smoke test timed out after ${LAUNCH_LIMIT_MS / 1000} s`));
    }, LAUNCH_LIMIT_MS);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0) return resolve();
      let reason = '';
      try { reason = JSON.parse(read(resultFile)).error || ''; } catch { /* exited before reporting */ }
      reject(new Error(`Packaged application exited ${code}${reason ? `: ${reason}` : ''}`));
    });
  });
  const result = JSON.parse(read(resultFile));
  assert.equal(result.ok, true, result.error);
  console.log(`Packaged application smoke passed in ${Math.round((Date.now() - started) / 1000)} s:`, result);
} catch (error) {
  failure = error;
} finally {
  const progress = read(progressFile);
  if (progress) console.log(`Stages reported by the application:\n${progress}`);
  // On Windows child.kill() ends the main process and leaves its renderer, GPU
  // and PTY helpers holding files in the scratch directory — which is how a
  // timeout used to surface as an EPERM from the cleanup instead of itself.
  if (child && child.exitCode === null) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    // Reported, never thrown: a cleanup problem must not replace the reason
    // the smoke test failed, and must not fail one that passed.
    console.warn(`Could not remove ${scratch} (${error.code}); a process may still hold files in it.`);
  }
}
if (failure) throw failure;
