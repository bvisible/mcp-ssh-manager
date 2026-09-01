#!/usr/bin/env node
/**
 * A control plane with something in it, for screenshots, for the demo video, and
 * for anyone who wants to see the interface without wiring up real servers first.
 *
 * ## Why there is a fake SSH server in here
 *
 * The screens worth showing — health, the file browser, a live terminal — are
 * the ones that only exist when something answers on the other end. Pointing the
 * demo at somebody's real infrastructure means the pictures leak it, and pointing
 * it at nothing means five screenshots of empty states.
 *
 * So this starts a genuine ssh2 server on the loopback and lets the product talk
 * to it for real: real SFTP over the wire, real exec, real shell. The *answers*
 * are canned, and nothing else is. What you see is the product working, not a
 * mockup of the product working.
 *
 * ## What is fictional, and what is not
 *
 * Fictional: three hostnames, the numbers the health commands report, the
 * contents of a small file tree. Everything a viewer might mistake for real
 * infrastructure is invented and obviously so — 127.0.0.1, `demo`, round numbers.
 *
 * Not fictional: the protocol, the pooling, the approval flow, the rendering,
 * the transfers. A bug in any of those shows up here the same as in production,
 * which is the point of demoing against a real server rather than a stub.
 *
 * Usage:
 *   node scripts/demo-env.mjs            # start, print the URL, stay up
 *   node scripts/demo-env.mjs --port 7315
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
// ssh2 is CommonJS: named imports do not resolve through the ESM bridge.
import ssh2 from 'ssh2';
import { ControlPlane } from '../src/control-plane.js';
import { SecretStore } from '../src/secret-store.js';
import { defaultSocketPath, buildRequest, requestDecision } from '../src/approval.js';
import { openStream } from '../src/live-stream.js';

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-manager-demo-'));
const teardown = [];

// A demo must never touch the operator's real vault or their real key.
process.env.SSH_MANAGER_HOME = scratch;
process.env.SSH_MANAGER_KEY_SOURCE = 'file';

/* ------------------------------------------------------------------ answers */

/**
 * What the fake host says when asked.
 *
 * Keyed on a fragment of the command the product actually builds (see
 * src/health-monitor.js), so if a builder changes shape this stops matching and
 * the demo visibly degrades rather than quietly showing stale numbers.
 */
function respond(command, persona) {
  const { cpu, memUsed, memTotal, disk, uptime, load } = persona;
  const table = [
    // The health screen sends one script with `=== SECTION ===` markers and
    // parses the whole reply (buildComprehensiveHealthCheckCommand). Answering
    // only the first section it recognises is how this first came back showing
    // "reachable" and no gauges at all.
    ['=== CPU ===', () => [
      '=== CPU ===', cpu.toFixed(1),
      '=== MEMORY ===', JSON.stringify({
        total: memTotal, used: memUsed, free: memTotal - memUsed,
        percent: Number((memUsed * 100 / memTotal).toFixed(2)),
      }),
      '=== DISK ===', ...disk.map(d => JSON.stringify(d)),
      '=== LOAD ===', load,
      '=== UPTIME ===', uptime,
      '=== NETWORK ===', '{"interface":"eth0:","rx_bytes":84213904,"tx_bytes":19288471}',
      '',
    ].join('\n')],
    // top -bn1 | ... | awk '{print 100 - $1}'  → a bare float
    ['Cpu(s)', () => `${cpu.toFixed(1)}\n`],
    // free -m | awk ...  → one JSON object
    ['free -m', () => JSON.stringify({
      total: memTotal, used: memUsed, free: memTotal - memUsed,
      percent: (memUsed * 100 / memTotal).toFixed(2),
    })],
    // df -h | awk ...  → one JSON object per line
    ['df -h', () => disk.map(d => JSON.stringify(d)).join('\n') + '\n'],
    ['/proc/net/dev', () =>
      '{"interface":"eth0:","rx_bytes":84213904,"tx_bytes":19288471}\n'],
    ['load average', () => `${load}\n`],
    // Matched before the health command's `uptime -p`, because a person in the
    // shell types `uptime` and expects the familiar one-liner.
    ['uptime', () => ` ${new Date().toUTCString().slice(17, 22)} up ${uptime.replace(/^up /, '')},`
      + `  2 users,  load average: ${load}\n`],
    ['systemctl', () => 'ACTIVE\nENABLED\n1284\nactive (running) since\n'],
    ['ps aux', () =>
      '{"user":"root","pid":1,"cpu":0.0,"mem":0.1,"vsz":168420,"rss":13284,"command":"/sbin/init"}\n' +
      '{"user":"www-data","pid":842,"cpu":1.4,"mem":2.3,"vsz":214880,"rss":48120,"command":"nginx: worker process"}\n' +
      '{"user":"postgres","pid":1104,"cpu":0.7,"mem":4.1,"vsz":398220,"rss":86440,"command":"postgres: checkpointer"}\n'],
    ['whoami', () => `${persona.user}\n`],
    ['hostname', () => `${persona.name}\n`],
  ];
  const hit = table.find(([fragment]) => command.includes(fragment));
  if (hit) return hit[1]();

  // Anything else: enough of a shell to be convincing in a terminal recording.
  if (/^\s*(ls|ll)\b/.test(command)) return 'app  backups  logs  releases\n';
  if (/^\s*pwd\b/.test(command)) return `/home/${persona.user}\n`;
  if (/^\s*date\b/.test(command)) return new Date().toUTCString() + '\n';
  if (/^\s*(echo)\s+/.test(command)) return command.replace(/^\s*echo\s+/, '') + '\n';
  return '';
}

/* -------------------------------------------------------------- the SFTP fs */

function serveSftp(sftp, root) {
  const handles = new Map();
  let counter = 0;
  const real = p => path.join(root, path.normalize('/' + p));
  const attrsOf = st => ({
    mode: st.mode, size: st.size, uid: st.uid, gid: st.gid,
    atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000),
  });
  const newHandle = value => {
    const id = Buffer.from(`h${counter++}`);
    handles.set(id.toString(), value);
    return id;
  };

  sftp.on('OPENDIR', (reqid, dir) => {
    try {
      handles.set(`d${counter}`, { entries: fs.readdirSync(real(dir)), dir, sent: false });
      sftp.handle(reqid, Buffer.from(`d${counter++}`));
    } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); }
  });
  sftp.on('READDIR', (reqid, handle) => {
    const state = handles.get(handle.toString());
    if (!state || state.sent) return sftp.status(reqid, STATUS_CODE.EOF);
    state.sent = true;
    sftp.name(reqid, state.entries.map(name => ({
      filename: name, longname: name,
      attrs: attrsOf(fs.lstatSync(path.join(real(state.dir), name))),
    })));
  });
  // A browser that cannot stat shows every entry as a file of unknown size.
  for (const event of ['STAT', 'LSTAT']) {
    sftp.on(event, (reqid, target) => {
      try { sftp.attrs(reqid, attrsOf(fs.lstatSync(real(target)))); }
      catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); }
    });
  }
  sftp.on('FSTAT', (reqid, handle) => {
    const state = handles.get(handle.toString());
    try { sftp.attrs(reqid, attrsOf(fs.fstatSync(state.fd))); }
    catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
  });
  sftp.on('OPEN', (reqid, filename, flags) => {
    try {
      const mode = (flags & OPEN_MODE.WRITE) ? 'w' : 'r';
      sftp.handle(reqid, newHandle({ fd: fs.openSync(real(filename), mode), pos: 0 }));
    } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); }
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const state = handles.get(handle.toString());
    const buf = Buffer.alloc(length);
    const read = fs.readSync(state.fd, buf, 0, length, offset);
    if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, buf.subarray(0, read));
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    fs.writeSync(handles.get(handle.toString()).fd, data, 0, data.length, offset);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('CLOSE', (reqid, handle) => {
    const state = handles.get(handle.toString());
    if (state?.fd !== undefined) { try { fs.closeSync(state.fd); } catch { /* fine */ } }
    handles.delete(handle.toString());
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('REALPATH', (reqid, given) => {
    const resolved = given === '.' ? '/srv' : path.posix.normalize(given);
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }]);
  });
  sftp.on('MKDIR', (reqid, dir) => {
    try { fs.mkdirSync(real(dir)); sftp.status(reqid, STATUS_CODE.OK); }
    catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
  });
  sftp.on('RENAME', (reqid, from, to) => {
    try { fs.renameSync(real(from), real(to)); sftp.status(reqid, STATUS_CODE.OK); }
    catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
  });
  sftp.on('REMOVE', (reqid, file) => {
    try { fs.unlinkSync(real(file)); sftp.status(reqid, STATUS_CODE.OK); }
    catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
  });
  sftp.on('RMDIR', (reqid, dir) => {
    try { fs.rmdirSync(real(dir)); sftp.status(reqid, STATUS_CODE.OK); }
    catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
  });
}

/* ------------------------------------------------------------------- the host */

function startHost(persona, root) {
  const keyPath = path.join(scratch, `hostkey-${persona.name}`);
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q']);

  const server = new Server({ hostKeys: [fs.readFileSync(keyPath)] }, client => {
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('sftp', a => serveSftp(a(), root));
        session.on('exec', (a, _reject, info) => {
          const stream = a();
          stream.write(respond(info.command, persona));
          stream.exit(0);
          stream.end();
        });
        // ssh2's client sends `pty-req` before `shell`, and a server that does
        // not answer it fails the whole request — "Unable to request a
        // pseudo-terminal", which is what this demo showed for a while. Only
        // found by opening a shell and typing in it; every automated check
        // until then had called the handler directly.
        session.on('pty', accept => accept && accept());
        session.on('window-change', accept => accept && accept());

        // An interactive shell, just enough of one to type into on camera.
        session.on('shell', a => {
          const stream = a();
          const prompt = `\x1b[32m${persona.user}@${persona.name}\x1b[0m:\x1b[34m~\x1b[0m$ `;
          stream.write(`Linux ${persona.name} 6.8.0 x86_64\r\n`);
          stream.write(`Last login: ${new Date().toUTCString()}\r\n\r\n${prompt}`);
          let line = '';
          stream.on('data', chunk => {
            for (const ch of chunk.toString('utf8')) {
              if (ch === '\r' || ch === '\n') {
                stream.write('\r\n');
                if (line.trim() === 'exit') { stream.exit(0); return stream.end(); }
                const out = respond(line, persona);
                if (out) stream.write(out.replace(/\n/g, '\r\n'));
                line = '';
                stream.write(prompt);
              } else if (ch === '\x7f') {                 // backspace
                if (line) { line = line.slice(0, -1); stream.write('\b \b'); }
              } else if (ch === '\x03') {                  // ctrl-c
                line = ''; stream.write('^C\r\n' + prompt);
              } else {
                line += ch; stream.write(ch);
              }
            }
          });
        });
      });
    });
    client.on('error', () => { /* a client hanging up is normal */ });
  });

  teardown.push(() => server.close());
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/* --------------------------------------------------------------------- setup */

/** A small file tree, so the browser has something with shape to show. */
function makeTree(root) {
  const files = {
    'srv/app/releases/2026-08-28/manifest.json': '{\n  "release": "2026-08-28",\n  "ok": true\n}\n',
    'srv/app/releases/2026-08-21/manifest.json': '{\n  "release": "2026-08-21",\n  "ok": true\n}\n',
    'srv/app/current/config.yml': 'workers: 4\ntimeout: 30\n',
    'srv/app/current/app.log': 'ready\nserving on :8080\n',
    'srv/backups/db-2026-08-28.sql.gz': 'x'.repeat(4096),
    'srv/backups/db-2026-08-27.sql.gz': 'x'.repeat(4096),
    'srv/logs/nginx/access.log': 'GET / 200\n'.repeat(40),
    'srv/logs/nginx/error.log': '',
  };
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
}

const PERSONAS = [
  { name: 'production', user: 'deploy', group: 'production', cpu: 34.2, memUsed: 5312,
    memTotal: 16008, uptime: 'up 4 weeks, 2 days', load: '0.42, 0.51, 0.48',
    disk: [{ mount: '/', size: '80G', used: '38G', avail: '38G', percent: 51 },
      { mount: '/var', size: '200G', used: '64G', avail: '126G', percent: 34 }] },
  { name: 'staging', user: 'deploy', group: 'staging', cpu: 8.7, memUsed: 2140,
    memTotal: 8192, uptime: 'up 6 days, 3 hours', load: '0.11, 0.09, 0.08',
    disk: [{ mount: '/', size: '40G', used: '12G', avail: '26G', percent: 32 }] },
  { name: 'backup', user: 'root', group: 'infra', cpu: 61.5, memUsed: 3600,
    memTotal: 4096, uptime: 'up 129 days', load: '1.84, 1.62, 1.40',
    disk: [{ mount: '/', size: '32G', used: '9G', avail: '22G', percent: 30 },
      { mount: '/mnt/archive', size: '4.0T', used: '3.6T', avail: '380G', percent: 91 }] },
];

/**
 * Put something real in flight, so Waiting and Live have content.
 *
 * @param {string} url The control plane URL, token included
 */
async function seedActivity(url) {
  // A command that trips the destructive check, left pending. requestDecision
  // resolves when somebody decides or the deadline passes; we deliberately do
  // not await it — the point is that it sits there.
  const request = buildRequest(
    { name: 'production', host: '127.0.0.1', user: 'deploy', mode: 'unrestricted' },
    'ssh_execute',
    { command: 'rm -rf /srv/app/releases/2026-08-21' },
    'rm -rf /srv/app/releases/2026-08-21',
  );
  requestDecision(request, { timeoutMs: 60 * 60 * 1000 })
    .catch(() => { /* nobody decided; the demo ended first */ });

  // An open shell on staging, with a couple of commands already run, so the Live
  // view has scrollback rather than a blank terminal.
  // Every request carries the token, so build paths off the URL we were given
  // rather than resolving against its origin — `new URL('/api/…', url)` drops
  // the query string and every call comes back 401.
  const base = new URL(url);
  const api = (pathname, params = {}) => {
    const target = new URL(pathname, base);
    target.search = base.search;
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return target;
  };
  const post = (pathname, body, params) => fetch(api(pathname, params), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // A live command, through the same openStream() the engine uses. Nothing is
  // faked into the registry: the socket carries it exactly as it would in
  // anger, which is why the Live view can be trusted as a picture of the product.
  const stream = openStream('production', 'tail -f /srv/logs/nginx/access.log');
  if (stream) {
    // The stream connects asynchronously; writing immediately loses the first
    // lines, which is how this first came back with an empty scrollback.
    await new Promise(r => setTimeout(r, 400));
    const lines = [
      '\u001b[2m2026-08-31T10:12:03Z\u001b[0m 192.0.2.44 GET /api/orders \u001b[32m200\u001b[0m 41ms',
      '\u001b[2m2026-08-31T10:12:03Z\u001b[0m 192.0.2.19 GET /assets/app.css \u001b[32m200\u001b[0m 3ms',
      '\u001b[2m2026-08-31T10:12:04Z\u001b[0m 198.51.100.7 POST /api/checkout \u001b[32m201\u001b[0m 128ms',
      '\u001b[2m2026-08-31T10:12:05Z\u001b[0m 192.0.2.44 GET /api/orders/8821 \u001b[33m404\u001b[0m 7ms',
      '\u001b[2m2026-08-31T10:12:06Z\u001b[0m 203.0.113.5 GET /health \u001b[32m200\u001b[0m 1ms',
    ];
    for (const line of lines) {
      await new Promise(r => setTimeout(r, 120));
      stream.write('stdout', line + '\n');
    }
  }

  try {
    const open = await post('/api/terminal', { server: 'staging' });
    if (open.ok) {
      const { id } = await open.json();
      for (const line of ['uptime\r', 'df -h /\r', 'ls\r']) {
        await new Promise(r => setTimeout(r, 300));
        await post('/api/terminal/input', { data: line }, { id });
      }
    }
  } catch { /* the demo is still useful without it */ }
}

async function main() {
  const args = process.argv.slice(2);
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 0;

  const root = path.join(scratch, 'hosts');
  makeTree(root);

  // The file browser's left pane is *this* machine, so point HOME at a stand-in.
  // Without this the screenshots publish whatever happens to be in the
  // maintainer's home directory — which is how the first set of README images
  // had to be thrown away and taken again.
  // Under /Users/Shared rather than $TMPDIR: the breadcrumb is part of the
  // picture, and `Users > Shared > ssh-manager-demo` reads like a home
  // directory where `/var/folders/0g/_1g568_j7lg51…` reads like a fault.
  // Removed on exit with the rest of the scratch.
  const home = fs.existsSync('/Users/Shared')
    ? path.join('/Users/Shared', 'ssh-manager-demo')
    : path.join(scratch, 'home', 'demo');
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of ['Desktop', 'Documents', 'Downloads', 'Projects/api', 'Projects/website']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(home, 'Documents', 'runbook.md'), '# Runbook\n');
  fs.writeFileSync(path.join(home, 'Projects', 'api', 'deploy.sh'), '#!/bin/sh\necho deploying\n');
  fs.writeFileSync(path.join(home, 'Projects', 'website', 'index.html'), '<h1>hello</h1>\n');
  process.env.HOME = home;

  // Into the vault rather than the environment: the Servers screen manages what
  // is *in the vault*, so an env-only server would run fine and show up nowhere.
  const store = new SecretStore(path.join(scratch, 'vault.json'));
  for (const persona of PERSONAS) {
    const sshPort = await startHost(persona, root);
    store.setServer(persona.name, {
      host: '127.0.0.1',
      port: sshPort,
      user: persona.user,
      password: 'demo',
      group: persona.group,
      defaultDir: '/srv',
    });
  }

  const plane = new ControlPlane({ socketPath: defaultSocketPath(), port, auditPaths: [] });
  const { url } = await plane.start();

  console.log(`
  Demo control plane running — three fake hosts on the loopback.

    ${url}

    app view:  ${url}${url.includes('?') ? '&' : '?'}shell=macos

  Nothing here touches your own servers or your own vault: home is ${scratch}.
  Ctrl-C to stop; the scratch directory goes with it.
`);

  // Waiting and Live are empty screens until something is actually happening, and
  // an empty screen is a bad screenshot and a worse demo. So put real work in
  // flight: a destructive command genuinely paused on the approval socket, and a
  // shell genuinely open on one of the hosts. Both go through the same code an
  // agent would; neither is drawn.
  await seedActivity(url);

  // Dropping a file on the Dock icon only happens in the packaged application,
  // so the browser has no way to reach that code path. With this set, the demo
  // announces the same event the desktop shell would, which is how the dialog
  // that asks "send it where?" can be seen and tested without a build.
  if (process.env.SSH_MANAGER_DEMO_DROP) {
    // Repeated, because a page that opens later would otherwise miss the one
    // announcement and the dialog would look broken rather than un-triggered.
    const paths = process.env.SSH_MANAGER_DEMO_DROP.split(',').map(p => p.trim());
    const timer = setInterval(() => plane.announce({ type: 'dropped-files', paths }), 12000);
    timer.unref();
  }

  const stop = async () => {
    for (const fn of teardown) { try { fn(); } catch { /* going away anyway */ } }
    await plane.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
    if (home.startsWith('/Users/Shared/')) fs.rmSync(home, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error(`Demo failed to start: ${error.message}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
