// SSH_LOG_STDERR=false keeps the engine silent on stderr (idea from fyq163's
// fork, for clients that draw a terminal interface on that stream), and nothing
// changes unless it is set: backward compatibility is the point of the test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-quiet-'));
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

/** Start the engine with its stdin already closed, so it starts and stops. */
function run(extra) {
  const logFile = path.join(scratch, `engine-${passed}-${Math.random().toString(36).slice(2)}.log`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
  Object.assign(env, {
    HOME: scratch, USERPROFILE: scratch,
    SSH_ENV_PATH: path.join(scratch, 'none.env'), SSH_CONFIG_PATH: path.join(scratch, 'none.toml'),
    SSH_MANAGER_HOME: path.join(scratch, 'state'), SSH_LOG_FILE: logFile,
    SSH_HISTORY_FILE: path.join(scratch, 'history.json'), ...extra,
  });
  const result = spawnSync(process.execPath, [path.join(repo, 'src/index.js')], { cwd: repo, env, input: '', encoding: 'utf8', timeout: 30000 });
  return { stderr: result.stderr, status: result.status, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
}

try {
  const normal = run({});
  assert.match(normal.stderr, /MCP SSH Manager Server started/);
  ok('by default the engine still writes its startup lines to stderr');

  for (const value of ['false', '0', 'off', 'NO', ' False ']) {
    const quiet = run({ SSH_LOG_STDERR: value });
    assert.equal(quiet.stderr, '', `SSH_LOG_STDERR=${JSON.stringify(value)} left ${quiet.stderr.length} bytes on stderr`);
    assert.match(quiet.log, /MCP Server initialized/, 'the log file keeps the logger lines');
  }
  ok('SSH_LOG_STDERR=false (or 0, off, no) leaves stderr empty and the log file complete');

  for (const value of ['true', '1', '', 'maybe']) {
    assert.match(run({ SSH_LOG_STDERR: value }).stderr, /MCP SSH Manager Server started/, JSON.stringify(value));
  }
  ok('any other value leaves stderr as it was');

  console.log(`\n✅ quiet stderr tests passed (${passed} checks)`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
