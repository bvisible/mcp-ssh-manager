// Sessions against shells that behave like the ones that broke them (#163).
//
// A session sends each command between two markers and reads the shell's
// answer back. Three things went wrong, all of them seen on a bastion that
// ignores the request to turn echo off, and one of them on any shell:
//
//   1. The end marker was looked for anywhere in the text, so the echoed copy
//      of the line that prints it was found first: every command came back as
//      failed, with its output cut short.
//   2. After `cd` or `export` the context was read while the session was still
//      busy, was refused ("not ready"), and stayed as it was.
//   3. Prompts and terminal escape sequences were part of the output, of the
//      working directory and of the environment.
//
// Each shell below is a FakeShell with the behaviour of one such server. The
// same checks run against every one, so a fix for one cannot break another.
import assert from 'node:assert/strict';
import { createSession, closeSession } from '../src/session-manager.js';
import { fakeSsh } from './helpers/fake-shell.js';

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

// Short, so a hung command fails the test quickly, not the suite's patience.
const TIMEOUT = 5000;

const shells = {
  'a shell that honours stty and PS1': {},
  'an echoing bastion that ignores stty and PS1, with a prompt and escapes': {
    echo: true, honorsStty: false, honorsPrompt: false, prompt: '$ ', escapes: true
  },
  'a shell that delivers its output three characters at a time': { chunkSize: 3 },
  'a real-looking shell: prompt kept, escapes on, echo off': {
    honorsPrompt: false, prompt: '$ ', escapes: true
  }
};

async function open(options) {
  const ssh = fakeSsh(options);
  const session = await createSession('fixture', ssh);
  return { session, ssh };
}

async function checkShell(label, options) {
  const { session } = await open(options);

  assert.equal(session.state, 'ready', `${label}: the session must be ready after start`);
  assert.equal(session.context.cwd, '/home/user', `${label}: the starting directory must be read cleanly`);
  assert.deepEqual(session.context.env, {
    PATH: '/usr/local/bin:/usr/bin:/bin', USER: 'user', HOME: '/home/user'
  }, `${label}: PATH holds colons, so the environment must not be split on them`);

  let result = await session.execute('echo hello world', { timeout: TIMEOUT });
  assert.equal(result.success, true, `${label}: a command that succeeds must be reported as success`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'hello world', `${label}: the output is what the command printed, nothing else`);

  result = await session.execute('false', { timeout: TIMEOUT });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1, `${label}: the status is the shell's, read from its answer`);
  assert.equal(result.output, '');

  result = await session.execute('true', { timeout: TIMEOUT });
  assert.equal(result.success, true, `${label}: a failure must not leak into the next command`);

  result = await session.execute('nosuchcommand', { timeout: TIMEOUT });
  assert.equal(result.exitCode, 127);
  assert.equal(result.output, 'sh: nosuchcommand: not found');

  result = await session.execute('echo cmd_0123456789abcdef:0', { timeout: TIMEOUT });
  assert.equal(result.output, 'cmd_0123456789abcdef:0', `${label}: output that looks like a marker is only output`);
  assert.equal(result.exitCode, 0);

  // Bug 2: the context after cd and export.
  result = await session.execute('cd /var/www', { timeout: TIMEOUT });
  assert.equal(result.success, true);
  assert.equal(session.state, 'ready', `${label}: the session is ready again after a cd`);
  assert.equal(session.context.cwd, '/var/www', `${label}: cd must update the working directory`);
  await session.execute('export FOO=bar', { timeout: TIMEOUT });
  assert.equal(session.state, 'ready');
  result = await session.execute('echo $FOO', { timeout: TIMEOUT });
  assert.equal(result.output, 'bar', `${label}: the shell keeps what export set`);

  // Bug 3: no terminal decoration in the output.
  result = await session.execute('colour', { timeout: TIMEOUT });
  assert.equal(result.output, 'red and plain', `${label}: escape sequences must not reach the output`);

  closeSession(session.id);
  ok(`${label}: status, output, cwd after cd, environment`);
}

async function testReadyMeansTheShellAnswered() {
  // A shell that echoes at once but runs nothing for 400 ms. The readiness
  // marker used to be found in the echo of the line that asks for it, so the
  // session started at once, before the shell could run a thing.
  const started = Date.now();
  const { session } = await open({ echo: true, honorsStty: false, honorsPrompt: false, prompt: '$ ', startupDelay: 400 });
  const took = Date.now() - started;
  assert.ok(took >= 350, `the session started after ${took} ms; it must wait for the shell's own answer`);
  assert.equal(session.context.cwd, '/home/user');
  closeSession(session.id);
  ok('a session is ready when the shell has answered, not when it echoed the question');
}

async function testOutputArrivesWhileTheCommandRuns() {
  const { session } = await open({});
  const pieces = [];
  const times = [];
  const started = Date.now();
  const result = await session.execute('slow', {
    timeout: TIMEOUT,
    onOutput: text => { pieces.push(text); times.push(Date.now() - started); }
  });
  assert.equal(result.output, 'one\ntwo\nthree');
  assert.equal(pieces.join(''), 'one\ntwo\nthree', 'the pieces, joined, are the output');
  assert.ok(pieces.length >= 2, `the output came in ${pieces.length} piece(s); it must arrive as it is printed`);
  assert.ok(times[0] < 300, `the first piece came after ${times[0]} ms, long before the command ended`);
  closeSession(session.id);
  ok('onOutput receives the output while the command runs, and the pieces add up');
}

async function testOutputIsForwardedFromAnEchoingShell() {
  const { session } = await open({ echo: true, honorsStty: false, honorsPrompt: false, prompt: '$ ', escapes: true });
  const pieces = [];
  const result = await session.execute('slow', { timeout: TIMEOUT, onOutput: text => pieces.push(text) });
  assert.equal(result.output, 'one\ntwo\nthree');
  assert.equal(pieces.join(''), 'one\ntwo\nthree', 'no echo, prompt or escape in what is forwarded');
  closeSession(session.id);
  ok('what is forwarded to the window carries no echo, prompt or escape either');
}

async function testBusyAndFailures() {
  const { session } = await open({});
  const running = session.execute('slow', { timeout: TIMEOUT });
  await assert.rejects(session.execute('echo second'), /not ready \(state: busy\)/,
    'a second command while one runs is refused');
  await running;
  assert.equal(session.state, 'ready');

  await assert.rejects(session.execute('hang', { timeout: 300 }), /Timeout waiting for marker: cmd_/);
  assert.equal(session.state, 'error', 'a command that never answers leaves the session in error');
  closeSession(session.id);
  ok('a busy session refuses a second command; a silent shell times out');
}

async function testWorkingDirectoryAfterCompoundCd() {
  const { session } = await open({});
  await session.execute('cd /srv', { timeout: TIMEOUT });
  assert.equal(session.getInfo().cwd, '/srv');
  closeSession(session.id);
  ok('the session info reports the refreshed directory');
}

for (const [label, options] of Object.entries(shells)) {
  await checkShell(label, options);
}
await testReadyMeansTheShellAnswered();
await testOutputArrivesWhileTheCommandRuns();
await testOutputIsForwardedFromAnEchoingShell();
await testBusyAndFailures();
await testWorkingDirectoryAfterCompoundCd();

console.log(`\n✅ session shell tests passed (${passed} checks)`);
process.exit(0);
