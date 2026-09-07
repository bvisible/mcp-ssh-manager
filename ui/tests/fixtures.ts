import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./control-plane.mjs', import.meta.url));
export const legacyConfig = 'SSH_SERVER_LEGACY_HOST=127.0.0.1\nSSH_SERVER_LEGACY_PORT=9\nSSH_SERVER_LEGACY_USER=fixture\nSSH_SERVER_LEGACY_PASSWORD=fixture-only-secret\nSSH_SERVER_LEGACY_PROXYJUMP=bastion\nSSH_SERVER_LEGACY_MODE=restricted\nSSH_SERVER_LEGACY_ALLOW_PATTERNS=^uptime$\n';

type App = { url: string; home: string; restart: () => Promise<void>; stop: () => Promise<void> };
export const test = base.extend<{ app: App; legacy: boolean }>({
  legacy: [false, { option: true }],
  app: async ({ legacy }, use) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-v4-'));
    // Windows's default named pipe is global, even when HOME is isolated.
    // Give concurrent workers their own approval pipe and derived stream pipe.
    const approvalSocket = process.platform === 'win32'
      ? `\\\\.\\pipe\\mcp-ssh-${path.basename(home)}` : path.join(home, 'approval.sock');
    if (legacy) await fs.writeFile(path.join(home, '.env'), legacyConfig);
    let child: ChildProcess;
    let output = '';
    const app: App = { home, url: '', restart: async () => { await app.stop(); await start(); }, stop: async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(deadline); resolve(); });
        child.kill('SIGTERM');
      });
    } };
    async function start() {
      child = spawn(process.execPath, [entry], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home, TEMP: home, TMP: home } : {}),
          HOME: home, SSH_MANAGER_HOME: home, SSH_MANAGER_KEY_SOURCE: 'file',
          SSH_MANAGER_APPROVAL_SOCKET: approvalSocket,
          SSH_ENV_PATH: path.join(home, '.env'), SSH_CONFIG_PATH: path.join(home, 'absent.toml'),
          SSH_LOG_FILE: path.join(home, 'test.log'), SSH_GROUPS_FILE: path.join(home, 'groups.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout?.on('data', chunk => { output += chunk; });
      child.stderr?.on('data', chunk => { output += chunk; });
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`Control plane startup timed out: ${output}`)), 10_000);
        child.once('error', error => { clearTimeout(deadline); reject(error); });
        child.once('exit', code => { clearTimeout(deadline); reject(new Error(`Control plane exited ${code}: ${output}`)); });
        child.on('message', (message: { url?: string }) => {
          if (message.url) { app.url = message.url; clearTimeout(deadline); resolve(); }
        });
      });
    }
    try { await start(); await use(app); }
    finally { await app.stop(); await fs.rm(home, { recursive: true, force: true }); }
  },
});
export { expect };
export function apiUrl(app: { url: string }, endpoint: string) {
  const base = new URL(app.url);
  return `${base.origin}${endpoint}${endpoint.includes('?') ? '&' : '?'}${base.search.slice(1)}`;
}
