// Tests for the file operations behind the control plane's file browser.
//
// Driven against a real SFTP server — ssh2 can be one — because the failures
// worth catching here are protocol-shaped: a POSIX mode misread as a file type,
// a path joined wrongly at the root, a pooled connection that dies between two
// requests. A mock returning what the test expects would prove none of it.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
// ssh2 is CommonJS: named imports do not resolve through the ESM bridge.
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { ControlPlane } from '../src/control-plane.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'files-'));
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
process.env.SSH_MANAGER_HOME = scratch;

/** @type {any[]} */
const cleanup = [];

/**
 * An SFTP server backed by a real directory on disk, so readdir, stat, rename
 * and unlink go through ssh2's protocol layer and land on a real filesystem.
 */
function startSftpServer(root) {
  const keyPath = path.join(scratch, 'host_key');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q']);
  const { STATUS_CODE, OPEN_MODE } = utils.sftp;

  const server = new Server({ hostKeys: [fs.readFileSync(keyPath)] }, client => {
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('sftp', accept2 => {
          const sftp = accept2();
          /** @type {Map<string, any>} */
          const handles = new Map();
          let counter = 0;
          const real = p => path.join(root, path.normalize('/' + p));
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
            sftp.name(reqid, state.entries.map(name => {
              const st = fs.lstatSync(path.join(real(state.dir), name));
              return {
                filename: name,
                longname: name,
                attrs: { mode: st.mode, size: st.size, uid: st.uid, gid: st.gid,
                  atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) },
              };
            }));
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
            const state = handles.get(handle.toString());
            fs.writeSync(state.fd, data, 0, data.length, offset);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('CLOSE', (reqid, handle) => {
            const state = handles.get(handle.toString());
            if (state?.fd !== undefined) { try { fs.closeSync(state.fd); } catch { /* fine */ } }
            handles.delete(handle.toString());
            sftp.status(reqid, STATUS_CODE.OK);
          });
          // REALPATH is how a client learns where '.' actually is. Without it a
          // file browser opens on a directory it cannot name.
          sftp.on('REALPATH', (reqid, given) => {
            const resolved = given === '.' ? '/home/demo' : path.posix.normalize(given);
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
        });
      });
    });
    client.on('error', () => { /* the client hanging up is normal */ });
  });

  cleanup.push(() => server.close());
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function main() {
  try {
    // A small tree with the shapes that break naive listing code.
    const root = path.join(scratch, 'remote');
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    fs.mkdirSync(path.join(root, 'home', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'home', 'demo', 'notes.txt'), 'in the home directory\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# hello\n');
    fs.writeFileSync(path.join(root, 'apps', 'server.log'), 'x'.repeat(4096));
    fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'link-to-readme'));

    const port = await startSftpServer(root);
    const plane = new ControlPlane({
      socketPath: path.join(scratch, 'cp.sock'),
      port: 0,
      vaultPath: path.join(scratch, 'vault.json'),
    });
    cleanup.push(() => plane.stop());
    const { url } = await plane.start();
    const base = url.split('/?')[0];
    const q = `token=${plane.token}`;
    plane.store.setServer('box', { host: '127.0.0.1', port, user: 'x', password: 'y' });

    // --- listing ---
    const listing = await fetch(`${base}/api/files?${q}&server=box&path=/`).then(r => r.json());
    const byName = Object.fromEntries(listing.entries.map(e => [e.name, e]));
    assert.ok(byName['README.md'], 'a file must be listed');
    assert.strictEqual(byName['README.md'].isDirectory, false);
    assert.strictEqual(byName.apps.isDirectory, true, 'S_IFDIR must be read from the POSIX mode');
    assert.strictEqual(byName['link-to-readme'].isSymlink, true, 'a symlink must not look like a plain file');
    assert.strictEqual(byName['README.md'].path, '/README.md',
      'joining at the root must not produce //README.md');
    ok(`a directory lists with types read from the POSIX mode (${listing.entries.length} entries)`);

    // The mode must arrive stripped of its file-type bits: a caller rendering
    // "0100644" where it wanted "644" is the classic sign of a missing mask.
    const mode = byName['README.md'].permissions;
    assert.ok(mode <= 0o7777, `permissions must be masked to the mode bits, got ${mode.toString(8)}`);
    assert.strictEqual(mode & 0o170000, 0, 'the S_IFMT bits must not leak into permissions');
    assert.ok(byName['README.md'].modifyTime > 1e12, 'mtime must be milliseconds, not seconds');
    assert.strictEqual(byName['README.md'].size, 8, 'the size must be the real byte count');
    ok('sizes, permissions and a millisecond mtime come back per entry');

    // --- the home directory has to resolve to a name ---
    const home = await fetch(`${base}/api/files?${q}&server=box`).then(r => r.json());
    assert.strictEqual(home.path, '/home/demo',
      "'.' must come back resolved: a browser cannot draw a breadcrumb for a directory it cannot name");
    assert.strictEqual(home.entries[0].path, '/home/demo/notes.txt',
      'paths under the home directory must be absolute, not relative to a dot');
    ok('the home directory resolves to a real path, so the breadcrumb has something to show');

    // --- nested path ---
    const nested = await fetch(`${base}/api/files?${q}&server=box&path=/apps`).then(r => r.json());
    assert.strictEqual(nested.entries[0].path, '/apps/server.log', 'a nested path must join correctly');
    ok('a nested directory joins its paths correctly');

    // --- download ---
    const body = await fetch(`${base}/api/files/read?${q}&server=box&path=/README.md`).then(r => r.text());
    assert.strictEqual(body, '# hello\n', 'the file content must come back byte for byte');
    ok('a file downloads through the control plane');

    // --- upload ---
    const put = await fetch(`${base}/api/files/write?${q}&server=box&path=/uploaded.txt`, {
      method: 'POST', body: 'written from the browser\n',
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(fs.readFileSync(path.join(root, 'uploaded.txt'), 'utf8'), 'written from the browser\n');
    ok('a file uploads and lands on the remote filesystem');

    // --- mkdir / rename / delete ---
    const json = (route, payload) => fetch(`${base}${route}?${q}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.strictEqual((await json('/api/files/mkdir', { server: 'box', path: '/newdir' })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'newdir')), 'mkdir must create the directory');
    assert.strictEqual((await json('/api/files/rename', { server: 'box', from: '/newdir', to: '/renamed' })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'renamed')), 'rename must move it');
    assert.strictEqual((await json('/api/files/delete', { server: 'box', path: '/renamed', isDirectory: true })).status, 200);
    assert.ok(!fs.existsSync(path.join(root, 'renamed')), 'rmdir must remove a directory');
    assert.strictEqual((await json('/api/files/delete', { server: 'box', path: '/uploaded.txt' })).status, 200);
    assert.ok(!fs.existsSync(path.join(root, 'uploaded.txt')), 'unlink must remove a file');
    ok('mkdir, rename and delete work, with directories and files taking different calls');

    // --- pooling ---
    assert.strictEqual(plane.sftpPool.size, 1,
      'all of that must have run over ONE connection, not one handshake per call');
    ok('the whole session reused a single pooled SFTP connection');

    // --- a dead pooled connection must not surface to the user ---
    const pooled = plane.sftpPool.get('box');
    pooled.ssh.dispose();
    const afterDeath = await fetch(`${base}/api/files?${q}&server=box&path=/`).then(r => r.json());
    assert.ok(afterDeath.entries?.length > 0,
      'a connection that died between two clicks must be reopened, not reported');
    ok('a pooled connection dying between requests is reopened transparently');

    // --- a connection that goes silent, rather than failing ---
    // The difference matters: dispose() above fails immediately, which is the
    // easy case. A machine dropping off the network answers nothing at all, and
    // ssh2 has no deadline of its own — without one the screen sits on
    // "Loading…" forever, which the operator cannot tell from a slow directory.
    const silent = plane.sftpPool.get('box');
    const original = silent.sftp.readdir;
    silent.sftp.readdir = () => { /* answers nothing, ever */ };
    const started = Date.now();
    const recovered = await fetch(`${base}/api/files?${q}&server=box&path=/`).then(r => r.json());
    const took = Date.now() - started;
    silent.sftp.readdir = original;
    assert.ok(recovered.entries || recovered.error,
      'a silent connection must resolve one way or the other, never hang');
    assert.ok(took < 40000, `it must give up in tens of seconds, took ${took}ms`);
    assert.ok(recovered.entries?.length > 0,
      'and the retry should succeed: a session that went quiet is replaced, not reported');
    ok(`a connection going silent is timed out and replaced, not left hanging (${(took / 1000).toFixed(0)}s)`);

    // --- refusals ---
    assert.strictEqual((await fetch(`${base}/api/files?${q}&server=nope&path=/`)).status, 404);
    assert.strictEqual((await fetch(`${base}/api/files?server=box&path=/`)).status, 401,
      'reading files must require the token');
    ok('an unknown server 404s, and reading files requires the token');

    // --- releasing ---
    plane.sftpPool.forEach((_, name) => plane.sftpPool.get(name));
    await plane.stop();
    assert.strictEqual(plane.sftpPool.size, 0, 'stopping must release pooled connections');
    ok('stopping the control plane releases every pooled connection');

    console.log(`\n✅ file tests passed (${passed} checks)`);
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
