// `ssh-manager codex setup|status`, and the Codex entry ConfigLoader writes.
//
// The entry used to be built from process.cwd(): args = [<cwd>/src/index.js], a file
// that exists only when the command is run from a source checkout. For everyone who
// installed with npm it named nothing, so Codex started no engine. Found by reading
// jaredshuai's fork, whose TypeScript port had the same line. The commands the
// documentation listed (setup, migrate, test, convert) did not exist at all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentContext } from '../src/agent-clients.js';
import { codexCommand } from '../cli/codex.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-codex-'));
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
process.env.SSH_LOG_FILE = path.join(scratch, 'log');
process.env.SSH_HISTORY_FILE = path.join(scratch, 'history');
const { ConfigLoader } = await import('../src/config-loader.js');

const capture = () => { const lines = []; return { lines, log: text => lines.push(text), error: text => lines.push(text) }; };
const world = home => agentContext({
  platform: process.platform,
  env: {},
  home,
  desktop: () => ({ supported: false, installed: false, path: null, version: null, method: null }),
  which: async name => ({ node: process.execPath, 'mcp-ssh-manager': path.join(repo, 'src', 'index.js') })[name] ?? null,
  run: async () => ({ code: 1, stdout: '', stderr: '' }),
});

try {
  // ── the entry ConfigLoader writes ─────────────────────────────────────────
  {
    const elsewhere = path.join(scratch, 'somewhere else');
    fs.mkdirSync(elsewhere);
    const config = path.join(scratch, 'config.toml');
    fs.writeFileSync(config, '# my own settings\nmodel = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n');
    const here = process.cwd();
    process.chdir(elsewhere);
    try { await new ConfigLoader().saveToCodexConfig(config); } finally { process.chdir(here); }
    const entry = /** @type {any} */ (TOML.parse(fs.readFileSync(config, 'utf8'))).mcp_servers['ssh-manager'];
    assert.equal(entry.args[0], path.join(repo, 'src', 'index.js'), 'the entry names this engine, not <cwd>/src/index.js');
    assert.ok(fs.existsSync(entry.args[0]), 'and it exists');
    const written = /** @type {any} */ (TOML.parse(fs.readFileSync(config, 'utf8')));
    assert.equal(written.model, 'o4');
    assert.equal(written.mcp_servers.other.command, 'other', 'other tables are kept');
    ok('the Codex entry names the engine by its own location, whatever directory the command runs from');
  }

  // ── setup ─────────────────────────────────────────────────────────────────
  {
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const file = path.join(home, '.codex', 'config.toml');
    const original = '# kept\nmodel = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n';
    fs.writeFileSync(file, original);

    const status = capture();
    assert.equal(await codexCommand(['status'], world(home), status), 0);
    assert.match(status.lines.join('\n'), /nothing yet/);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'status writes nothing');

    const out = capture();
    assert.equal(await codexCommand(['setup'], world(home), out), 0, out.lines.join('\n'));
    assert.match(out.lines.join('\n'), /Codex now runs the npm engine/);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith('# kept\nmodel = "o4"'), 'the comment and the other settings stay as they were');
    const parsed = /** @type {any} */ (TOML.parse(text));
    assert.equal(parsed.mcp_servers.other.command, 'other');
    assert.equal(parsed.mcp_servers['ssh-manager'].args[0], path.join(repo, 'src', 'index.js'));
    assert.match((await (async () => { const o = capture(); await codexCommand(['status'], world(home), o); return o.lines.join('\n'); })()), /runs the npm engine/);

    // The configuration written is one that starts a working engine.
    const entry = parsed.mcp_servers['ssh-manager'];
    const engineHome = path.join(scratch, 'engine-home');
    fs.mkdirSync(engineHome);
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args,
      env: { PATH: process.env.PATH, HOME: engineHome, SSH_MANAGER_HOME: engineHome, SSH_ENV_PATH: path.join(engineHome, '.env'),
        SSH_CONFIG_PATH: path.join(engineHome, 'absent.toml'), SSH_LOG_LEVEL: 'ERROR', ...entry.env }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'codex-setup', version: '1.0' });
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'ssh_execute'));
    await client.close();
    ok('setup writes the ssh-manager entry for the npm engine, leaves the rest of the file, and the entry starts a real engine');

    assert.equal(await codexCommand(['setup'], world(home), capture()), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'a second setup changes nothing');
    ok('running setup again changes nothing');
  }

  // ── refusals ──────────────────────────────────────────────────────────────
  {
    const home = path.join(scratch, 'home2');
    const noNpm = { ...world(home), which: async () => null };
    const out = capture();
    assert.equal(await codexCommand(['setup'], noNpm, out), 1);
    assert.match(out.lines.join('\n'), /npm install -g mcp-ssh-manager/);
    assert.ok(!fs.existsSync(path.join(home, '.codex')), 'nothing is written when there is no engine to name');
    const unknown = capture();
    assert.equal(await codexCommand(['migrate'], world(home), unknown), 2);
    assert.match(unknown.lines.join('\n'), /Unknown command: codex migrate/);
    assert.equal(await codexCommand([], world(home), capture()), 2);
    ok('without an npm install setup says how to get one and writes nothing; an unknown command is refused');
  }

  // ── through the real CLI ──────────────────────────────────────────────────
  {
    const home = path.join(scratch, 'home3');
    fs.mkdirSync(home);
    const run = (...args) => spawnSync(process.execPath, [path.join(repo, 'cli', 'ssh-manager.js'), ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, SSH_MANAGER_HOME: path.join(home, 'sm') } });
    const help = run('--help');
    assert.match(help.stdout, /codex setup\|status/, 'the help lists it');
    const status = run('codex', 'status');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Codex (is installed|was not found here)/);
    assert.equal(run('codex', 'migrate').status, 2);
    assert.ok(!fs.existsSync(path.join(home, '.codex')), 'status writes nothing');
    ok('through the real command line: listed in the help, status answers and writes nothing');
  }

  console.log(`\n✅ Codex command tests passed (${passed} checks)`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
