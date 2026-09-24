// Runs only through --release-smoke-test, with an isolated directory supplied
// by scripts/smoke-desktop.mjs. Exercise the packaged code, UI and native PTY.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const SHELL_MARKER = 'SSH_RELEASE_SMOKE_OK';

/**
 * Timestamped progress, on stdout and in a file next to the result.
 *
 * A packaged Windows smoke that took 3 s on 2026-09-07 took 40 s and then 47 s
 * on 2026-09-24, and the second one hit the launcher's limit with nothing to
 * say where the time went. The file survives a killed process; stdout does not
 * reliably reach CI from a GUI-subsystem executable on Windows.
 */
function createStages() {
  const started = Date.now();
  const lines = [];
  const file = `${process.env.SSH_RELEASE_SMOKE_RESULT}.progress`;
  return name => {
    const line = `${String(Date.now() - started).padStart(6)} ms  ${name}`;
    lines.push(line);
    console.log(`[release-smoke] ${line}`);
    try { fs.writeFileSync(file, `${lines.join('\n')}\n`); } catch { /* progress is diagnostic only */ }
  };
}

export function terminalSmokeCommand(shell) {
  const name = shell.toLowerCase();
  if (name === 'cmd.exe' || name === 'cmd') return 'echo SSH_RELEASE_^SMOKE_OK\r';
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) return "Write-Output ('SSH_RELEASE_' + 'SMOKE_OK')\r";
  return "printf 'SSH_RELEASE_%s\\n' 'SMOKE_OK'\r";
}

/** A PTY emits terminal controls, especially ConPTY; validate command output,
 * not a particular cursor position or newline sequence. The command itself
 * never contains the complete marker, so its input echo cannot pass the test.
 */
export async function verifyLocalTerminalSmoke(terminal, { timeoutMs = 10000, stage = () => {} } = {}) {
  await new Promise((resolve, reject) => {
    let output = '';
    let done = false;
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error(`Packaged ${terminal.shell} terminal did not return the command result (${output.length} PTY bytes received)`));
    }, timeoutMs);
    terminal.onExit(() => {
      clearTimeout(timeout);
      reject(new Error(`Packaged ${terminal.shell} terminal exited before returning the command result (${output.length} PTY bytes received)`));
    });
    terminal.onData(chunk => {
      output = (output + chunk).slice(-16384);
      // Output keeps arriving after the marker; report and resolve once.
      if (!done && stripVTControlCharacters(output).includes(SHELL_MARKER)) {
        done = true;
        clearTimeout(timeout);
        stage(`terminal returned the command result (${output.length} PTY bytes)`);
        resolve();
      }
    });
    terminal.write(Buffer.from(terminalSmokeCommand(terminal.shell)));
  });
  // A normal shell exit avoids ConPTY's asynchronous kill/enumeration race.
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      // Logged before the call: on Windows a ConPTY teardown is the one step
      // here that can block the main process outright, and then nothing after
      // it runs to say so.
      stage('shell did not exit within 2 s; killing it');
      terminal.kill();
      stage('kill returned');
      resolve();
    }, 2000);
    terminal.onExit(() => { clearTimeout(timeout); stage('shell exited on its own'); resolve(); });
    terminal.write(Buffer.from('exit\r'));
  });
}

export async function runSmokeTest({ app, BrowserWindow, url, root, localShellProvider }) {
  const stage = createStages();
  stage('control plane started');
  const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const failures = [];
  page.webContents.on('render-process-gone', (_event, details) => failures.push(details.reason));
  await page.loadURL(url);
  stage('interface loaded');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await page.webContents.executeJavaScript('document.querySelector("#root")?.children.length > 0')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await page.webContents.executeJavaScript('document.querySelector("#root")?.children.length > 0'), true, 'packaged interface renders');
  assert.deepEqual(failures, []);
  stage('interface rendered');
  const groups = await import(pathToFileURL(path.join(root, 'src/server-groups.js')).href);
  groups.createGroup('release_smoke', ['fixture']);
  assert.equal(fs.existsSync(path.join(root, '.server-groups.json')), false, 'groups must not write inside the application');
  assert.equal(fs.existsSync(path.join(process.env.SSH_MANAGER_HOME, 'groups.json')), true);
  stage('group written to user state');
  const factory = localShellProvider();
  assert.ok(factory, 'packaged node-pty loads');
  const terminal = await factory({ cols: 80, rows: 24, cwd: process.env.SSH_MANAGER_HOME });
  stage(`local terminal started (${terminal.shell})`);
  await verifyLocalTerminalSmoke(terminal, { stage });
  fs.writeFileSync(process.env.SSH_RELEASE_SMOKE_RESULT, JSON.stringify({ ok: true, version: app.getVersion(), platform: process.platform, arch: process.arch }));
  stage('result written; quitting');
  page.destroy();
}
