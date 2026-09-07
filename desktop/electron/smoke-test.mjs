// Runs only through --release-smoke-test, with an isolated directory supplied
// by scripts/smoke-desktop.mjs. Exercise the packaged code, UI and native PTY.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { terminal.kill(); reject(new Error('packaged local terminal did not produce output')); }, 10000);
    let output = '';
    terminal.onData(chunk => {
      output += chunk;
      if (/(?:^|\r?\n)SSH_RELEASE_SMOKE_OK\r?\n/.test(output)) {
        clearTimeout(timeout);
        terminal.kill();
        resolve();
      }
    });
    terminal.write(Buffer.from('echo SSH_RELEASE_SMOKE_OK\r'));
  });
  fs.writeFileSync(process.env.SSH_RELEASE_SMOKE_RESULT, JSON.stringify({ ok: true, version: app.getVersion(), platform: process.platform, arch: process.arch }));
  page.destroy();
}
