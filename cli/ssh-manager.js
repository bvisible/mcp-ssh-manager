#!/usr/bin/env node
// Cross-platform entry point for the `ssh-manager` CLI.
//
// The real CLI is implemented as a Bash script (cli/ssh-manager). On Unix-like
// systems we simply forward to it. On Windows, npm cannot create a usable shim
// for a Bash shebang, so this Node wrapper locates a usable Bash interpreter
// (Git Bash, WSL, or a bash on PATH) and invokes the script with the correct
// path conversion.
//
// See: https://github.com/bvisible/mcp-ssh-manager/issues/22

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const bashScript = resolve(__dirname, 'ssh-manager');

if (!existsSync(bashScript)) {
  console.error(`[ssh-manager] Unable to locate CLI script at: ${bashScript}`);
  process.exit(1);
}

const isWindows = platform() === 'win32';
const args = process.argv.slice(2);

/**
 * Convert a Windows-style path (C:\foo\bar) into a POSIX-style path
 * understood by Git Bash / MSYS (/c/foo/bar). Leaves non-Windows paths alone.
 */
function toPosixPath(winPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!match) return winPath.replace(/\\/g, '/');
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/${drive}/${rest}`;
}

/**
 * Convert a Windows-style path into a WSL-style path (/mnt/c/foo/bar).
 */
function toWslPath(winPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!match) return winPath.replace(/\\/g, '/');
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/**
 * Try to locate a Git Bash executable on Windows.
 * Returns an absolute path or null if none is found.
 */
function findGitBash() {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Check whether WSL is available by running `wsl.exe --status`.
 */
function hasWsl() {
  try {
    const result = spawnSync('wsl.exe', ['--status'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check whether `bash` is on PATH (covers Unix and some Windows setups).
 */
function hasBashOnPath() {
  const probe = isWindows ? 'where' : 'which';
  try {
    const result = spawnSync(probe, ['bash'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function runUnix() {
  const result = spawnSync('bash', [bashScript, ...args], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[ssh-manager] Failed to execute bash: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

function runWindows() {
  // 1. Prefer Git Bash — it understands MSYS-style paths natively.
  const gitBash = findGitBash();
  if (gitBash) {
    const posixScript = toPosixPath(bashScript);
    const result = spawnSync(gitBash, [posixScript, ...args], {
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(`[ssh-manager] Failed to run Git Bash: ${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status ?? 0);
  }

  // 2. Fall back to WSL — the script lives on the Windows filesystem, so we
  //    translate C:\... into /mnt/c/... before invoking it.
  if (hasWsl()) {
    const wslScript = toWslPath(bashScript);
    const result = spawnSync('wsl.exe', ['bash', wslScript, ...args], {
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(`[ssh-manager] Failed to run WSL bash: ${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status ?? 0);
  }

  // 3. Last resort: a `bash` on PATH (e.g. custom MSYS2 install).
  if (hasBashOnPath()) {
    const result = spawnSync('bash', [bashScript, ...args], {
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(`[ssh-manager] Failed to run bash: ${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status ?? 0);
  }

  // Nothing worked — print an actionable message.
  console.error(`
[ssh-manager] No compatible Bash interpreter was found on this Windows system.

The \`ssh-manager\` CLI is implemented as a Bash script and requires one of:

  1. Git for Windows (recommended)
     Download: https://git-scm.com/download/win
     This ships a Git Bash that \`ssh-manager\` can use transparently.

  2. Windows Subsystem for Linux (WSL)
     Install with: wsl --install
     Then re-run \`ssh-manager\`.

Note: the MCP server itself (\`mcp-ssh-manager\`) is pure Node.js and works on
Windows without any of the above. Only the interactive \`ssh-manager\` CLI
needs a Bash environment.
`);
  process.exit(1);
}

if (isWindows) {
  runWindows();
} else {
  runUnix();
}
