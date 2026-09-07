// Real files, HTTP and CLI contracts for optional v4 adoption. The outer
// process gives every dependency an isolated home before it is imported.
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (!process.argv.includes('--isolated')) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'v4m-'));
  try {
    const env = { ...process.env, HOME: scratch, USERPROFILE: scratch,
      SSH_MANAGER_HOME: path.join(scratch, 'manager'), SSH_MANAGER_KEY_SOURCE: 'file',
      SSH_ENV_PATH: path.join(scratch, '.env'), SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
      SSH_LOG_FILE: path.join(scratch, 'log'), SSH_HISTORY_FILE: path.join(scratch, 'history'),
      SSH_GROUPS_FILE: path.join(scratch, 'groups.json') };
    delete env.SSH_MANAGER_ENV;
    delete env.SSH_MANAGER_VAULT;
    delete env.PREFER_TOML_CONFIG;
    for (const key of Object.keys(env)) if (key.startsWith('SSH_SERVER_')) delete env[key];
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], {
      cwd: scratch, env, stdio: 'inherit', timeout: 120000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
} else {
  await main();
}

async function main() {
  const { SecretStore } = await import('../src/secret-store.js');
  const { ConfigLoader } = await import('../src/config-loader.js');
  const { ServerConfigManager } = await import('../src/server-config-manager.js');
  const { ControlPlane } = await import('../src/control-plane.js');
  const { resolveEnvFilePath } = await import('../src/config-paths.js');
  const { writeRecoveryFile, readRecoveryFile } = await import('../src/vault-recovery.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const scratch = process.cwd();
  const envPath = process.env.SSH_ENV_PATH;
  const store = new SecretStore();
  let checks = 0;
  const ok = label => { console.log(`✓ ${++checks}. ${label}`); };
  const envText = 'SSH_SERVER_PROD_HOST=old.example.com\nSSH_SERVER_PROD_USER=deploy\n';
  fs.writeFileSync(envPath, envText);
  const inertEnv = path.join(scratch, 'inert.env');
  fs.writeFileSync(inertEnv, 'SSH_SERVER_PROD_HOST=127.0.0.1\nSSH_SERVER_PROD_PORT=1\nSSH_SERVER_PROD_USER=fixture\n');
  const withFreshMcp = async check => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, 'src/index.js')], cwd: scratch,
      env: { ...process.env, SSH_ENV_PATH: inertEnv }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'vault-migration-regression', version: '1.0' });
    try {
      await client.connect(transport);
      assert.ok((await client.listTools()).tools.length > 0, 'a broken vault must not prevent MCP startup');
      await check(client);
    } finally { await client.close(); }
  };
  const assertVaultBlocked = async client => {
    const result = await client.callTool({ name: 'ssh_execute', arguments: { server: 'prod', command: 'printf fixture' } });
    assert.equal(result.isError, true);
    assert.match(result.content.map(item => item.text || '').join('\n'), /SSH operations are blocked.*ssh-manager vault restore/);
  };

  const manager = new ServerConfigManager({ envPath });
  await manager.loadInitial();
  assert.equal(manager.servers.prod.mode, 'unrestricted');
  assert.equal(manager.servers.prod.approval, undefined);
  assert.equal(fs.existsSync(process.env.SSH_MANAGER_HOME), false, 'loading without a vault writes nothing');
  await withFreshMcp(async client => {
    const result = await client.callTool({ name: 'ssh_list_servers', arguments: {} });
    assert.notEqual(result.isError, true, 'a fresh legacy MCP process still loads .env without a vault');
    assert.match(JSON.stringify(result.content), /127\.0\.0\.1/);
  });
  assert.equal(store.exists(), false);
  ok('a fresh legacy process without a vault retains file-only configuration and creates no vault');
  const advanced = { host: 'new.example.com', user: 'deploy', port: 22, approval: 'always',
    password: 'synthetic-primary', mode: 'restricted', allowPatterns: ['^ls$'], denyPatterns: ['rm'],
    proxyJump: 'bastion', proxyCommand: 'ssh bastion -W %h:%p', platform: 'windows',
    forwardAgent: true, auditLog: path.join(scratch, 'audit.jsonl'), description: 'Keep me',
    accounts: [{ id: 'root', username: 'root', password: 'synthetic-nested', passphrase: 'nested-phrase' }] };
  store.setServer('prod', advanced);
  store.setServer('new', { host: 'second.example.com', user: 'deploy' });
  let loaded = await manager.getServers();
  assert.equal(loaded.prod.host, advanced.host);
  assert.equal(loaded.prod.approval, 'always');
  assert.ok(loaded.new);
  store.setServer('prod', { ...advanced, host: 'edit.example.com' });
  loaded = await manager.getServers();
  assert.equal(loaded.prod.host, 'edit.example.com');
  store.removeServer('new');
  assert.equal((await manager.getServers()).new, undefined);
  ok('a running config manager sees vault creation, edits, approval and removals');

  process.env.SSH_SERVER_PROD_HOST = 'override.example.com';
  process.env.SSH_SERVER_PROD_USER = 'override';
  const overridden = await new ConfigLoader().load();
  assert.equal(overridden.get('prod').host, 'override.example.com');
  assert.equal(overridden.get('prod').approval, 'always');
  delete process.env.SSH_SERVER_PROD_HOST;
  delete process.env.SSH_SERVER_PROD_USER;
  const filesOnly = await new ConfigLoader().load({ vaultPath: null });
  assert.equal(filesOnly.get('prod').host, 'old.example.com');
  assert.equal(filesOnly.get('prod').approval, undefined);
  ok('process overrides preserve vault approval, while migration can explicitly exclude the vault');

  const validVault = fs.readFileSync(store.vaultPath, 'utf8');
  fs.writeFileSync(store.vaultPath, '{ broken JSON');
  await assert.rejects(manager.getServers(), error => error.code === 'VAULT_UNREADABLE');
  await assert.rejects(manager.getServers(), error => error.code === 'VAULT_UNREADABLE');
  assert.deepEqual(manager.servers, {}, 'the previous configuration cannot escape through direct cache access');
  const freshManager = new ServerConfigManager({ envPath });
  await assert.rejects(freshManager.loadInitial(), error => error.code === 'VAULT_UNREADABLE');
  await assert.rejects(freshManager.getServers(), error => error.code === 'VAULT_UNREADABLE');
  const brokenLoader = new ConfigLoader();
  await assert.rejects(brokenLoader.load(), error => error.code === 'VAULT_UNREADABLE');
  assert.equal(brokenLoader.servers.size, 0, 'the fallback loaded before the vault must not remain accessible');
  await withFreshMcp(async client => {
    await assertVaultBlocked(client);
    await assertVaultBlocked(client);
    fs.writeFileSync(store.vaultPath, validVault);
    const recovered = await client.callTool({ name: 'ssh_list_servers', arguments: {} });
    assert.notEqual(recovered.isError, true, 'the same MCP process recovers after the vault is repaired');
  });
  assert.equal((await freshManager.getServers()).prod.approval, 'always');
  assert.equal((await manager.getServers()).prod.mode, 'restricted');
  ok('damaged adopted vaults block fresh and running engines, including repeated calls, until repaired');
  const lock = `${store.vaultPath}.lock`;
  fs.writeFileSync(lock, String(process.pid));
  try {
    assert.throws(() => store.setServer('other', { host: 'other.example.com' }), error => error.code === 'VAULT_BUSY');
    assert.equal(fs.readFileSync(store.vaultPath, 'utf8'), validVault);
  } finally { fs.rmSync(lock); }
  ok('concurrent writers cannot overwrite the vault');

  const onDisk = fs.readFileSync(store.vaultPath, 'utf8');
  assert.ok(!onDisk.includes('synthetic-primary') && !onDisk.includes('synthetic-nested'));
  assert.equal(store.getAllDecrypted().prod.accounts[0].password, 'synthetic-nested');
  assert.equal(store.checkKey().checked, 3);
  ok('additional account credentials are encrypted and counted in integrity checks');

  const plane = new ControlPlane({ socketPath: path.join(scratch, 'a.sock') });
  await plane.start();
  const call = async (endpoint, payload, method = payload === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${plane.port}${endpoint}?token=${plane.token}`, {
      method, headers: { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const edited = await call('/api/servers', { name: 'prod', host: advanced.host, port: 2222,
      accounts: [{ id: 'root', username: 'root-edited', hasPassword: true, hasPassphrase: true }] });
    assert.equal(edited.status, 200);
    const saved = store.getAllDecrypted().prod;
    for (const field of ['proxyJump', 'proxyCommand', 'platform', 'forwardAgent', 'allowPatterns',
      'denyPatterns', 'auditLog', 'description', 'approval', 'password']) {
      assert.deepEqual(saved[field], advanced[field], `${field} must survive editing another field`);
    }
    assert.equal(saved.accounts[0].password, 'synthetic-nested');
    assert.equal(saved.accounts[0].username, 'root-edited');
    assert.equal(saved.accounts[0].hasPassword, undefined, 'UI presence flags are never stored');
    const listing = await call('/api/servers');
    const serialized = JSON.stringify(listing.body);
    assert.ok(!serialized.includes('synthetic') && !serialized.includes('v1:'));
    assert.equal(listing.body.servers[0].accounts[0].hasPassword, true);
    await call('/api/servers', { name: 'prod', host: advanced.host, proxyJump: '', auditLog: '' });
    assert.equal((await new ConfigLoader().load()).get('prod').proxyJump, '');
    assert.equal(fs.readFileSync(envPath, 'utf8'), envText);
    ok('HTTP edits preserve advanced settings and nested secrets, without exposing them or editing .env');

    const bad = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: plane.port, path: 'http://[', method: 'GET' }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(bad, 400);
    assert.equal((await call('/api/state')).status, 200);
    const badBody = await call('/api/servers', null);
    assert.equal(badBody.status, 400);
    ok('malformed URLs and bodies are refused while the control plane keeps serving requests');

    delete process.env.SSH_ENV_PATH;
    const globalEnv = path.join(process.env.SSH_MANAGER_HOME, '.env');
    fs.writeFileSync(globalEnv, 'SSH_SERVER_GLOBAL_HOST=global.example.com\nSSH_SERVER_GLOBAL_USER=deploy\n');
    assert.equal(resolveEnvFilePath(), globalEnv);
    const migration = await call('/api/migration');
    assert.equal(migration.body.envPath, globalEnv);
    assert.deepEqual(migration.body.pending.map(server => server.name), ['global']);
    const imported = await call('/api/migration', { servers: ['global'] });
    assert.deepEqual(imported.body.imported, ['global']);
    const cli = spawnSync(process.execPath, [path.join(root, 'cli/vault.js'), 'import'], {
      cwd: scratch, env: process.env, input: 'n\n', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /global\.example\.com/);
    assert.match(cli.stdout, /Cancelled/);
    const tomlPath = path.join(scratch, 'servers.toml');
    fs.writeFileSync(tomlPath, '[ssh_servers.toml_only]\nhost="toml.example.com"\nuser="deploy"\n');
    const tomlCli = spawnSync(process.execPath, [path.join(root, 'cli/vault.js'), 'import', '--from', tomlPath], {
      cwd: scratch, env: process.env, input: 'n\n', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(tomlCli.status, 0, tomlCli.stderr);
    assert.match(tomlCli.stdout, /toml_only/);
    assert.ok(!tomlCli.stdout.includes('global.example.com'));
    process.env.SSH_ENV_PATH = envPath;
    ok('GUI migration and CLI import discover the global .env; explicit TOML import also works');

    const passphrase = 'correct synthetic recovery';
    const status = await call('/api/vault/status');
    assert.equal(status.body.readable, true);
    assert.equal((await call('/api/vault/backup', { passphrase: 'short' })).status, 400);
    const backup = await call('/api/vault/backup', { passphrase });
    assert.equal(backup.status, 200);
    assert.ok(!backup.body.content.includes('synthetic-primary'));
    const content = backup.body.content;
    const beforePreview = fs.readFileSync(store.vaultPath, 'utf8');
    const preview = await call('/api/vault/restore', { content, passphrase });
    assert.equal(preview.status, 200);
    assert.ok(preview.body.conflicts.includes('prod'));
    assert.equal(fs.readFileSync(store.vaultPath, 'utf8'), beforePreview);
    store.setServer('concurrent', { host: 'concurrent.example.com' });
    const stale = await call('/api/vault/restore', { content, passphrase, confirm: true, revision: preview.body.revision });
    assert.equal(stale.status, 409);
    assert.ok(store.listServers().includes('concurrent'));
    const fresh = await call('/api/vault/restore', { content, passphrase });
    const restored = await call('/api/vault/restore', { content, passphrase, confirm: true, revision: fresh.body.revision });
    assert.equal(restored.status, 200);
    assert.equal(store.getAllDecrypted().prod.password, 'synthetic-primary');
    assert.ok(store.listServers().includes('concurrent'));
    ok('browser recovery downloads encrypted data, previews without writes and rejects stale confirmations');

    const raw = store.read();
    const pieces = raw.servers.prod.accounts[0].passphrase.split(':');
    const tag = Buffer.from(pieces[2], 'base64'); tag[0] ^= 1; pieces[2] = tag.toString('base64');
    raw.servers.prod.accounts[0].passphrase = pieces.join(':'); store.write(raw);
    assert.equal(store.checkKey().ok, false);
    assert.throws(() => new SecretStore().getAllDecrypted());
    await assert.rejects(new ConfigLoader().load(), error => error.code === 'VAULT_UNREADABLE',
      'readable approval metadata must not allow fallback to weaker file policies when a secret is damaged');
    const badBytes = fs.readFileSync(store.vaultPath, 'utf8');
    assert.equal((await call('/api/vault/backup', { passphrase })).status, 400);
    assert.equal((await call('/api/servers', { name: 'prod', host: 'changed.example.com' })).status, 500);
    assert.equal(fs.readFileSync(store.vaultPath, 'utf8'), badBytes);
    const damagedPreview = await call('/api/vault/restore', { content, passphrase });
    assert.equal(damagedPreview.body.replacesUnreadable, true);
    assert.ok(damagedPreview.body.removed.includes('concurrent'));
    const repaired = await call('/api/vault/restore', {
      content, passphrase, confirm: true, revision: damagedPreview.body.revision,
    });
    assert.equal(repaired.status, 200);
    assert.equal(new SecretStore().getAllDecrypted().prod.accounts[0].passphrase, 'nested-phrase');
    ok('a damaged later credential blocks reassuring status, incomplete backups and destructive edits; recovery repairs it');
  } finally { await plane.stop(); }

  const recovery = path.join(scratch, 'recovery.json');
  const expected = new SecretStore().getAllDecrypted();
  const longLived = new SecretStore();
  assert.deepEqual(longLived.getAllDecrypted(), expected);
  writeRecoveryFile(expected, 'another recovery phrase', recovery);
  fs.rmSync(path.join(process.env.SSH_MANAGER_HOME, 'vault.key'));
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.throws(() => new SecretStore().setServer('new', { host: 'new.example.com', password: 'new' }),
      error => error.code === 'VAULT_KEY_MISMATCH');
    assert.equal(fs.existsSync(path.join(process.env.SSH_MANAGER_HOME, 'vault.key')), false,
      'missing keys must not be silently replaced on any retry');
  }
  await assert.rejects(new ConfigLoader().load(), error => error.code === 'VAULT_UNREADABLE',
    'a missing key blocks file fallback instead of weakening the adopted vault policy');
  await assert.rejects(manager.getServers(), error => error.code === 'VAULT_UNREADABLE');
  await withFreshMcp(assertVaultBlocked);
  const saved = readRecoveryFile(recovery, 'another recovery phrase');
  new SecretStore().restoreServers(saved, { replaceUnreadable: true });
  assert.deepEqual(new SecretStore().getAllDecrypted(), expected);
  assert.deepEqual(longLived.getAllDecrypted(), expected, 'the running UI must refresh its cached key after CLI recovery');
  assert.equal(longLived.checkKey().ok, true);
  assert.equal((await manager.getServers()).prod.mode, 'restricted');
  ok('key loss stays an error on every retry, and explicit recovery rebuilds a fully readable vault');

  fs.rmSync(store.vaultPath);
  assert.equal((await manager.getServers()).prod.host, 'old.example.com');
  assert.equal((await manager.getServers()).prod.approval, undefined);
  ok('removing the optional vault restores the original file-only configuration');
  console.log(`\n✅ v4 migration regression tests passed (${checks} checks)`);
}
