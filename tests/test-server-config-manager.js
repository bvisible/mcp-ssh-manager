import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'config-manager-'));
process.env.SSH_MANAGER_HOME = sandbox;
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
process.env.SSH_LOG_FILE = path.join(sandbox, 'log');
const { ServerConfigManager } = await import('../src/server-config-manager.js');

let passed = 0;
function ok(label) { console.log(`[32m✓[0m ${label}`); passed++; }

function writeToml(filePath, servers) {
  const content = Object.entries(servers).map(([name, server]) => `
[ssh_servers.${name}]
host = "${server.host}"
user = "${server.user}"
password = "${server.password}"
port = ${server.port}
description = "${server.description}"
`).join('\n');

  fs.writeFileSync(filePath, content, 'utf8');
}

function writeEnv(filePath, host) {
  fs.writeFileSync(filePath, [
    `SSH_SERVER_LAN_51_HOST=${host}`,
    'SSH_SERVER_LAN_51_USER=root',
    'SSH_SERVER_LAN_51_PASSWORD=123456',
    'SSH_SERVER_LAN_51_PORT=22',
    'SSH_SERVER_LAN_51_DESCRIPTION="LAN server from env"',
    ''
  ].join('\n'), 'utf8');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const tmpdir = (tag) => fs.mkdtempSync(path.join(sandbox, `${tag}-`));

// Spy loader: deterministic, counts loads and lets each test program the result.
// The manager still stat()s the *real* files on disk to decide whether to reload,
// so tests create real files and mutate them to drive the signature.
class SpyLoader {
  constructor() {
    this.loadCount = 0;
    this.behavior = () => new Map();
  }
  async load() {
    this.loadCount++;
    return this.behavior();
  }
}

// ── Existing coverage: initial load + hot reload of TOML and .env ──────────────
async function testInitialLoadAndHotReload() {
  const dir = tmpdir('hot-reload');
  const tomlPath = path.join(dir, 'ssh-config.toml');
  const envPath = path.join(dir, '.env');

  writeToml(tomlPath, {
    lan_51: { host: '10.0.0.51', user: 'root', password: '123456', port: 22, description: 'LAN server 10.0.0.51' }
  });

  const manager = new ServerConfigManager({ envPath, tomlPath, preferToml: false });

  let servers = await manager.loadInitial();
  assert.deepStrictEqual(Object.keys(servers), ['lan_51']);
  ok('initial load reads servers from TOML');

  await sleep(1100);
  writeToml(tomlPath, {
    lan_51: { host: '10.0.0.51', user: 'root', password: '123456', port: 22, description: 'LAN server 10.0.0.51' },
    lan_52: { host: '10.0.0.52', user: 'root', password: '123456', port: 22, description: 'LAN server 10.0.0.52' }
  });

  servers = await manager.getServers();
  assert.deepStrictEqual(Object.keys(servers), ['lan_51', 'lan_52']);
  assert.strictEqual(servers.lan_52.host, '10.0.0.52');
  ok('hot reload: server added to TOML is picked up without restart');

  writeEnv(envPath, '10.0.0.151');
  await sleep(1100);
  servers = await manager.getServers();
  assert.strictEqual(servers.lan_51.host, '10.0.0.151');
  ok('hot reload: .env change is picked up');

  writeEnv(envPath, '10.0.0.152');
  await sleep(1100);
  servers = await manager.getServers();
  assert.strictEqual(servers.lan_51.host, '10.0.0.152');
  ok('hot reload: subsequent .env change is picked up');
}

// ── New: laziness — no reload happens when nothing on disk changed ─────────────
async function testLazyReload() {
  const dir = tmpdir('lazy');
  const tomlPath = path.join(dir, 'ssh-config.toml');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(tomlPath, '# real file so the signature can be computed\n');

  const loader = new SpyLoader();
  loader.behavior = () => new Map([['alpha', { host: '10.0.0.1' }]]);
  const manager = new ServerConfigManager({ envPath, tomlPath, configLoader: loader });

  await manager.loadInitial();
  assert.strictEqual(loader.loadCount, 1);

  await manager.getServers();
  await manager.getServers();
  assert.strictEqual(loader.loadCount, 1, 'getServers() must not reload when files are unchanged');
  ok('lazy: repeated getServers() does not reload while files are unchanged');

  // Changing the file size changes the signature → exactly one reload.
  fs.appendFileSync(tomlPath, '\n[ssh_servers.beta]\nhost = "10.0.0.2"\n');
  await manager.getServers();
  assert.strictEqual(loader.loadCount, 2, 'getServers() reloads once after a file change');
  ok('lazy: getServers() reloads exactly once after file metadata changes');
}

// ── New: a failed reload must keep the last valid config (no throw, no wipe) ───
async function testReloadFailureKeepsPrevious() {
  const dir = tmpdir('failsafe');
  const tomlPath = path.join(dir, 'ssh-config.toml');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(tomlPath, '# initial\n');

  const loader = new SpyLoader();
  loader.behavior = () => new Map([['alpha', { host: '1.1.1.1' }]]);
  const manager = new ServerConfigManager({ envPath, tomlPath, configLoader: loader });

  let servers = await manager.loadInitial();
  assert.deepStrictEqual(Object.keys(servers), ['alpha']);

  // Next reload throws (e.g. malformed config written mid-edit).
  loader.behavior = () => { throw new Error('boom: malformed config'); };
  fs.appendFileSync(tomlPath, '\n# broken edit\n');

  servers = await manager.getServers(); // must catch internally
  assert.deepStrictEqual(Object.keys(servers), ['alpha'], 'previous config retained on failure');
  assert.strictEqual(servers.alpha.host, '1.1.1.1');
  ok('reload failure keeps the last valid config (no throw, no wipe)');

  // Recovery: once the config is valid again, a further change reloads it.
  loader.behavior = () => new Map([['alpha', { host: '1.1.1.1' }], ['gamma', { host: '3.3.3.3' }]]);
  fs.appendFileSync(tomlPath, '\n# fixed\n');
  servers = await manager.getServers();
  assert.deepStrictEqual(Object.keys(servers), ['alpha', 'gamma']);
  ok('recovers and reloads once the config becomes valid again');
}

// ── New: a deleted config file must not crash getServers() ────────────────────
async function testDeletedFileIsSafe() {
  const dir = tmpdir('deleted');
  const tomlPath = path.join(dir, 'ssh-config.toml');
  const envPath = path.join(dir, '.env');
  writeToml(tomlPath, {
    alpha: { host: '10.0.0.1', user: 'root', password: 'x', port: 22, description: 'a' }
  });

  const manager = new ServerConfigManager({ envPath, tomlPath, preferToml: true });
  let servers = await manager.loadInitial();
  assert.deepStrictEqual(Object.keys(servers), ['alpha']);

  fs.rmSync(tomlPath);
  await sleep(20);

  // signature flips to "missing" → reload attempt; whatever the loader does,
  // getServers() must stay defined and never throw.
  servers = await manager.getServers();
  assert.ok(servers && typeof servers === 'object', 'getServers() returns an object after file deletion');
  ok(`file deleted: getServers() stays robust (no crash, ${Object.keys(servers).length} server(s))`);
}

async function main() {
  try {
    await testInitialLoadAndHotReload();
    await testLazyReload();
    await testReloadFailureKeepsPrevious();
    await testDeletedFileIsSafe();
    console.log(`\n✅ server config manager tests passed (${passed} checks)`);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
