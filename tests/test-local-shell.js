// How the desktop application starts the shell behind "a terminal on this
// machine".
//
// The bug this guards: an application opened from the Dock or Finder inherits
// launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin). A shell started without
// `-l` never reads the profile files where Homebrew and most installers put
// their directories (~/.zprofile, ~/.bash_profile), so `brew`, `node` or `mo`
// were "command not found" in the application's terminal and fine in Warp or
// Terminal.app, which start login shells.
//
// What is tested is the launch itself, run for real: a throw-away HOME whose
// profile adds a directory holding a command to PATH, a shell started with the
// file, arguments and environment the application would use, and a lookup of
// that command. The same shell started without `-l` must NOT find it, so a
// test that passes for the wrong reason cannot pass.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localShellLaunch } from '../desktop/electron/local-shell.mjs';

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

// ── what the launch is made of (pure, so every platform is checked here) ────
{
  const darwin = localShellLaunch({ platform: 'darwin', env: { SHELL: '/bin/zsh' } });
  assert.equal(darwin.file, '/bin/zsh');
  assert.deepEqual(darwin.args, ['-l']);
  const linux = localShellLaunch({ platform: 'linux', env: { SHELL: '/usr/bin/fish' } });
  assert.equal(linux.file, '/usr/bin/fish');
  assert.deepEqual(linux.args, ['-l']);
  ok("macOS and Linux start the user's own shell as a login shell");

  assert.equal(localShellLaunch({ platform: 'darwin', env: {} }).file, '/bin/zsh');
  assert.equal(localShellLaunch({ platform: 'linux', env: { SHELL: '' } }).file, '/bin/bash');
  ok('without $SHELL, macOS falls back to zsh and Linux to bash');

  const windows = localShellLaunch({ platform: 'win32', env: { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' } });
  assert.equal(windows.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(windows.args, [], 'cmd.exe and PowerShell have no -l: they read their profile on their own');
  assert.equal(localShellLaunch({ platform: 'win32', env: {} }).file, 'powershell.exe');
  ok('Windows keeps its shell and gets no extra argument');

  const input = { SHELL: '/bin/zsh', ELECTRON_RUN_AS_NODE: '1', TERM: 'dumb', KEEP: 'me' };
  const launch = localShellLaunch({ platform: 'darwin', env: input });
  assert.equal(launch.env.TERM, 'xterm-256color');
  assert.equal(launch.env.KEEP, 'me');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in launch.env), 'a shell must not hand ELECTRON_RUN_AS_NODE to every `electron` the user runs');
  assert.equal(input.ELECTRON_RUN_AS_NODE, '1', 'the application\'s own environment is left alone');
  ok('the terminal type is set, ELECTRON_RUN_AS_NODE is dropped, the caller\'s environment is not modified');
}

// ── the real thing: a shell started that way finds what the profile adds ────
if (process.platform === 'win32') {
  console.log('(a login shell has no meaning on Windows: the behavioural checks are skipped)');
} else {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  try {
    const tools = path.join(home, 'tools');
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'mo'), '#!/bin/sh\necho stub\n', { mode: 0o755 });
    // One line, valid in zsh, bash and sh: the profile of whichever shell runs.
    const profile = 'PATH="$HOME/tools:$PATH"; export PATH\n';
    for (const file of ['.zprofile', '.bash_profile', '.profile']) fs.writeFileSync(path.join(home, file), profile);

    // The PATH of an application opened from the Dock.
    const dockPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const lookup = (shell, args) => {
      const launch = localShellLaunch({ platform: process.platform, env: { SHELL: shell, HOME: home, PATH: dockPath } });
      return execFileSync(launch.file, [...args(launch), '-c', 'command -v mo || echo NOT_FOUND'], { env: launch.env, encoding: 'utf8' }).trim();
    };

    const shells = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash'].filter(candidate => fs.existsSync(candidate));
    assert.ok(shells.length > 0, 'a POSIX shell to test with');
    for (const shell of shells) {
      assert.equal(lookup(shell, () => []), 'NOT_FOUND', `${shell}: without -l the profile is not read (the bug this test exists for)`);
      assert.equal(lookup(shell, launch => launch.args), path.join(tools, 'mo'), `${shell}: the application's launch finds a command its profile put on PATH`);
    }
    ok(`${shells.map(shell => path.basename(shell)).join(' and ')}: the launch reads the profile, the same shell without -l does not`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n✅ local shell launch tests passed (${passed} checks)`);
