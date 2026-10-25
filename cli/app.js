#!/usr/bin/env node
// `ssh-manager app` — install the desktop application if needed, then open it.
//
// The engine installs the application of its own version and proves it is the
// release's before anything is installed (src/desktop-install.js). When the
// application is already there it is only opened: keeping it current is the
// application's own auto-update. Agents keep using this npm engine either way.
//
// Native Node rather than Bash, so it works on Windows without Git Bash.
//
// Exit codes: 0 opened, 1 failed (nothing installed), 2 not available here.

import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  desktopStatus, installDesktop, openDesktop, desktopRunning, compareVersions, engineVersion, RELEASES_PAGE,
} from '../src/desktop-install.js';
import { defaultSocketPath } from '../src/approval.js';
import { ORANGE, GREEN, RED, YELLOW, BOLD, DIM, RESET } from './style.js';

const USAGE = `
${BOLD}ssh-manager app${RESET} — the desktop application

  ssh-manager app            Install it if needed (checked against the release), then open it
  ssh-manager app --status   One line: installed, and which version, or not

  Exit codes: 0 opened · 1 failed, nothing installed · 2 not available on this platform
`;

/**
 * The state in one line, as the interactive menu shows it.
 * @param {import('../src/desktop-install.js').DesktopStatus} status
 * @param {string} platform
 * @param {string} arch
 */
function statusLine(status, platform, arch) {
  if (status.installed) return `desktop app ${status.version ? `${status.version} ` : ''}installed`;
  if (status.supported) return 'desktop app not installed';
  return `desktop app not available for ${platform} ${arch}`;
}

/**
 * Is anything answering on the approval socket? Connecting, not just looking
 * for the file: a crash leaves a socket file nobody listens on.
 * @param {string} socketPath
 * @returns {Promise<boolean>}
 */
function probeSocket(socketPath) {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    const done = live => { socket.destroy(); resolve(live); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/** @param {number} bytes */
const megabytes = bytes => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/**
 * Draws the installation as it happens: one line per step that is done, and on
 * a terminal a line redrawn in place for what is in progress.
 * @param {{write: (text: string) => any, isTTY?: boolean}} out
 * @param {string} version
 * @param {string} platform
 * @param {string|null} method
 */
function progressPrinter(out, version, platform, method) {
  const tty = Boolean(out.isTTY);
  let transient = false;
  let downloaded = false;
  const clear = () => {
    if (transient) out.write('\r\x1b[K');
    transient = false;
  };
  const line = text => {
    clear();
    out.write(`  ${text}\n`);
  };
  const pending = text => {
    if (!tty) return;
    out.write(`\r\x1b[K  ${text}`);
    transient = true;
  };
  /** @param {import('../src/desktop-install.js').DesktopProgress} progress */
  const onProgress = progress => {
    const { phase, received, total, passed, file } = progress;
    if (phase === 'manifest') pending(`${DIM}reading release v${version}…${RESET}`);
    if (phase === 'download' && total > 0) {
      const ratio = Math.min(1, received / total);
      const filled = Math.round(ratio * 12);
      const text = `${ORANGE}↓${RESET} ${file}   ${megabytes(total)}  ${'█'.repeat(filled)}${'░'.repeat(12 - filled)} `
        + `${String(Math.floor(ratio * 100)).padStart(3)}%`;
      if (received < total) pending(text);
      else if (!downloaded) {
        downloaded = true;
        line(text);
      }
    }
    if (phase === 'verify' && !passed) pending(`${DIM}verifying…${RESET}`);
    if (passed === 'sha256') {
      line(`${GREEN}✓${RESET} SHA-256 matches release v${version}`);
      if (platform === 'win32') line(`${DIM}On Windows the SHA-256 against the release is the check.${RESET}`);
    }
    if (passed === 'apple') line(`${GREEN}✓${RESET} signed and notarized by Apple (bVisible Sarl)`);
    if (phase === 'install') {
      // apt-get writes to this terminal, so nothing may be redrawn over it.
      if (method === 'terminal') line(`${DIM}installing with apt-get…${RESET}`);
      else pending(`${DIM}installing…${RESET}`);
    }
  };
  return { line, clear, onProgress };
}

/**
 * The whole command, with its output stream and system access injectable so
 * it can be tested against a stand-in release.
 *
 * @param {string[]} argv - Arguments after `app`
 * @param {Object} [io]
 * @param {{write: (text: string) => any, isTTY?: boolean}} [io.out]
 * @param {Object} [io.options] - Passed to desktop-install.js: platform, arch, env, applicationsDir, baseUrl, run, tmpRoot
 * @param {() => Promise<boolean>} [io.socketLive] - Is a control plane answering on the approval socket?
 * @param {string} [io.version] - Release to install; the engine's own
 * @returns {Promise<number>} Exit code
 */
export async function runApp(argv, {
  out = process.stdout,
  options = {},
  socketLive = () => probeSocket(defaultSocketPath()),
  version = engineVersion(),
} = {}) {
  if (argv.includes('-h') || argv.includes('--help')) {
    out.write(USAGE);
    return 0;
  }
  const unknown = argv.find(arg => arg !== '--status');
  if (unknown) {
    out.write(`Unknown option: ${unknown}\n${USAGE}`);
    return 1;
  }
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const status = desktopStatus(options);

  if (argv.includes('--status')) {
    out.write(`${statusLine(status, platform, arch)}\n`);
    return status.installed ? 0 : status.supported ? 1 : 2;
  }

  out.write(`\n  ${ORANGE}${BOLD}SSH Manager${RESET}${BOLD} — desktop application${RESET}\n\n`);
  if (!status.installed && !status.supported) {
    out.write(`  ${RED}✗${RESET} There is no desktop build for ${platform} ${arch}.\n`
      + `    Releases: ${RELEASES_PAGE}\n\n`);
    return 2;
  }

  // Something answering on the approval socket while the application is not
  // running is a browser control plane: `ssh-manager control`.
  const appRunning = status.installed && await desktopRunning(options);
  const controlRunning = !appRunning && await socketLive();
  if (controlRunning && platform === 'win32') {
    // A named pipe cannot be bound twice: the app would not start.
    out.write(`  ${YELLOW}!${RESET} ${BOLD}ssh-manager control${RESET} is running and holds the approval pipe the app needs.\n`
      + `    Stop it (Ctrl-C where it runs), then run ${BOLD}ssh-manager app${RESET} again.\n\n`);
    return 1;
  }

  const printer = progressPrinter(out, version, platform, status.method);
  let target = status.path;
  if (status.installed) {
    printer.line(`${GREEN}✓${RESET} installed in ${status.path}${status.version ? ` (${status.version})` : ''}`);
    if (status.version && compareVersions(status.version, version) < 0) {
      printer.line(`${DIM}This engine is ${version}: the app will offer its own update.${RESET}`);
    }
  } else {
    if (status.method === 'terminal') printer.line(`${DIM}This installs a .deb with apt-get, which asks for your password.${RESET}`);
    try {
      const result = await installDesktop({ ...options, version, terminal: true, onProgress: printer.onProgress });
      target = result.path;
      printer.line(`${GREEN}✓${RESET} installed in ${result.path}`);
    } catch (error) {
      printer.line(`${RED}✗${RESET} ${error.message}`);
      if (!/nothing was installed/i.test(error.message)) printer.line(`${DIM}Nothing was installed.${RESET}`);
      out.write('\n');
      return error.code === 'UNSUPPORTED' ? 2 : 1;
    }
  }

  if (appRunning && platform !== 'darwin') {
    printer.line(`${ORANGE}→${RESET} already running`);
  } else {
    printer.line(`${ORANGE}→${RESET} opening…`);
    try {
      await openDesktop({ ...options, path: target });
    } catch (error) {
      printer.line(`${RED}✗${RESET} Could not open it: ${error.message}`);
      out.write('\n');
      return 1;
    }
  }

  if (controlRunning) {
    out.write(`\n  ${YELLOW}!${RESET} ${BOLD}ssh-manager control${RESET} is running. The app takes over the approval socket\n`
      + '    when it starts, so you can stop the browser control plane (Ctrl-C where it runs).\n');
  }
  out.write(`\n  ${DIM}Your agents keep using this npm engine; the app shows what they do\n  and lets you decide.${RESET}\n\n`);
  return 0;
}

/** Run when executed, not when imported by the tests. Realpaths: a symlinked checkout must still count. */
function isMain() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (process.argv[1] && isMain()) {
  runApp(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
      console.error(`${RED}${error.message}${RESET}`);
      process.exitCode = 1;
    }
  );
}
