// Runs only through --release-smoke-test, with an isolated directory supplied
// by scripts/smoke-desktop.mjs. Exercise the packaged code, UI and native PTY.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const SHELL_MARKER = 'SSH_RELEASE_SMOKE_OK';

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
export async function verifyLocalTerminalSmoke(terminal, { timeoutMs = 10000 } = {}) {
  await new Promise((resolve, reject) => {
    let output = '';
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
      if (stripVTControlCharacters(output).includes(SHELL_MARKER)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    terminal.write(Buffer.from(terminalSmokeCommand(terminal.shell)));
  });
  // A normal shell exit avoids ConPTY's asynchronous kill/enumeration race.
  await new Promise(resolve => {
    const timeout = setTimeout(() => { terminal.kill(); resolve(); }, 2000);
    terminal.onExit(() => { clearTimeout(timeout); resolve(); });
    terminal.write(Buffer.from('exit\r'));
  });
}

export async function runSmokeTest({ app, BrowserWindow, url, root, localShellProvider }) {
  const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const failures = [];
  page.webContents.on('render-process-gone', (_event, details) => failures.push(details.reason));
  await page.loadURL(url);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await page.webContents.executeJavaScript('document.querySelector("#root")?.children.length > 0')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await page.webContents.executeJavaScript('document.querySelector("#root")?.children.length > 0'), true, 'packaged interface renders');
  assert.deepEqual(failures, []);
  const groups = await import(pathToFileURL(path.join(root, 'src/server-groups.js')).href);
  groups.createGroup('release_smoke', ['fixture']);
  assert.equal(fs.existsSync(path.join(root, '.server-groups.json')), false, 'groups must not write inside the application');
  assert.equal(fs.existsSync(path.join(process.env.SSH_MANAGER_HOME, 'groups.json')), true);
  const factory = localShellProvider();
  assert.ok(factory, 'packaged node-pty loads');
  const terminal = await factory({ cols: 80, rows: 24, cwd: process.env.SSH_MANAGER_HOME });
  await verifyLocalTerminalSmoke(terminal);
  fs.writeFileSync(process.env.SSH_RELEASE_SMOKE_RESULT, JSON.stringify({ ok: true, version: app.getVersion(), platform: process.platform, arch: process.arch }));
  page.destroy();
}
