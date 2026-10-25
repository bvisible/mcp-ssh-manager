// Tests for getting the desktop application from the npm engine.
//
// A local HTTP server stands in for the GitHub release (manifest, redirect to
// an asset host, the files), and an injected runner stands in for ditto,
// codesign, spctl, the Windows installer, apt-get and `open`. Nothing real is
// downloaded or installed, and the real /Applications is never looked at.
//
// The promise under test: nothing is installed unless every check passes, and
// a failure leaves no file behind.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  desktopStatus, installDesktop, openDesktop, desktopRunning, compareVersions, engineVersion,
} from '../src/desktop-install.js';
import { runApp } from '../cli/app.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const VERSION = '4.0.0-beta.3';
const TEAM = 'BT249938WK';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-install-'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// --- the stand-in release ----------------------------------------------------

/** @type {Record<string, Buffer>} */
const artifacts = {
  [`SSH-Manager-${VERSION}-arm64.zip`]: Buffer.from('zip for apple silicon '.repeat(5000)),
  [`SSH-Manager-${VERSION}-x64.zip`]: Buffer.from('zip for intel '.repeat(5000)),
  [`SSH-Manager-${VERSION}-setup.exe`]: Buffer.from('nsis installer '.repeat(5000)),
  [`SSH-Manager-${VERSION}-amd64.deb`]: Buffer.from('debian package '.repeat(5000)),
  [`SSH-Manager-${VERSION}-x86_64.AppImage`]: Buffer.from('appimage '.repeat(5000)),
};
const PLATFORM_FILES = {
  darwin: [`SSH-Manager-${VERSION}-arm64.zip`, `SSH-Manager-${VERSION}-x64.zip`],
  win32: [`SSH-Manager-${VERSION}-setup.exe`],
  linux: [`SSH-Manager-${VERSION}-amd64.deb`, `SSH-Manager-${VERSION}-x86_64.AppImage`],
};

/** Edits a test makes to a manifest entry, by file name. */
let tamper = {};
/** Manifests that answer 404, by platform. */
let missing = new Set();
/** Every path the server was asked for. */
let requests = [];
/** Send files in chunks with no Content-Length, so only the bytes can tell. */
let chunked = false;

function manifestFor(platform) {
  return {
    version: VERSION,
    platform,
    commit: 'abc123',
    files: PLATFORM_FILES[platform].flatMap(name => [
      { name, size: artifacts[name].length, sha256: sha256(artifacts[name]), ...tamper[name] },
      // The real manifests list blockmaps beside the installers; picking one by
      // mistake would install a differential map.
      { name: `${name}.blockmap`, size: 10, sha256: sha256(Buffer.from('blockmap')) },
    ]),
  };
}

const server = http.createServer((req, res) => {
  requests.push(req.url);
  const prefix = `/download/v${VERSION}/`;
  const manifest = /^release-manifest-(darwin|win32|linux)\.json$/.exec(decodeURIComponent((req.url || '').slice(prefix.length)));
  if (req.url?.startsWith(prefix) && manifest) {
    if (missing.has(manifest[1])) { res.writeHead(404); res.end('Not Found'); return; }
    // GitHub answers every asset with a redirect to its asset host.
    res.writeHead(302, { location: `/assets/${manifest[0]}` });
    res.end();
    return;
  }
  if (req.url?.startsWith(prefix)) {
    res.writeHead(302, { location: `/assets/${req.url.slice(prefix.length)}` });
    res.end();
    return;
  }
  const asset = /^\/assets\/(.+)$/.exec(req.url || '');
  if (asset) {
    const name = decodeURIComponent(asset[1]);
    const platform = /^release-manifest-(\w+)\.json$/.exec(name)?.[1];
    if (platform) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifestFor(platform)));
      return;
    }
    if (artifacts[name]) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      if (chunked) {
        const half = Math.floor(artifacts[name].length / 2);
        res.write(artifacts[name].subarray(0, half));
        setTimeout(() => res.end(artifacts[name].subarray(half)), 10);
        return;
      }
      res.end(artifacts[name]);
      return;
    }
  }
  res.writeHead(404);
  res.end('Not Found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${/** @type {import('net').AddressInfo} */ (server.address()).port}/download`;

// --- a machine to install on -------------------------------------------------

/**
 * A fresh fake machine: its home, the system Applications folder, a PATH and a
 * temporary root, all inside the scratch directory.
 */
function machine(label) {
  const root = fs.mkdtempSync(path.join(scratch, `${label}-`));
  const dirs = {
    root,
    home: path.join(root, 'home'),
    apps: path.join(root, 'Applications'),
    tmp: path.join(root, 'tmp'),
    bin: path.join(root, 'bin'),
    opt: path.join(root, 'opt', 'SSH Manager'),
    local: path.join(root, 'home', 'AppData', 'Local'),
  };
  for (const dir of [dirs.home, dirs.apps, dirs.tmp, dirs.bin]) fs.mkdirSync(dir, { recursive: true });
  const env = { HOME: dirs.home, PATH: dirs.bin, LOCALAPPDATA: dirs.local };
  return { ...dirs, env };
}

/** Put a fake executable on the machine's PATH. */
function onPath(box, name) {
  const file = path.join(box.bin, name);
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
}

/**
 * The injected runner. Records every call and plays the part of each tool.
 * @param {ReturnType<typeof machine>} box
 * @param {{team?: string, codesign?: number, spctl?: number, installer?: number, ps?: string}} [behaviour]
 */
function fakeRunner(box, behaviour = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {number[]} */
  const tempModes = [];
  /** @type {import('../src/desktop-install.js').Runner} */
  const run = async (command, args, options = {}) => {
    calls.push([command, ...args, ...(options.detached ? ['<detached>'] : []), ...(options.stdio ? [`<${options.stdio}>`] : [])]);
    const done = (code = 0, stdout = '', stderr = '') => ({ code, stdout, stderr });
    if (command === 'ditto' && args[0] === '-x') {
      tempModes.push(fs.statSync(path.dirname(args[3])).mode & 0o777);
      const contents = path.join(args[3], 'SSH Manager.app', 'Contents');
      fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
      fs.writeFileSync(path.join(contents, 'MacOS', 'SSH Manager'), 'binary');
      fs.writeFileSync(path.join(contents, 'Info.plist'),
        `<?xml version="1.0"?>\n<plist version="1.0">\n  <dict>\n    <key>CFBundleShortVersionString</key>\n    <string>${VERSION}</string>\n  </dict>\n</plist>\n`);
      return done();
    }
    if (command === 'codesign' && args[0] === '--verify') return done(behaviour.codesign ?? 0);
    if (command === 'codesign' && args[0] === '-dv') {
      return done(0, '', `Identifier=com.bvisible.ssh-manager\nAuthority=Developer ID Application\nTeamIdentifier=${behaviour.team ?? TEAM}\n`);
    }
    if (command === 'spctl') return done(behaviour.spctl ?? 0, '', behaviour.spctl ? 'rejected' : 'accepted');
    if (command.endsWith('setup.exe')) {
      if (behaviour.installer) return done(behaviour.installer);
      const dir = path.join(box.local, 'Programs', 'SSH Manager');
      fs.mkdirSync(path.join(dir, 'resources', 'engine'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'SSH Manager.exe'), 'exe');
      fs.writeFileSync(path.join(dir, 'resources', 'engine', 'package.json'), JSON.stringify({ version: VERSION }));
      return done();
    }
    if (command === 'sudo') {
      fs.mkdirSync(path.join(box.opt, 'resources', 'engine'), { recursive: true });
      fs.writeFileSync(path.join(box.opt, 'ssh-manager-desktop'), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(path.join(box.opt, 'resources', 'engine', 'package.json'), JSON.stringify({ version: VERSION }));
      fs.symlinkSync(path.join(box.opt, 'ssh-manager-desktop'), path.join(box.bin, 'ssh-manager-desktop'));
      return done();
    }
    if (command === 'ps') return done(0, behaviour.ps ?? '');
    if (command === 'tasklist') return done(0, behaviour.ps ?? '');
    return done();
  };
  return { run, calls, tempModes };
}

/** What a failed install must leave: no temporary file, no application. */
function assertNothingInstalled(box, label) {
  assert.deepEqual(fs.readdirSync(box.tmp), [], `${label}: the temporary directory must be removed`);
  assert.deepEqual(fs.readdirSync(box.apps), [], `${label}: nothing may be installed in Applications`);
  assert.equal(fs.existsSync(path.join(box.home, 'Applications')), false, `${label}: nothing may be installed in ~/Applications`);
  assert.equal(desktopStatus({ platform: 'darwin', arch: 'arm64', env: box.env, applicationsDir: box.apps }).installed, false);
}

const mac = box => ({ platform: 'darwin', arch: 'arm64', env: box.env, applicationsDir: box.apps, tmpRoot: box.tmp, baseUrl, version: VERSION });

function reset() {
  tamper = {};
  missing = new Set();
  requests = [];
  chunked = false;
}

// --- the tests ---------------------------------------------------------------

async function testMacInstallsVerifiesAndOpens() {
  reset();
  const box = machine('mac');
  const { run, calls, tempModes } = fakeRunner(box);
  /** @type {any[]} */
  const progress = [];
  const result = await installDesktop({ ...mac(box), run, onProgress: p => progress.push(p) });

  const app = path.join(box.apps, 'SSH Manager.app');
  assert.deepEqual(result, { path: app, version: VERSION, downloaded: true });
  assert.ok(fs.existsSync(path.join(app, 'Contents', 'Info.plist')), 'the application must be in Applications');
  assert.deepEqual(fs.readdirSync(box.tmp), [], 'the temporary directory must be gone after a success too');
  assert.deepEqual(tempModes, [0o700], 'the download must sit in a private (0700) directory');
  ok('macOS: the zip for this architecture is downloaded into a private directory and installed in Applications');

  assert.deepEqual(calls.map(call => call.slice(0, 2)), [
    ['ditto', '-x'],
    ['codesign', '--verify'],
    ['codesign', '-dv'],
    ['spctl', '--assess'],
  ], 'unpack, verify the signature, read the team, ask Gatekeeper — in that order');
  assert.deepEqual(calls[1].slice(1, 4), ['--verify', '--deep', '--strict']);
  assert.deepEqual(calls[3].slice(1, 4), ['--assess', '--type', 'execute']);
  ok('macOS: ditto, codesign --verify --deep --strict, the team identifier, then spctl, in that order');

  assert.ok(requests.includes(`/download/v${VERSION}/release-manifest-darwin.json`), 'the manifest of the engine\'s own version');
  assert.ok(requests.includes(`/download/v${VERSION}/SSH-Manager-${VERSION}-arm64.zip`), 'the arm64 zip, not the blockmap or the x64 one');
  assert.ok(requests.some(url => url.startsWith('/assets/')), 'GitHub\'s redirect to its asset host is followed');
  ok('the release of the engine\'s own version is used, through GitHub\'s redirect');

  const phases = progress.map(p => p.passed ? `${p.phase}:${p.passed}` : p.phase)
    .filter((phase, i, all) => phase !== all[i - 1]);
  assert.deepEqual(phases, ['manifest', 'download', 'verify', 'verify:sha256', 'verify:apple', 'install']);
  const last = progress.filter(p => p.phase === 'download').pop();
  assert.equal(last.received, artifacts[`SSH-Manager-${VERSION}-arm64.zip`].length);
  assert.equal(last.total, last.received);
  assert.ok(progress.filter(p => p.phase === 'download').length <= 102, 'progress is reported once per percent at most');
  ok('progress runs manifest → download (bytes of total) → verify (hash, Apple) → install');

  await openDesktop({ path: result.path, platform: 'darwin', run });
  assert.deepEqual(calls.pop(), ['open', app, '<detached>']);
  ok('macOS: the installed application is opened with `open`, detached');
}

async function testMacFallsBackToHomeApplications() {
  if (process.getuid?.() === 0) return; // root can write anywhere: nothing to fall back from
  reset();
  const box = machine('mac-user');
  fs.chmodSync(box.apps, 0o555);
  try {
    const { run } = fakeRunner(box);
    const result = await installDesktop({ ...mac(box), run });
    assert.equal(result.path, path.join(box.home, 'Applications', 'SSH Manager.app'));
    assert.equal(desktopStatus({ platform: 'darwin', arch: 'arm64', env: box.env, applicationsDir: box.apps }).path, result.path);
    ok('macOS: a standard account without write access to /Applications gets ~/Applications');
  } finally {
    fs.chmodSync(box.apps, 0o755);
  }
}

async function testWrongHashInstallsNothing() {
  reset();
  const box = machine('hash');
  tamper[`SSH-Manager-${VERSION}-arm64.zip`] = { sha256: sha256(Buffer.from('something else')) };
  const { run, calls } = fakeRunner(box);
  await assert.rejects(installDesktop({ ...mac(box), run }), error => error.code === 'VERIFY' && /SHA-256 does not match/.test(error.message));
  assert.deepEqual(calls, [], 'nothing may be unpacked or run once the hash is wrong');
  assertNothingInstalled(box, 'wrong hash');
  ok('a wrong SHA-256 installs nothing, runs nothing and leaves no file behind');
}

async function testWrongSizeInstallsNothing() {
  reset();
  const box = machine('size');
  const name = `SSH-Manager-${VERSION}-arm64.zip`;
  // Bigger than the release says: refused while it arrives, not after.
  tamper[name] = { size: artifacts[name].length - 100 };
  const { run, calls } = fakeRunner(box);
  await assert.rejects(installDesktop({ ...mac(box), run }), error => error.code === 'VERIFY');
  assert.deepEqual(calls, []);
  assertNothingInstalled(box, 'too large');

  // Smaller than the release says: a truncated download.
  tamper[name] = { size: artifacts[name].length + 100 };
  await assert.rejects(installDesktop({ ...mac(box), run }), error => error.code === 'VERIFY');
  assert.deepEqual(calls, []);
  assertNothingInstalled(box, 'truncated');
  ok('a size that differs from the manifest, larger or smaller, installs nothing');

  // Without a Content-Length, only counting the bytes as they arrive can tell.
  chunked = true;
  tamper[name] = { size: artifacts[name].length - 100 };
  await assert.rejects(installDesktop({ ...mac(box), run }), error => error.code === 'VERIFY' && /Larger than the release/.test(error.message));
  tamper[name] = { size: artifacts[name].length + 100 };
  await assert.rejects(installDesktop({ ...mac(box), run }), error => error.code === 'VERIFY' && /Downloaded \d+ bytes/.test(error.message));
  assert.deepEqual(calls, []);
  assertNothingInstalled(box, 'chunked');
  ok('without a Content-Length, a download is cut off at the manifest size, and a short one refused');
}

async function testMissingManifestInstallsNothing() {
  reset();
  const box = machine('404');
  missing.add('darwin');
  const { run, calls } = fakeRunner(box);
  await assert.rejects(installDesktop({ ...mac(box), run }),
    error => error.code === 'NOT_FOUND' && /release-manifest-darwin\.json/.test(error.message) && /releases/.test(error.message));
  assert.ok(!requests.some(url => url.includes('.zip')), 'no artifact may be fetched without a manifest');
  assert.deepEqual(calls, []);
  assertNothingInstalled(box, 'missing manifest');
  ok('a release with no manifest (404) installs nothing and names the releases page');
}

async function testUnsupportedPlatform() {
  reset();
  const box = machine('arm-linux');
  const status = desktopStatus({ platform: 'linux', arch: 'arm64', env: box.env });
  assert.deepEqual(status, { supported: false, installed: false, path: null, version: null, method: null });
  const { run, calls } = fakeRunner(box);
  await assert.rejects(installDesktop({ platform: 'linux', arch: 'arm64', env: box.env, baseUrl, tmpRoot: box.tmp, run, version: VERSION }),
    error => error.code === 'UNSUPPORTED' && /linux arm64/.test(error.message));
  assert.deepEqual(requests, [], 'an unsupported platform must not touch the network');
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(box.tmp), []);
  for (const [platform, arch] of [['freebsd', 'x64'], ['win32', 'ia32'], ['darwin', 'ppc']]) {
    assert.equal(desktopStatus({ platform, arch, env: box.env, applicationsDir: box.apps }).supported, false, `${platform} ${arch}`);
  }
  ok('an unsupported platform (Linux arm64, FreeBSD, 32-bit Windows) is not offered and downloads nothing');
}

async function testAlreadyInstalledOpensWithoutDownloading() {
  reset();
  const box = machine('installed');
  const app = path.join(box.apps, 'SSH Manager.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key>\n<string>4.0.0-beta.1</string></dict></plist>');
  assert.deepEqual(desktopStatus({ platform: 'darwin', arch: 'arm64', env: box.env, applicationsDir: box.apps }),
    { supported: true, installed: true, path: app, version: '4.0.0-beta.1', method: 'auto' });

  const { run, calls } = fakeRunner(box);
  const result = await installDesktop({ ...mac(box), run });
  assert.deepEqual(result, { path: app, version: '4.0.0-beta.1', downloaded: false });
  await openDesktop({ path: result.path, platform: 'darwin', run });
  assert.deepEqual(requests, [], 'an installed application must not be downloaded again');
  assert.deepEqual(calls, [['open', app, '<detached>']]);
  ok('already installed (its version read from Info.plist): opened, nothing downloaded');

  const home = machine('home-installed');
  fs.mkdirSync(path.join(home.home, 'Applications', 'SSH Manager.app'), { recursive: true });
  assert.equal(desktopStatus({ platform: 'darwin', arch: 'x64', env: home.env, applicationsDir: home.apps }).path,
    path.join(home.home, 'Applications', 'SSH Manager.app'));
  ok('an application in ~/Applications is found too');
}

async function testMacWrongTeamInstallsNothing() {
  reset();
  const box = machine('team');
  const { run, calls } = fakeRunner(box, { team: 'ZZZZZZZZZZ' });
  await assert.rejects(installDesktop({ ...mac(box), run }), error => error.code === 'VERIFY' && /ZZZZZZZZZZ/.test(error.message));
  assert.ok(!calls.some(call => call[0] === 'spctl'), 'no point asking Gatekeeper about a stranger\'s build');
  assertNothingInstalled(box, 'wrong team');
  ok('macOS: a valid signature from another team installs nothing');
}

async function testMacSignatureOrGatekeeperRefusalInstallsNothing() {
  reset();
  const refused = machine('spctl');
  await assert.rejects(installDesktop({ ...mac(refused), run: fakeRunner(refused, { spctl: 3 }).run }),
    error => error.code === 'VERIFY' && /Gatekeeper/.test(error.message));
  assertNothingInstalled(refused, 'spctl refusal');
  ok('macOS: a build Gatekeeper refuses (not notarized) installs nothing');

  const broken = machine('codesign');
  await assert.rejects(installDesktop({ ...mac(broken), run: fakeRunner(broken, { codesign: 1 }).run }),
    error => error.code === 'VERIFY' && /signature/.test(error.message));
  assertNothingInstalled(broken, 'codesign failure');
  ok('macOS: a signature that does not verify installs nothing');
}

async function testWindowsSilentPerUserInstall() {
  reset();
  const box = machine('win');
  const { run, calls } = fakeRunner(box);
  const options = { platform: 'win32', arch: 'x64', env: box.env, baseUrl, tmpRoot: box.tmp, run, version: VERSION };
  assert.equal(desktopStatus(options).method, 'auto');
  const result = await installDesktop(options);
  const exe = path.join(box.local, 'Programs', 'SSH Manager', 'SSH Manager.exe');
  assert.deepEqual(result, { path: exe, version: VERSION, downloaded: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /SSH-Manager-4\.0\.0-beta\.3-setup\.exe$/);
  assert.deepEqual(calls[0].slice(1), ['/S', '/currentuser'], 'silent, per user: no administrator rights');
  assert.deepEqual(fs.readdirSync(box.tmp), []);
  await openDesktop({ path: exe, platform: 'win32', run });
  assert.deepEqual(calls.pop(), [exe, '<detached>']);
  ok('Windows: setup.exe runs silently per user, the .exe is found under %LOCALAPPDATA%\\Programs and started');

  const failing = machine('win-fail');
  await assert.rejects(installDesktop({ ...options, env: failing.env, tmpRoot: failing.tmp, run: fakeRunner(failing, { installer: 2 }).run }),
    error => error.code === 'INSTALL');
  assert.deepEqual(fs.readdirSync(failing.tmp), []);
  ok('Windows: an installer that fails is reported, and its download removed');
}

async function testLinuxDebNeedsTheTerminal() {
  reset();
  const box = machine('deb');
  onPath(box, 'apt-get');
  const options = { platform: 'linux', arch: 'x64', env: box.env, baseUrl, tmpRoot: box.tmp, version: VERSION };
  assert.equal(desktopStatus(options).method, 'terminal', 'a .deb needs sudo, so a terminal');

  const { run, calls } = fakeRunner(box);
  await assert.rejects(installDesktop({ ...options, run }), error => error.code === 'NEEDS_TERMINAL');
  assert.deepEqual(requests, [], 'nothing is downloaded when the install could not finish');
  assert.deepEqual(calls, []);

  const result = await installDesktop({ ...options, run, terminal: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ['sudo', 'apt-get', 'install', '-y']);
  assert.ok(path.isAbsolute(calls[0][4]) && calls[0][4].endsWith(`SSH-Manager-${VERSION}-amd64.deb`), 'apt-get needs a path, not a name');
  assert.equal(calls[0][5], '<inherit>', 'sudo asks for its password in the terminal');
  assert.deepEqual(result, { path: path.join(box.bin, 'ssh-manager-desktop'), version: VERSION, downloaded: true });
  assert.deepEqual(fs.readdirSync(box.tmp), []);
  ok('Linux with apt: the .deb goes through `sudo apt-get install -y` in the terminal only');
}

async function testLinuxAppImageWithoutApt() {
  reset();
  const box = machine('appimage');
  const options = { platform: 'linux', arch: 'x64', env: box.env, baseUrl, tmpRoot: box.tmp, version: VERSION };
  assert.equal(desktopStatus(options).method, 'auto');
  const { run, calls } = fakeRunner(box);
  const result = await installDesktop({ ...options, run });
  const image = path.join(box.home, 'Applications', 'SSH-Manager.AppImage');
  assert.deepEqual(result, { path: image, version: VERSION, downloaded: true });
  assert.equal(fs.statSync(image).mode & 0o777, 0o755);
  assert.deepEqual(fs.readFileSync(image), artifacts[`SSH-Manager-${VERSION}-x86_64.AppImage`]);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(path.join(box.home, 'Applications')), ['SSH-Manager.AppImage'], 'no partial file left');
  assert.equal(desktopStatus(options).installed, true);
  ok('Linux without apt: the AppImage lands in ~/Applications, mode 0755');
}

async function testHttpsOnly() {
  reset();
  const box = machine('https');
  await assert.rejects(installDesktop({ ...mac(box), run: fakeRunner(box).run, baseUrl: 'http://example.com/download' }),
    error => error.code === 'DOWNLOAD' && /HTTPS only/.test(error.message));
  assertNothingInstalled(box, 'plain http');
  ok('a plain-HTTP release outside loopback is refused before anything is fetched');
}

async function testRunningDetection() {
  const box = machine('ps');
  const mac = '/Applications/SSH Manager.app/Contents/MacOS/SSH Manager\n/usr/bin/login\n';
  assert.equal(await desktopRunning({ platform: 'darwin', run: fakeRunner(box, { ps: mac }).run }), true);
  assert.equal(await desktopRunning({ platform: 'darwin', run: fakeRunner(box, { ps: '/Applications/SSH Manager.app/Contents/Frameworks/SSH Manager Helper.app/x\n' }).run }), false);
  assert.equal(await desktopRunning({ platform: 'linux', run: fakeRunner(box, { ps: '/opt/SSH Manager/ssh-manager-desktop --no-sandbox\n' }).run }), true);
  assert.equal(await desktopRunning({ platform: 'win32', run: fakeRunner(box, { ps: '"SSH Manager.exe","4242","Console"\n' }).run }), true);
  assert.equal(await desktopRunning({ platform: 'linux', run: async () => { throw new Error('no ps'); } }), false);
  ok('a running application is recognised on each platform, and a failing probe means "not running"');
}

function testVersions() {
  assert.ok(compareVersions('4.0.0-beta.2', '4.0.0-beta.10') < 0);
  assert.ok(compareVersions('4.0.0-beta.3', '4.0.0') < 0);
  assert.ok(compareVersions('4.0.0', '4.0.0-beta.3') > 0);
  assert.ok(compareVersions('4.1.0', '4.0.9') > 0);
  assert.equal(compareVersions('v4.0.0', '4.0.0'), 0);
  assert.ok(compareVersions('4.0.0-alpha.1', '4.0.0-beta.1') < 0);
  assert.match(engineVersion(), /^\d+\.\d+\.\d+/);
  ok('versions compare as semver, prereleases below their release');
}

// --- `ssh-manager app` -------------------------------------------------------

const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Run the CLI command against the stand-in release, capturing what it prints. */
async function app(argv, options, { socketLive = async () => false } = {}) {
  let text = '';
  const out = { write: chunk => { text += chunk; }, isTTY: false };
  const code = await runApp(argv, { out, options, socketLive, version: VERSION });
  return { code, text: plain(text) };
}

async function testAppCommandInstallsAndOpens() {
  reset();
  const box = machine('cli');
  const { run, calls } = fakeRunner(box);
  const { code, text } = await app([], { ...mac(box), run });
  assert.equal(code, 0, text);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  assert.deepEqual(lines, [
    'SSH Manager — desktop application',
    `↓ SSH-Manager-${VERSION}-arm64.zip   1 MB  ████████████ 100%`,
    `✓ SHA-256 matches release v${VERSION}`,
    '✓ signed and notarized by Apple (bVisible Sarl)',
    `✓ installed in ${path.join(box.apps, 'SSH Manager.app')}`,
    '→ opening…',
    'Your agents keep using this npm engine; the app shows what they do',
    'and lets you decide.',
  ]);
  assert.deepEqual(calls.at(-1), ['open', path.join(box.apps, 'SSH Manager.app'), '<detached>']);
  ok('`ssh-manager app`: download, SHA-256, Apple signature, installed, opened — exit 0');
}

async function testAppCommandFailureAndExitCodes() {
  reset();
  const box = machine('cli-fail');
  tamper[`SSH-Manager-${VERSION}-arm64.zip`] = { sha256: sha256(Buffer.from('other')) };
  const failed = await app([], { ...mac(box), run: fakeRunner(box).run });
  assert.equal(failed.code, 1);
  assert.match(failed.text, /✗ SHA-256 does not match release v4\.0\.0-beta\.3: nothing was installed/);
  assert.doesNotMatch(failed.text, /opening/);
  assertNothingInstalled(box, 'cli wrong hash');
  ok('`ssh-manager app` with a wrong hash: exit 1, says nothing was installed, opens nothing');

  reset();
  missing.add('darwin');
  const absent = await app([], { ...mac(box), run: fakeRunner(box).run });
  assert.equal(absent.code, 1);
  assert.match(absent.text, /release-manifest-darwin\.json not found/);
  assert.match(absent.text, /Nothing was installed/);
  ok('`ssh-manager app` with no release for this version: exit 1, nothing installed');

  reset();
  const arm = machine('cli-arm');
  const unsupported = await app([], { platform: 'linux', arch: 'arm64', env: arm.env, baseUrl, tmpRoot: arm.tmp, run: fakeRunner(arm).run });
  assert.equal(unsupported.code, 2);
  assert.match(unsupported.text, /no desktop build for linux arm64/);
  assert.match(unsupported.text, /github\.com\/bvisible\/mcp-ssh-manager\/releases/);
  assert.deepEqual(requests, []);
  ok('`ssh-manager app` on an unsupported platform: exit 2 and the releases page, nothing fetched');
}

async function testAppCommandStatusLine() {
  reset();
  const box = machine('cli-status');
  const options = { ...mac(box), run: fakeRunner(box).run };
  assert.deepEqual(await app(['--status'], options), { code: 1, text: 'desktop app not installed\n' });
  const bundle = path.join(box.apps, 'SSH Manager.app', 'Contents');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), '<key>CFBundleShortVersionString</key><string>4.0.0-beta.1</string>');
  assert.deepEqual(await app(['--status'], options), { code: 0, text: 'desktop app 4.0.0-beta.1 installed\n' });
  assert.deepEqual(await app(['--status'], { platform: 'linux', arch: 'arm64', env: box.env }),
    { code: 2, text: 'desktop app not available for linux arm64\n' });
  assert.deepEqual(requests, [], '--status reads files only');
  ok('`ssh-manager app --status`: one line, exit 0 installed, 1 not installed, 2 not available');

  const { run, calls } = fakeRunner(box);
  const opened = await app([], { ...options, run });
  assert.equal(opened.code, 0);
  assert.match(opened.text, /✓ installed in .*SSH Manager\.app \(4\.0\.0-beta\.1\)/);
  assert.match(opened.text, /This engine is 4\.0\.0-beta\.3: the app will offer its own update/);
  assert.deepEqual(calls.filter(call => call[0] === 'open').length, 1);
  assert.deepEqual(requests, [], 'an installed app is opened, not downloaded again');
  ok('`ssh-manager app` with an older app installed: opens it and says the app offers its update');
}

async function testAppCommandWithAControlPlaneRunning() {
  reset();
  const box = machine('cli-control');
  const { text, code } = await app([], { ...mac(box), run: fakeRunner(box).run }, { socketLive: async () => true });
  assert.equal(code, 0);
  assert.match(text, /ssh-manager control is running\. The app takes over the approval socket/);
  assert.match(text, /you can stop the browser control plane/);
  ok('with `ssh-manager control` running, the command says the app takes over the socket');

  reset();
  const win = machine('cli-control-win');
  const refused = await app([], { platform: 'win32', arch: 'x64', env: win.env, baseUrl, tmpRoot: win.tmp, run: fakeRunner(win).run },
    { socketLive: async () => true });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /holds the approval pipe the app needs/);
  assert.deepEqual(requests, [], 'nothing is downloaded when the app could not start');
  ok('on Windows, a running `ssh-manager control` is stopped first: a pipe cannot be shared');

  reset();
  const linux = machine('cli-running');
  fs.mkdirSync(path.join(linux.home, 'Applications'), { recursive: true });
  fs.writeFileSync(path.join(linux.home, 'Applications', 'SSH-Manager.AppImage'), 'image', { mode: 0o755 });
  const { run, calls } = fakeRunner(linux, { ps: `${path.join(linux.home, 'Applications', 'SSH-Manager.AppImage')}\n` });
  const running = await app([], { platform: 'linux', arch: 'x64', env: linux.env, baseUrl, tmpRoot: linux.tmp, run },
    { socketLive: async () => true });
  assert.equal(running.code, 0);
  assert.match(running.text, /→ already running/);
  assert.doesNotMatch(running.text, /ssh-manager control is running/, 'the socket is the running app\'s own');
  assert.deepEqual(calls.map(call => call[0]), ['ps'], 'a running app is not launched a second time');
  ok('on Linux, an app already running is not launched again, and its socket is not taken for a control plane');
}

try {
  await testMacInstallsVerifiesAndOpens();
  await testMacFallsBackToHomeApplications();
  await testWrongHashInstallsNothing();
  await testWrongSizeInstallsNothing();
  await testMissingManifestInstallsNothing();
  await testUnsupportedPlatform();
  await testAlreadyInstalledOpensWithoutDownloading();
  await testMacWrongTeamInstallsNothing();
  await testMacSignatureOrGatekeeperRefusalInstallsNothing();
  await testWindowsSilentPerUserInstall();
  await testLinuxDebNeedsTheTerminal();
  await testLinuxAppImageWithoutApt();
  await testHttpsOnly();
  await testRunningDetection();
  testVersions();
  await testAppCommandInstallsAndOpens();
  await testAppCommandFailureAndExitCodes();
  await testAppCommandStatusLine();
  await testAppCommandWithAControlPlaneRunning();
  console.log(`\n✅ desktop install tests passed (${passed} checks)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
