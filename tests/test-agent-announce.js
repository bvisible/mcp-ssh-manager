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
import assert from 'assert';
import { EventEmitter } from 'events';
import SSHManager from '../src/ssh-manager.js';

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

async function main() {
  // 1. execCommand announces.
  assert.strictEqual((await execOpts()).env.AI_AGENT, 'mcp-ssh-manager');
  ok('execCommand sends AI_AGENT=mcp-ssh-manager');

  // 2. execCommandStream announces. Fails if only execCommand is patched.
  assert.strictEqual((await streamOpts()).env.AI_AGENT, 'mcp-ssh-manager');
  ok('execCommandStream sends AI_AGENT (ssh_tail --follow)');

  // 3. requestShell announces, on the SECOND argument.
  const { wnd, opts } = await shellArgs();
  assert.strictEqual(opts.env.AI_AGENT, 'mcp-ssh-manager');
  ok('requestShell sends AI_AGENT (ssh_session_start)');

  // 4. The pty options must survive untouched on the FIRST argument. ssh2
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

  // 5. announceAgent:false opts out, on every site. The objects are asserted
  //    non-null first so that a channelEnv() returning undefined fails here
  //    with a message naming the problem, rather than throwing on .env.
  const offExec = await execOpts({ announceAgent: false });
  const offStream = await streamOpts({ announceAgent: false });
  const offShell = (await shellArgs({ announceAgent: false })).opts;
  assert.ok(offExec && offStream && offShell, 'opted-out options must still be objects');
  assert.strictEqual(offExec.env, undefined);
  assert.strictEqual(offStream.env, undefined);
  assert.strictEqual(offShell.env, undefined);
  ok('announceAgent:false sends nothing, on all three channels');

  // 6. Opted out, the options object is still an object. ssh2's exec reads
  //    opts.allowHalfOpen without guarding, so returning undefined here would
  //    throw for exactly the users who turned the announcement off.
  assert.strictEqual(typeof (await execOpts({ announceAgent: false })), 'object');
  ok('opting out still passes an options object, not undefined');

  console.log(`\n${passed}/6 checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
