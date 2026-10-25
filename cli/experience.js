import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** An invitation for people at a terminal; never part of command/MCP output. */
export function suggestDesktop(args, { stdin = process.stdin, stderr = process.stderr, env = process.env } = {}) {
  if (args.length && !(args.length === 1 && ['-i', '--interactive', 'interactive'].includes(args[0]))) return false;
  if (!stdin.isTTY || !stderr.isTTY || env.CI || env.SSH_MANAGER_NO_TIPS === '1' || env.TERM === 'dumb') return false;
  const marker = path.join(env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager'), '.v4-desktop-tip');
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, 'seen\n', { flag: 'wx', mode: 0o600 });
  } catch {
    // Already seen or read-only home: a tip must never interfere with the CLI.
    return false;
  }
  stderr.write('\nNew in v4: a workspace for your servers, files and agent approvals.\n'
    + 'In your browser: ssh-manager control\n'
    + 'As a desktop app (menu bar, notifications, updates itself): ssh-manager app\n'
    + 'Your npm/CLI setup stays supported. The interface is optional.\n\n');
  return true;
}
