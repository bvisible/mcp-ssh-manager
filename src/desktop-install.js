// Getting the desktop application from the npm engine.
//
// Someone who installed mcp-ssh-manager from npm has the engine, the CLI and
// the browser control plane. The desktop application is the same control plane
// in a window, with a menu bar item and native notifications. This module is
// the one path from the first to the second, used by `ssh-manager app` and by
// the control plane's "Install the app" button.
//
// ## What gets installed, and why it can be trusted
//
// The engine installs the application of **its own version**: release tag
// `v<package.json version>`, never "the latest". A beta engine installs its
// beta, and 4.0.0 never pulls 4.1.0 in behind the user's back.
//
// The release publishes `release-manifest-<platform>.json` beside the
// installers, listing every file with its size and SHA-256. The release
// workflow refuses to publish an artifact that differs from it, so it is the
// reference. Nothing is installed unless all of this holds:
//
//   1. the downloaded bytes have the manifest's size and SHA-256, computed
//      while downloading into a private temporary directory;
//   2. on macOS, the unpacked application passes `codesign --verify --deep
//      --strict`, is signed by our Developer ID team, and Gatekeeper accepts it
//      (`spctl`), which means Apple notarized it. On Windows and Linux the
//      hash is the check.
//
// Any failure removes the temporary directory and installs nothing.
//
// Every download is HTTPS. The base URL is a parameter for the tests, which
// stand in for the release with a local HTTP server; plain HTTP is accepted
// only when that base is itself a loopback address. There is deliberately no
// environment variable to point this elsewhere.

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

/** Where people can pick a file by hand when there is nothing to install here. */
export const RELEASES_PAGE = 'https://github.com/bvisible/mcp-ssh-manager/releases';

/** Release assets live under `<this>/v<version>/<file>`. */
const RELEASE_BASE_URL = `${RELEASES_PAGE}/download`;

/** The Developer ID team of bVisible Sarl, which signs and notarizes the macOS build. */
const TEAM_ID = 'BT249938WK';

/** electron-builder's productName: the bundle, the Windows directory and executable. */
const APP_NAME = 'SSH Manager';

/** The same name as it appears in release file names, spaces made hyphens. */
const ARTIFACT_PREFIX = 'SSH-Manager';

/** The Linux .deb puts this on the PATH (the desktop package's npm name). */
const LINUX_BINARY = 'ssh-manager-desktop';

/** Where the AppImage route installs to, under the home directory. */
const APPIMAGE_NAME = 'SSH-Manager.AppImage';

/** A manifest is a few hundred bytes; anything this large is not one. */
const MANIFEST_LIMIT_BYTES = 1024 * 1024;

/** GitHub sends one redirect, to its asset host. A chain this long is a loop. */
const MAX_REDIRECTS = 5;

/** A download that sends nothing for this long has stopped. */
const IDLE_TIMEOUT_MS = 30 * 1000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * @typedef {Object} DesktopStatus
 * @property {boolean} supported - A release artifact exists for this platform and architecture
 * @property {boolean} installed - The application is where its installer puts it
 * @property {string|null} path - What to open: the .app, the .exe, the binary or the AppImage
 * @property {string|null} version - Its version, when it can be read
 * @property {'auto'|'terminal'|null} method - How a fresh install runs: by itself, or in a terminal (sudo)
 */

/**
 * @typedef {Object} DesktopProgress
 * @property {'manifest'|'download'|'verify'|'install'} phase - Where the installation is
 * @property {number} received - Bytes downloaded so far
 * @property {number} total - Bytes the release says the file has; 0 before the manifest is read
 * @property {string} [file] - The release file being downloaded
 * @property {'sha256'|'apple'} [passed] - A check that has just passed, during `verify`
 */

/**
 * What a step reports; the byte counts carry over from the last report.
 * @typedef {Omit<Partial<DesktopProgress>, 'phase'> & {phase: DesktopProgress['phase']}} ProgressUpdate
 */

/**
 * @typedef {Object} RunResult
 * @property {number} code - Exit status; 0 when a detached process was started
 * @property {string} stdout - Captured output (empty with `stdio: 'inherit'`)
 * @property {string} stderr - Captured errors (empty with `stdio: 'inherit'`)
 */

/**
 * Runs a command. Injectable, so the tests never touch the real system.
 * @callback Runner
 * @param {string} command - Program to run
 * @param {string[]} args - Its arguments, never through a shell
 * @param {{detached?: boolean, stdio?: 'inherit'}} [options] - `detached` starts it and returns at once;
 *   `inherit` hands it the terminal (sudo asks for its password there)
 * @returns {Promise<RunResult>}
 */

/**
 * @typedef {Object} DesktopError
 * @property {'UNSUPPORTED'|'NEEDS_TERMINAL'|'NOT_FOUND'|'DOWNLOAD'|'VERIFY'|'INSTALL'} code
 */

/**
 * @param {DesktopError['code']} code - What kind of failure, for the caller's exit code
 * @param {string} message - What a person reads
 * @returns {Error & DesktopError}
 */
function desktopError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The engine's own version, which is the application version it installs.
 * @returns {string}
 */
export function engineVersion() {
  return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

/**
 * Compare two versions, prereleases included: 4.0.0-beta.2 < 4.0.0-beta.10 < 4.0.0.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a is older, 0 when equal, positive when newer
 */
export function compareVersions(a, b) {
  const split = value => {
    const text = String(value).replace(/^v/, '').split('+')[0];
    const dash = text.indexOf('-');
    return {
      core: (dash < 0 ? text : text.slice(0, dash)).split('.').map(part => Number(part) || 0),
      pre: dash < 0 ? [] : text.slice(dash + 1).split('.'),
    };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] || 0) - (right.core[i] || 0);
    if (diff) return diff;
  }
  // A release ranks above any of its prereleases.
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (!numeric && x !== y) {
      // Numeric identifiers rank below alphanumeric ones, as semver has it.
      if (/^\d+$/.test(x)) return -1;
      if (/^\d+$/.test(y)) return 1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function homeOf(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** @param {string} file */
function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** @param {string} dir */
function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/** @param {string} dir */
function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return isDirectory(dir);
  } catch {
    return false;
  }
}

/**
 * An executable on the PATH, found by looking rather than by running `which`.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform
 * @returns {string|null}
 */
function findOnPath(name, env, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isFile(candidate)) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * The engine copy inside an installed application carries the same version as
 * the application: they are built and released together.
 * @param {string} resourcesDir - The application's `resources` directory
 * @returns {string|null}
 */
function bundledEngineVersion(resourcesDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(resourcesDir, 'engine', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} app - Path to `SSH Manager.app`
 * @returns {string|null}
 */
function macVersion(app) {
  try {
    const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (match) return match[1].trim();
  } catch { /* unreadable: try the engine copy */ }
  return bundledEngineVersion(path.join(app, 'Contents', 'Resources'));
}

/**
 * Which release file fits this machine, and how it installs.
 * @param {string} platform
 * @param {string} arch
 * @param {NodeJS.ProcessEnv} env
 * @returns {{suffix: string, kind: 'mac'|'windows'|'deb'|'appimage', method: 'auto'|'terminal'}|null}
 */
function releaseTarget(platform, arch, env) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return { suffix: `${arch}.zip`, kind: 'mac', method: 'auto' };
  }
  // One NSIS installer carries both architectures.
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    return { suffix: 'setup.exe', kind: 'windows', method: 'auto' };
  }
  if (platform === 'linux' && arch === 'x64') {
    // The .deb sets up Chromium's sandbox and the AppArmor profile, so it is
    // preferred wherever apt can install it — but that needs sudo, and so a
    // terminal where the password can be typed.
    return findOnPath('apt-get', env, platform)
      ? { suffix: 'amd64.deb', kind: 'deb', method: 'terminal' }
      : { suffix: 'x86_64.AppImage', kind: 'appimage', method: 'auto' };
  }
  return null;
}

/**
 * Where an installed application is, looked up at the places its installers use.
 * @param {string} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} applicationsDir - The system-wide Applications folder (macOS)
 * @returns {{path: string, version: string|null}|null}
 */
function findInstalled(platform, env, applicationsDir) {
  const home = homeOf(env);
  if (platform === 'darwin') {
    for (const dir of [applicationsDir, path.join(home, 'Applications')]) {
      const app = path.join(dir, `${APP_NAME}.app`);
      if (isDirectory(app)) return { path: app, version: macVersion(app) };
    }
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const exe = path.join(base, 'Programs', APP_NAME, `${APP_NAME}.exe`);
    if (isFile(exe)) return { path: exe, version: bundledEngineVersion(path.join(path.dirname(exe), 'resources')) };
  }
  if (platform === 'linux') {
    const binary = findOnPath(LINUX_BINARY, env, platform);
    if (binary) {
      let real = binary;
      try { real = fs.realpathSync(binary); } catch { /* keep the link */ }
      return { path: binary, version: bundledEngineVersion(path.join(path.dirname(real), 'resources')) };
    }
    // An AppImage is a compressed image: its version cannot be read without mounting it.
    const image = path.join(home, 'Applications', APPIMAGE_NAME);
    if (isFile(image)) return { path: image, version: null };
  }
  return null;
}

/**
 * Whether the application can be installed here, and whether it already is.
 * Reads files only: cheap enough for a menu's status line.
 * @param {Object} [options]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.applicationsDir] - The system Applications folder (tests point it elsewhere)
 * @returns {DesktopStatus}
 */
export function desktopStatus({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  applicationsDir = '/Applications',
} = {}) {
  const target = releaseTarget(platform, arch, env);
  const found = findInstalled(platform, env, applicationsDir);
  return {
    supported: Boolean(target),
    installed: Boolean(found),
    path: found?.path ?? null,
    version: found?.version ?? null,
    method: target?.method ?? null,
  };
}

/**
 * The default runner: spawn, never a shell.
 * @type {Runner}
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.detached) {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve({ code: 0, stdout: '', stderr: '' });
      });
      return;
    }
    const child = spawn(command, args, {
      stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: options.stdio !== 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Is the application running right now?
 *
 * macOS's `open` brings a running application forward, but on Linux and
 * Windows launching it again starts a second copy, which then fights the first
 * for the approval socket. Any failure to tell answers "no".
 *
 * @param {Object} [options]
 * @param {string} [options.platform]
 * @param {Runner} [options.run]
 * @returns {Promise<boolean>}
 */
export async function desktopRunning({ platform = process.platform, run = runCommand } = {}) {
  try {
    if (platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${APP_NAME}.exe`]);
      return stdout.includes(`"${APP_NAME}.exe"`);
    }
    const { code, stdout } = await run('ps', ['-A', '-o', 'command=']);
    if (code !== 0) return false;
    const markers = platform === 'darwin'
      ? [`/${APP_NAME}.app/Contents/MacOS/${APP_NAME}`]
      : [`/${LINUX_BINARY}`, `/${APPIMAGE_NAME}`, `/opt/${APP_NAME}/`];
    return stdout.split('\n').some(line => markers.some(marker => line.includes(marker)));
  } catch {
    return false;
  }
}

/**
 * GET a URL and hand back the response, following redirects. HTTPS only,
 * except loopback HTTP when the caller allows it (a test standing in for the
 * release).
 * @param {URL} url
 * @param {boolean} allowLoopbackHttp
 * @param {number} [redirects]
 * @returns {Promise<import('http').IncomingMessage>}
 */
function get(url, allowLoopbackHttp, redirects = 0) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    if (!secure && !(allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
      reject(desktopError('DOWNLOAD', `Refusing to download over ${url.protocol.replace(':', '')} from ${url.host}: HTTPS only`));
      return;
    }
    const request = (secure ? https : http).get(url, {
      headers: { 'user-agent': 'mcp-ssh-manager', accept: 'application/octet-stream, application/json' },
    }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(desktopError('DOWNLOAD', 'Too many redirects'));
          return;
        }
        let next;
        try {
          next = new URL(response.headers.location, url);
        } catch {
          reject(desktopError('DOWNLOAD', 'The release answered with an unreadable redirect'));
          return;
        }
        resolve(get(next, allowLoopbackHttp, redirects + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        const file = decodeURIComponent(url.pathname.split('/').pop() || '');
        reject(desktopError(status === 404 ? 'NOT_FOUND' : 'DOWNLOAD', `${file}: HTTP ${status}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(desktopError('DOWNLOAD', 'The download stopped answering')));
    request.on('error', reject);
  });
}

/**
 * @typedef {Object} ManifestEntry
 * @property {string} name
 * @property {number} size
 * @property {string} sha256
 */

/**
 * Read and check the release manifest for one platform.
 * @param {URL} base - The release directory, ending in `/`
 * @param {string} version
 * @param {string} platform
 * @param {boolean} allowLoopbackHttp
 * @returns {Promise<ManifestEntry[]>}
 */
async function readManifest(base, version, platform, allowLoopbackHttp) {
  const name = `release-manifest-${platform}.json`;
  let response;
  try {
    response = await get(new URL(name, base), allowLoopbackHttp);
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      throw desktopError('NOT_FOUND', `Release v${version} has no desktop build for this platform (${name} not found). `
        + `See ${RELEASES_PAGE}`);
    }
    throw error;
  }
  let text = '';
  response.setEncoding('utf8');
  for await (const chunk of response) {
    text += chunk;
    if (text.length > MANIFEST_LIMIT_BYTES) {
      response.destroy();
      throw desktopError('VERIFY', `${name} is too large to be a release manifest`);
    }
  }
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw desktopError('VERIFY', `${name} is not valid JSON`);
  }
  if (manifest?.version !== version || manifest?.platform !== platform || !Array.isArray(manifest.files)) {
    throw desktopError('VERIFY', `${name} does not describe release v${version} for ${platform}`);
  }
  return manifest.files;
}

/**
 * Stream a file to disk, hashing as it arrives and refusing a single byte more
 * than the release announced.
 * @param {URL} url
 * @param {string} file - Destination, created exclusively
 * @param {number} expected - Size from the manifest
 * @param {(received: number) => void} onBytes
 * @param {boolean} allowLoopbackHttp
 * @returns {Promise<{size: number, sha256: string}>}
 */
async function download(url, file, expected, onBytes, allowLoopbackHttp) {
  const response = await get(url, allowLoopbackHttp);
  const announced = Number(response.headers['content-length']);
  if (Number.isFinite(announced) && announced > 0 && announced !== expected) {
    response.destroy();
    throw desktopError('VERIFY', `The server is sending ${announced} bytes; release says ${expected}`);
  }
  const hash = crypto.createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expected) {
        callback(desktopError('VERIFY', `Larger than the release says (${expected} bytes): refused`));
        return;
      }
      hash.update(chunk);
      onBytes(received);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response, meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (error.code === 'VERIFY' || error.code === 'DOWNLOAD') throw error;
    throw desktopError('DOWNLOAD', `The download was interrupted (${error.message})`);
  }
  return { size: received, sha256: hash.digest('hex') };
}

/**
 * Run a command that must succeed.
 * @param {Runner} run
 * @param {string} command
 * @param {string[]} args
 * @param {DesktopError['code']} code
 * @param {string} message
 * @returns {Promise<RunResult>}
 */
async function mustRun(run, command, args, code, message) {
  const result = await run(command, args);
  if (result.code !== 0) throw desktopError(code, message);
  return result;
}

/**
 * Unpack, prove it is ours and notarized, then move it into Applications.
 * @param {Object} context
 * @param {string} context.archive
 * @param {string} context.temp
 * @param {Runner} context.run
 * @param {string} context.applicationsDir
 * @param {string} context.home
 * @param {(update: ProgressUpdate) => void} context.report
 * @returns {Promise<string>} Where the application now is
 */
async function installMac({ archive, temp, run, applicationsDir, home, report }) {
  const unpacked = path.join(temp, 'unpacked');
  fs.mkdirSync(unpacked, { mode: 0o700 });
  // ditto, not unzip: it keeps the bundle's symlinks and extended attributes,
  // without which the signature no longer verifies.
  await mustRun(run, 'ditto', ['-x', '-k', archive, unpacked], 'VERIFY', 'Unpacking the archive failed');
  const app = path.join(unpacked, `${APP_NAME}.app`);
  if (!isDirectory(app)) throw desktopError('VERIFY', `The archive does not contain ${APP_NAME}.app`);

  await mustRun(run, 'codesign', ['--verify', '--deep', '--strict', app], 'VERIFY',
    'The code signature does not verify: nothing was installed');
  const details = await run('codesign', ['-dv', '--verbose=2', app]);
  const team = /^TeamIdentifier=(\S+)$/m.exec(`${details.stdout}\n${details.stderr}`)?.[1];
  if (details.code !== 0 || team !== TEAM_ID) {
    throw desktopError('VERIFY', `Signed by team ${team || 'unknown'}, not bVisible Sarl (${TEAM_ID}): nothing was installed`);
  }
  await mustRun(run, 'spctl', ['--assess', '--type', 'execute', app], 'VERIFY',
    'Gatekeeper refuses it (not notarized by Apple): nothing was installed');
  report({ phase: 'verify', passed: 'apple' });

  report({ phase: 'install' });
  // /Applications is writable by administrators; a standard account gets the
  // per-user folder, which Finder and Spotlight treat the same way.
  const folder = isWritable(applicationsDir) ? applicationsDir : path.join(home, 'Applications');
  fs.mkdirSync(folder, { recursive: true });
  const destination = path.join(folder, `${APP_NAME}.app`);
  if (fs.existsSync(destination)) throw desktopError('INSTALL', `${destination} already exists`);
  try {
    fs.renameSync(app, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw desktopError('INSTALL', `Could not move it into ${folder}: ${error.message}`);
    // The temporary directory is on another volume. ditto copies the bundle
    // with everything its signature covers.
    const copied = await run('ditto', [app, destination]);
    if (copied.code !== 0) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw desktopError('INSTALL', `Could not copy it into ${folder}`);
    }
  }
  return destination;
}

/**
 * Download, verify and install the desktop application. Installs nothing
 * unless every check passes; when it is already installed, downloads nothing.
 *
 * @param {Object} [options]
 * @param {string} [options.version] - Release to install; the engine's own by default
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.baseUrl] - Release download root (tests only)
 * @param {(progress: DesktopProgress) => void} [options.onProgress]
 * @param {Runner} [options.run]
 * @param {boolean} [options.terminal] - A person is at a terminal, so `sudo` may ask for a password
 * @param {string} [options.applicationsDir] - The system Applications folder (tests only)
 * @param {string} [options.tmpRoot] - Where the private temporary directory is made
 * @returns {Promise<{path: string, version: string|null, downloaded: boolean}>}
 */
export async function installDesktop({
  version = engineVersion(),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  baseUrl = RELEASE_BASE_URL,
  onProgress = () => {},
  run = runCommand,
  terminal = false,
  applicationsDir = '/Applications',
  tmpRoot = os.tmpdir(),
} = {}) {
  const before = desktopStatus({ platform, arch, env, applicationsDir });
  if (before.installed) return { path: before.path, version: before.version, downloaded: false };

  const target = releaseTarget(platform, arch, env);
  if (!target) {
    throw desktopError('UNSUPPORTED', `There is no desktop build for ${platform} ${arch}. See ${RELEASES_PAGE}`);
  }
  if (target.method === 'terminal' && !terminal) {
    throw desktopError('NEEDS_TERMINAL', 'Installing the .deb needs your password: run `ssh-manager app` in a terminal');
  }

  const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const allowLoopbackHttp = root.protocol === 'http:' && LOOPBACK_HOSTS.has(root.hostname);
  if (root.protocol !== 'https:' && !allowLoopbackHttp) {
    throw desktopError('DOWNLOAD', `Refusing to download from ${root.origin}: HTTPS only`);
  }
  const base = new URL(`v${encodeURIComponent(version)}/`, root);
  const name = `${ARTIFACT_PREFIX}-${version}-${target.suffix}`;

  let received = 0;
  let total = 0;
  /** @param {ProgressUpdate} update */
  const report = update => {
    received = update.received ?? received;
    total = update.total ?? total;
    onProgress({ ...update, received, total });
  };

  const temp = fs.mkdtempSync(path.join(tmpRoot, 'ssh-manager-app-'));
  try {
    fs.chmodSync(temp, 0o700);

    report({ phase: 'manifest' });
    const entry = (await readManifest(base, version, platform, allowLoopbackHttp)).find(item => item?.name === name);
    if (!entry) throw desktopError('NOT_FOUND', `Release v${version} lists no ${name}. See ${RELEASES_PAGE}`);
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[0-9a-f]{64}$/.test(String(entry.sha256))) {
      throw desktopError('VERIFY', `The manifest entry for ${name} has no usable size and SHA-256`);
    }

    const file = path.join(temp, name);
    let shown = -1;
    report({ phase: 'download', file: name, received: 0, total: entry.size });
    const got = await download(new URL(encodeURIComponent(name), base), file, entry.size, bytes => {
      // Once per percent: enough for a progress bar, few enough for an event stream.
      const percent = Math.floor((bytes * 100) / entry.size);
      if (percent === shown && bytes !== entry.size) return;
      shown = percent;
      report({ phase: 'download', file: name, received: bytes });
    }, allowLoopbackHttp);

    report({ phase: 'verify' });
    if (got.size !== entry.size) {
      throw desktopError('VERIFY', `Downloaded ${got.size} bytes; release v${version} says ${entry.size}: nothing was installed`);
    }
    if (got.sha256 !== entry.sha256) {
      throw desktopError('VERIFY', `SHA-256 does not match release v${version}: nothing was installed`);
    }
    report({ phase: 'verify', passed: 'sha256' });

    const home = homeOf(env);
    if (target.kind === 'mac') {
      await installMac({ archive: file, temp, run, applicationsDir, home, report });
    } else if (target.kind === 'windows') {
      report({ phase: 'install' });
      // Silent, for this user only: no administrator rights, no window.
      const result = await run(file, ['/S', '/currentuser']);
      if (result.code !== 0) throw desktopError('INSTALL', `The installer stopped with code ${result.code}`);
    } else if (target.kind === 'deb') {
      report({ phase: 'install' });
      const result = await run('sudo', ['apt-get', 'install', '-y', file], { stdio: 'inherit' });
      if (result.code !== 0) throw desktopError('INSTALL', `apt-get stopped with code ${result.code}`);
    } else {
      report({ phase: 'install' });
      const folder = path.join(home, 'Applications');
      fs.mkdirSync(folder, { recursive: true });
      const destination = path.join(folder, APPIMAGE_NAME);
      const partial = path.join(folder, `.${APPIMAGE_NAME}.partial`);
      try {
        fs.copyFileSync(file, partial);
        fs.chmodSync(partial, 0o755);
        fs.renameSync(partial, destination);
      } catch (error) {
        fs.rmSync(partial, { force: true });
        throw desktopError('INSTALL', `Could not write ${destination}: ${error.message}`);
      }
    }

    const after = desktopStatus({ platform, arch, env, applicationsDir });
    if (!after.installed) throw desktopError('INSTALL', 'The installer finished, but the application is not where it should be');
    return { path: after.path, version: after.version ?? version, downloaded: true };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Start the installed application, detached: it outlives whoever opened it.
 * @param {Object} options
 * @param {string} options.path - From desktopStatus() or installDesktop()
 * @param {string} [options.platform]
 * @param {Runner} [options.run]
 * @returns {Promise<void>}
 */
export async function openDesktop({ path: target, platform = process.platform, run = runCommand }) {
  if (!target) throw desktopError('INSTALL', 'The desktop application is not installed');
  if (platform === 'darwin') await run('open', [target], { detached: true });
  else await run(target, [], { detached: true });
}
