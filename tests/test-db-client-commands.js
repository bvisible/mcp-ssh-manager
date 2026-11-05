// ssh_db_query and the database clients' own commands (GHSA-qmf5-hrhv-5hjm).
//
// ssh_db_query is the read-only tool, allowed on servers in `readonly` and
// `restricted` mode and never held for approval. Its SQL went to the remote
// `psql` or `mysql` client as the client's input, and both clients run commands
// of their own found there: `\!` runs a shell command (psql and mysql), `\o |cmd`
// pipes to one (psql), `system` does the same at the start of a line (mysql).
// A query such as `SELECT 1 \! id` passed the SELECT-only check, so a read-only
// query was a shell on the target.
//
// Now psql receives each statement as a single-quoted `-c` argument, which it
// sends to the server as it is, and a MySQL query may hold neither a backslash
// nor a line break (the mysql client reads those even from `-e`).
//
// The first part checks the commands that are built. The second runs the
// report's payloads through the real engine, over SSH, to a server in readonly
// mode whose fixture executes what it receives with /bin/sh, against a
// throwaway PostgreSQL and MariaDB/MySQL started here when their binaries are
// installed (skipped, and said so, where they are not).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoMySQLClientCommands, buildMySQLQueryCommand, buildPostgreSQLQueryCommand, isSafeQuery,
} from '../src/database-manager.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

// ── the commands that are built ─────────────────────────────────────────────
const PG_PAYLOADS = [
  'SELECT 1\n\\! echo pwned > PROOF',
  'SELECT 1 \\! echo pwned > PROOF',
  'SELECT 1\n\\o |cat > PROOF',
  "SELECT 1\n\\copy (SELECT 1) TO PROGRAM 'cat > PROOF'",
];
const MYSQL_PAYLOADS = [
  'SELECT 1\n\\! echo pwned > PROOF',
  'SELECT 1 \\! echo pwned > PROOF',
  'SELECT 1\nsystem echo pwned > PROOF',
  'SELECT 1\rsystem echo pwned > PROOF',
  'SELECT 1 \\. /tmp/x.sql',
];
{
  // The payloads are SELECTs to the SELECT-only check; what changes is where they go.
  for (const query of [...PG_PAYLOADS, ...MYSQL_PAYLOADS]) assert.equal(isSafeQuery(query), true, query);

  for (const query of PG_PAYLOADS) {
    const command = buildPostgreSQLQueryCommand({ database: 'app', query });
    assert.ok(!command.includes('<<'), `psql must not read the query as a script: ${command}`);
    const argv = execFileSync('/bin/sh', ['-c', `psql() { for a in "$@"; do printf '%s\\0' "$a"; done; }; ${command}`])
      .toString('utf8').split('\0').slice(0, -1);
    assert.deepEqual(argv.slice(-6), ['-c', 'BEGIN TRANSACTION READ ONLY', '-c', query.trim(), '-c', 'ROLLBACK']);
  }
  ok('PostgreSQL: the query is a -c argument psql sends to the server, inside a read-only transaction, never its input');

  for (const query of MYSQL_PAYLOADS) {
    assert.throws(() => buildMySQLQueryCommand({ database: 'app', query }), /one line without backslashes/, JSON.stringify(query));
  }
  assert.throws(() => assertNoMySQLClientCommands("SELECT 'a\\nb'"), /backslash/, 'a backslash inside a literal too: the client does not know it is one');
  assert.throws(() => assertNoMySQLClientCommands('SELECT 1\u0000'), /one line/);
  for (const query of ['SELECT 1', 'SELECT 1;\n', '  select\tname FROM t WHERE x = 1  ', "SELECT `a b` FROM t WHERE note LIKE '%x%'"]) {
    assert.doesNotThrow(() => buildMySQLQueryCommand({ database: 'app', query }), query);
  }
  ok('MySQL: a backslash, a line break or another control character is refused; a one-line SELECT (tabs, backticks) is built');
}

// ── the real thing ──────────────────────────────────────────────────────────
if (process.platform === 'win32') {
  console.log('(no POSIX shell to run the fixture on Windows: the end-to-end part is skipped)');
  console.log(`\n✅ database client command tests passed (${passed} checks)`);
  process.exit(0);
}

const which = (name, extra = []) => {
  for (const dir of [...extra, ...String(process.env.PATH).split(':')]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};
const globDirs = pattern => {
  const [base, rest] = pattern.split('*');
  try { return fs.readdirSync(path.dirname(base)).filter(n => n.startsWith(path.basename(base))).map(n => path.join(path.dirname(base), n + rest)).sort().reverse(); }
  catch { return []; }
};
const pgDirs = [...globDirs('/opt/homebrew/opt/postgresql@*/bin'), ...globDirs('/usr/local/opt/postgresql@*/bin'), ...globDirs('/usr/lib/postgresql/*/bin')];
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dbcc-'));
const stops = [];
try {
  // PostgreSQL, on a Unix socket in the scratch directory only.
  let pg = null;
  const initdb = which('initdb', pgDirs);
  const pgCtl = initdb && path.join(path.dirname(initdb), 'pg_ctl');
  const psql = which('psql', initdb ? [path.dirname(initdb)] : pgDirs);
  if (initdb && psql && fs.existsSync(pgCtl)) {
    const data = path.join(scratch, 'pg');
    const port = await freePort();
    const init = spawnSync(initdb, ['-D', data, '-U', 'fixture', '-A', 'trust'], { encoding: 'utf8' });
    const start = init.status === 0 && spawnSync(pgCtl, ['-D', data, '-o', `-p ${port} -k ${scratch} -c listen_addresses=''`, '-l', path.join(scratch, 'pg.log'), '-w', 'start'], { encoding: 'utf8' });
    if (start && start.status === 0) {
      pg = { port, bin: path.dirname(psql) };
      stops.push(() => spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']));
    }
  }

  // MariaDB or MySQL, on 127.0.0.1 only.
  let my = null;
  const mariadbd = which('mariadbd', ['/opt/homebrew/opt/mariadb/bin', '/usr/sbin']);
  const installDb = which('mariadb-install-db', ['/opt/homebrew/opt/mariadb/bin', '/usr/bin']);
  const mysqlClient = which('mysql', ['/opt/homebrew/opt/mariadb/bin', '/opt/homebrew/bin']);
  if (mariadbd && installDb && mysqlClient) {
    const data = path.join(scratch, 'my');
    const port = await freePort();
    const init = spawnSync(installDb, [`--datadir=${data}`, '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
    if (init.status === 0) {
      const server = spawn(mariadbd, ['--no-defaults', `--datadir=${data}`, `--socket=${path.join(scratch, 'my.sock')}`, `--port=${port}`,
        '--bind-address=127.0.0.1', `--pid-file=${path.join(scratch, 'my.pid')}`, `--log-error=${path.join(scratch, 'my.err')}`], { stdio: 'ignore' });
      stops.push(() => server.kill('SIGKILL'));
      const up = await until(() => new Promise(resolve => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); }), 30000);
      if (up) my = { port, bin: path.dirname(mysqlClient) };
    }
  }

  if (!pg && !my) {
    console.log('(no PostgreSQL or MariaDB binaries to start a throwaway server: the end-to-end part is skipped)');
  } else {
    // An SSH server that runs what it is sent with /bin/sh, as a real one would.
    const binPath = [pg?.bin, my?.bin, '/usr/bin', '/bin'].filter(Boolean).join(':');
    const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    const { default: ssh2 } = await import('ssh2');
    const sshd = new ssh2.Server({ hostKeys: [hostKey] }, client => {
      client.on('error', () => {});
      client.on('authentication', ctx => ctx.accept());
      client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, reject, info) => {
        const stream = acceptExec();
        const child = spawn('/bin/sh', ['-c', info.command], { cwd: scratch, env: { PATH: binPath, HOME: scratch } });
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream.stderr, { end: false });
        child.on('close', code => { stream.exit(code ?? 1); stream.end(); });
      })));
    });
    await new Promise(resolve => sshd.listen(0, '127.0.0.1', resolve));
    stops.push(() => sshd.close());

    const preload = path.join(scratch, 'isolated-home.mjs');
    fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.homedir = () => process.env.SSH_TEST_HOME; syncBuiltinESMExports();");
    const envFile = path.join(scratch, 'servers.env');
    fs.writeFileSync(envFile, `SSH_SERVER_TARGET_HOST=127.0.0.1\nSSH_SERVER_TARGET_PORT=${sshd.address().port}\nSSH_SERVER_TARGET_USER=fixture\nSSH_SERVER_TARGET_PASSWORD=fixture\nSSH_SERVER_TARGET_MODE=readonly\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
    Object.assign(env, { SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'), SSH_MANAGER_HOME: scratch,
      SSH_MANAGER_KEY_SOURCE: 'file', SSH_MANAGER_VAULT: path.join(scratch, 'vault.json'), SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
      SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'), SSH_LOG_LEVEL: 'ERROR', SSH_TEST_HOME: scratch });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, path.join(ROOT, 'src', 'index.js')], cwd: scratch, env, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'db-client-commands', version: '1.0' });
    stops.unshift(() => client.close().catch(() => {}));
    await client.connect(transport);
    const query = async (type, sql, extra) => {
      const result = await client.callTool({ name: 'ssh_db_query', arguments: { server: 'target', type, database: type === 'postgresql' ? 'postgres' : 'mysql', query: sql, ...extra } });
      return { error: Boolean(result.isError), text: result.content.map(item => item.text || '').join('\n') };
    };

    if (pg) {
      const opts = { dbUser: 'fixture', dbHost: scratch, dbPort: pg.port };
      const answer = await query('postgresql', 'SELECT 41 + 1 AS answer', opts);
      assert.ok(!answer.error && /42/.test(answer.text), answer.text);
      assert.ok(/42/.test((await query('postgresql', 'SELECT\n  41 + 1\n  AS answer', opts)).text), 'a multi-line query still works');
      assert.ok(/\bt\b/.test((await query('postgresql', "SELECT 'a1' ~ '\\d' AS digit", opts)).text), 'a backslash in a literal still works');
      for (const [i, payload] of PG_PAYLOADS.entries()) {
        const proof = path.join(scratch, `proof-pg-${i}`);
        await query('postgresql', payload.replace('PROOF', proof), opts);
        assert.equal(fs.existsSync(proof), false, `psql ran a shell command from ${JSON.stringify(payload)}`);
      }
      ok(`PostgreSQL (real psql, server in readonly mode): queries answer, none of the ${PG_PAYLOADS.length} payloads reaches a shell`);
    } else {
      console.log('(no PostgreSQL here: the real psql check is skipped)');
    }

    if (my) {
      const opts = { dbUser: 'root', dbHost: '127.0.0.1', dbPort: my.port };
      const answer = await query('mysql', 'SELECT 41 + 1', opts);
      assert.ok(!answer.error && /42/.test(answer.text), answer.text);
      for (const [i, payload] of MYSQL_PAYLOADS.entries()) {
        const proof = path.join(scratch, `proof-my-${i}`);
        const result = await query('mysql', payload.replace('PROOF', proof), opts);
        // The tool reports a refused query in its text, as it reports any failed one.
        assert.match(result.text, /query failed: MySQL queries must be one line without backslashes/, result.text);
        assert.equal(fs.existsSync(proof), false, `mysql ran a shell command from ${JSON.stringify(payload)}`);
      }
      ok(`MySQL/MariaDB (real client, server in readonly mode): a query answers, the ${MYSQL_PAYLOADS.length} payloads are refused and none reaches a shell`);
    } else {
      console.log('(no MariaDB here: the real mysql check is skipped)');
    }
  }
} finally {
  for (const stop of stops) { try { await stop(); } catch { /* going away anyway */ } }
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n✅ database client command tests passed (${passed} checks)`);
process.exit(0);
