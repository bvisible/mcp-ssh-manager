#!/usr/bin/env node
/** Registry 3.8.5 -> packed working tree -> registry rollback, with no opt-in UI.
 * Run before a release: node scripts/test-upgrade-from-published.mjs [version]
 * Installs three times and probes .env, TOML and process-environment setups.
 * Every home/config is isolated; only hashes of credential fields cross probes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PREVIOUS = process.argv[2] || '3.8.5';
assert.match(PREVIOUS, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'previous version must be an exact version');
const FIELDS = ['name', 'host', 'user', 'password', 'keyPath', 'passphrase', 'port',
  'defaultDir', 'sudoPassword', 'description', 'group', 'platform', 'proxyJump',
  'proxyCommand', 'forwardAgent', 'mode', 'allowPatterns', 'denyPatterns', 'auditLog', 'source'];
let passed = 0;
const ok = label => console.log(`✓ ${++passed}. ${label}`);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// npm.cmd cannot be passed to execFile on Windows. Locate npm's JavaScript CLI
// and run it with this Node executable on every platform, without shell quoting.
function npmCLI() {
  const candidates = [process.env.npm_execpath];
  try { candidates.push(path.join(path.dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin', 'npm-cli.js')); } catch { /* global install */ }
  for (const dir of [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)]) {
    candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    try { candidates.push(fs.realpathSync(path.join(dir, 'npm'))); } catch { /* not on this PATH entry */ }
  }
  const cli = candidates.find(candidate => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate));
  if (!cli) throw new Error('Cannot locate npm-cli.js; run this check through npm or install npm beside Node');
  return cli;
}
const npmPath = npmCLI();
function npm(args, cwd) {
  try {
    return execFileSync(process.execPath, [npmPath, ...args], { cwd, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  } catch (error) {
    // Do not dump npm configuration or child output, which may contain tokens.
    throw new Error(`npm ${args[0]} failed (exit ${error.status ?? error.code}); check registry access and retry`);
  }
}

function interrogate(scenario, entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', scenario.preload, entry], {
      cwd: scenario.dir, env: scenario.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let nextId = 1;
    let finished = false;
    const pending = new Map();
    const timer = setTimeout(() => fail(new Error(`${scenario.name}: MCP probe timed out`)), 12000);
    const exit = new Promise(done => child.once('exit', done));
    function fail(error) {
      if (finished) return;
      finished = true; clearTimeout(timer); child.kill(); reject(error);
    }
    child.stderr.on('data', () => {});
    child.on('error', fail);
    child.on('exit', () => { if (!finished) fail(new Error(`${scenario.name}: MCP exited before answering`)); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error(`${scenario.name}: non-JSON stdout broke MCP framing`)); return; }
        if (message.method === 'elicitation/create') { fail(new Error(`${scenario.name}: unexpected interactive prompt`)); return; }
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(`${scenario.name}: MCP ${waiter.method} failed`)) : waiter.resolve(message.result); }
      }
    });
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upgrade-regression', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      const tools = await request('tools/list', {});
      const listed = await request('tools/call', { name: 'ssh_list_servers', arguments: {} });
      assert.equal(listed.isError, undefined, `${scenario.name}: listing failed`);
      let servers;
      try { servers = JSON.parse(listed.content[0].text); } catch { throw new Error(`${scenario.name}: server listing is not JSON`); }
      assert.ok(Array.isArray(servers) && servers.length === 2, `${scenario.name}: expected exactly the two fixture servers`);
      assert.equal(tools.tools.length, 37, `${scenario.name}: expected all 37 tools`);
      const schemas = Object.fromEntries(tools.tools.map(tool => [tool.name, canonical(tool.inputSchema)]).sort(([a], [b]) => a.localeCompare(b)));
      assert.equal(Object.keys(schemas).length, 37, `${scenario.name}: duplicate tool names`);
      finished = true; clearTimeout(timer); child.stdin.end();
      const kill = setTimeout(() => child.kill(), 1000);
      await exit; clearTimeout(kill);
      resolve({ listing: canonical(servers.sort((a, b) => a.name.localeCompare(b.name))), schemas });
    })().catch(fail);
  });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-real-'));
const salt = crypto.randomBytes(32).toString('hex');
const hash = value => crypto.createHmac('sha256', salt).update(JSON.stringify(value)).digest('hex');
const snapshots = new Map();
function remember(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); snapshots.set(file, fs.readFileSync(file)); }

function scenario(name) {
  const dir = path.join(work, name); fs.mkdirSync(dir);
  const envFile = path.join(dir, '.env');
  const tomlFile = path.join(dir, '.codex', 'ssh-config.toml');
  const preload = path.join(dir, 'isolation.mjs');
  const fields = { name: 'prod', host: `${name}.fixture.invalid`, user: 'fixture-user', password: 'fixture-password',
    keyPath: '~/.ssh/fixture-key', passphrase: 'fixture-passphrase', port: 2222, defaultDir: '~/fixture folder',
    sudoPassword: 'fixture-sudo', description: `${name} fixture`, group: 'fixture-group', platform: 'windows',
    proxyJump: 'bastion', proxyCommand: 'ssh -W %h:%p fixture-bastion', forwardAgent: true,
    mode: 'restricted', allowPatterns: ['^printf', '^echo'], denyPatterns: ['forbidden'], auditLog: path.join(dir, 'audit.jsonl').replaceAll('\\', '/'), source: name === 'toml' ? 'toml' : 'env' };
  const mapping = { host: 'HOST', user: 'USER', password: 'PASSWORD', keyPath: 'KEYPATH', passphrase: 'PASSPHRASE', port: 'PORT',
    defaultDir: 'DEFAULT_DIR', sudoPassword: 'SUDO_PASSWORD', description: 'DESCRIPTION', group: 'GROUP', platform: 'PLATFORM',
    proxyJump: 'PROXYJUMP', proxyCommand: 'PROXYCOMMAND', forwardAgent: 'FORWARD_AGENT', mode: 'MODE',
    allowPatterns: 'ALLOW_PATTERNS', denyPatterns: 'DENY_PATTERNS', auditLog: 'AUDIT_LOG' };
  const tomlMapping = { keyPath: 'key_path', defaultDir: 'default_dir', sudoPassword: 'sudo_password',
    proxyJump: 'proxy_jump', proxyCommand: 'proxy_command', forwardAgent: 'forward_agent',
    allowPatterns: 'allow_patterns', denyPatterns: 'deny_patterns', auditLog: 'audit_log' };
  const variables = { SSH_SERVER_BASTION_HOST: 'bastion.fixture.invalid', SSH_SERVER_BASTION_USER: 'fixture' };
  for (const [key, suffix] of Object.entries(mapping)) variables[`SSH_SERVER_PROD_${suffix}`] = Array.isArray(fields[key]) ? fields[key].join(';') : String(fields[key]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_') && key !== 'PREFER_TOML_CONFIG' && key !== 'NODE_OPTIONS'));
  Object.assign(env, { NODE_ENV: 'test', SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: tomlFile, SSH_MANAGER_HOME: path.join(dir, 'managed'),
    SSH_MANAGER_VAULT: path.join(dir, 'managed', 'vault.json'), SSH_MANAGER_KEY_SOURCE: 'file',
    SSH_LOG_FILE: path.join(dir, 'probe.log'), SSH_HISTORY_FILE: path.join(dir, 'history.json'), SSH_LOG_LEVEL: 'ERROR' });
  // Fail if either release attempts to start a local server/UI during a stdio
  // probe. The OS-home stub isolates old readers that predate SSH_MANAGER_HOME.
  fs.writeFileSync(preload, `import os from 'node:os'; import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module'; os.homedir=()=>${JSON.stringify(dir)}; net.Server.prototype.listen=function(){throw new Error('Unexpected network listener in a headless probe');}; syncBuiltinESMExports();`);
  if (name === 'toml') {
    remember(envFile, '# TOML setup has no env server definitions\n');
    remember(tomlFile, `[ssh_servers.bastion]\nhost = "bastion.fixture.invalid"\nuser = "fixture"\n\n[ssh_servers.prod]\n` + Object.keys(mapping).map(key => `${tomlMapping[key] || key} = ${JSON.stringify(fields[key])}`).join('\n') + '\n');
  } else {
    remember(envFile, name === 'environment' ? '# credentials supplied by the MCP client environment\n'
      : Object.entries(variables).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n');
    if (name === 'environment') Object.assign(env, variables);
  }
  return { name, dir, envFile, tomlFile, preload, env, fields };
}

function loaderSnapshot(installed, item) {
  const helper = path.join(item.dir, 'loader-probe.mjs');
  fs.writeFileSync(helper, `import crypto from 'node:crypto';
import {ConfigLoader} from ${JSON.stringify(pathToFileURL(path.join(installed, 'src/config-loader.js')).href)};
const loaded=await new ConfigLoader().load(${JSON.stringify({ envPath: item.envFile, tomlPath: item.tomlFile })});
const fields=${JSON.stringify(FIELDS)};
const result=Object.fromEntries([...loaded].sort(([a],[b])=>a.localeCompare(b)).map(([name,config])=>[name,Object.fromEntries(fields.map(field=>[field,{present:Object.hasOwn(config,field),kind:typeof config[field],hash:crypto.createHmac('sha256',${JSON.stringify(salt)}).update(JSON.stringify(config[field]===undefined?{undefined:true}:config[field])).digest('hex')}]))]));
process.stdout.write(JSON.stringify(result));`);
  let output;
  try { output = execFileSync(process.execPath, ['--import', item.preload, helper], { cwd: item.dir, env: item.env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`${item.name}: isolated ConfigLoader probe failed`); }
  const snapshot = JSON.parse(output);
  assert.deepEqual(Object.keys(snapshot).sort(), ['bastion', 'prod'], `${item.name}: missing loader fixture servers`);
  for (const field of FIELDS) {
    assert.equal(snapshot.prod[field]?.kind, typeof item.fields[field], `${item.name}: ${field} missing or mistyped`);
    assert.equal(snapshot.prod[field]?.hash, hash(item.fields[field]), `${item.name}: ${field} changed from the configured fixture`);
  }
  return snapshot;
}

function untouched(scenarios) {
  for (const [file, before] of snapshots) assert.ok(fs.readFileSync(file).equals(before), `${path.basename(file)} was modified`);
  for (const item of scenarios) {
    for (const name of ['managed', '.ssh-manager', 'vault.json', 'vault.key', '.server-groups.json', 'commands.json', 'commands.log.jsonl']) {
      assert.equal(fs.existsSync(path.join(item.dir, name)), false, `${item.name}: unexpected opt-in state ${name}`);
    }
  }
}

async function main() {
  try {
    const scenarios = ['env', 'toml', 'environment'].map(scenario);
    const install = path.join(work, 'installation'); fs.mkdirSync(install);
    remember(path.join(install, 'package.json'), '{"name":"upgrade-regression","version":"1.0.0","private":true}\n');
    // npm intentionally updates this manifest; the original user config files
    // above are the byte-preservation contract, not npm's dependency bookkeeping.
    snapshots.delete(path.join(install, 'package.json'));
    const installed = path.join(install, 'node_modules', 'mcp-ssh-manager');
    const packageVersion = () => JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
    const installPrevious = () => npm(['install', `mcp-ssh-manager@${PREVIOUS}`, '--no-audit', '--no-fund', '--silent', '--registry=https://registry.npmjs.org'], install);
    installPrevious(); assert.equal(packageVersion(), PREVIOUS); ok(`registry ${PREVIOUS} installed`);
    const before = {};
    for (const item of scenarios) before[item.name] = { protocol: await interrogate(item, path.join(installed, 'src/index.js')), loader: loaderSnapshot(installed, item) };
    untouched(scenarios); ok('previous release: .env, TOML and environment each preserve all 20 effective fields and expose 37 tools');
    const pack = JSON.parse(npm(['pack', '--json', '--pack-destination', work], ROOT));
    assert.equal(pack.length, 1, 'npm pack must produce one artifact');
    npm(['install', path.join(work, pack[0].filename), '--no-audit', '--no-fund', '--silent'], install);
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    assert.equal(packageVersion(), current); ok(`installed packed ${current} over ${PREVIOUS}`);
    for (const item of scenarios) {
      const after = { protocol: await interrogate(item, path.join(installed, 'src/index.js')), loader: loaderSnapshot(installed, item) };
      assert.deepEqual(after.loader, before[item.name].loader, `${item.name}: effective ConfigLoader field fingerprints differ`);
      assert.deepEqual(after.protocol.listing, before[item.name].protocol.listing, `${item.name}: MCP listing changed`);
      assert.deepEqual(after.protocol.schemas, before[item.name].protocol.schemas, `${item.name}: MCP tool names or input schemas changed`);
      ok(`${item.name}: effective fields, MCP listing and all 37 tool input schemas unchanged`);
    }
    untouched(scenarios); ok('upgrade leaves original config bytes intact and starts no UI, listener, prompt or vault');
    installPrevious(); assert.equal(packageVersion(), PREVIOUS);
    for (const item of scenarios) {
      const rollback = { protocol: await interrogate(item, path.join(installed, 'src/index.js')), loader: loaderSnapshot(installed, item) };
      assert.deepEqual(rollback, before[item.name], `${item.name}: rollback differs from the previous release`);
    }
    untouched(scenarios); ok(`rollback to registry ${PREVIOUS} restores identical behavior for all three configurations`);
    console.log(`\nUpgrade ${PREVIOUS} → ${current} → ${PREVIOUS}: ${passed} checks passed`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(`Upgrade check failed: ${error.message}`); process.exitCode = 1; });
