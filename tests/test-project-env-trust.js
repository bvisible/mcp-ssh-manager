// Security regression test for GHSA-wxcj-q5hp-wjrw.
//
// The engine read `.env` from the working directory, which is whatever project
// the MCP client was started in. That file can define a server with a
// PROXYCOMMAND (or point SSH_CONFIG_PATH at a TOML that does), and the engine
// runs it on this machine when a tool connects to that server: before any SSH
// banner, before authentication, whatever the mode or the approval.
//
// The working directory's .env is now read only when the user placed it (it is
// the manager home's, the home directory's or the install directory's file) or
// when the environment of the MCP server says SSH_MANAGER_TRUST_PROJECT_ENV.
//
// This drives the real stdio entry point, with a command that creates a file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-project-env-')));
// The engine under test runs from a copy of the sources. The checkout's own `.env` is the
// install directory's file, which is read on purpose, and CI writes one there with a test server.
const engine = path.join(scratch, 'engine');
fs.mkdirSync(engine);
fs.cpSync(path.join(repo, 'src'), path.join(engine, 'src'), { recursive: true });
fs.copyFileSync(path.join(repo, 'package.json'), path.join(engine, 'package.json'));
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(engine, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
let counter = 0;

/** A fresh home, manager home and project folder, each its own folder. */
function layout() {
  const root = path.join(scratch, `case-${++counter}`);
  const home = path.join(root, 'home');
  const managerHome = path.join(home, '.ssh-manager');
  const project = path.join(root, 'project');
  for (const dir of [home, project]) fs.mkdirSync(dir, { recursive: true });
  return { root, home, managerHome, project, canary: path.join(root, 'canary') };
}

const SERVER = (name, extra = '') => `SSH_SERVER_${name}_HOST=127.0.0.1\nSSH_SERVER_${name}_USER=nobody\n${extra}`;

/** The environment an engine would get from a client, with nothing of ours in it. */
function engineEnv({ home, managerHome }, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, SSH_MANAGER_HOME: managerHome, ...extra };
  for (const name of ['SSH_ENV_PATH', 'SSH_MANAGER_ENV', 'SSH_CONFIG_PATH', 'PREFER_TOML_CONFIG', 'SSH_MANAGER_TRUST_PROJECT_ENV']) {
    if (!(name in extra)) delete env[name];
  }
  // CI defines servers of its own in the environment (SSH_SERVER_TEST_*): they would load
  // beside the ones under test, and the lists below are meant to be empty.
  for (const name of Object.keys(env)) if (name.startsWith('SSH_SERVER_') && !(name in extra)) delete env[name];
  return env;
}

/** Run `body` against a real engine started in `cwd`, and close it after. */
async function withEngine(cwd, env, body) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(engine, 'src', 'index.js')],
    cwd,
    env,
    stderr: 'pipe'
  });
  let log = '';
  transport.stderr?.on('data', chunk => { log += chunk.toString(); });
  const client = new Client({ name: 'project-env-trust', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await body(client, () => log);
  } finally {
    await client.close();
  }
}

const text = result => result.content.map(item => item.text).join('\n');
const servers = async client => JSON.parse((await client.callTool({ name: 'ssh_list_servers', arguments: {} })).content[0].text);
const connect = (client, server = 'lab') => client.callTool({
  name: 'ssh_download', arguments: { server, remotePath: '/etc/hostname', localPath: 'download.txt' }
});

// 1. The choice itself.
{
  const { envFileChoice, envFileProblem } = await import('../src/config-paths.js');
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  const choose = (where, extra = {}, options) => {
    process.chdir(where.project);
    process.env.HOME = where.home;
    process.env.USERPROFILE = where.home;
    process.env.SSH_MANAGER_HOME = where.managerHome;
    for (const name of ['SSH_ENV_PATH', 'SSH_MANAGER_ENV', 'SSH_MANAGER_TRUST_PROJECT_ENV']) delete process.env[name];
    Object.assign(process.env, extra);
    return envFileChoice({ projectRoot: path.join(where.root, 'install'), ...options });
  };
  try {
    const where = layout();
    const projectEnv = path.join(where.project, '.env');
    const managerEnv = path.join(where.managerHome, '.env');
    fs.writeFileSync(projectEnv, SERVER('LAB', 'SSH_SERVER_LAB_PROXYCOMMAND=touch x\n'));

    let choice = choose(where);
    assert.equal(choice.path, managerEnv, 'with nothing else, the manager home is the place, not the project');
    assert.equal(choice.skippedProject, projectEnv, 'the project file that sets up a server is named');
    assert.match(envFileProblem(choice), /was not read: a project file is not trusted .*SSH_MANAGER_TRUST_PROJECT_ENV=1/);
    ok('a project .env is not chosen, and the engine is told it was left unread');

    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      choice = choose(where, { SSH_MANAGER_TRUST_PROJECT_ENV: value });
      assert.equal(choice.path, projectEnv, `${value} trusts the project file`);
      assert.equal(choice.skippedProject, null);
    }
    for (const value of ['0', 'false', 'no', '', 'maybe']) {
      assert.equal(choose(where, { SSH_MANAGER_TRUST_PROJECT_ENV: value }).path, managerEnv, `"${value}" does not`);
    }
    ok('the environment variable trusts it, only when it says yes');

    fs.mkdirSync(path.dirname(managerEnv), { recursive: true });
    fs.writeFileSync(managerEnv, SERVER('OWN'));
    choice = choose(where);
    assert.equal(choice.path, managerEnv);
    assert.equal(choice.skippedProject, null, 'with a manager-home file the project one was never read: nothing to say');
    ok('with a file in the manager home the project one is unchanged: ignored, and said nothing about');
    fs.rmSync(managerEnv);

    fs.writeFileSync(path.join(where.home, '.env'), SERVER('HOME'));
    choice = choose(where);
    assert.equal(choice.path, path.join(where.home, '.env'), 'the home .env is read in place of the project one');
    assert.equal(choice.skippedProject, projectEnv);
    fs.rmSync(path.join(where.home, '.env'));
    ok('a project file no longer hides the home .env');

    // Files the user placed are the user's, even when they are the working directory.
    const install = path.join(where.root, 'install');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, '.env'), SERVER('INSTALL'));
    process.chdir(install);
    choice = envFileChoice({ projectRoot: install });
    assert.equal(choice.path, path.join(install, '.env'), 'run from a checkout, its own .env is read as before');
    assert.equal(choice.skippedProject, null);
    process.chdir(where.home);
    fs.writeFileSync(path.join(where.home, '.env'), SERVER('HOME'));
    choice = envFileChoice({ projectRoot: install });
    assert.equal(choice.path, path.join(where.home, '.env'));
    assert.equal(choice.skippedProject, null, 'started from the home directory, the home .env is the same file');
    ok('the install directory and the home directory keep reading their own .env');

    // Explicit choices are not touched.
    const named = path.join(where.root, 'named.env');
    fs.writeFileSync(named, SERVER('NAMED'));
    assert.equal(choose(where, { SSH_ENV_PATH: named }).path, named);
    assert.equal(choose(where, { SSH_MANAGER_ENV: named }).path, named);
    ok('SSH_ENV_PATH and SSH_MANAGER_ENV name a file as before');

    // Most repositories have a .env of their own: say nothing about those.
    const plain = layout();
    fs.writeFileSync(path.join(plain.project, '.env'), 'DATABASE_URL=postgres://localhost/app\nDEBUG=1\n');
    choice = choose(plain);
    assert.equal(choice.skippedProject, null, 'an application .env has no SSH server in it');
    assert.equal(envFileProblem(choice), null);
    ok('a project .env that sets up no server is left alone without a word');
  } finally {
    process.chdir(saved.cwd);
    for (const name of Object.keys(process.env)) if (!(name in saved.env)) delete process.env[name];
    Object.assign(process.env, saved.env);
  }
}

// 2. The engine, with the command of the advisory.
if (process.platform === 'win32') {
  console.log('(engine checks use `touch` and run on POSIX systems only)');
} else {
  // The .env of the advisory.
  {
    const where = layout();
    fs.writeFileSync(path.join(where.project, '.env'), SERVER('LAB', `SSH_SERVER_LAB_PROXYCOMMAND=touch ${where.canary}\n`));
    await withEngine(where.project, engineEnv(where), async (client, log) => {
      assert.deepEqual(await servers(client), [], 'the server of a project .env is not loaded');
      const note = text(await client.callTool({ name: 'ssh_list_servers', arguments: {} }));
      assert.match(note, /No server loaded: .*\.env was not read/);
      const result = await connect(client);
      assert.equal(result.isError ?? false, true);
      assert.match(text(result), /Server "lab" not found \(.*\.env was not read: a project file is not trusted/);
      assert.equal(fs.existsSync(where.canary), false, 'the command of the project file did not run');
      assert.match(log(), /\.env was not read/, 'startup says so');
    });
    ok('GHSA-wxcj-q5hp-wjrw: a project .env with a PROXYCOMMAND runs nothing, and the answer says why');
  }

  // The same through SSH_CONFIG_PATH and a TOML in the project.
  {
    const where = layout();
    const toml = path.join(where.project, 'ssh.toml');
    fs.writeFileSync(toml, `[ssh_servers.lab]\nhost = "127.0.0.1"\nuser = "nobody"\nproxy_command = "touch ${where.canary}"\n`);
    fs.writeFileSync(path.join(where.project, '.env'), `SSH_CONFIG_PATH=${toml}\n`);
    await withEngine(where.project, engineEnv(where), async client => {
      assert.deepEqual(await servers(client), []);
      await connect(client);
      assert.equal(fs.existsSync(where.canary), false, 'a TOML named by the project .env is not read either');
    });
    ok('a project .env cannot bring in a TOML with a proxy_command');
  }

  // A file the agent writes into the project after the engine has started.
  {
    const where = layout();
    await withEngine(where.project, engineEnv(where), async client => {
      assert.deepEqual(await servers(client), []);
      fs.writeFileSync(path.join(where.project, '.env'), SERVER('LAB', `SSH_SERVER_LAB_PROXYCOMMAND=touch ${where.canary}\n`));
      assert.deepEqual(await servers(client), [], 'a running engine does not pick the new file up');
      await connect(client);
      assert.equal(fs.existsSync(where.canary), false);
    });
    ok('a .env written into the project while the engine runs is not loaded');
  }

  // Opting in keeps what worked: the working directory's .env, for who chose it.
  {
    const where = layout();
    fs.writeFileSync(path.join(where.project, '.env'), SERVER('LAB', `SSH_SERVER_LAB_PROXYCOMMAND=touch ${where.canary}\n`));
    await withEngine(where.project, engineEnv(where, { SSH_MANAGER_TRUST_PROJECT_ENV: '1' }), async client => {
      assert.deepEqual((await servers(client)).map(server => server.name), ['lab']);
      await connect(client);
      assert.equal(fs.existsSync(where.canary), true, 'opted in, the project file is read as it was');
    });
    ok('SSH_MANAGER_TRUST_PROJECT_ENV=1 in the environment of the engine reads the project .env as before');
  }

  // A project file cannot grant itself the trust.
  {
    const where = layout();
    fs.writeFileSync(path.join(where.project, '.env'),
      SERVER('LAB', `SSH_SERVER_LAB_PROXYCOMMAND=touch ${where.canary}\n`) + 'SSH_MANAGER_TRUST_PROJECT_ENV=1\n');
    await withEngine(where.project, engineEnv(where), async client => {
      assert.deepEqual(await servers(client), []);
      await connect(client);
      assert.equal(fs.existsSync(where.canary), false, 'the project file cannot vouch for itself');
    });
    ok('SSH_MANAGER_TRUST_PROJECT_ENV written in the project .env does nothing');
  }

  // The user's own file wins, with the project's in the way, as before.
  {
    const where = layout();
    fs.mkdirSync(where.managerHome, { recursive: true });
    fs.writeFileSync(path.join(where.managerHome, '.env'), SERVER('OWN'));
    fs.writeFileSync(path.join(where.project, '.env'), SERVER('LAB', `SSH_SERVER_LAB_PROXYCOMMAND=touch ${where.canary}\n`));
    await withEngine(where.project, engineEnv(where), async (client, log) => {
      assert.deepEqual((await servers(client)).map(server => server.name), ['own']);
      assert.doesNotMatch(log(), /was not read/, 'nothing changed for this user, so nothing to say');
      assert.equal((await client.callTool({ name: 'ssh_list_servers', arguments: {} })).content.length, 1);
    });
    ok('with a file in the manager home the engine behaves, and reads, exactly as before');
  }

  // An ordinary project: its .env is none of our business.
  {
    const where = layout();
    fs.writeFileSync(path.join(where.project, '.env'), 'DATABASE_URL=postgres://localhost/app\n');
    await withEngine(where.project, engineEnv(where), async (client, log) => {
      assert.deepEqual(await servers(client), []);
      assert.equal((await client.callTool({ name: 'ssh_list_servers', arguments: {} })).content.length, 1);
      assert.doesNotMatch(log(), /was not read/);
    });
    ok('an application .env in the project produces no warning and no extra line in the list');
  }
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n✅ project .env trust tests passed (${passed} checks)`);
