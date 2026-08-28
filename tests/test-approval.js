// Tests for the v4 approval broker.
//
// This is the only place in the engine that waits on a human, so the failure
// modes matter more than the happy path. Three of them would each be worse than
// having no approval at all:
//
//   * waiting forever because the control plane crashed mid-review
//   * leaking a password into the request the UI displays and logs
//   * changing anything for the users who never asked for approval
//
// Each test drives a real socket with a fake control plane, so what is exercised
// is the actual protocol, not a mock of it.
import assert from 'assert';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import {
  needsApproval,
  isDestructive,
  approvalMode,
  requestDecision,
  buildRequest,
  isControlPlaneListening,
  VALID_APPROVAL_MODES
} from '../src/approval.js';
import { sanitize } from '../src/audit.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-approval-'));
const servers = [];

/**
 * Start a fake control plane.
 * @param {(request: any) => any|null} handler - Returns the reply, or null to stay silent
 * @returns {Promise<string>} The socket path
 */
function startControlPlane(handler) {
  const socketPath = path.join(scratch, `cp-${servers.length}.sock`);
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      const reply = handler(request);
      if (reply !== null) socket.write(`${JSON.stringify(reply)}\n`);
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  return new Promise(resolve => server.listen(socketPath, () => resolve(socketPath)));
}

function testDefaultIsOff() {
  // The single most important property: someone who never heard of approval
  // must not be prompted, ever.
  assert.strictEqual(approvalMode({}), 'never');
  assert.strictEqual(approvalMode(undefined), 'never');
  assert.strictEqual(needsApproval({}, 'ssh_execute_sudo', 'rm -rf /var'), false,
    'a server with no approval setting must never require approval');
  ok('approval is off by default, even for a destructive command');

  // An unreadable value must fail safe (off) rather than locking someone out.
  assert.strictEqual(approvalMode({ approval: 'sometimes' }), 'never');
  ok('an unknown approval mode falls back to off, not to blocking');
}

function testModes() {
  const always = { approval: 'always' };
  const destructive = { approval: 'destructive' };

  assert.strictEqual(needsApproval(always, 'ssh_execute', 'uptime'), true,
    '"always" must prompt even for a harmless command');
  assert.strictEqual(needsApproval(destructive, 'ssh_execute', 'uptime'), false,
    '"destructive" must not prompt for a read-only command');
  assert.strictEqual(needsApproval(destructive, 'ssh_execute', 'rm -rf /var/log'), true,
    '"destructive" must prompt for rm -rf');
  assert.strictEqual(needsApproval(destructive, 'ssh_deploy', undefined), true,
    'a state-changing tool is destructive whatever its arguments');
  ok('never / destructive / always each behave as named');

  assert.deepStrictEqual([...VALID_APPROVAL_MODES].sort(), ['always', 'destructive', 'never']);
  ok('the mode list is exactly the three documented values');
}

function testDestructiveClassification() {
  const shouldPrompt = [
    'rm -rf /var/www', 'rm -f important.db', 'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1', 'shutdown -h now', 'reboot',
    'systemctl stop nginx', 'DROP TABLE users;', 'truncate table logs',
    'chown -R nobody /srv', 'chmod -R 777 /etc', 'iptables -F',
  ];
  for (const command of shouldPrompt) {
    assert.strictEqual(isDestructive('ssh_execute', command), true,
      `must be treated as destructive: ${command}`);
  }
  ok(`destructive commands are recognised (${shouldPrompt.length} checked)`);

  // A list that cries wolf gets clicked through without reading, which is worse
  // than no prompt at all — so ordinary work must stay silent.
  const shouldNotPrompt = [
    'uptime', 'ls -la /var/log', 'systemctl status nginx', 'systemctl restart nginx',
    'tail -n 100 /var/log/syslog', 'df -h', 'cat /etc/hostname', 'grep error app.log',
    'SELECT * FROM users', 'git pull', 'docker ps',
  ];
  for (const command of shouldNotPrompt) {
    assert.strictEqual(isDestructive('ssh_execute', command), false,
      `must NOT interrupt for: ${command}`);
  }
  ok(`everyday commands do not interrupt (${shouldNotPrompt.length} checked)`);
}

async function testOperatorDecisions() {
  const allowPath = await startControlPlane(req => ({ id: req.id, decision: 'allow' }));
  const allowed = await requestDecision(buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'uptime'),
    { socketPath: allowPath, timeoutMs: 3000 });
  assert.strictEqual(allowed.decision, 'allow');
  assert.strictEqual(allowed.source, 'operator');
  ok('an approval from the control plane is honoured');

  const denyPath = await startControlPlane(req => ({ id: req.id, decision: 'deny', reason: 'not tonight' }));
  const denied = await requestDecision(buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'rm -rf /'),
    { socketPath: denyPath, timeoutMs: 3000 });
  assert.strictEqual(denied.decision, 'deny');
  assert.strictEqual(denied.reason, 'not tonight');
  ok('a refusal is honoured, with the operator’s reason preserved');
}

async function testFailureModesAllDeny() {
  // Silent control plane: the deadline must fire, and quickly enough to matter.
  const silentPath = await startControlPlane(() => null);
  const started = Date.now();
  const timedOut = await requestDecision(buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'x'),
    { socketPath: silentPath, timeoutMs: 400 });
  const elapsed = Date.now() - started;
  assert.strictEqual(timedOut.decision, 'deny', 'a silent control plane must end in a refusal');
  assert.strictEqual(timedOut.source, 'timeout');
  assert.ok(elapsed < 3000, `the deadline must actually fire, waited ${elapsed}ms`);
  ok(`a control plane that never answers is refused at the deadline (${elapsed}ms)`);

  // Socket that is not there at all.
  const missing = await requestDecision(buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'x'),
    { socketPath: path.join(scratch, 'nothing-here.sock'), timeoutMs: 2000 });
  assert.strictEqual(missing.decision, 'deny');
  assert.strictEqual(missing.source, 'error');
  ok('an unreachable socket is refused rather than waited on');

  // Connection dropped mid-review, as a crashing UI would do.
  const dropPath = path.join(scratch, 'drop.sock');
  const dropper = net.createServer(socket => socket.destroy());
  servers.push(dropper);
  await new Promise(resolve => dropper.listen(dropPath, () => resolve(undefined)));
  const dropped = await requestDecision(buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'x'),
    { socketPath: dropPath, timeoutMs: 2000 });
  assert.strictEqual(dropped.decision, 'deny');
  ok('a control plane that hangs up without deciding is refused');

  // A reply about someone else's request must not be accepted: it would let a
  // confused or hostile control plane approve the wrong action.
  const wrongIdPath = await startControlPlane(() => ({ id: 'not-the-one', decision: 'allow' }));
  const wrongId = await requestDecision(buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'x'),
    { socketPath: wrongIdPath, timeoutMs: 2000 });
  assert.strictEqual(wrongId.decision, 'deny', 'a mismatched id must not approve anything');
  ok('a reply carrying the wrong request id is refused');

  // Garbage on the wire.
  const garbagePath = path.join(scratch, 'garbage.sock');
  const garbage = net.createServer(socket => socket.write('this is not json\n'));
  servers.push(garbage);
  await new Promise(resolve => garbage.listen(garbagePath, () => resolve(undefined)));
  const unreadable = await requestDecision(buildRequest({ name: 'prod' }, 'ssh_execute', {}, 'x'),
    { socketPath: garbagePath, timeoutMs: 2000 });
  assert.strictEqual(unreadable.decision, 'deny');
  ok('an unreadable reply is refused');
}

async function testNoSecretInTheRequest() {
  const SECRET = 'prod-sudo-password-42';
  let received = null;
  const socketPath = await startControlPlane(req => {
    received = req;
    return { id: req.id, decision: 'allow' };
  });

  const args = { command: 'systemctl restart app', password: SECRET, nested: { sudoPassword: SECRET } };
  await requestDecision(
    buildRequest({ name: 'prod', host: 'p.internal', password: SECRET }, 'ssh_execute_sudo', sanitize(args), 'systemctl restart app'),
    { socketPath, timeoutMs: 3000 }
  );

  const serialized = JSON.stringify(received);
  assert.ok(!serialized.includes(SECRET),
    'no secret may reach the control plane, which displays and logs what it receives');
  assert.ok(serialized.includes('systemctl restart app'), 'the command must be shown — that is the point');
  assert.ok(serialized.includes('p.internal'), 'the target host must be shown');
  ok('the request shows the command and host but carries no secret');
}

function testListeningDetection() {
  assert.strictEqual(isControlPlaneListening(path.join(scratch, 'absent.sock')), false);
  // A regular file is not a control plane, and connecting to one would hang.
  const regular = path.join(scratch, 'not-a-socket');
  fs.writeFileSync(regular, 'x');
  assert.strictEqual(isControlPlaneListening(regular), false,
    'a regular file must not be mistaken for a listening control plane');
  ok('a missing socket and a regular file both read as "nobody listening"');

  // A path over the sun_path limit can never host a socket, and bind() reports
  // it as EADDRINUSE on an empty path — an hour of confusion the first time.
  const tooLong = path.join(scratch, 'x'.repeat(120), 'approval.sock');
  assert.strictEqual(isControlPlaneListening(tooLong), false,
    'an over-long socket path must read as "nobody listening", not be attempted');
  ok('a socket path over the 104-byte limit is rejected with a clear warning');
}

async function main() {
  try {
    testDefaultIsOff();
    testModes();
    testDestructiveClassification();
    await testOperatorDecisions();
    await testFailureModesAllDeny();
    await testNoSecretInTheRequest();
    testListeningDetection();
    console.log(`\n✅ approval tests passed (${passed} checks)`);
  } finally {
    for (const server of servers) server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
