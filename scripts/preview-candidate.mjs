#!/usr/bin/env node
/**
 * Preview a candidate with temporary credentials, files and a loopback SSH host.
 *   node scripts/preview-candidate.mjs --app '/path/SSH Manager.app'
 *   node scripts/preview-candidate.mjs --engine /path/to/mcp-ssh-manager
 * Type r + Enter to restart with the same profile; q + Enter or Ctrl-C cleans up.
 * Remote commands are simulated; SFTP writes only inside the temporary fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ssh2 from 'ssh2';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { STATUS_CODE: S, OPEN_MODE: O } = ssh2.utils.sftp;

function reply(command) {
  if (command.includes('=== CPU ===')) return [
    '=== CPU ===', '12.5', '=== MEMORY ===', '{"total":8192,"used":2048,"free":6144,"percent":25}',
    '=== DISK ===', '{"mount":"/","size":"40G","used":"10G","avail":"30G","percent":25}',
    '=== LOAD ===', '0.12, 0.18, 0.09', '=== UPTIME ===', 'up 2 days',
    '=== NETWORK ===', '{"interface":"eth0:","rx_bytes":12000,"tx_bytes":6000}', '',
  ].join('\n');
  if (/\bwhoami\b/.test(command)) return 'demo\n';
  if (/\bhostname\b/.test(command)) return 'local-preview-fixture\n';
  if (/\buptime\b/.test(command)) return 'up 2 days, load average: 0.12, 0.18, 0.09\n';
  if (/\bpwd\b/.test(command)) return '/srv\n';
  if (/\b(ls|ll)\b/.test(command)) return 'README.txt  reports  uploads\n';
  if (/\bdf\b/.test(command)) return 'Filesystem  Size  Used  Avail  Use%  Mounted on\npreview  40G  10G  30G  25%  /\n';
  return `Simulated command; no shell was executed: ${command}\n`;
}

function serveSftp(sftp, root) {
  const handles = new Map();
  let counter = 0;
  const target = given => {
    const relative = path.posix.normalize(`/${given}`).slice(1);
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Outside fixture');
    // Do not follow links, including ones introduced manually during a preview.
    let current = root;
    for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are disabled');
    }
    return resolved;
  };
  const attrs = stat => ({ mode: stat.mode, size: stat.size, uid: 1000, gid: 1000,
    atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  const handle = state => {
    const id = Buffer.from(String(++counter)); handles.set(id.toString(), state); return id;
  };
  const on = (event, fn) => sftp.on(event, (id, ...args) => {
    try { fn(id, ...args); } catch { sftp.status(id, S.FAILURE); }
  });
  for (const event of ['STAT', 'LSTAT']) on(event, (id, file) => sftp.attrs(id, attrs(fs.lstatSync(target(file)))));
  on('REALPATH', (id, file) => {
    const remote = file === '.' ? '/srv' : path.posix.normalize(`/${file}`);
    target(remote); sftp.name(id, [{ filename: remote, longname: remote, attrs: {} }]);
  });
  on('OPENDIR', (id, dir) => sftp.handle(id, handle({ dir: target(dir), sent: false })));
  on('READDIR', (id, value) => {
    const state = handles.get(value.toString());
    if (state.sent) return sftp.status(id, S.EOF);
    state.sent = true;
    sftp.name(id, fs.readdirSync(state.dir).map(filename => ({ filename, longname: filename,
      attrs: attrs(fs.lstatSync(path.join(state.dir, filename))) })));
  });
  on('OPEN', (id, file, flags) => {
    const writable = Boolean(flags & O.WRITE);
    const mode = !writable ? 'r' : flags & O.APPEND ? 'a+' : flags & O.TRUNC ? 'w+' : 'r+';
    let fd;
    try { fd = fs.openSync(target(file), mode, 0o600); }
    catch (error) {
      if (error.code !== 'ENOENT' || !(flags & O.CREAT) || !writable) throw error;
      fd = fs.openSync(target(file), 'wx+', 0o600);
    }
    sftp.handle(id, handle({ fd }));
  });
  on('FSTAT', (id, value) => sftp.attrs(id, attrs(fs.fstatSync(handles.get(value.toString()).fd))));
  on('READ', (id, value, offset, length) => {
    const buffer = Buffer.alloc(Math.min(length, 1024 * 1024));
    const size = fs.readSync(handles.get(value.toString()).fd, buffer, 0, buffer.length, offset);
    size ? sftp.data(id, buffer.subarray(0, size)) : sftp.status(id, S.EOF);
  });
  on('WRITE', (id, value, offset, data) => {
    fs.writeSync(handles.get(value.toString()).fd, data, 0, data.length, offset); sftp.status(id, S.OK);
  });
  on('CLOSE', (id, value) => {
    const state = handles.get(value.toString());
    if (state?.fd !== undefined) fs.closeSync(state.fd);
    handles.delete(value.toString()); sftp.status(id, S.OK);
  });
  on('MKDIR', (id, dir) => { fs.mkdirSync(target(dir)); sftp.status(id, S.OK); });
  on('RMDIR', (id, dir) => { fs.rmdirSync(target(dir)); sftp.status(id, S.OK); });
  on('REMOVE', (id, file) => { fs.unlinkSync(target(file)); sftp.status(id, S.OK); });
  on('RENAME', (id, from, to) => { fs.renameSync(target(from), target(to)); sftp.status(id, S.OK); });
  for (const event of ['SETSTAT', 'FSETSTAT']) on(event, id => sftp.status(id, S.OP_UNSUPPORTED));
  sftp.on('close', () => {
    for (const state of handles.values()) if (state.fd !== undefined) {
      try { fs.closeSync(state.fd); } catch { /* already closed */ }
    }
    handles.clear();
  });
}

/** Create a fixture without starting a GUI or changing this process's environment. */
export async function createCandidatePreview(engine = repo) {
  engine = fs.realpathSync(engine);
  for (const file of ['package.json', 'src/secret-store.js', 'cli/control.js']) {
    if (!fs.existsSync(path.join(engine, file))) throw new Error(`Candidate engine is missing ${file}`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-p-'));
  const home = path.join(scratch, 'home');
  const remote = path.join(scratch, 'remote');
  const connections = new Set();
  let server;
  let listening = false;
  const close = async () => {
    for (const client of connections) client.end();
    if (listening) { await new Promise(resolve => server.close(resolve)); listening = false; }
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  try {
    for (const dir of ['home/Desktop', 'home/Documents', 'home/Downloads', 'home/.ssh', 'tmp', 'remote/srv/reports', 'remote/srv/uploads']) {
      fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(home, 'Documents', 'upload-me.txt'), 'Temporary candidate preview upload.\n');
    fs.writeFileSync(path.join(remote, 'srv', 'README.txt'), 'Temporary SSH fixture. Downloads and edits are safe here.\n');
    fs.writeFileSync(path.join(remote, 'srv', 'reports', 'status.json'), '{"fixture":true,"healthy":true}\n');
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SHELL', 'LANG', 'LC_ALL',
      'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, {
      HOME: home, USERPROFILE: home, ZDOTDIR: home,
      APPDATA: path.join(scratch, 'app-data'), LOCALAPPDATA: path.join(scratch, 'local-data'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local/share'), TMPDIR: path.join(scratch, 'tmp'),
      TEMP: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'),
      SSH_MANAGER_HOME: scratch, SSH_MANAGER_PREVIEW_HOME: scratch, SSH_MANAGER_KEY_SOURCE: 'file',
      SSH_MANAGER_APPROVAL_SOCKET: process.platform === 'win32'
        ? `\\\\.\\pipe\\mcp-ssh-${path.basename(scratch)}` : path.join(scratch, 'approval.sock'),
      SSH_MANAGER_VAULT: path.join(scratch, 'vault.json'),
      SSH_MANAGER_KNOWN_HOSTS: path.join(home, '.ssh/known_hosts'),
      SSH_ENV_PATH: path.join(scratch, 'empty.env'), SSH_CONFIG_PATH: path.join(scratch, 'empty.toml'),
      SSH_LOG_FILE: path.join(scratch, 'engine.log'), SSH_HISTORY_FILE: path.join(scratch, 'history.json'),
      SSH_GROUPS_FILE: path.join(scratch, 'groups.json'),
    });
    fs.writeFileSync(env.SSH_ENV_PATH, ''); fs.writeFileSync(env.SSH_CONFIG_PATH, '');
    const password = crypto.randomBytes(18).toString('hex');
    const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    server = new ssh2.Server({ hostKeys: [key] }, client => {
      connections.add(client);
      client.on('close', () => connections.delete(client));
      client.on('error', () => {});
      client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'demo' && ctx.password === password
        ? ctx.accept() : ctx.reject(['password']));
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('sftp', start => serveSftp(start(), remote));
        session.on('exec', (start, _reject, info) => {
          const stream = start(); stream.write(reply(info.command)); stream.exit(0); stream.end();
        });
        session.on('pty', acceptPty => acceptPty?.());
        session.on('window-change', acceptResize => acceptResize?.());
        session.on('shell', start => {
          const stream = start();
          const prompt = 'demo@local-preview:/srv$ ';
          stream.write(`Temporary SSH fixture — commands are simulated.\r\n${prompt}`);
          let line = '';
          stream.on('data', data => {
            for (const ch of data.toString()) {
              if (ch === '\r' || ch === '\n') {
                stream.write('\r\n');
                if (line.trim() === 'exit') { stream.exit(0); stream.end(); return; }
                if (line) stream.write(reply(line).replaceAll('\n', '\r\n'));
                line = ''; stream.write(prompt);
              } else if (ch === '\x03') { line = ''; stream.write(`^C\r\n${prompt}`); }
              else if (ch === '\x7f' || ch === '\b') { if (line) { line = line.slice(0, -1); stream.write('\b \b'); } }
              else if (line.length < 8192) { line += ch; stream.write(ch); }
            }
          });
        });
      }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    listening = true;
    const port = server.address().port;
    const configs = Object.fromEntries(['demo_app', 'demo_backup'].map((name, index) => [name, {
      host: '127.0.0.1', port, user: 'demo', password, defaultDir: '/srv',
      description: 'Local preview fixture: simulated commands, temporary files.',
      group: index ? 'Preview backups' : 'Preview applications', mode: 'unrestricted', approval: 'never',
    }]));
    // Seed using the candidate's actual implementation, in a separate process
    // whose home and key source have been isolated before any engine import.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `import {SecretStore} from ${JSON.stringify(pathToFileURL(path.join(engine, 'src/secret-store.js')).href)};
       const store = new SecretStore();
       for (const [name, config] of Object.entries(JSON.parse(await new Promise(resolve => {
         let text=''; process.stdin.on('data', chunk => text+=chunk); process.stdin.on('end', () => resolve(text));
       })))) store.setServer(name, config);`],
    { env, cwd: home, input: JSON.stringify(configs), stdio: ['pipe', 'ignore', 'pipe'], timeout: 10000 });
    return { scratch, home, remote, env, port, password, engine, close };
  } catch (error) { await close(); throw error; }
}

/** Resolve only the Electron candidate bundle, without altering it. */
export function resolveCandidateApp(given) {
  const app = fs.realpathSync(given);
  const executable = app.endsWith('.app') ? path.join(app, 'Contents/MacOS/SSH Manager') : app;
  const resources = app.endsWith('.app') ? path.join(app, 'Contents/Resources') : path.join(path.dirname(app), 'resources');
  if (!fs.statSync(executable).isFile()) throw new Error('Pass the Electron application bundle or executable');
  // asar entries are uncompressed; this also rejects older candidates that
  // would ignore the profile override and open the operator's real UI profile.
  if (!fs.readFileSync(path.join(resources, 'app.asar')).includes(Buffer.from('SSH_MANAGER_PREVIEW_HOME'))) {
    throw new Error('This candidate lacks isolated preview support; use the current CI artifact');
  }
  return { executable, engine: path.join(resources, 'engine') };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !['--app', '--engine'].includes(args[0])) {
    console.log('Usage: node scripts/preview-candidate.mjs --app "/path/SSH Manager.app"\n'
      + '   or: node scripts/preview-candidate.mjs --engine /path/to/mcp-ssh-manager');
    process.exitCode = args.includes('--help') ? 0 : 1; return;
  }
  const candidate = args[0] === '--app' ? resolveCandidateApp(args[1]) : { engine: args[1] };
  const preview = await createCandidatePreview(candidate.engine);
  let child;
  let stopping = false;
  let restarting = false;
  const input = readline.createInterface({ input: process.stdin });
  const stopChild = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const target = child;
      const kill = signal => {
        try { process.platform === 'win32' ? target.kill(signal) : process.kill(-target.pid, signal); } catch { /* already exited */ }
      };
      const deadline = setTimeout(() => kill('SIGKILL'), 5000);
      target.once('exit', () => { clearTimeout(deadline); resolve(); });
      kill('SIGTERM');
    });
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    input.close();
    process.stdin.pause();
    process.stdin.unref?.();
    await stopChild();
    await preview.close();
    console.log('Candidate preview stopped; its temporary profile was removed.');
  };
  const start = () => {
    const executable = candidate.executable || process.execPath;
    const commandArgs = candidate.executable ? [] : [path.join(preview.engine, 'cli/control.js')];
    child = spawn(executable, commandArgs, { env: preview.env, cwd: preview.home,
      stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' });
    child.once('error', error => { console.error(`Candidate launch failed: ${error.message}`); process.exitCode = 1; void stop(); });
    child.once('exit', code => {
      if (!restarting && !stopping) { process.exitCode = code || 0; void stop(); }
    });
  };
  console.log(`Candidate preview profile: ${preview.scratch}\n`
    + `SSH fixture: 127.0.0.1:${preview.port} — demo_app and demo_backup\n`
    + `Upload sample: ${path.join(preview.home, 'Documents/upload-me.txt')}\n`
    + 'Only these temporary fixtures are configured. Remote commands are simulated.\n'
    + 'Type r + Enter to restart with this profile; q + Enter or Ctrl-C to quit and delete it.');
  input.on('line', async line => {
    if (line.trim() === 'q') return void stop();
    if (line.trim() !== 'r' || restarting || stopping) return;
    restarting = true;
    await stopChild();
    if (!stopping) start();
    restarting = false;
  });
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  start();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
