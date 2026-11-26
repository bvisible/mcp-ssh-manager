// Whether closing the desktop window quits the application or leaves it in the
// system tray / menu bar.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOSE_TO_TRAY_KEY, shouldQuitOnWindowAllClosed } from '../desktop/electron/window-close.mjs';

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

const read = relative => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-winclose-'));
const writePrefs = content => fs.writeFileSync(
  path.join(home, 'preferences.json'),
  typeof content === 'string' ? content : JSON.stringify(content)
);

try {
  // 1. Default behaviour with no preferences file: unchanged on every platform.
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'darwin', home }), false, 'macOS stays in the menu bar by default');
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'win32', home }), true, 'Windows quits on window close by default');
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'linux', home }), true, 'Linux quits on window close by default');
  ok('without a saved preference, macOS stays running and Windows and Linux quit');

  // 2. Unrelated preferences leave the platform default untouched.
  writePrefs({ 'ssh-manager.theme': 'dark' });
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'darwin', home }), false);
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'win32', home }), true);
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'linux', home }), true);
  ok('unrelated preferences leave each platform default unchanged');

  // 3. Opting in keeps Windows and Linux in the tray when a tray icon exists.
  for (const enabled of ['true', true]) {
    writePrefs({ [CLOSE_TO_TRAY_KEY]: enabled });
    for (const platform of ['darwin', 'win32', 'linux']) {
      assert.equal(
        shouldQuitOnWindowAllClosed({ platform, home, hasTray: true }),
        false,
        `${platform} stays running when ${CLOSE_TO_TRAY_KEY} is ${JSON.stringify(enabled)}`
      );
    }
  }
  ok('enabling close-to-tray keeps the application running on Windows, Linux and macOS');

  // 4. Without a tray icon on Windows or Linux, never leave an unreachable process.
  writePrefs({ [CLOSE_TO_TRAY_KEY]: 'true' });
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'win32', home, hasTray: false }), true);
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'linux', home, hasTray: false }), true);
  assert.equal(shouldQuitOnWindowAllClosed({ platform: 'darwin', home, hasTray: false }), false, 'macOS still has the Dock');
  ok('when no tray icon could be created on Windows or Linux, closing the window still quits');

  // 5. Opting out quits on every platform, macOS included.
  for (const disabled of ['false', false]) {
    writePrefs({ [CLOSE_TO_TRAY_KEY]: disabled });
    for (const platform of ['darwin', 'win32', 'linux']) {
      assert.equal(
        shouldQuitOnWindowAllClosed({ platform, home, hasTray: true }),
        true,
        `${platform} quits when ${CLOSE_TO_TRAY_KEY} is ${JSON.stringify(disabled)}`
      );
    }
  }
  ok('disabling close-to-tray quits on window close on every platform');

  // 6. Malformed files or invalid values fall back to the platform default.
  for (const invalid of ['{unterminated', '[]', 'null', JSON.stringify({ [CLOSE_TO_TRAY_KEY]: 'maybe' }), JSON.stringify({ [CLOSE_TO_TRAY_KEY]: 1 })]) {
    writePrefs(invalid);
    assert.equal(shouldQuitOnWindowAllClosed({ platform: 'darwin', home }), false, invalid);
    assert.equal(shouldQuitOnWindowAllClosed({ platform: 'win32', home }), true, invalid);
    assert.equal(shouldQuitOnWindowAllClosed({ platform: 'linux', home }), true, invalid);
  }
  ok('unreadable or invalid preferences fall back cleanly to the platform default');

  // 7. Default home follows SSH_MANAGER_HOME when omitted.
  const previousHome = process.env.SSH_MANAGER_HOME;
  process.env.SSH_MANAGER_HOME = home;
  try {
    writePrefs({ [CLOSE_TO_TRAY_KEY]: 'true' });
    assert.equal(shouldQuitOnWindowAllClosed({ platform: 'win32', hasTray: true }), false);
  } finally {
    if (previousHome === undefined) delete process.env.SSH_MANAGER_HOME;
    else process.env.SSH_MANAGER_HOME = previousHome;
  }
  ok('omitting home reads preferences from SSH_MANAGER_HOME');

  // 8. Packaged builds carry window-close.mjs alongside main.js.
  const builderConfig = read('desktop/electron/electron-builder.yml');
  assert.match(builderConfig, /^\s*-\s+window-close\.mjs\s*$/m, 'electron-builder.yml must bundle window-close.mjs in app.asar');
  const mainSource = read('desktop/electron/main.js');
  assert.match(mainSource, /shouldQuitOnWindowAllClosed/, 'main.js must consult shouldQuitOnWindowAllClosed');
  ok('electron-builder.yml bundles window-close.mjs and main.js wires it in');

  console.log(`\n✅ desktop window-close tests passed (${passed} checks)`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
