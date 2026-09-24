import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { suggestDesktop } from '../cli/experience.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-v4-'));
try {
  let output = '';
  const options = { stdin: { isTTY: true }, stderr: { isTTY: true, write: text => { output += text; } }, env: { SSH_MANAGER_HOME: scratch } };
  for (const args of [['--version'], ['--help'], ['server', 'list'], ['control'], ['vault', 'list']]) {
    assert.equal(suggestDesktop(args, options), false);
  }
  assert.equal(output, '');
  assert.deepEqual(fs.readdirSync(scratch), []);
  assert.equal(suggestDesktop([], { ...options, stdin: { isTTY: false } }), false);
  assert.equal(suggestDesktop([], { ...options, env: { ...options.env, CI: 'true' } }), false);
  assert.equal(suggestDesktop([], { ...options, env: { ...options.env, SSH_MANAGER_NO_TIPS: '1' } }), false);
  assert.equal(suggestDesktop([], options), true);
  assert.match(output, /ssh-manager control/);
  assert.match(output, /interface is optional/);
  const once = output;
  assert.equal(suggestDesktop([], options), false);
  assert.equal(output, once);

  const version = spawnSync(process.execPath, ['cli/ssh-manager.js', '--version'], { encoding: 'utf8', env: { ...process.env, SSH_MANAGER_HOME: scratch } });
  assert.equal(version.status, 0);
  assert.ok(version.stdout.includes(`SSH Manager CLI v${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`));
  assert.equal(version.stderr, '');
  console.log('CLI compatibility: direct commands/pipes/CI stay silent; desktop invitation is optional and shown once.');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
