// Tests for the interactive terminal.
//
// Driven against a real SSH server — ssh2 can be one — rather than a mock, so
// what is exercised is an actual shell channel: a PTY is requested, bytes flow
// both ways, and a resize reaches the far side. A mock would prove only that the
// code calls the functions it calls.
//
// The point worth stating: the *remote* shell needs **no native module**. ssh2
// allocates the far pseudo-terminal itself (`client.shell()`), so there is no
// node-pty in the engine and nothing to compile at install time.
//
// A shell on *this* machine does need one, which is why the control plane does
// not open it — a host process hands one down through `setLocalShellProvider`.
// That contract is a function, so it is tested here with a stand-in and this
// file still needs nothing compiled.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
// ssh2 is CommonJS: named imports do not resolve through the ESM bridge.
import ssh2 from 'ssh2';
const { Server } = ssh2;
import { ControlPlane } from '../src/control-plane.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'term-'));
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
process.env.SSH_MANAGER_HOME = scratch;

/** @type {any[]} */
const cleanup = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await wait(25);
  }
  return null;
}

/**
 * A minimal SSH server that accepts any password and answers a shell request
 * with a fake prompt, echoing what it receives.
 *
 * @returns {Promise<{port: number, seen: {pty: any, resized: any[], input: string}}>}
 */
function startSshServer() {
  const keyPath = path.join(scratch, 'host_key');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q']);

  const seen = { pty: null, resized: [], input: '' };

  const server = new Server({ hostKeys: [fs.readFileSync(keyPath)] }, client => {
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        // The PTY request is what makes this a terminal rather than a pipe.
        session.on('pty', (accept2, reject2, info) => { seen.pty = info; accept2?.(); });
        session.on('window-change', (accept2, reject2, info) => { seen.resized.push(info); accept2?.(); });
        session.on('shell', accept2 => {
          const stream = accept2();
          stream.write('fake-host:~$ ');
          stream.on('data', chunk => {
            seen.input += chunk.toString();
            // Echo, as a real shell does, so the test can see the round trip.
            stream.write(chunk);
          });
        });
      });
    });
    client.on('error', () => { /* the client hanging up is normal here */ });
  });

  cleanup.push(() => server.close());
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, seen });
    });
  });
}

async function startPlane() {
  const plane = new ControlPlane({
    socketPath: path.join(scratch, `cp${cleanup.length}.sock`),
    port: 0,
    vaultPath: path.join(scratch, 'vault.json'),
  });
  cleanup.push(() => plane.stop());
  const { url } = await plane.start();
  return { plane, base: url.split('/?')[0] };
}

/**
 * A shell on this machine.
 *
 * The control plane cannot open one itself — that needs a pseudo-terminal, and
 * the engine ships no native module — so a host process hands one down. Which
 * makes this testable without node-pty: the contract is the factory, and a
 * stand-in exercises every line of the control plane's half.
 */
async function testLocalShell() {
  const { plane, base } = await startPlane();
  const q = `token=${plane.token}`;

  // --- before anything offers one ---
  const refused = await fetch(`${base}/api/terminal?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local: true, cols: 80, rows: 24 }),
  });
  assert.strictEqual(refused.status, 501, 'without a provider a local shell must be refused, not faked');
  const offered = await (await fetch(`${base}/api/options?${q}`)).json();
  assert.strictEqual(offered.localShell, false, 'the page must be told there is no local shell');
  ok('with no provider, a local shell is refused and the interface is told not to offer one');

  // --- with one ---
  const fake = { written: [], resized: [], killed: false, emit: null, opened: null };
  plane.setLocalShellProvider(async ({ cols, rows, cwd }) => {
    fake.opened = { cols, rows, cwd };
    return {
      shell: 'zsh',
      onData: handler => { fake.emit = handler; },
      onExit: () => {},
      write: data => fake.written.push(data.toString('utf8')),
      resize: (nextCols, nextRows) => fake.resized.push({ cols: nextCols, rows: nextRows }),
      kill: () => { fake.killed = true; },
    };
  });

  const nowOffered = await (await fetch(`${base}/api/options?${q}`)).json();
  assert.strictEqual(nowOffered.localShell, true, 'once a provider exists the page must be told');

  const opened = await fetch(`${base}/api/terminal?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local: true, cols: 111, rows: 33 }),
  });
  const session = await opened.json();
  assert.strictEqual(opened.status, 200, `a local shell must open, got ${JSON.stringify(session)}`);
  assert.strictEqual(session.local, true, 'the answer must say which machine this is');
  assert.deepStrictEqual(
    { cols: fake.opened.cols, rows: fake.opened.rows }, { cols: 111, rows: 33 },
    'the pane\u2019s size must reach the pseudo-terminal, or the first draw is wrong');
  ok('a local shell opens at the size the pane asked for');

  // --- bytes out ---
  const stream = await fetch(`${base}/api/terminal/stream?id=${session.id}&${q}`);
  const reader = stream.body.getReader();
  await until(() => fake.emit);
  fake.emit(Buffer.from('h\u00e9llo \u001b[32mgreen\u001b[0m'));
  // The stream opens with a `: connected` comment, so read until a data frame
  // rather than assuming the first chunk is one.
  const decoder = new TextDecoder();
  let buffer = '';
  let seenText = '';
  for (let attempt = 0; attempt < 5 && !seenText; attempt += 1) {
    buffer += decoder.decode((await reader.read()).value ?? new Uint8Array());
    const line = buffer.split('\n').find(candidate => candidate.startsWith('data: '));
    if (line) seenText = Buffer.from(JSON.parse(line.slice(6)).chunk, 'base64').toString();
  }
  assert.strictEqual(seenText, 'h\u00e9llo \u001b[32mgreen\u001b[0m',
    'escape sequences and multi-byte characters must survive the trip');
  ok('output reaches the page byte for byte, colours and accents included');

  // --- keystrokes in, and the window size ---
  await fetch(`${base}/api/terminal/input?id=${session.id}&${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: Buffer.from('ls -l\n').toString('base64') }),
  });
  assert.deepStrictEqual(fake.written, ['ls -l\n'], 'keystrokes must arrive as typed');

  await fetch(`${base}/api/terminal/resize?id=${session.id}&${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols: 140, rows: 45 }),
  });
  // node-pty takes (cols, rows) and ssh2 takes (rows, cols); getting the order
  // wrong garbles every full-screen program and nothing else complains.
  assert.deepStrictEqual(fake.resized, [{ cols: 140, rows: 45 }], 'a resize must arrive the right way round');
  ok('keystrokes and window size reach the shell, with cols and rows the right way round');

  // --- closing ---
  await reader.cancel().catch(() => {});
  const closed = await fetch(`${base}/api/terminal?id=${session.id}&${q}`, { method: 'DELETE' });
  assert.strictEqual(closed.status, 200, 'closing must succeed');
  assert.strictEqual(fake.killed, true, 'closing the pane must kill the process, not leak it');
  ok('closing the pane kills the local process');
}

async function main() {
  try {
    const { port, seen } = await startSshServer();
    const { plane, base } = await startPlane();
    const q = `token=${plane.token}`;

    plane.store.setServer('testbox', { host: '127.0.0.1', port, user: 'tester', password: 'anything' });

    // --- opening ---
    const opened = await fetch(`${base}/api/terminal?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: 'testbox', cols: 100, rows: 30 }),
    });
    const session = await opened.json();
    assert.strictEqual(opened.status, 200, `opening a shell must succeed, got ${JSON.stringify(session)}`);
    assert.ok(session.id, 'a terminal id must come back');
    ok('an interactive shell opens on a real SSH server');

    // The remote side must have been asked for a terminal, with our size.
    const pty = await until(() => seen.pty);
    assert.ok(pty, 'the server must have received a PTY request — without it this is a pipe, not a terminal');
    assert.strictEqual(pty.cols, 100, 'the requested width must reach the far side');
    assert.strictEqual(pty.rows, 30, 'the requested height must reach the far side');
    assert.match(String(pty.term), /xterm/, 'a terminal type must be declared, or colours are off');
    ok(`a real PTY is allocated remotely (${pty.term}, ${pty.cols}×${pty.rows}) — no native module involved`);

    // --- output flows back, including what arrived before anyone watched ---
    // The banner and first prompt land in the gap between the shell opening and
    // the browser subscribing. Waiting here makes that gap certain rather than
    // timing-dependent, so this really tests the replay.
    await wait(300);
    const received = [];
    const stream = await fetch(`${base}/api/terminal/stream?${q}&id=${session.id}`);
    const reader = stream.body.getReader();
    const readSome = (async () => {
      const decoder = new TextDecoder();
      for (let i = 0; i < 6; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('data: ')) received.push(JSON.parse(line.slice(6)));
        }
      }
    })();

    const prompt = await until(() => received.find(m => Buffer.from(m.chunk, 'base64').toString().includes('$')));
    assert.ok(prompt, 'the prompt printed before anyone subscribed must still be replayed');
    ok('a screen attaching late still sees the banner and prompt (backlog replay)');

    // --- input flows in ---
    await fetch(`${base}/api/terminal/input?${q}&id=${session.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('whoami\r').toString('base64') }),
    });
    const echoed = await until(() => seen.input.includes('whoami'));
    assert.ok(echoed, 'what is typed must reach the remote shell');
    ok('keystrokes reach the remote shell');

    // --- resizing ---
    await fetch(`${base}/api/terminal/resize?${q}&id=${session.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 120, rows: 40 }),
    });
    const resize = await until(() => seen.resized.find(r => r.cols === 120));
    assert.ok(resize, 'a resize must reach the far side, or full-screen programs draw at the wrong size');
    assert.strictEqual(resize.rows, 40);
    ok('resizing the window is forwarded to the remote terminal');

    // --- closing releases the connection ---
    const closed = await fetch(`${base}/api/terminal?${q}&id=${session.id}`, { method: 'DELETE' });
    assert.strictEqual(closed.status, 200);
    assert.strictEqual(plane.terminals.size, 0, 'closing must release the shell, not leak an SSH connection');
    const gone = await fetch(`${base}/api/terminal/input?${q}&id=${session.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: '' }),
    });
    assert.strictEqual(gone.status, 404, 'a closed terminal must not still accept input');
    ok('closing releases the SSH connection and the id stops working');
    reader.cancel().catch(() => {});
    await readSome.catch(() => {});

    // --- refusals ---
    const unknown = await fetch(`${base}/api/terminal?${q}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: 'not-in-the-vault' }),
    });
    assert.strictEqual(unknown.status, 404, 'opening a shell on an unknown server must 404');
    const noToken = await fetch(`${base}/api/terminal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: 'testbox' }),
    });
    assert.strictEqual(noToken.status, 401, 'a shell is the most dangerous thing here — it must require the token');
    ok('an unknown server 404s, and opening a shell requires the token');

    // --- the built interface, and nothing else, is served from disk ---
    // xterm.js used to be vendored and served from /vendor. The app bundles it
    // now, so the only files reaching a browser are the build's own.
    for (const [asset, type] of [['/app.js', 'javascript'], ['/app.css', 'css']]) {
      const res = await fetch(`${base}${asset}?${q}`);
      assert.strictEqual(res.status, 200, `${asset} must be served — run npm run build:ui`);
      assert.match(res.headers.get('content-type') || '', new RegExp(type));
    }
    // These two routes read a path out of a URL, which is how traversal happens.
    for (const attempt of ['/assets/../../package.json', '/assets/../../../etc/passwd']) {
      const res = await fetch(`${base}${attempt}?${q}`);
      assert.notStrictEqual(res.status, 200, `${attempt} must not be served`);
    }
    const bundleWithoutToken = await fetch(`${base}/app.js`);
    assert.strictEqual(bundleWithoutToken.status, 401, 'even the bundle requires the token');
    ok('the built interface is served, nothing outside it is, and it needs the token');

    await testLocalShell();

    console.log(`\n✅ terminal tests passed (${passed} checks)`);
  } finally {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* already gone */ }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
