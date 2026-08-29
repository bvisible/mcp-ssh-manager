// Tests for the command log and the alert thresholds.
//
// Both exist for the same reason: the control plane already sees everything —
// every command an agent runs streams through it, every health probe passes
// through it — so answering "what has my agent been doing?" and "is that box
// about to fill up?" needs nothing configured on the servers themselves.
//
// The rule that matters most here is what is NOT written down. A stream carries
// whatever a program printed: a config being catted, a token echoed by a deploy
// script. A file of that in someone's home directory is a liability they did
// not ask for.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendCommand, readCommandLog, trimCommandLog, clearCommandLog,
  commandLogPath, recordsOutput,
} from '../src/command-log.js';
import { checkAlertThresholds, createAlertConfig } from '../src/health-monitor.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlog-'));
process.env.SSH_MANAGER_HOME = scratch;
process.env.SSH_MANAGER_KEY_SOURCE = 'file';

function testOutputIsNotWrittenByDefault() {
  delete process.env.SSH_MANAGER_LOG_OUTPUT;
  assert.strictEqual(recordsOutput(), false, 'off unless explicitly turned on');

  appendCommand({
    ts: new Date().toISOString(),
    server: 'prod',
    command: 'cat /etc/app/secrets.env',
    code: 0,
    output: 'DATABASE_PASSWORD=hunter2\nAPI_TOKEN=sk-live-abc123\n',
  });

  const raw = fs.readFileSync(commandLogPath(), 'utf8');
  assert.ok(!raw.includes('hunter2'), 'a password that passed through must not land on disk');
  assert.ok(!raw.includes('sk-live-abc123'), 'nor a token');
  assert.ok(raw.includes('cat /etc/app/secrets.env'),
    'the command itself is recorded — that is the point of the log');
  ok('output is not written by default, so secrets in it never reach the disk');
}

function testOutputIsWrittenWhenAskedFor() {
  process.env.SSH_MANAGER_LOG_OUTPUT = '1';
  assert.strictEqual(recordsOutput(), true);
  appendCommand({ ts: new Date().toISOString(), server: 'prod', command: 'ls', code: 0, output: 'a\nb\n' });
  assert.strictEqual(readCommandLog()[0].output, 'a\nb\n');
  ok('output is written when the operator has asked for it on their own machine');
}

function testLongOutputIsTruncatedFromTheFront() {
  process.env.SSH_MANAGER_LOG_OUTPUT = '1';
  const long = `${'x'.repeat(9000)}THE-END`;
  appendCommand({ ts: new Date().toISOString(), server: 'prod', command: 'yes', code: 0, output: long });
  const stored = readCommandLog()[0].output;
  assert.ok(stored.length < 5000, `must be truncated, got ${stored.length}`);
  assert.ok(stored.includes('THE-END'),
    'the end is what matters — an error appears after the output, not before it');
  assert.ok(stored.includes('truncated'), 'and it must say it was cut');
  ok('long output keeps the end, which is where the error is');
}

function testTheFileIsPrivateAndAppendOnly() {
  const mode = fs.statSync(commandLogPath()).mode & 0o777;
  assert.strictEqual(mode, 0o600, `got ${mode.toString(8)}`);
  const before = readCommandLog().length;
  appendCommand({ ts: new Date().toISOString(), server: 'x', command: 'y', code: 0 });
  assert.strictEqual(readCommandLog().length, before + 1, 'appending must not rewrite the file');
  ok('the log is private to its owner and only ever appended to');
}

function testNewestFirst() {
  clearCommandLog();
  for (const n of [1, 2, 3]) {
    appendCommand({ ts: new Date(Date.now() + n * 1000).toISOString(), server: 'prod', command: `cmd${n}`, code: 0 });
  }
  assert.deepStrictEqual(readCommandLog().map(e => e.command), ['cmd3', 'cmd2', 'cmd1'],
    'the most recent command is the one being looked for');
  ok('the log reads newest first');
}

function testABadLineDoesNotInvalidateTheFile() {
  fs.appendFileSync(commandLogPath(), 'this is not json\n');
  appendCommand({ ts: new Date().toISOString(), server: 'prod', command: 'after', code: 0 });
  const entries = readCommandLog();
  assert.strictEqual(entries[0].command, 'after',
    'a corrupt line must be skipped, not take the whole history down');
  assert.ok(entries.length >= 3);
  ok('one unreadable line is skipped and the rest still reads');
}

function testTrimming() {
  clearCommandLog();
  const line = `${JSON.stringify({ ts: new Date().toISOString(), server: 'p', command: 'c', code: 0 })}\n`;
  fs.writeFileSync(commandLogPath(), line.repeat(6000));
  trimCommandLog();
  const kept = fs.readFileSync(commandLogPath(), 'utf8').split('\n').filter(Boolean).length;
  assert.ok(kept <= 5000, `the log must stay bounded, got ${kept}`);
  ok('the log is trimmed rather than growing without limit');
}

function testAWriteFailureDoesNotThrow() {
  // A log that cannot be written must never take down the thing it records.
  const original = process.env.SSH_MANAGER_HOME;
  process.env.SSH_MANAGER_HOME = '/proc/nonexistent-and-unwritable';
  assert.doesNotThrow(() =>
    appendCommand({ ts: new Date().toISOString(), server: 'p', command: 'c', code: 0 }));
  assert.deepStrictEqual(readCommandLog(), []);
  process.env.SSH_MANAGER_HOME = original;
  ok('an unwritable log fails quietly instead of breaking the command it records');
}

function testThresholdsAreOnlyReportedWhenCrossed() {
  const limits = createAlertConfig({ cpu: 80, memory: 90, disk: 85 });
  const calm = {
    cpu: { percent: 12 }, memory: { percent: 40 },
    disks: [{ mount: '/', percent: 30 }],
  };
  assert.deepStrictEqual(checkAlertThresholds(calm, limits), [],
    'a healthy machine must produce nothing — an alert that always fires is noise');

  const busy = {
    cpu: { percent: 95 }, memory: { percent: 92 },
    disks: [{ mount: '/', percent: 91 }, { mount: '/var', percent: 20 }],
  };
  const alerts = checkAlertThresholds(busy, limits);
  const types = alerts.map(a => a.type).sort();
  assert.deepStrictEqual(types, ['cpu', 'disk', 'memory']);
  assert.ok(alerts.every(a => a.message.includes('%')), 'each says the number and the threshold');
  assert.ok(!alerts.some(a => a.message.includes('/var')),
    'and the mount that is fine is not mentioned');
  ok('thresholds report what crossed and stay silent about what did not');
}

function main() {
  try {
    testOutputIsNotWrittenByDefault();
    testOutputIsWrittenWhenAskedFor();
    testLongOutputIsTruncatedFromTheFront();
    testTheFileIsPrivateAndAppendOnly();
    testNewestFirst();
    testABadLineDoesNotInvalidateTheFile();
    testTrimming();
    testAWriteFailureDoesNotThrow();
    testThresholdsAreOnlyReportedWhenCrossed();
    console.log(`\n✅ command log tests passed (${passed} checks)`);
  } finally {
    delete process.env.SSH_MANAGER_LOG_OUTPUT;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
