// A backup whose dump failed must fail; a restore of a corrupt archive must not
// start. Both used to look like successes.
//
// `mysqldump ... | gzip > out` reports gzip's exit code: with a wrong password, a
// missing database or a full disk the dump died, gzip still succeeded, the file was
// an empty archive of 20 bytes and ssh_db_dump / ssh_backup_create answered
// success. `gunzip -c dump.gz | mysql` ran mysql on whatever gunzip had read, so a
// truncated archive was restored in part, without an error. A MongoDB backup was
// written as <id>.tar.gz but measured and restored as <id>.gz: a size of 0, and no
// way back. Found by reading jaredshuai's fork.
//
// The commands run for real, under every shell this machine has as the account's
// login shell (csh and tcsh included), with dump programs that fail or succeed on
// demand; then through the real MCP entry point against an ssh2 server that runs
// what it is given.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildMySQLDumpCommand as dbMysqlDump, buildPostgreSQLDumpCommand as dbPgDump, buildMySQLImportCommand, buildPostgreSQLImportCommand, buildMongoDBDumpCommand as dbMongoDump } from '../src/database-manager.js';
import { buildMySQLDumpCommand, buildPostgreSQLDumpCommand, buildMongoDBDumpCommand, buildRestoreCommand, backupExtension } from '../src/backup-manager.js';
import { guardedDump, guardedFeed, mongoArchivePath } from '../src/dump-guard.js';

if (process.platform === 'win32') {
  console.log('Skipped: the commands run under POSIX shells.');
  process.exit(0);
}

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-backup-integrity-'));
const bin = path.join(scratch, 'bin');
const work = path.join(scratch, 'work');
fs.mkdirSync(bin);
fs.mkdirSync(work);
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

// Dump and restore programs, faked. A file named fail-<program> beside them makes
// that program fail (after printing something, like a real dump that dies midway).
const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
for (const dumper of ['mysqldump', 'pg_dump']) {
  script(dumper, `echo "-- ${dumper} output"\nif [ -e "${bin}/fail-${dumper}" ]; then echo "${dumper}: access denied" >&2; exit 2; fi\necho "dump body of ${dumper}"`);
}
script('mysql', `cat > "${work}/mysql-received"`);
script('pg_restore', `cat > "${work}/pg-received"`);
script('mongodump', `out=""; db=""; while [ $# -gt 0 ]; do case "$1" in --out) out=$2; shift;; --db) db=$2; shift;; esac; shift; done\nif [ -e "${bin}/fail-mongodump" ]; then echo "mongodump: failed" >&2; exit 2; fi\nmkdir -p "$out/$db" && echo bson > "$out/$db/c.bson"`);
script('mongorestore', `echo "$@" > "${work}/mongorestore-args"; for last; do :; done; ls "$last" > "${work}/mongorestore-listing" 2>&1`);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const failing = (program, on) => (on ? fs.writeFileSync(path.join(bin, `fail-${program}`), '') : fs.rmSync(path.join(bin, `fail-${program}`), { force: true }));
const run = (shell, command) => spawnSync(shell, ['-c', command], { env, encoding: 'utf8' });
const gunzip = file => zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');

// ── the commands are one simple command of single-quoted words ──────────────
{
  for (const command of [guardedDump("mysqldump 'db'", '/b/o ut.gz', true), guardedDump('x', '/b/o', false), guardedFeed('/b/in.gz', "mysql 'db'")]) {
    assert.match(command, /^sh -c '(?:[^']|'\\'')*' sh '(?:[^']|'\\'')*'(?: '(?:[^']|'\\'')*')*(?: [01])?$/, command);
  }
  ok('both guards are one simple command of single-quoted words, which any login shell accepts');
}

// ── a dump that fails fails, and leaves nothing behind, under every login shell ─
const shells = ['sh', 'bash', 'dash', 'zsh', 'ksh', 'tcsh', 'csh'].filter(name => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0);
const dumpers = {
  'ssh_db_dump mysql': (file, compress) => dbMysqlDump({ database: 'shop', user: 'u', password: 'p w', outputFile: file, compress }),
  'ssh_db_dump postgresql': (file, compress) => dbPgDump({ database: 'shop', user: 'u', password: 'p w', outputFile: file, compress }),
  'ssh_backup_create mysql': (file, compress) => buildMySQLDumpCommand({ database: 'shop', user: 'u', password: 'p w', outputFile: file, compress }),
  'ssh_backup_create postgresql': (file, compress) => buildPostgreSQLDumpCommand({ database: 'shop', user: 'u', password: 'p w', outputFile: file, compress }),
};
const program = label => (label.includes('postgresql') ? 'pg_dump' : 'mysqldump');
for (const [label, build] of Object.entries(dumpers)) {
  for (const shell of shells) {
    for (const compress of [true, false]) {
      const out = path.join(work, `out ${label.replace(/\W+/g, '-')}-${shell}-${compress}.dump`);
      failing(program(label), true);
      const failed = run(shell, build(out, compress));
      assert.notEqual(failed.status, 0, `${label} under ${shell} (compress ${compress}): a failed dump reported exit code 0`);
      assert.match(failed.stderr, /access denied/, 'the dump program\'s own message reaches the caller');
      assert.ok(!fs.existsSync(out), `${label} under ${shell}: a failed dump left ${out}`);
      assert.deepEqual(fs.readdirSync(work).filter(name => name.includes('.status.')), [], 'no status file is left behind');
      failing(program(label), false);
      const good = run(shell, build(out, compress));
      assert.equal(good.status, 0, `${label} under ${shell}: ${good.stderr}`);
      const content = compress ? gunzip(out) : fs.readFileSync(out, 'utf8');
      assert.equal(content, `-- ${program(label)} output\ndump body of ${program(label)}\n`, `${label} under ${shell}: the dump is intact`);
      assert.deepEqual(fs.readdirSync(work).filter(name => name.includes('.status.')), []);
    }
  }
}
ok(`all four dump builders fail when the dump fails, keep the dump's message, leave no file, and still work when it succeeds, compressed or not, under ${shells.join(', ')}`);

// ── a restore of a corrupt archive never starts ─────────────────────────────
{
  const sql = 'CREATE TABLE t (id int);\n'.repeat(4000);
  const good = path.join(work, 'good.sql.gz');
  fs.writeFileSync(good, zlib.gzipSync(sql));
  const cut = path.join(work, 'cut.sql.gz');
  fs.writeFileSync(cut, fs.readFileSync(good).subarray(0, Math.floor(fs.statSync(good).size / 2)));
  const plain = path.join(work, 'plain under gz name.gz');
  fs.writeFileSync(plain, sql);
  const consumers = {
    'ssh_db_import mysql': file => buildMySQLImportCommand({ database: 'shop', user: 'u', inputFile: file }),
    'ssh_backup_restore mysql': file => buildRestoreCommand('mysql', file, { database: 'shop', user: 'u' }),
  };
  for (const [label, build] of Object.entries(consumers)) {
    for (const shell of shells) {
      fs.rmSync(path.join(work, 'mysql-received'), { force: true });
      const refused = run(shell, build(cut));
      assert.notEqual(refused.status, 0, `${label} under ${shell}: a truncated archive was restored`);
      assert.ok(!fs.existsSync(path.join(work, 'mysql-received')), `${label} under ${shell}: mysql started on a truncated archive`);
      const restored = run(shell, build(good));
      assert.equal(restored.status, 0, restored.stderr);
      assert.equal(fs.readFileSync(path.join(work, 'mysql-received'), 'utf8'), sql, `${label} under ${shell}: the whole dump arrives`);
      fs.rmSync(path.join(work, 'mysql-received'));
      const asIs = run(shell, build(plain));
      assert.equal(asIs.status, 0, asIs.stderr);
      assert.equal(fs.readFileSync(path.join(work, 'mysql-received'), 'utf8'), sql, `${label} under ${shell}: a plain file with a .gz name is fed as it is`);
    }
  }
  fs.rmSync(path.join(work, 'pg-received'), { force: true });
  assert.notEqual(run('sh', buildPostgreSQLImportCommand({ database: 'shop', inputFile: cut })).status, 0);
  assert.ok(!fs.existsSync(path.join(work, 'pg-received')), 'pg_restore started on a truncated archive');
  assert.equal(run('sh', buildPostgreSQLImportCommand({ database: 'shop', inputFile: good })).status, 0);
  assert.equal(fs.readFileSync(path.join(work, 'pg-received'), 'utf8'), sql);
  ok('a truncated archive is refused before the database program starts, a whole one arrives whole, a plain dump under a .gz name still restores');
}

// ── MongoDB: one archive path for the dump, the size, the record and the restore ─
{
  assert.equal(mongoArchivePath('/b/x'), '/b/x.tar.gz');
  assert.equal(backupExtension('mongodb', true), '.tar.gz');
  assert.equal(backupExtension('mongodb', false), '');
  for (const type of ['mysql', 'postgresql', 'files']) assert.equal(backupExtension(type, true), '.gz');
  for (const [label, build] of Object.entries({ db: dbMongoDump, backup: buildMongoDBDumpCommand })) {
    const dir = path.join(work, `mongo-${label}`);
    failing('mongodump', true);
    const refused = run('sh', build({ database: 'shop', outputDir: dir, outputFile: dir, compress: true }));
    assert.notEqual(refused.status, 0);
    assert.ok(!fs.existsSync(mongoArchivePath(dir)));
    failing('mongodump', false);
    assert.equal(run('sh', build({ database: 'shop', outputDir: dir, outputFile: dir, compress: true })).status, 0);
    assert.ok(fs.statSync(mongoArchivePath(dir)).size > 0, `${label}: the archive is where mongoArchivePath says`);
    assert.ok(!fs.existsSync(dir), 'the dump directory is removed once archived');
  }
  ok('a MongoDB archive is where mongoArchivePath() says, in both builders, and a failed mongodump leaves none');
}

// ── through the engine: the tools say what happened, and a backup can be restored ─
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const sockets = new Set();
const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => {});
  client.on('authentication', context => context.accept());
  client.on('ready', () => client.on('session', open => open().on('exec', (start, _reject, info) => {
    const stream = start();
    const child = spawn('/bin/sh', ['-c', info.command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => stream.write(chunk));
    child.stderr.on('data', chunk => stream.stderr.write(chunk));
    child.on('close', code => { stream.exit(code ?? 1); stream.end(); });
  })));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const envFile = path.join(scratch, 'servers.env');
fs.writeFileSync(envFile, ['SSH_SERVER_PROD_HOST=127.0.0.1', `SSH_SERVER_PROD_PORT=${server.address().port}`, 'SSH_SERVER_PROD_USER=fixture', 'SSH_SERVER_PROD_PASSWORD=fixture', ''].join('\n'));
const preload = path.join(scratch, 'isolated-home.mjs');
fs.writeFileSync(preload, "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const home = process.env.SSH_TEST_HOME; if (!home) throw new Error('SSH_TEST_HOME is not set'); os.homedir = () => home; syncBuiltinESMExports();");
const engineEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
Object.assign(engineEnv, {
  SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
  SSH_MANAGER_HOME: path.join(scratch, 'state'), SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
  SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'),
  SSH_LOG_LEVEL: 'ERROR', SSH_TEST_HOME: scratch,
});
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['--import', preload, path.join(repo, 'src/index.js')], cwd: repo, env: engineEnv, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'backup-integrity', version: '1.0' });
const call = (name, args) => client.callTool({ name, arguments: { server: 'prod', ...args } });
const text = result => result.content.map(item => item.text || '').join('\n');
const backups = path.join(scratch, 'backups');

try {
  await client.connect(transport);

  failing('mysqldump', true);
  const dumpOut = path.join(scratch, 'engine-dump.sql.gz');
  const failedDump = await call('ssh_db_dump', { type: 'mysql', database: 'shop', outputFile: dumpOut, dbUser: 'u', dbPassword: 'wrong' });
  assert.equal(failedDump.isError, true, text(failedDump));
  assert.match(text(failedDump), /Dump failed.*access denied/s);
  assert.ok(!fs.existsSync(dumpOut), 'ssh_db_dump left an archive after a failed dump');
  const failedBackup = await call('ssh_backup_create', { type: 'mysql', name: 'nightly', database: 'shop', dbUser: 'u', backupDir: backups });
  assert.equal(failedBackup.isError, true, text(failedBackup));
  assert.deepEqual(fs.existsSync(backups) ? fs.readdirSync(backups).filter(name => name.endsWith('.gz')) : [], [], 'ssh_backup_create left an archive after a failed dump');
  failing('mysqldump', false);
  ok('ssh_db_dump and ssh_backup_create report a failed dump as a failure, and leave no archive');

  const goodDump = JSON.parse(text(await call('ssh_db_dump', { type: 'mysql', database: 'shop', outputFile: dumpOut, dbUser: 'u' })));
  assert.equal(goodDump.success, true);
  assert.ok(goodDump.size_bytes > 20, 'a real dump is not an empty archive');
  ok('a dump that works is reported as one, with its real size');

  // MongoDB: create, then restore, through the real tools.
  const created = JSON.parse(text(await call('ssh_backup_create', { type: 'mongodb', name: 'docs', database: 'shop', backupDir: backups })));
  assert.equal(created.success, true, JSON.stringify(created));
  const archive = fs.readdirSync(backups).find(name => name.endsWith('.tar.gz'));
  assert.ok(archive, `no archive in ${fs.readdirSync(backups)}`);
  assert.ok(created.size > 0, `the size of the archive that exists is reported, not 0 (${created.size})`);
  const restored = await call('ssh_backup_restore', { backupId: created.backup_id, backupDir: backups, database: 'shop' });
  assert.equal(restored.isError, undefined, text(restored));
  assert.match(fs.readFileSync(path.join(work, 'mongorestore-listing'), 'utf8'), /shop/, 'mongorestore was given the extracted dump');
  ok('a MongoDB backup is created, measured and restored under one path');

  const missing = await call('ssh_backup_restore', { backupId: created.backup_id, backupDir: backups });
  fs.rmSync(path.join(backups, archive));
  const gone = await call('ssh_backup_restore', { backupId: created.backup_id, backupDir: backups });
  assert.equal(missing.isError, undefined);
  assert.equal(gone.isError, true);
  assert.match(text(gone), /Backup file not found/);
  ok('a backup whose file is gone is reported as that, before anything is restored');

  console.log(`\n✅ backup integrity tests passed (${passed} checks)`);
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) { socket.end(); socket.destroy?.(); }
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
