// Security regression test for three advisories, all the same class of bug:
//
//   GHSA-qwwm-vrm9-4mw8 (high)     — every builder in backup-manager.js
//   GHSA-796j-h5q5-jx6p (critical) — ssh_db_dump's follow-up stat, MongoDB dump
//   GHSA-m793-whw6-f537 (critical) — buildServiceStatusCommand and ssh_tail,
//                                    which bypassed readonly/restricted mode
//
// The v3.6.7 fix (CVE-2026-77383) introduced shellQuote() but applied it to
// database-manager.js only. The parallel builders for backups and monitoring
// kept interpolating caller-controlled values raw, so the same RCE stayed open
// in three other places for months.
//
// This drives the real shipped builders through a real /bin/sh with the backup
// binaries faked as no-ops, and asserts the payload NEVER executes: the canary
// file must not appear. The shell utilities the builders pipe through (cat,
// gzip, tar, find, grep, echo, dirname, basename) are the real ones, so an
// unquoted payload would genuinely run.
import assert from 'assert';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
  buildFilesBackupCommand,
  buildRestoreCommand,
  buildSaveMetadataCommand,
  buildListBackupsCommand,
  buildCleanupCommand,
  buildCronScheduleCommand
} from '../src/backup-manager.js';
import {
  buildServiceStatusCommand,
  buildProcessListCommand,
  buildProcessInfoCommand,
  buildSaveAlertConfigCommand,
  buildLoadAlertConfigCommand
} from '../src/health-monitor.js';
import { shellQuote, safeInteger } from '../src/shell-quote.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// Binaries faked as no-ops so the builders can run without a database or a real
// backup target. Deliberately NOT faked: the shell utilities the commands pipe
// through, so an escape would really execute.
const FAKE_BINARIES = [
  'mysqldump', 'mysql', 'pg_dump', 'pg_restore', 'mongodump', 'mongorestore',
  'crontab', 'systemctl', 'service', 'pgrep', 'ps'
];

// Payloads that each break out of a different quoting mistake.
const PAYLOADS = [
  'x; touch CANARY',
  'x && touch CANARY',
  'x | touch CANARY',
  '$(touch CANARY)',
  '`touch CANARY`',
  'x" ; touch CANARY ; echo "',
  "x' ; touch CANARY ; echo '",
  'x\ntouch CANARY',
  'x$(touch CANARY)y',
  '"; touch CANARY; #'
];

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-injection-'));
const binDir = path.join(workRoot, 'bin');
fs.mkdirSync(binDir);
for (const name of FAKE_BINARIES) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
}

/**
 * Run a built command in a throwaway directory with the fake binaries first on
 * PATH, and report whether the canary was created.
 */
function canaryFired(command) {
  const dir = fs.mkdtempSync(path.join(workRoot, 'run-'));
  const canary = path.join(dir, 'CANARY');
  const cmd = command.split('CANARY').join(canary);
  try {
    execSync(cmd, {
      cwd: dir,
      shell: '/bin/sh',
      stdio: 'ignore',
      timeout: 5000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
    });
  } catch {
    // A non-zero exit is fine and expected — only the canary matters.
  }
  const fired = fs.existsSync(canary);
  fs.rmSync(dir, { recursive: true, force: true });
  return fired;
}

// Each case names a builder and the argument the payload is injected into.
function buildCases(payload) {
  const out = path.join(workRoot, 'out.dump');
  const base = { database: 'app', user: 'u', password: 'p', host: 'h', port: 3306, outputFile: out };
  return [
    ['mysql dump / database', () => buildMySQLDumpCommand({ ...base, database: payload })],
    ['mysql dump / user', () => buildMySQLDumpCommand({ ...base, user: payload })],
    ['mysql dump / password', () => buildMySQLDumpCommand({ ...base, password: payload })],
    ['mysql dump / host', () => buildMySQLDumpCommand({ ...base, host: payload })],
    ['mysql dump / outputFile', () => buildMySQLDumpCommand({ ...base, outputFile: payload })],
    ['postgres dump / database', () => buildPostgreSQLDumpCommand({ ...base, database: payload })],
    ['postgres dump / password', () => buildPostgreSQLDumpCommand({ ...base, password: payload })],
    ['postgres dump / outputFile', () => buildPostgreSQLDumpCommand({ ...base, outputFile: payload })],
    ['mongo dump / database', () => buildMongoDBDumpCommand({ ...base, database: payload, outputDir: out })],
    ['mongo dump / outputDir', () => buildMongoDBDumpCommand({ ...base, outputDir: payload })],
    ['mongo dump / password', () => buildMongoDBDumpCommand({ ...base, password: payload, outputDir: out })],
    ['files backup / paths', () => buildFilesBackupCommand({ paths: [payload], outputFile: out })],
    ['files backup / exclude', () => buildFilesBackupCommand({ paths: ['/etc'], outputFile: out, exclude: [payload] })],
    ['files backup / outputFile', () => buildFilesBackupCommand({ paths: ['/etc'], outputFile: payload })],
    ['restore mysql / backupFile', () => buildRestoreCommand('mysql', payload, base)],
    ['restore mysql / database', () => buildRestoreCommand('mysql', out, { ...base, database: payload })],
    ['restore postgres / backupFile', () => buildRestoreCommand('postgresql', payload, base)],
    ['restore mongo / backupFile', () => buildRestoreCommand('mongodb', `${payload}.tar.gz`, base)],
    ['restore files / targetPath', () => buildRestoreCommand('files', out, { targetPath: payload })],
    ['save metadata / path', () => buildSaveMetadataCommand({ id: 'x' }, payload)],
    ['save metadata / payload', () => buildSaveMetadataCommand({ id: payload }, path.join(workRoot, 'm.json'))],
    ['list backups / dir', () => buildListBackupsCommand(payload)],
    ['list backups / type', () => buildListBackupsCommand(workRoot, payload)],
    ['cleanup / dir', () => buildCleanupCommand(payload, 7)],
    ['cron schedule / schedule', () => buildCronScheduleCommand(payload, 'echo hi', 'c')],
    ['cron schedule / comment', () => buildCronScheduleCommand('0 2 * * *', 'echo hi', payload)],
    // GHSA-m793 sink A
    ['service status / name', () => buildServiceStatusCommand(payload)],
    ['process list / filter', () => buildProcessListCommand({ filter: payload })],
    ['alert config / path', () => buildSaveAlertConfigCommand({ a: 1 }, payload)],
    ['alert config / payload', () => buildSaveAlertConfigCommand({ a: payload }, path.join(workRoot, 'a.json'))],
    ['load alert config / path', () => buildLoadAlertConfigCommand(payload)],
    // GHSA-m793 sink B: ssh_tail's construction, mirrored from the handler.
    ['ssh_tail / file', () => `tail -n ${safeInteger(10, 10)} ${shellQuote(payload)}`],
    ['ssh_tail / grep', () => `tail -n 10 /dev/null | grep ${shellQuote(payload)}`],
    // GHSA-796j: the follow-up stat command in ssh_db_dump.
    ['ssh_db_dump / stat outputFile', () => `stat -f%z ${shellQuote(payload)} 2>/dev/null || stat -c%s ${shellQuote(payload)} 2>/dev/null`]
  ];
}

function testNoPayloadEverExecutes() {
  const failures = [];
  let checks = 0;

  for (const payload of PAYLOADS) {
    for (const [label, build] of buildCases(payload)) {
      let command;
      try {
        command = build();
      } catch {
        // A builder that refuses the input outright is a valid defence.
        continue;
      }
      checks++;
      if (canaryFired(command)) failures.push(`${label} — payload ${JSON.stringify(payload)}`);
    }
  }

  assert.deepStrictEqual(failures, [],
    `command injection reachable through:\n${failures.join('\n')}`);
  ok(`no payload executes through any builder (${checks} combinations)`);
}

function testNumericArgumentsCannotCarryCommands() {
  // Numeric arguments land inside command strings too. safeInteger() is what
  // stops a string arriving where a number is declared.
  for (const value of ['5; touch CANARY', '$(touch CANARY)', NaN, Infinity, -3, 2.7]) {
    const command = `tail -n ${safeInteger(value, 10)} /dev/null`;
    assert.ok(/^tail -n \d+ \/dev\/null$/.test(command),
      `numeric coercion leaked for ${JSON.stringify(value)}: ${command}`);
    assert.ok(!canaryFired(command), `numeric argument executed for ${JSON.stringify(value)}`);
  }
  ok('numeric arguments are coerced and cannot carry commands');
}

function testProcessInfoRejectsNonNumericPid() {
  // buildProcessInfoCommand had no guard at all, unlike buildKillProcessCommand.
  for (const bad of ['1; touch /tmp/x', '$(id)', '', null, undefined, 1.5, -1, 0]) {
    assert.throws(() => buildProcessInfoCommand(/** @type {any} */ (bad)),
      `buildProcessInfoCommand must reject ${JSON.stringify(bad)}`);
  }
  assert.ok(buildProcessInfoCommand(1234).includes('ps -p 1234'), 'a real PID must still work');
  ok('buildProcessInfoCommand rejects every non-PID input');
}

function testBenignValuesStillWork() {
  // Quoting must not break ordinary use — a fix nobody can use is not a fix.
  const cmd = buildMySQLDumpCommand({
    database: 'my_app', user: 'backup', password: 'p@ss w0rd', host: 'db.internal',
    port: 3306, outputFile: '/var/backups/app.sql.gz', compress: true
  });
  assert.ok(cmd.includes("'my_app'"), 'database must be quoted');
  assert.ok(cmd.includes("'p@ss w0rd'"), 'a password with a space must survive quoting');
  assert.ok(cmd.includes("| gzip > '/var/backups/app.sql.gz'"), 'the output path must be quoted');
  assert.ok(cmd.startsWith('mysqldump'), 'the command itself must be unchanged');

  const svc = buildServiceStatusCommand('nginx');
  assert.ok(svc.includes("systemctl is-active 'nginx'"), 'a plain service name must still work');
  ok('benign values still produce correct, working commands');
}

function main() {
  try {
    testNoPayloadEverExecutes();
    testNumericArgumentsCannotCarryCommands();
    testProcessInfoRejectsNonNumericPid();
    testBenignValuesStillWork();
    console.log(`\n✅ backup/monitor injection tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main();
