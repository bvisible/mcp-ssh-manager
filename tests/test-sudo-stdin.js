// Regression test for issue #34: the sudo password must never reach the remote
// command line. It used to be interpolated as `echo "<pass>" | sudo -S <cmd>`,
// which published it to the remote process list, /proc/<pid>/cmdline and any
// auditd trail for the lifetime of the echo — readable by every account on the
// host. Output masking did not help: it only redacted the copy sent back to the
// agent, never the remote-side exposure.
//
// The fix routes the password over the exec channel's stdin instead. This test
// locks all three halves of it: the strategy builder emits no password in any
// command, SSHManager.execCommand actually writes stdin to the channel, and no
// source file reintroduces the old pipeline.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import SSHManager from '../src/ssh-manager.js';
import { buildDeploymentStrategy } from '../src/deploy-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');

const SECRET = 'sup3r-s3cret-sudo-pw';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// Minimal stand-in for an ssh2 exec channel: duplex-ish, records what the
// caller writes, and lets the test drive close/data events by hand.
function makeFakeStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.written = [];
  stream.ended = false;
  stream.write = chunk => { stream.written.push(String(chunk)); return true; };
  stream.end = () => { stream.ended = true; };
  stream.destroy = () => {};
  return stream;
}

// Drives SSHManager.execCommand against a fake ssh2 client and returns both the
// command the client was asked to run and the stream it was handed.
async function runExec(command, options) {
  const manager = new SSHManager({ host: 'h', username: 'u' });
  manager.connected = true;
  const stream = makeFakeStream();
  let execCommand = null;

  manager.client = {
    exec(cmd, cb) {
      execCommand = cmd;
      setImmediate(() => {
        cb(null, stream);
        // Let execCommand wire its listeners and write stdin, then finish.
        setImmediate(() => stream.emit('close', 0, null));
      });
    },
    end() {}
  };

  const result = await manager.execCommand(command, options);
  return { execCommand, stream, result };
}

async function testStdinReachesTheChannel() {
  const { execCommand, stream } = await runExec("sudo -S -k -p '' systemctl restart nginx", {
    stdin: `${SECRET}\n`,
    timeout: 0
  });

  assert.ok(!execCommand.includes(SECRET),
    `the password must not appear in the command sent to the host, got: ${execCommand}`);
  ok('the password is absent from the command handed to ssh2');

  assert.deepStrictEqual(stream.written, [`${SECRET}\n`],
    'the password must be written to the exec channel exactly once');
  ok('the password is written to the exec channel stdin');

  assert.strictEqual(stream.ended, true,
    'stdin must be closed so sudo stops waiting for more input');
  ok('stdin is closed after the password is written');
}

async function testNoStdinLeavesTheChannelUntouched() {
  // Commands that supply no stdin must not have their input closed — doing so
  // unconditionally would break anything reading from stdin remotely.
  const { stream } = await runExec('uptime', { timeout: 0 });
  assert.deepStrictEqual(stream.written, [], 'nothing may be written without stdin');
  assert.strictEqual(stream.ended, false, 'the channel input must stay open without stdin');
  ok('a command with no stdin leaves the channel input untouched');
}

function testDeploymentStrategyKeepsThePasswordOutOfCommands() {
  const strategy = buildDeploymentStrategy('/etc/nginx/nginx.conf', {
    sudoPassword: SECRET,
    owner: 'root:root',
    permissions: '644'
  });

  const offenders = strategy.steps.filter(step => step.command.includes(SECRET));
  assert.deepStrictEqual(offenders.map(s => `${s.type}: ${s.command}`), [],
    'no deployment step may carry the password in its command');
  ok(`no deployment command contains the password (${strategy.steps.length} steps)`);

  // Every privileged step must instead carry it as stdin, or sudo would block
  // forever waiting for a password that never arrives.
  const sudoSteps = strategy.steps.filter(step => step.command.includes('sudo'));
  assert.ok(sudoSteps.length >= 3, `expected copy/chown/chmod to need sudo, got ${sudoSteps.length}`);
  for (const step of sudoSteps) {
    assert.strictEqual(step.stdin, `${SECRET}\n`,
      `step "${step.type}" must carry the password as stdin`);
    assert.ok(step.command.includes('sudo -S -k -p'),
      `step "${step.type}" must read the password from stdin, got: ${step.command}`);
  }
  ok(`every privileged step carries the password as stdin instead (${sudoSteps.length} steps)`);
}

function testNoPasswordWithoutSudoPassword() {
  // Without a configured password, sudo must stay plain: adding -S with no
  // stdin would make it fail instead of using an existing NOPASSWD rule.
  const strategy = buildDeploymentStrategy('/etc/hosts', { owner: 'root:root' });
  for (const step of strategy.steps) {
    assert.ok(!step.stdin, `step "${step.type}" must not invent stdin`);
    assert.ok(!step.command.includes('-S'),
      `step "${step.type}" must not use sudo -S without a password, got: ${step.command}`);
  }
  ok('without a sudo password, steps use plain sudo and no stdin');
}

function testOldPipelineIsGoneFromSource() {
  // The exact shape that leaked. Catching it in source stops the pattern from
  // being copy-pasted back into a new tool later.
  const leaky = /echo\s+"\$\{[^}]*[Pp]assword[^}]*\}"\s*\|\s*sudo/;
  const offenders = [];

  for (const file of fs.readdirSync(SRC_DIR)) {
    if (!file.endsWith('.js')) continue;
    const lines = fs.readFileSync(path.join(SRC_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (leaky.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepStrictEqual(offenders, [],
    `the leaking sudo pipeline is back in source:\n${offenders.join('\n')}`);
  ok('no source file pipes a password into sudo on the command line');
}

async function main() {
  await testStdinReachesTheChannel();
  await testNoStdinLeavesTheChannelUntouched();
  testDeploymentStrategyKeepsThePasswordOutOfCommands();
  testNoPasswordWithoutSudoPassword();
  testOldPipelineIsGoneFromSource();
  console.log(`\n✅ sudo stdin tests passed (${passed} checks)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
