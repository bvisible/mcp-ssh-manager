// Behavioural test for the AI_AGENT declaration (see the README).
//
// SSHManager opens a channel in three places that can carry an env request:
// execCommand, execCommandStream and requestShell. `env` is a per-channel
// request (RFC 4254 §6.4), not a connection-level option, so each site needs
// its own copy — and a suite that only drives execCommand stays green while
// the other two announce nothing. There is one case per site below, and each
// fails if the announcement is removed from that site alone.
//
// getSFTP and forwardOut are deliberately excluded; see the comments on those
// methods in src/ssh-manager.js.
//
// Off unless chosen, per server or with SSH_MANAGER_ANNOUNCE_AGENT, so that
// upgrading changes nothing that reaches a server. And never for a person:
// every connection the control plane opens is a human's, and labelling one as
// an agent would be the confusion the convention exists to end.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import SSHManager, { rsyncAgentAnnouncement } from '../src/ssh-manager.js';
import { connectionConfig } from '../src/ssh-connection.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

function makeFakeStream() {
  const s = new EventEmitter();
  s.stderr = new EventEmitter();
  s.write = () => true;
  s.end = () => {};
  s.destroy = () => {};
  return s;
}

// The stubs below reproduce ssh2's own argument normalisation, so that a
// plausible wrong implementation reaches the assertion that names it instead
// of crashing on an arity mismatch. Without this, folding the announcement
// into the pty options would fail with "cb is not a function" and the test
// would look like it caught the right thing for the wrong reason.
function normaliseExec(opts, cb) {
  if (typeof opts === 'function') return { opts: {}, cb: opts };
  return { opts, cb };
}

// ssh2 lib/client.js: shell(wndopts, opts, cb) shifts its arguments, and
// then reassigns opts = wndopts when the window object carries env or x11.
function normaliseShell(a, b, cb) {
  if (typeof a === 'function') return { wnd: undefined, opts: undefined, cb: a };
  if (typeof b === 'function') { cb = b; b = undefined; }
  if (a && (a.x11 !== undefined || a.env !== undefined)) return { wnd: undefined, opts: a, cb };
  return { wnd: a, opts: b, cb };
}

// execCommand: capture the options object reaching client.exec.
async function execOpts(config = {}) {
  const manager = new SSHManager({ host: 'h', username: 'u', ...config });
  manager.connected = true;
  const stream = makeFakeStream();
  let seen;
  manager.client = {
    exec(cmd, o, c) {
      const { opts, cb } = normaliseExec(o, c);
      seen = opts;
      setImmediate(() => {
        cb(null, stream);
        setImmediate(() => stream.emit('close', 0, null));
      });
    },
    end() {}
  };
  await manager.execCommand('echo hi');
  return seen;
}

// execCommandStream: the ssh_tail follow path, one caller only.
async function streamOpts(config = {}) {
  const manager = new SSHManager({ host: 'h', username: 'u', ...config });
  manager.connected = true;
  const stream = makeFakeStream();
  let seen;
  manager.client = {
    exec(cmd, o, c) {
      const { opts, cb } = normaliseExec(o, c);
      seen = opts;
      setImmediate(() => {
        cb(null, stream);
        setImmediate(() => stream.emit('close', 0, null));
      });
    },
    end() {}
  };
  await manager.execCommandStream('tail -f /var/log/syslog');
  return seen;
}

// requestShell: capture BOTH ssh2 arguments, because which one carries the
// announcement decides whether the pty settings survive.
async function shellArgs(config = {}) {
  const manager = new SSHManager({ host: 'h', username: 'u', ...config });
  manager.connected = true;
  const stream = makeFakeStream();
  let wnd, opts;
  manager.client = {
    shell(a, b, c) {
      const n = normaliseShell(a, b, c);
      wnd = n.wnd;
      opts = n.opts;
      setImmediate(() => n.cb(null, stream));
    },
    end() {}
  };
  await manager.requestShell({ term: 'xterm-256color', cols: 80, rows: 24, modes: { ECHO: 0 } });
  return { wnd, opts };
}

/** Run `fn` with SSH_MANAGER_ANNOUNCE_AGENT set, then put the old value back. */
async function withGlobal(value, fn) {
  const saved = process.env.SSH_MANAGER_ANNOUNCE_AGENT;
  process.env.SSH_MANAGER_ANNOUNCE_AGENT = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.SSH_MANAGER_ANNOUNCE_AGENT;
    else process.env.SSH_MANAGER_ANNOUNCE_AGENT = saved;
  }
}

async function main() {
  delete process.env.SSH_MANAGER_ANNOUNCE_AGENT;
  const ON = { announceAgent: true };

  // 1. The upgrade promise: nothing is announced unless someone chose it, on
  //    any of the three sites, and each still receives an options object —
  //    ssh2's exec reads opts.allowHalfOpen without guarding, so undefined
  //    would throw for every user who never heard of this feature.
  const quiet = [await execOpts(), await streamOpts(), (await shellArgs()).opts];
  for (const opts of quiet) {
    assert.ok(opts && typeof opts === 'object', 'options must still be an object when nothing is announced');
    assert.strictEqual(opts.env, undefined, 'nothing may be announced by default');
  }
  ok('by default nothing is announced, on all three channels, and ssh2 still gets an options object');

  // 2. execCommand announces once chosen.
  assert.strictEqual((await execOpts(ON)).env.AI_AGENT, 'mcp-ssh-manager');
  ok('execCommand sends AI_AGENT=mcp-ssh-manager when the server opts in');

  // 3. execCommandStream announces. Fails if only execCommand is patched.
  assert.strictEqual((await streamOpts(ON)).env.AI_AGENT, 'mcp-ssh-manager');
  ok('execCommandStream sends AI_AGENT (ssh_tail --follow)');

  // 4. requestShell announces, on the SECOND argument.
  const { wnd, opts } = await shellArgs(ON);
  assert.strictEqual(opts.env.AI_AGENT, 'mcp-ssh-manager');
  ok('requestShell sends AI_AGENT (ssh_session_start)');

  // 5. The pty options must survive untouched on the FIRST argument. ssh2
  //    reassigns opts = wndopts and drops wndopts when the first object
  //    carries `env`, so folding the announcement into the window options
  //    would lose term/cols/rows/modes — and every assertion above would
  //    still pass. This is the case that catches that mistake.
  assert.ok(wnd, 'window options must not be undefined');
  assert.strictEqual(wnd.term, 'xterm-256color');
  assert.strictEqual(wnd.cols, 80);
  assert.strictEqual(wnd.rows, 24);
  assert.strictEqual(wnd.modes.ECHO, 0, 'ECHO:0 is load-bearing for the session marker protocol');
  assert.strictEqual(wnd.env, undefined, 'the announcement must not be folded into the window options');
  ok('requestShell keeps term/cols/rows/modes on the window options');

  // 6. The global switch turns it on for servers that said nothing, and a
  //    per-server false still wins on every site: one untrusted host stays
  //    silent under a fleet-wide switch.
  await withGlobal('true', async () => {
    assert.strictEqual((await execOpts()).env.AI_AGENT, 'mcp-ssh-manager', 'the global switch must enable an unset server');
    const OFF = { announceAgent: false };
    assert.strictEqual((await execOpts(OFF)).env, undefined);
    assert.strictEqual((await streamOpts(OFF)).env, undefined);
    assert.strictEqual((await shellArgs(OFF)).opts.env, undefined);
  });
  await withGlobal('no', async () => {
    assert.strictEqual((await execOpts()).env, undefined, 'an explicit "no" must not enable it');
  });
  ok('SSH_MANAGER_ANNOUNCE_AGENT enables unset servers; a per-server false wins on all three channels');

  // 7. A person is never announced as an agent, even when the server and the
  //    global switch both ask for it.
  await withGlobal('true', async () => {
    const servers = { prod: { host: 'h', username: 'u', announceAgent: true } };
    const human = connectionConfig('prod', servers, 'human');
    assert.strictEqual(human.announceAgent, false);
    assert.strictEqual(servers.prod.announceAgent, true, 'the loaded configuration must not be mutated');
    assert.strictEqual((await execOpts(human)).env, undefined, 'a human connection must announce nothing');
    assert.strictEqual(connectionConfig('prod', servers).announceAgent, true, 'an agent connection keeps the server’s choice');
  });
  ok('a connection opened for a person never announces, whatever the server or the global switch says');

  // 8. And every connection the control plane opens is a person's. A new call
  //    added without the marker would announce a click as an agent; this is
  //    the guard that makes forgetting it fail.
  const plane = fs.readFileSync(path.join(SRC, 'control-plane.js'), 'utf8');
  const calls = plane.match(/connectServer\([^)]*\)/g) || [];
  assert.ok(calls.length >= 5, `expected the control plane's connections, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /actor: 'human'/, `control-plane connection without actor: 'human': ${call}`);
  }
  assert.ok(!/new SSHManager\(/.test(plane), 'the control plane must connect through connectServer, not around it');
  ok(`all ${calls.length} control-plane connections are marked as a person's`);

  // 9. ssh_sync drives the system ssh, not ssh2: SendEnv plus the variable in
  //    rsync's environment, and nothing at all by default.
  assert.deepStrictEqual(rsyncAgentAnnouncement({}), { sshOptions: [], env: {} });
  assert.deepStrictEqual(rsyncAgentAnnouncement(ON), {
    sshOptions: ['-o SendEnv=AI_AGENT'], env: { AI_AGENT: 'mcp-ssh-manager' },
  });
  // No POSIX CI run can observe the real rsync argv (ssh_sync connects over
  // SSH first), so the wiring is checked where it lives, as test-rsync-path does.
  const index = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  assert.match(index, /sshOptions\.push\(\.\.\.agentAnnouncement\.sshOptions\)/, 'ssh_sync must pass the SendEnv option');
  assert.match(index, /processEnv = \{ \.\.\.process\.env, \.\.\.agentAnnouncement\.env \}/, 'ssh_sync must put AI_AGENT in rsync’s environment');
  ok('ssh_sync announces through SendEnv when chosen, and adds nothing otherwise');

  console.log(`\n${passed}/9 checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
