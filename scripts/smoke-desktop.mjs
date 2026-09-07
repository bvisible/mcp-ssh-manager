#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const executable = process.argv[2];
assert.ok(executable && fs.existsSync(executable), 'Pass a packaged application executable');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-release-'));
const resultFile = path.join(scratch, 'result.json');
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
try {
  await new Promise((resolve, reject) => {
    const child = spawn(path.resolve(executable), ['--release-smoke-test'], { env, cwd: scratch, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Packaged application smoke test timed out')); }, 45000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0) return resolve();
      let reason = '';
      try { reason = JSON.parse(fs.readFileSync(resultFile, 'utf8')).error || ''; } catch { /* exited before reporting */ }
      reject(new Error(`Packaged application exited ${code}${reason ? `: ${reason}` : ''}`));
    });
  });
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, true, result.error);
  console.log('Packaged application smoke passed:', result);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
