// Tests for live command streaming — watching the agent work.
//
// Two properties matter more than the feature itself, because breaking either
// would make the engine worse for everyone who never opens the window:
//
//   1. **Nobody watching costs nothing.** No socket, no connection attempt, no
//      buffers, and above all no change to how a command runs.
//   2. **A watcher can never break or slow a command.** A wedged control plane,
//      a socket that vanishes mid-command, a listener that throws — none of it
//      may propagate into the execution path.
//
// The rest covers the scrollback, which is what lets a window opened mid-command
// show what came before rather than starting blank.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  openStream,
  isWatching,
  streamSocketPath,
  StreamRegistry,
  listenForStreams
} from '../src/live-stream.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// Short path: sun_path caps Unix sockets at 104 bytes.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
process.env.SSH_MANAGER_HOME = scratch;

const servers = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wait until `check` is true, or give up. Polling beats a fixed sleep. */
async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(25);
  }
  return false;
}

async function testNobodyWatchingCostsNothing() {
  // No control plane has been started, so there is no socket.
  assert.strictEqual(isWatching(), false, 'with no socket, nothing must be watching');
  assert.strictEqual(openStream('prod', 'uptime'), null,
    'openStream must return null so callers can optional-chain it away');
  ok('with no control plane, streaming is inert and allocates nothing');
}

async function testStreamReachesTheRegistry() {
  const registry = new StreamRegistry();
  const server = await listenForStreams(registry);
  servers.push(server);

  assert.strictEqual(isWatching(), true, 'the socket must now be detected');

  const stream = openStream('prod', 'tail -f /var/log/syslog');
  assert.ok(stream, 'a stream must open when someone is watching');

  await until(() => registry.list().length === 1);
  const [live] = registry.list();
  assert.strictEqual(live.server, 'prod');
  assert.strictEqual(live.command, 'tail -f /var/log/syslog');
  assert.strictEqual(live.code, null, 'a running command has no exit code yet');
  ok('a started command appears in the registry with its command line');

  stream.write('stdout', 'line one\n');
  stream.write('stdout', 'line two\n');
  stream.write('stderr', 'a warning\n');
  await until(() => registry.get(live.id)?.scrollback.includes('a warning'));
  const withOutput = registry.get(live.id);
  assert.ok(withOutput.scrollback.includes('line one'), 'output must accumulate');
  assert.ok(withOutput.scrollback.includes('a warning'), 'stderr must be captured too');
  ok('output arrives as it is written, stdout and stderr both');

  stream.end(0);
  await until(() => registry.get(live.id)?.code === 0);
  assert.strictEqual(registry.get(live.id).code, 0, 'the exit code must be recorded');
  ok('the exit code is recorded when the command ends');
}

async function testScrollbackIsBounded() {
  const registry = new StreamRegistry();
  // A command that prints for an hour must not grow the buffer without limit.
  registry.apply({ type: 'start', id: 'x', server: 'prod', command: 'yes', ts: new Date().toISOString() });
  for (let i = 0; i < 200; i++) {
    registry.apply({ type: 'data', id: 'x', channel: 'stdout', chunk: 'y'.repeat(1024) });
  }
  const size = registry.get('x').scrollback.length;
  assert.ok(size <= 64 * 1024, `the scrollback must stay bounded, got ${size} bytes`);
  // And it must keep the END, which is what someone opening the window wants.
  registry.apply({ type: 'data', id: 'x', channel: 'stdout', chunk: 'THE-LAST-LINE' });
  assert.ok(registry.get('x').scrollback.endsWith('THE-LAST-LINE'),
    'trimming must drop the oldest output, not the newest');
  ok('the scrollback is bounded at 64 KB and keeps the most recent output');
}

async function testFinishedStreamsAreTrimmed() {
  const registry = new StreamRegistry();
  for (let i = 0; i < 30; i++) {
    registry.apply({ type: 'start', id: `s${i}`, server: 'prod', command: `cmd ${i}`, ts: new Date().toISOString() });
    registry.apply({ type: 'end', id: `s${i}`, code: 0 });
  }
  assert.ok(registry.list().length <= 20, `finished streams must be capped, got ${registry.list().length}`);
  assert.ok(registry.get('s29'), 'the most recent must survive');
  assert.ok(!registry.get('s0'), 'the oldest must be dropped');
  ok('finished streams are capped at 20, oldest dropped first');
}

async function testAWatcherCannotBreakACommand() {
  const registry = new StreamRegistry();
  const server = await listenForStreams(registry);
  servers.push(server);

  // A subscriber that throws must not stop the others, nor propagate.
  let secondCalled = false;
  registry.subscribe(() => { throw new Error('bad subscriber'); });
  registry.subscribe(() => { secondCalled = true; });
  registry.apply({ type: 'start', id: 'z', server: 'prod', command: 'x', ts: '' });
  assert.strictEqual(secondCalled, true, 'a throwing subscriber must not stop the next one');
  ok('a subscriber that throws does not stop the others');

  // The socket vanishing mid-command must not throw into the caller.
  const stream = openStream('prod', 'long-running');
  await until(() => registry.list().some(s => s.command === 'long-running'));
  server.close();
  try { fs.unlinkSync(streamSocketPath()); } catch { /* fine */ }
  assert.doesNotThrow(() => {
    stream?.write('stdout', 'output after the watcher vanished');
    stream?.end(0);
  }, 'writing to a dead control plane must never throw into the command path');
  ok('the control plane disappearing mid-command does not throw into the caller');
}

async function testMalformedEventsAreIgnored() {
  const registry = new StreamRegistry();
  const server = await listenForStreams(registry);
  servers.push(server);

  const net = await import('net');
  const socket = net.createConnection(streamSocketPath());
  await new Promise(resolve => socket.on('connect', resolve));
  socket.write('this is not json\n');
  socket.write(`${JSON.stringify({ type: 'start', id: 'good', server: 'prod', command: 'ok', ts: '' })}\n`);
  await until(() => registry.get('good'));

  assert.ok(registry.get('good'), 'a valid event after a malformed one must still be applied');
  ok('a malformed line is dropped without taking the connection down');

  // Events split across chunks must be reassembled, since TCP does not respect
  // message boundaries.
  const payload = `${JSON.stringify({ type: 'start', id: 'split', server: 'prod', command: 'halves', ts: '' })}\n`;
  socket.write(payload.slice(0, 12));
  await wait(60);
  socket.write(payload.slice(12));
  await until(() => registry.get('split'));
  assert.ok(registry.get('split'), 'an event split across two writes must be reassembled');
  ok('events split across chunks are reassembled');
  socket.end();
}

async function main() {
  try {
    await testNobodyWatchingCostsNothing();
    await testStreamReachesTheRegistry();
    await testScrollbackIsBounded();
    await testFinishedStreamsAreTrimmed();
    await testAWatcherCannotBreakACommand();
    await testMalformedEventsAreIgnored();
    console.log(`\n✅ live stream tests passed (${passed} checks)`);
  } finally {
    for (const server of servers) {
      try { server.close(); } catch { /* already closed */ }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
