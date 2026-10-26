import path from 'node:path';

/**
 * What the desktop application starts for "a terminal on this machine": the
 * file, its arguments and its environment. Kept apart from main.js so a plain
 * Node test can run it (main.js needs Electron).
 *
 * It is the user's own shell, started as a *login* shell on macOS and Linux.
 * An application opened from the Dock or Finder gets launchd's bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), and the directories Homebrew and most
 * installers add live in ~/.zprofile or ~/.bash_profile, which only a login
 * shell reads. Without `-l`, `brew`, `node` or any tool installed outside
 * /usr/bin was "command not found" here and fine in Terminal.app or Warp,
 * which both start login shells.
 *
 * On Windows it is PowerShell, the shell Windows Terminal opens by default and
 * the one people use there today. COMSPEC is not consulted: it names cmd.exe on
 * every Windows machine, so it says nothing about what the user chose. Windows
 * PowerShell (powershell.exe) ships with Windows 10 and 11, unlike PowerShell 7.
 * It has no `-l`; it reads its own profile.
 *
 * @param {{ platform?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {{ file: string, args: string[], env: Record<string, string|undefined> }}
 */
export function localShellLaunch({ platform = process.platform, env = process.env } = {}) {
  const file = platform === 'win32'
    ? 'powershell.exe'
    : env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

  const childEnv = { ...env, TERM: 'xterm-256color' };
  // Electron sets this when it runs as a plain Node process; inherited by a
  // shell it makes every `electron` the user runs behave as node instead.
  delete childEnv.ELECTRON_RUN_AS_NODE;

  return { file, args: platform === 'win32' ? [] : ['-l'], env: childEnv };
}

/** The name the interface shows for the shell (`zsh`, `cmd.exe`). */
export function localShellName(file, platform = process.platform) {
  return (platform === 'win32' ? path.win32 : path.posix).basename(file);
}
