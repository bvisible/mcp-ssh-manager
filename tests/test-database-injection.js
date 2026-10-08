// Security regression test for issue #48: shell command injection through the
// database command builders. Every caller-controlled value (database, table,
// collection, file path, user, host, port, password) arrives from ssh_db_*
// tool arguments and used to be interpolated straight into a shell-evaluated
// command string. This test drives every builder × every such parameter × a
// battery of injection payloads through a real /bin/sh, with fake no-op DB
// client binaries on PATH, and asserts the payload NEVER executes (no canary
// file is written). It also unit-tests shellQuote() and checks benign values
// stay correctly quoted.
//
// Run only DB *client* binaries are faked (mysql, psql, mongo, mysqldump, …);
// the shell utilities the builders pipe through (cat, gzip, tar, dirname,
// basename, sed, tail, tee, rm) are the real ones, so an unescaped payload
// would genuinely run — which is exactly what we must prevent.
import assert from 'assert';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  shellQuote,
  buildMySQLListDatabasesCommand, buildMySQLListTablesCommand,
  buildPostgreSQLListDatabasesCommand, buildPostgreSQLListTablesCommand,
  buildMongoDBListDatabasesCommand, buildMongoDBListCollectionsCommand,
  buildMySQLDumpCommand, buildPostgreSQLDumpCommand, buildMongoDBDumpCommand,
  buildMySQLImportCommand, buildPostgreSQLImportCommand, buildMongoDBRestoreCommand,
  buildMySQLQueryCommand, buildPostgreSQLQueryCommand, buildMongoDBQueryCommand
} from '../src/database-manager.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-injection-'));
const FAKEBIN = path.join(TMP, 'bin');
const WORK = path.join(TMP, 'work');
const CANARY = path.join(TMP, 'CANARY');
fs.mkdirSync(FAKEBIN, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

// Fake, no-op DB client binaries. They must NOT read stdin (heredoc/pipe input
// is discarded) and always succeed, so the only way a canary appears is the
// shell interpreting an unescaped payload.
for (const bin of ['mysql', 'psql', 'mongo', 'mysqldump', 'pg_dump', 'pg_restore', 'mongodump', 'mongorestore']) {
  const p = path.join(FAKEBIN, bin);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
}

// Benign input files/dirs so the non-injected baseline paths resolve cleanly.
const BENIGN_SQL = path.join(WORK, 'benign.sql');
const BENIGN_DUMP = path.join(WORK, 'benign.dump');
const BENIGN_DIR = path.join(WORK, 'benign');
fs.writeFileSync(BENIGN_SQL, '-- benign\n');
fs.writeFileSync(BENIGN_DUMP, 'benign\n');
fs.mkdirSync(BENIGN_DIR, { recursive: true });

// Payload generators. `c` is the absolute canary path each payload tries to
// create. If a builder leaves any value shell-interpreted, one of these writes
// the canary; a correct builder passes them as inert literal arguments.
const PAYLOADS = [
  c => `$(echo PWNED > ${c})`,        // command substitution
  c => '`echo PWNED > ' + c + '`',    // backtick substitution
  c => `; echo PWNED > ${c}`,         // command separator
  c => `&& echo PWNED > ${c}`,        // AND-chain
  c => `| tee ${c}`,                  // pipe into a real binary
  c => `x > ${c}`,                    // bare redirect
  c => `$(echo PWNED > ${c}).tar.gz`, // substitution that also drives .tar.gz branches
  c => `\ntouch ${c}\n`,              // embedded newline
];

// A fresh benign options object per builder; the fuzzed key is overwritten by
// the caller. Values that must be real filesystem paths point into WORK.
function benignOptions() {
  return {
    database: 'appdb',
    collection: 'users',
    query: 'SELECT 1',
    user: 'dbuser',
    password: 'p@ss',
    host: 'db.internal',
    port: 3306,
    tables: ['orders'],
    collections: ['sessions'],
    outputFile: path.join(WORK, 'out.sql'),
    outputDir: BENIGN_DIR,
    inputFile: BENIGN_SQL,
    inputPath: BENIGN_DIR
  };
}

const BUILDERS = [
  { name: 'MySQLListDatabases', fn: buildMySQLListDatabasesCommand, params: ['user', 'password', 'host', 'port'] },
  { name: 'MySQLListTables', fn: buildMySQLListTablesCommand, params: ['database', 'user', 'password', 'host', 'port'] },
  { name: 'PostgreSQLListDatabases', fn: buildPostgreSQLListDatabasesCommand, params: ['user', 'password', 'host', 'port'] },
  { name: 'PostgreSQLListTables', fn: buildPostgreSQLListTablesCommand, params: ['database', 'user', 'password', 'host', 'port'] },
  { name: 'MongoDBListDatabases', fn: buildMongoDBListDatabasesCommand, params: ['user', 'password', 'host', 'port'] },
  { name: 'MongoDBListCollections', fn: buildMongoDBListCollectionsCommand, params: ['database', 'user', 'password', 'host', 'port'] },
  { name: 'MySQLDump', fn: buildMySQLDumpCommand, params: ['database', 'user', 'password', 'host', 'port', 'outputFile', 'tables'] },
  { name: 'PostgreSQLDump', fn: buildPostgreSQLDumpCommand, params: ['database', 'user', 'password', 'host', 'port', 'outputFile', 'tables'] },
  { name: 'MongoDBDump', fn: buildMongoDBDumpCommand, params: ['database', 'user', 'password', 'host', 'port', 'outputDir', 'collections'] },
  { name: 'MySQLImport', fn: buildMySQLImportCommand, params: ['database', 'user', 'password', 'host', 'port', 'inputFile'] },
  { name: 'PostgreSQLImport', fn: buildPostgreSQLImportCommand, params: ['database', 'user', 'password', 'host', 'port', 'inputFile'] },
  { name: 'MongoDBRestore', fn: buildMongoDBRestoreCommand, params: ['user', 'password', 'host', 'port', 'inputPath'] },
  { name: 'MySQLQuery', fn: buildMySQLQueryCommand, params: ['database', 'user', 'password', 'host', 'port'] },
  { name: 'PostgreSQLQuery', fn: buildPostgreSQLQueryCommand, params: ['database', 'user', 'password', 'host', 'port'] },
  // A filter document, not 'SELECT 1': since 4.0 the builder refuses anything
  // else, which would skip every payload below instead of testing it.
  { name: 'MongoDBQuery', fn: buildMongoDBQueryCommand, params: ['database', 'collection', 'user', 'password', 'host', 'port'], extra: { query: '{}' } },
];

const ARRAY_PARAMS = new Set(['tables', 'collections']);

function runIsolated(command) {
  try {
    execSync(command, {
      cwd: WORK,
      env: { ...process.env, PATH: `${FAKEBIN}:${process.env.PATH}` },
      stdio: 'ignore',
      timeout: 10000,
      shell: '/bin/sh'
    });
  } catch {
    // A non-zero exit is fine — we only care whether the canary was written.
  }
}

function testShellQuote() {
  assert.strictEqual(shellQuote('appdb'), "'appdb'");
  assert.strictEqual(shellQuote("o'brien"), "'o'\\''brien'");
  assert.strictEqual(shellQuote('$(whoami)'), "'$(whoami)'");
  assert.strictEqual(shellQuote(3306), "'3306'");
  assert.strictEqual(shellQuote(undefined), "''");

  // Behavioural: whatever we quote must reach a program as one verbatim arg.
  for (const raw of ['a b', "o'brien", '$(id)', '`id`', 'x; rm -rf /', 'a|b', 'a\nb', '"q"']) {
    const out = execSync(`printf %s ${shellQuote(raw)}`, { shell: '/bin/sh' }).toString();
    assert.strictEqual(out, raw, `shellQuote round-trip failed for ${JSON.stringify(raw)}`);
  }
  ok('shellQuote() escapes and round-trips every metacharacter payload');
}

function testInjectionResistance() {
  let combos = 0;
  for (const builder of BUILDERS) {
    for (const param of builder.params) {
      for (const makePayload of PAYLOADS) {
        const payload = makePayload(CANARY);
        const options = { ...benignOptions(), ...builder.extra };
        options[param] = ARRAY_PARAMS.has(param) ? [payload] : payload;

        let command;
        try {
          command = builder.fn(options);
        } catch {
          // A builder that rejects the payload outright (e.g. isSafeQuery) is
          // also safe — nothing reaches the shell.
          continue;
        }

        try { fs.rmSync(CANARY); } catch { /* absent */ }
        runIsolated(command);
        combos++;
        assert.ok(
          !fs.existsSync(CANARY),
          `INJECTION in ${builder.name} via "${param}" with payload ${JSON.stringify(payload)}\n  command: ${command}`
        );
      }
    }
  }
  ok(`no injection across ${combos} builder/parameter/payload combinations`);
}

function testBenignStillQuoted() {
  // A normal database name must survive as a properly single-quoted shell word.
  const spot = [
    buildMySQLListTablesCommand(benignOptions()),
    buildPostgreSQLListTablesCommand(benignOptions()),
    buildMongoDBListCollectionsCommand(benignOptions()),
    buildMySQLDumpCommand(benignOptions()),
    buildMongoDBQueryCommand({ ...benignOptions(), query: '{}' }),
  ];
  for (const cmd of spot) {
    assert.ok(typeof cmd === 'string' && cmd.length > 0);
    assert.ok(cmd.includes("'appdb'"), `benign database name not shell-quoted in: ${cmd}`);
  }
  // The mysql list-tables database must be a positional arg, never an SQL USE clause.
  assert.ok(!buildMySQLListTablesCommand(benignOptions()).includes('USE '),
    'MySQL list-tables must not interpolate the database into a USE clause');
  ok('benign values remain correctly shell-quoted and functional');
}

function main() {
  try {
    testShellQuote();
    testInjectionResistance();
    testBenignStillQuoted();
    console.log(`\n✅ database injection tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main();
