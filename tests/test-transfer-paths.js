// Where the file tools may touch the local disk.
//
// ssh_download wrote any local path it was given, in every security mode: on a
// `readonly` server an agent could put a file of its own choosing on the server
// (`printf … > /tmp/x` is allowed there) and have it downloaded over ~/.zshrc or
// into ~/.ssh/authorized_keys. ssh_upload and ssh_sync read and write any local
// path as well, which is what `unrestricted` means, but gave no way to say
// otherwise. A transfer root is that way, and readonly and restricted servers now
// have one by default for downloads.
//
// 1. the module, case by case;
// 2. the real engine over stdio against a local ssh2 server that speaks SFTP, in
//    every mode: what is refused leaves the disk as it was, what is allowed lands
//    where it should, a failed transfer leaves nothing behind.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { confineLocalPath, transferPolicy } from '../src/transfer-paths.js';
import { ConfigLoader } from '../src/config-loader.js';
import { ed25519Pair } from './helpers/ssh2-keys.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// realpath: on macOS the temporary folder is reached through /var -> /private/var.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-xfer-')));
// This process reads the configuration too (the loader below): keep it away from the developer's own vault and keychain.
const state = path.join(scratch, 'state');
fs.mkdirSync(state, { recursive: true });
process.env.SSH_MANAGER_HOME = state;
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };
const read = file => fs.readFileSync(file, 'utf8');
const throwsOutside = (policy, given, options = { direction: 'write' }) =>
  assert.throws(() => confineLocalPath(policy, given, options), /outside|link|does not exist|folder|empty/, `must refuse ${JSON.stringify(given)}`);

// ── 1. The module ───────────────────────────────────────────────────────────────
const jail = path.join(scratch, 'jail');
const policy = { root: jail, explicit: true };
const realJail = fs.realpathSync(fs.mkdirSync(jail, { recursive: true }) ?? jail);
fs.mkdirSync(path.join(scratch, 'jail-evil'));
fs.mkdirSync(path.join(scratch, 'elsewhere'));
fs.writeFileSync(path.join(scratch, 'elsewhere', 'secret.txt'), 'SECRET');

// Which server gets which policy.
assert.equal(transferPolicy({ mode: 'unrestricted' }, 'ssh_download'), null, 'unrestricted without a root: no filter, as before');
assert.equal(transferPolicy({}, 'ssh_download'), null);
assert.equal(transferPolicy({ mode: 'readonly' }, 'ssh_upload'), null, 'the upload is refused outright in readonly: nothing to confine');
assert.equal(transferPolicy({ mode: 'restricted' }, 'ssh_sync'), null);
for (const mode of ['readonly', 'restricted', 'READONLY']) {
  assert.deepEqual(transferPolicy({ mode }, 'ssh_download'), { root: path.join(state, 'transfers'), explicit: false }, `${mode}: the transfers folder of the manager home`);
}
for (const tool of ['ssh_download', 'ssh_upload', 'ssh_sync']) {
  assert.deepEqual(transferPolicy({ mode: 'unrestricted', transferRoot: jail }, tool), { root: jail, explicit: true }, `${tool}: a named root applies in every mode`);
}
assert.equal(transferPolicy({ mode: 'unrestricted', transferRoot: '   ' }, 'ssh_download'), null, 'a blank root is no root');
ok('a server is confined when it names a root, or is readonly or restricted (downloads), and not otherwise');

// What a path may be.
assert.equal(confineLocalPath(policy, 'a.txt', { direction: 'write' }), path.join(realJail, 'a.txt'), 'a relative path is read from the root');
assert.equal(confineLocalPath(policy, path.join(jail, 'b.txt'), { direction: 'write' }), path.join(realJail, 'b.txt'), 'an absolute path inside the root');
assert.equal(confineLocalPath(policy, 'deep/er/c.txt', { direction: 'write' }), path.join(realJail, 'deep', 'er', 'c.txt'));
assert.ok(fs.statSync(path.join(realJail, 'deep', 'er')).isDirectory(), 'its folders are made');
assert.equal(fs.statSync(path.join(realJail, 'deep')).mode & 0o777, 0o700, 'private to the user');
for (const given of ['../escape.txt', '..', '../jail-evil/x', path.join(scratch, 'jail-evil', 'x'), path.join(scratch, 'elsewhere', 'x'),
  '/etc/passwd', path.join(jail, '..', 'elsewhere', 'x'), 'a/../../escape']) {
  throwsOutside(policy, given);
}
assert.ok(!fs.existsSync(path.join(scratch, 'escape.txt')) && !fs.existsSync(path.join(scratch, 'elsewhere', 'x')), 'nothing was made');
assert.throws(() => confineLocalPath(policy, 'x\0y', { direction: 'write' }), /not a valid path/);
assert.throws(() => confineLocalPath(policy, '', { direction: 'write' }), /empty/);
ok('a path outside the root is refused: .., a sibling that starts like the root, absolute paths elsewhere, an empty or NUL path');

// Links: followed to where they lead, never through the file itself.
fs.symlinkSync(path.join(scratch, 'elsewhere'), path.join(realJail, 'out'));
fs.symlinkSync(path.join(scratch, 'elsewhere', 'secret.txt'), path.join(realJail, 'secret-link'));
fs.writeFileSync(path.join(realJail, 'plain.txt'), 'PLAIN');
fs.symlinkSync(path.join(realJail, 'plain.txt'), path.join(realJail, 'inside-link'));
throwsOutside(policy, 'out/new.txt');
throwsOutside(policy, 'out/secret.txt', { direction: 'read' });
throwsOutside(policy, 'secret-link');
throwsOutside(policy, 'secret-link', { direction: 'read' });
throwsOutside(policy, 'inside-link');
assert.ok(!fs.existsSync(path.join(scratch, 'elsewhere', 'new.txt')), 'nothing was written through the link');
ok('a folder link that leads out, and a link as the file itself, are refused');

// The root reached by another name.
fs.symlinkSync(jail, path.join(scratch, 'jail-by-link'));
assert.equal(confineLocalPath({ root: path.join(scratch, 'jail-by-link'), explicit: true }, 'viaLink.txt', { direction: 'write' }), path.join(realJail, 'viaLink.txt'));
assert.equal(confineLocalPath(policy, path.join(scratch, 'jail-by-link', 'again.txt'), { direction: 'write' }), path.join(realJail, 'again.txt'), 'the root as a link names it too');
ok('the root and its link name the same folder');

// Reading, folders and the root itself.
assert.equal(confineLocalPath(policy, 'plain.txt', { direction: 'read' }), path.join(realJail, 'plain.txt'));
assert.throws(() => confineLocalPath(policy, 'absent.txt', { direction: 'read' }), /does not exist/);
fs.mkdirSync(path.join(realJail, 'folder'));
assert.throws(() => confineLocalPath(policy, 'folder', { direction: 'write' }), /is a folder/);
assert.throws(() => confineLocalPath(policy, '.', { direction: 'write' }), /outside/, 'a file cannot be the root itself');
assert.equal(confineLocalPath(policy, '.', { direction: 'read', allowRoot: true }), realJail, 'a sync may name the root');
assert.equal(confineLocalPath(policy, 'folder/', { direction: 'read', allowRoot: true }), path.join(realJail, 'folder') + path.sep, 'a trailing slash is kept: it changes what rsync copies');
assert.equal(confineLocalPath(policy, '~/x.txt', { direction: 'write' }), path.join(realJail, '~', 'x.txt'), 'a ~ is not expanded: it is a name inside the root');
ok('reads must exist, folders are not files, the root is allowed for a sync, a trailing slash survives');

// The new field reaches the configuration, from .env and from TOML, and back out.
{
  const envFile = path.join(scratch, 'servers.env');
  fs.writeFileSync(envFile, 'SSH_SERVER_ONE_HOST=h\nSSH_SERVER_ONE_USER=u\nSSH_SERVER_ONE_PASSWORD=p\nSSH_SERVER_ONE_TRANSFER_ROOT=/srv/transfers\nSSH_SERVER_TWO_HOST=h2\nSSH_SERVER_TWO_USER=u\nSSH_SERVER_TWO_PASSWORD=p\n');
  const tomlFile = path.join(scratch, 'servers.toml');
  fs.writeFileSync(tomlFile, '[ssh_servers.three]\nhost = "h3"\nuser = "u"\npassword = "p"\ntransfer_root = "~/xfer"\n');
  try {
    const fromEnv = await new ConfigLoader().load({ envPath: envFile, tomlPath: path.join(scratch, 'absent.toml') });
    assert.equal(fromEnv.get('one')?.transferRoot, '/srv/transfers', '.env');
    assert.equal(fromEnv.get('two')?.transferRoot, undefined, 'unset stays unset');
    const fromToml = await new ConfigLoader().load({ envPath: path.join(scratch, 'absent.env'), tomlPath: tomlFile });
    assert.equal(fromToml.get('three')?.transferRoot, '~/xfer', 'TOML');
  } finally {
    // loadEnvConfig may populate process.env; keep these test keys out of the engine started below.
    for (const key of Object.keys(process.env)) if (key.startsWith('SSH_SERVER_ONE_') || key.startsWith('SSH_SERVER_TWO_')) delete process.env[key];
  }
  ok('transferRoot is read from .env and from TOML');
}

// ── 2. The real engine, over SFTP ───────────────────────────────────────────────
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const STATUS = ssh2.utils.sftp.STATUS_CODE;
const OPEN_MODE = ssh2.utils.sftp.OPEN_MODE;
const BIG = 100000;
const remoteFiles = new Map([
  ['/srv/data.txt', Buffer.from('REMOTE-DATA\n')],
  ['/srv/big.bin', Buffer.alloc(BIG, 7)],
]);
const sockets = new Set();
const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => {});
  client.on('authentication', context => context.accept());
  client.on('ready', () => client.on('session', open => {
    const session = open();
    session.on('exec', (start, _reject, info) => {
      const stream = start();
      stream.write(/echo ping/.test(info.command) ? 'ping\n' : 'ok\n');
      stream.exit(0);
      stream.end();
    });
    session.on('sftp', accept => {
      const sftp = accept();
      const handles = new Map();
      let counter = 0;
      const attributes = file => ({ mode: 0o100644, size: remoteFiles.get(file)?.length ?? 0, uid: 0, gid: 0, atime: 0, mtime: 0 });
      sftp.on('OPEN', (request, file, flags) => {
        const write = Boolean(flags & OPEN_MODE.WRITE);
        if (!write && !remoteFiles.has(file)) return sftp.status(request, STATUS.NO_SUCH_FILE);
        if (write) remoteFiles.set(file, Buffer.alloc(0));
        const handle = Buffer.from(String(++counter));
        handles.set(handle.toString(), file);
        sftp.handle(request, handle);
      });
      const stat = (request, file) => (remoteFiles.has(file) ? sftp.attrs(request, attributes(file)) : sftp.status(request, STATUS.NO_SUCH_FILE));
      sftp.on('STAT', stat);
      sftp.on('LSTAT', stat);
      sftp.on('FSTAT', (request, handle) => stat(request, handles.get(handle.toString())));
      sftp.on('READ', (request, handle, offset, length) => {
        const file = handles.get(handle.toString());
        const content = remoteFiles.get(file);
        // The big file stops being readable after its first chunk: a transfer that fails half way.
        if (file === '/srv/big.bin' && offset > 0) return sftp.status(request, STATUS.FAILURE);
        if (offset >= content.length) return sftp.status(request, STATUS.EOF);
        sftp.data(request, content.subarray(offset, offset + length));
      });
      sftp.on('WRITE', (request, handle, offset, data) => {
        const file = handles.get(handle.toString());
        const current = remoteFiles.get(file);
        const grown = Buffer.alloc(Math.max(current.length, offset + data.length));
        current.copy(grown);
        data.copy(grown, offset);
        remoteFiles.set(file, grown);
        sftp.status(request, STATUS.OK);
      });
      sftp.on('CLOSE', (request, handle) => { handles.delete(handle.toString()); sftp.status(request, STATUS.OK); });
      sftp.on('REALPATH', (request, file) => sftp.name(request, [{ filename: file, longname: file, attrs: attributes(file) }]));
    });
  }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const home = path.join(scratch, 'home');
const customRoot = path.join(scratch, 'custom-root');
const jailed = path.join(scratch, 'jailed');
for (const folder of [home, path.join(home, 'dir')]) fs.mkdirSync(folder, { recursive: true });
const keyFile = path.join(scratch, 'key');
fs.writeFileSync(keyFile, ed25519Pair().private, { mode: 0o600 });
const servers = {
  RO: { MODE: 'readonly' },
  RS: { MODE: 'restricted', ALLOW_PATTERNS: '^uptime$' },
  RR: { MODE: 'readonly', TRANSFER_ROOT: customRoot },
  OPEN: { MODE: 'unrestricted' },
  JAIL: { MODE: 'unrestricted', TRANSFER_ROOT: jailed },
};
const envFile = path.join(scratch, 'engine.env');
fs.writeFileSync(envFile, Object.entries(servers).flatMap(([name, fields]) => [
  `SSH_SERVER_${name}_HOST=127.0.0.1`, `SSH_SERVER_${name}_PORT=${port}`, `SSH_SERVER_${name}_USER=fixture`, `SSH_SERVER_${name}_KEYPATH=${keyFile}`,
  ...Object.entries(fields).map(([key, value]) => `SSH_SERVER_${name}_${key}=${value}`),
]).join('\n') + '\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !key.startsWith('MCP_SSH_')));
Object.assign(env, {
  HOME: home, SSH_ENV_PATH: envFile, SSH_CONFIG_PATH: path.join(scratch, 'absent.toml'),
  SSH_MANAGER_HOME: state, SSH_MANAGER_KEY_SOURCE: 'file', SSH_MANAGER_KNOWN_HOSTS: path.join(scratch, 'known_hosts'),
  SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'), SSH_LOG_LEVEL: 'ERROR',
});
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'src/index.js')], cwd: repo, env, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'transfer-test', version: '1' });
await client.connect(transport);
const text = result => result.content.map(item => item.text || '').join(' ').replace(/\s+/g, ' ');
const download = (server, localPath, remotePath = '/srv/data.txt') => client.callTool({ name: 'ssh_download', arguments: { server, remotePath, localPath } });
const upload = (server, localPath, remotePath) => client.callTool({ name: 'ssh_upload', arguments: { server, localPath, remotePath } });
const transfers = path.join(state, 'transfers');
const leftovers = folder => (fs.existsSync(folder) ? fs.readdirSync(folder, { recursive: true }).map(String).filter(name => name.includes('.part-')) : []);

try {
  // The files an agent was after, as they stand.
  const zshrc = path.join(home, '.zshrc');
  fs.writeFileSync(zshrc, 'ORIGINAL-ZSHRC\n');
  const authorizedKeys = path.join(home, '.ssh', 'authorized_keys');

  for (const server of ['RO', 'RS']) {
    for (const target of [zshrc, authorizedKeys, path.join(home, 'dir', 'x.txt'), '../escape.txt']) {
      const result = await download(server, target);
      assert.equal(result.isError, true, `${server}: ${target} must be refused`);
      assert.match(text(result), /outside the transfer folder/);
    }
    assert.equal(read(zshrc), 'ORIGINAL-ZSHRC\n', `${server}: ~/.zshrc is untouched`);
    assert.ok(!fs.existsSync(path.join(home, '.ssh')) && !fs.existsSync(path.join(home, 'dir', 'x.txt')) && !fs.existsSync(path.join(state, 'escape.txt')), `${server}: nothing was created outside`);
  }
  ok('a readonly or restricted server cannot have a download written outside the transfer folder (~/.zshrc, authorized_keys, ..)');

  const inside = await download('RO', 'notes/data.txt');
  assert.equal(inside.isError, undefined, text(inside));
  assert.equal(read(path.join(transfers, 'notes', 'data.txt')), 'REMOTE-DATA\n', 'it lands in the transfer folder');
  assert.match(text(inside), new RegExp(`Local: ${path.join(transfers, 'notes', 'data.txt').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'and the reply says where');
  assert.deepEqual(leftovers(transfers), [], 'no partial file is left');
  assert.equal((await download('RO', path.join(transfers, 'abs.txt'))).isError, undefined, 'an absolute path inside the folder is fine');
  assert.equal(read(path.join(transfers, 'abs.txt')), 'REMOTE-DATA\n');
  assert.equal((await download('RO', 'notes/data.txt')).isError, undefined, 'overwriting a file inside the folder is fine');
  ok('a download to a path inside the transfer folder works, and leaves no partial file');

  // Links put in the folder cannot be used to get out of it.
  fs.symlinkSync(zshrc, path.join(transfers, 'link-to-zshrc'));
  fs.symlinkSync(path.join(home, 'dir'), path.join(transfers, 'link-to-dir'));
  for (const target of ['link-to-zshrc', 'link-to-dir/x.txt']) assert.equal((await download('RO', target)).isError, true, `${target} must be refused`);
  assert.equal(read(zshrc), 'ORIGINAL-ZSHRC\n');
  assert.ok(!fs.existsSync(path.join(home, 'dir', 'x.txt')));
  ok('a link inside the transfer folder is not followed out of it');

  // A transfer that fails half way leaves nothing.
  const failed = await download('RO', 'big.bin', '/srv/big.bin');
  assert.equal(failed.isError, true);
  assert.ok(!fs.existsSync(path.join(transfers, 'big.bin')), 'no half file at the destination');
  assert.deepEqual(leftovers(transfers), [], 'and no partial file beside it');
  const missing = await download('RO', 'gone.txt', '/srv/none');
  assert.equal(missing.isError, true);
  assert.ok(!fs.existsSync(path.join(transfers, 'gone.txt')));
  ok('a download that fails leaves neither a half file nor a partial one');

  // A named root replaces the default, in every mode.
  assert.equal((await download('RR', 'in-custom.txt')).isError, undefined);
  assert.equal(read(path.join(customRoot, 'in-custom.txt')), 'REMOTE-DATA\n');
  assert.ok(!fs.existsSync(path.join(transfers, 'in-custom.txt')));
  const outsideCustom = await download('RR', path.join(transfers, 'x.txt'));
  assert.equal(outsideCustom.isError, true);
  assert.match(text(outsideCustom), /transfer root set for this server/);
  ok('a server with its own transfer root uses it instead of the default one');

  // An unrestricted server with no root is what it was.
  const free = path.join(home, 'dir', 'free.txt');
  assert.equal((await download('OPEN', free)).isError, undefined, 'no filter without a root, as documented');
  assert.equal(read(free), 'REMOTE-DATA\n');
  ok('an unrestricted server without a transfer root downloads anywhere, as before');

  // An unrestricted server with a root: the three tools.
  assert.equal((await download('JAIL', free.replace('free', 'jail-out'))).isError, true);
  assert.ok(!fs.existsSync(free.replace('free', 'jail-out')));
  assert.equal((await download('JAIL', 'ok.txt')).isError, undefined);
  assert.equal(read(path.join(jailed, 'ok.txt')), 'REMOTE-DATA\n');
  fs.writeFileSync(path.join(home, 'local-secret.txt'), 'LOCAL-SECRET');
  const stolen = await upload('JAIL', path.join(home, 'local-secret.txt'), '/srv/stolen.txt');
  assert.equal(stolen.isError, true);
  assert.match(text(stolen), /outside/);
  assert.ok(!remoteFiles.has('/srv/stolen.txt'), 'a local file outside the root did not reach the server');
  fs.writeFileSync(path.join(jailed, 'to-send.txt'), 'SEND-ME');
  assert.equal((await upload('JAIL', 'to-send.txt', '/srv/sent.txt')).isError, undefined);
  assert.equal(remoteFiles.get('/srv/sent.txt')?.toString(), 'SEND-ME', 'a file inside the root is sent');
  const sync = await client.callTool({ name: 'ssh_sync', arguments: { server: 'JAIL', source: `local:${path.join(home, 'dir')}/`, destination: 'remote:/srv/sync/' } });
  assert.equal(sync.isError, true);
  assert.match(text(sync), /outside/, 'a sync reads from inside the root only');
  const syncIn = await client.callTool({ name: 'ssh_sync', arguments: { server: 'JAIL', source: 'remote:/srv/sync/', destination: `local:${path.join(home, 'dir')}/` } });
  assert.equal(syncIn.isError, true);
  assert.match(text(syncIn), /outside/, 'and writes inside the root only');
  ok('with a transfer root, ssh_download, ssh_upload and ssh_sync keep their local side inside it');

  // The ones that were already refused still are.
  for (const server of ['RO', 'RS']) {
    assert.equal((await upload(server, path.join(home, 'local-secret.txt'), '/srv/x')).isError, true, `${server}: upload`);
  }
  ok('ssh_upload is still refused on readonly and restricted servers');
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) socket.end();
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n✅ transfer path tests passed (${passed} checks)`);
process.exit(0);
