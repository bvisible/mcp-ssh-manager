// Switching an AI tool between the npm engine and the desktop application's,
// from the interface (src/agent-clients.js and /api/agents).
//
// Everything happens in a scratch home with stand-in commands: no real
// configuration is read or written. The last check starts, for real, the
// engine a written configuration points at, and asks it for its tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentContext, agentsStatus, useEngine, describeEntry, appEngine } from '../src/agent-clients.js';
import { ControlPlane } from '../src/control-plane.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

// A desktop application laid out as the macOS one is, with its engine inside.
const appBundle = path.join(scratch, 'Applications', 'SSH Manager.app');
const appEngineRoot = path.join(appBundle, 'Contents', 'Resources', 'engine');
fs.mkdirSync(path.join(appEngineRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true });
fs.writeFileSync(path.join(appBundle, 'Contents', 'MacOS', 'SSH Manager'), '');
fs.writeFileSync(path.join(appEngineRoot, 'src', 'index.js'), '');
fs.writeFileSync(path.join(appEngineRoot, 'package.json'), JSON.stringify({ version: '4.0.0' }));

// An npm global install, the way npm lays it out: a bin link to src/index.js.
const npmRoot = path.join(scratch, 'npm', 'lib', 'node_modules', 'mcp-ssh-manager');
fs.mkdirSync(path.join(npmRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(npmRoot, 'src', 'index.js'), '');
fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ version: '3.8.7' }));
fs.mkdirSync(path.join(scratch, 'npm', 'bin'));
fs.symlinkSync(path.join(npmRoot, 'src', 'index.js'), path.join(scratch, 'npm', 'bin', 'mcp-ssh-manager'));

const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const calls = [];
let claudeDesktopRunning = false;
let commands = { node: '/usr/local/bin/node', 'mcp-ssh-manager': path.join(scratch, 'npm', 'bin', 'mcp-ssh-manager'), claude: null, codex: null };

const context = agentContext({
  platform: 'darwin',
  env: {},
  home,
  desktop: () => ({ supported: true, installed: true, path: appBundle, version: '4.0.0', method: 'auto' }),
  which: async name => commands[name] ?? null,
  run: async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ps') {
      return { code: 0, stdout: claudeDesktopRunning ? '/Applications/Claude.app/Contents/MacOS/Claude\n' : '/bin/zsh\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  },
});

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

try {
  // ── what is on offer ──────────────────────────────────────────────────────
  let status = await agentsStatus(context);
  assert.equal(status.engines.app.command, path.join(appBundle, 'Contents', 'MacOS', 'SSH Manager'));
  assert.deepEqual(status.engines.app.args, [path.join(appEngineRoot, 'src', 'index.js')]);
  assert.deepEqual(status.engines.app.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(status.engines.app.version, '4.0.0');
  assert.equal(status.engines.npm.command, '/usr/local/bin/node');
  assert.deepEqual(status.engines.npm.args, [fs.realpathSync(path.join(npmRoot, 'src', 'index.js'))]);
  assert.equal(status.engines.npm.version, '3.8.7');
  assert.deepEqual(status.clients.map(c => [c.id, c.installed, c.engine]),
    [['claude-code', false, null], ['claude-desktop', false, null], ['codex', false, null]]);
  ok('both engines are found: the application\'s (run as Node by its own runtime) and npm\'s');

  assert.equal(appEngine({ ...context, desktop: () => ({ supported: true, installed: true, path: '/home/u/Applications/SSH-Manager.AppImage', version: null, method: 'auto' }), platform: 'linux' }), null);
  assert.equal(appEngine({ ...context, desktop: () => ({ supported: true, installed: false, path: null, version: null, method: 'auto' }) }), null);
  for (const moving of ['/Volumes/SSH Manager 4.0.0-arm64/SSH Manager.app', '/private/var/folders/x/AppTranslocation/0A1B/d/SSH Manager.app']) {
    assert.equal(appEngine({ ...context, desktop: () => ({ supported: true, installed: true, path: moving, version: '4.0.0', method: 'auto' }) }), null, moving);
  }
  ok('no application engine is offered from an AppImage, a disk image or a translocated copy (each moves on the next start), or when the app is absent');

  // ── Claude Code, without its command: the file, everything else kept ─────
  const claudeJson = path.join(home, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({
    numStartups: 12,
    projects: { '/work': { allowedTools: [] } },
    mcpServers: {
      other: { type: 'stdio', command: 'other-mcp', args: [] },
      'ssh-manager': { type: 'stdio', command: '/usr/local/bin/node', args: [path.join(npmRoot, 'src', 'index.js')], env: { SSH_ENV_PATH: '/work/.env' } },
    },
  }));
  status = await agentsStatus(context);
  assert.deepEqual([status.clients[0].installed, status.clients[0].engine, status.clients[0].version], [true, 'npm', '3.8.7']);

  let client = await useEngine('claude-code', 'app', context);
  assert.deepEqual([client.engine, client.version], ['app', '4.0.0']);
  let written = readJson(claudeJson);
  assert.deepEqual(written.mcpServers['ssh-manager'], {
    type: 'stdio',
    command: path.join(appBundle, 'Contents', 'MacOS', 'SSH Manager'),
    args: [path.join(appEngineRoot, 'src', 'index.js')],
    env: { SSH_ENV_PATH: '/work/.env', ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.deepEqual(written.mcpServers.other, { type: 'stdio', command: 'other-mcp', args: [] });
  assert.equal(written.numStartups, 12);
  assert.deepEqual(written.projects, { '/work': { allowedTools: [] } });

  client = await useEngine('claude-code', 'npm', context);
  assert.equal(client.engine, 'npm');
  assert.deepEqual(readJson(claudeJson).mcpServers['ssh-manager'].env, { SSH_ENV_PATH: '/work/.env' });
  ok('Claude Code: switched to the app and back to npm; its other settings and servers untouched, SSH_ENV_PATH kept');

  // ── Claude Code with its command: Claude Code writes its own file ────────
  commands = { ...commands, claude: '/opt/bin/claude' };
  calls.length = 0;
  await useEngine('claude-code', 'app', context);
  assert.deepEqual(calls[0], ['/opt/bin/claude', 'mcp', 'remove', 'ssh-manager', '--scope', 'user']);
  assert.equal(calls[1][0], '/opt/bin/claude');
  assert.deepEqual(calls[1].slice(1, 3), ['mcp', 'add-json']);
  assert.equal(calls[1][3], 'ssh-manager');
  assert.deepEqual(JSON.parse(calls[1][4]).env, { SSH_ENV_PATH: '/work/.env', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(calls[1].slice(5), ['--scope', 'user']);
  commands = { ...commands, claude: null };
  ok('with the `claude` command installed, the change goes through `claude mcp`, never beside it');

  // ── Claude Desktop: refused while it runs ─────────────────────────────────
  const desktopConfig = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(desktopConfig), { recursive: true });
  fs.writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { files: { command: 'files-mcp' } }, globalShortcut: 'Cmd+Space' }));
  claudeDesktopRunning = true;
  await assert.rejects(useEngine('claude-desktop', 'app', context), error => error.status === 409 && /Quit Claude Desktop/.test(error.message));
  assert.equal(readJson(desktopConfig).mcpServers['ssh-manager'], undefined, 'nothing written while it runs');
  claudeDesktopRunning = false;
  client = await useEngine('claude-desktop', 'app', context);
  assert.equal(client.engine, 'app');
  written = readJson(desktopConfig);
  assert.deepEqual(written.mcpServers.files, { command: 'files-mcp' });
  assert.equal(written.globalShortcut, 'Cmd+Space');
  assert.deepEqual(written.mcpServers['ssh-manager'].env, { ELECTRON_RUN_AS_NODE: '1' });
  ok('Claude Desktop: refused while it runs (it would undo the edit), written once it is closed, the rest kept');

  // ── Codex: one table replaced in place ────────────────────────────────────
  const codexToml = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexToml), { recursive: true });
  fs.writeFileSync(codexToml, [
    '# my settings',
    'model = "gpt-5"',
    '',
    '[mcp_servers.ssh-manager]',
    'command = "/usr/local/bin/node"',
    `args = ["${path.join(npmRoot, 'src', 'index.js')}"]`,
    '',
    '[mcp_servers.ssh-manager.env]',
    'SSH_CONFIG_PATH = "/Users/me/.codex/ssh-config.toml"',
    '',
    '# another server, after ours',
    '[mcp_servers.files]',
    'command = "files-mcp"',
    '',
  ].join('\n'));
  client = await useEngine('codex', 'app', context);
  assert.equal(client.engine, 'app');
  const text = fs.readFileSync(codexToml, 'utf8');
  assert.match(text, /^# my settings\nmodel = "gpt-5"\n/, 'the start of the file is untouched');
  assert.match(text, /# another server, after ours\n\[mcp_servers\.files\]\ncommand = "files-mcp"/);
  assert.equal(text.match(/\[mcp_servers\.ssh-manager/g).length, 1, 'one ssh-manager table, its old env table gone');
  assert.ok(text.indexOf('[mcp_servers.ssh-manager]') < text.indexOf('[mcp_servers.files]'), 'where the old table stood, not moved to the end');
  const parsed = /** @type {any} */ (TOML.parse(text));
  assert.deepEqual(parsed.mcp_servers['ssh-manager'].env, { SSH_CONFIG_PATH: '/Users/me/.codex/ssh-config.toml', ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(parsed.mcp_servers['ssh-manager'].command, path.join(appBundle, 'Contents', 'MacOS', 'SSH Manager'));
  assert.equal(parsed.mcp_servers.files.command, 'files-mcp');
  ok('Codex: its ssh-manager table replaced in place; comments, other settings and SSH_CONFIG_PATH kept');

  // ── what cannot be done ──────────────────────────────────────────────────
  await assert.rejects(useEngine('cursor', 'npm', context), error => error.status === 404);
  const noNpm = { ...context, which: async name => (name === 'mcp-ssh-manager' ? null : commands[name] ?? null) };
  await assert.rejects(useEngine('codex', 'npm', noNpm), error => error.status === 409 && /not installed with npm/.test(error.message));
  const before = fs.readFileSync(codexToml, 'utf8');
  fs.writeFileSync(codexToml, `${before}\n[mcp_servers]\nssh-manager.command = "x"\n`);
  const broken = fs.readFileSync(codexToml, 'utf8');
  await assert.rejects(useEngine('codex', 'npm', context), error => error.status === 409 && /change it by hand/.test(error.message));
  assert.equal(fs.readFileSync(codexToml, 'utf8'), broken, 'a file it cannot edit safely is left exactly as it was');
  fs.writeFileSync(codexToml, before);
  ok('an unknown tool is a 404; an engine that is not installed, or a Codex file it cannot edit safely, is refused with nothing written');

  // ── classification ───────────────────────────────────────────────────────
  assert.deepEqual(describeEntry(null), { engine: null, version: null });
  assert.equal(describeEntry({ command: 'npx', args: ['-y', 'mcp-ssh-manager'] }).engine, 'npm');
  assert.equal(describeEntry({ command: 'C:\\Users\\u\\AppData\\Local\\Programs\\SSH Manager\\SSH Manager.exe',
    args: ['C:\\Users\\u\\AppData\\Local\\Programs\\SSH Manager\\resources\\engine\\src\\index.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }).engine, 'app');
  assert.equal(describeEntry({ command: 'node', args: ['/src/checkout/src/index.js'] }).engine, 'other');
  ok('an entry is recognised as npm\'s (npx included), the application\'s (Windows paths too) or something else');

  // ── the interface's endpoints ────────────────────────────────────────────
  const plane = new ControlPlane({
    socketPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-')), 'a.sock'),
    port: 0,
    vaultPath: path.join(scratch, 'vault.json'),
    agents: { platform: 'darwin', env: {}, home, desktop: context.desktop, which: context.which, run: context.run },
  });
  const { url } = await plane.start();
  const api = (route, init) => fetch(`${new URL(url).origin}${route}?${new URL(url).search.slice(1)}`, init);
  try {
    let response = await api('/api/agents');
    assert.equal(response.status, 200);
    const body = await response.json();
    // Claude Code's last switch went through its stand-in `claude` command, which writes nothing.
    assert.deepEqual(body.clients.map(c => c.engine), ['npm', 'app', 'app']);
    response = await api('/api/agents/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: 'codex', engine: 'npm' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).client.engine, 'npm');
    response = await api('/api/agents/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: 'codex', engine: 'docker' }) });
    assert.equal(response.status, 400);
    assert.equal((await fetch(`${new URL(url).origin}/api/agents`)).status, 401, 'token required like every other endpoint');
  } finally {
    await plane.stop();
  }
  ok('GET /api/agents and POST /api/agents/use: status, switch, bad input refused, token required');

  // ── for real: the written configuration starts a working engine ──────────
  const real = agentContext({
    platform: process.platform,
    env: {},
    home,
    desktop: () => ({ supported: false, installed: false, path: null, version: null, method: null }),
    which: async name => ({ node: process.execPath, 'mcp-ssh-manager': path.join(repo, 'src', 'index.js') })[name] ?? null,
    run: context.run,
  });
  await useEngine('codex', 'npm', real);
  const entry = /** @type {any} */ (TOML.parse(fs.readFileSync(codexToml, 'utf8'))).mcp_servers['ssh-manager'];
  const engineHome = path.join(scratch, 'engine-home');
  fs.mkdirSync(engineHome);
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { PATH: process.env.PATH, HOME: engineHome, SSH_MANAGER_HOME: engineHome, SSH_ENV_PATH: path.join(engineHome, '.env'),
      SSH_CONFIG_PATH: path.join(engineHome, 'absent.toml'), SSH_LOG_LEVEL: 'ERROR', ...entry.env },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const mcp = new Client({ name: 'agents-test', version: '1.0' });
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  await mcp.close();
  assert.ok(tools.some(tool => tool.name === 'ssh_execute'), 'the engine the configuration names answers with its tools');
  ok('the configuration written for a tool starts a real engine that answers over MCP');

  console.log(`\n✅ AI tools engine switch tests passed (${passed} checks)`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
