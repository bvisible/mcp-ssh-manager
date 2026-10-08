// Which .env the engine reads when an override names a file that is gone
// (issue #90).
//
// 3.8.5's engine never read SSH_MANAGER_ENV; 4.0 does. A shell profile still
// exporting it towards a deleted development clone took a working setup from
// 59 of 63 servers to none, with no message anywhere. Now a missing file named
// by SSH_MANAGER_ENV is skipped as 3.8.5 skipped the variable, and a missing
// file named by SSH_ENV_PATH (the engine's own override) is said out loud at
// startup, in ssh_list_servers and in the "not found" error.
import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-env-choice-'));
const home = path.join(scratch, 'home');
const managerHome = path.join(scratch, 'manager');
fs.mkdirSync(home);
fs.mkdirSync(managerHome);
const homeEnv = path.join(managerHome, '.env');
fs.writeFileSync(homeEnv, 'SSH_SERVER_WEB_HOST=web.example.com\nSSH_SERVER_WEB_USER=deploy\nSSH_SERVER_WEB_PASSWORD=x\n');
const gone = path.join(scratch, 'deleted-clone', '.env');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, SSH_MANAGER_HOME: managerHome };
delete baseEnv.SSH_ENV_PATH;
delete baseEnv.SSH_MANAGER_ENV;
delete baseEnv.SSH_CONFIG_PATH;

/** Talk MCP to a fresh engine and return what it said. */
function probe(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/index.js')], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    const pending = new Map();
    let id = 1;
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP probe timed out')); }, 15000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        pending.get(message.id)?.(message.result);
      }
    });
    const request = (method, params) => new Promise(done => {
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id++, method, params })}\n`);
    });
    (async () => {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'env-choice', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      const listed = await request('tools/call', { name: 'ssh_list_servers', arguments: {} });
      const missing = await request('tools/call', { name: 'ssh_execute', arguments: { server: 'web', command: 'true' } });
      clearTimeout(timer);
      child.kill();
      resolve({ listed, missing, stderr });
    })().catch(reject);
  });
}

try {
  const { envFileChoice, envFileProblem } = await import('../src/config-paths.js');
  const withEnv = (vars, fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, { SSH_MANAGER_HOME: managerHome }, vars);
    for (const key of ['SSH_ENV_PATH', 'SSH_MANAGER_ENV']) if (!(key in vars)) delete process.env[key];
    try { return fn(); } finally { process.env = saved; }
  };

  withEnv({ SSH_MANAGER_ENV: gone }, () => {
    const choice = envFileChoice();
    assert.equal(choice.path, homeEnv, 'a missing SSH_MANAGER_ENV falls back to the 3.8.5 discovery');
    assert.deepEqual(choice.ignored, { variable: 'SSH_MANAGER_ENV', path: gone });
    assert.match(envFileProblem(choice), /SSH_MANAGER_ENV names .* which does not exist; using .*\.env instead/);
  });
  withEnv({ SSH_MANAGER_ENV: homeEnv }, () => {
    assert.equal(envFileChoice().path, homeEnv);
    assert.equal(envFileProblem(envFileChoice()), null, 'an existing file is nothing to report');
  });
  withEnv({ SSH_ENV_PATH: gone, SSH_MANAGER_ENV: homeEnv }, () => {
    const choice = envFileChoice();
    assert.equal(choice.path, gone, 'SSH_ENV_PATH stays the choice: nothing is read in place of what was asked');
    assert.equal(choice.missing, true);
    assert.match(envFileProblem(choice), /SSH_ENV_PATH names .* which does not exist: no server is loaded/);
  });
  withEnv({}, () => assert.equal(envFileProblem(envFileChoice()), null, 'the plain discovery reports nothing'));
  ok('a missing SSH_MANAGER_ENV falls back as 3.8.5 did; a missing SSH_ENV_PATH stays and is reported');

  const stale = await probe({ ...baseEnv, SSH_MANAGER_ENV: gone });
  assert.equal(JSON.parse(stale.listed.content[0].text).map(server => server.name).join(), 'web',
    'the case from the issue: servers load again');
  assert.match(stale.stderr, /SSH_MANAGER_ENV names .* which does not exist; using/);
  ok('a stale SSH_MANAGER_ENV no longer empties the server list, and startup says why');

  const explicit = await probe({ ...baseEnv, SSH_ENV_PATH: gone });
  assert.deepEqual(JSON.parse(explicit.listed.content[0].text), [], 'the list itself is unchanged for parsers');
  assert.match(explicit.listed.content[1]?.text ?? '', /^No server loaded: SSH_ENV_PATH names .* which does not exist/);
  assert.match(JSON.stringify(explicit.missing), /Server \\"web\\" not found \(SSH_ENV_PATH names .* which does not exist/);
  assert.match(explicit.stderr, /SSH_ENV_PATH names .* which does not exist/);
  ok('a missing SSH_ENV_PATH is named in the log, in ssh_list_servers and in "not found"');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n✅ env file choice tests passed (${passed} checks)`);
