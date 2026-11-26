import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLOSE_TO_TRAY_KEY = 'ssh-manager.close-to-tray';

/**
 * Whether closing the last window should quit the application.
 *
 * Without a saved preference, each platform keeps its own convention: macOS
 * stays in the menu bar and Dock; Windows and Linux quit. When the user sets
 * the preference in Options, that choice wins — except on Windows and Linux
 * when no tray icon could be created, where staying alive with neither window
 * nor tray would leave an unreachable process holding the approval socket.
 *
 * @param {{ platform?: string, home?: string, hasTray?: boolean }} [options]
 * @returns {boolean}
 */
export function shouldQuitOnWindowAllClosed({
  platform = process.platform,
  home = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager'),
  hasTray = true,
} = {}) {
  let keepInTray = platform === 'darwin';
  try {
    const preferences = JSON.parse(fs.readFileSync(path.join(home, 'preferences.json'), 'utf8'));
    const saved = preferences?.[CLOSE_TO_TRAY_KEY];
    if (saved === 'true' || saved === true) keepInTray = true;
    else if (saved === 'false' || saved === false) keepInTray = false;
  } catch {
    // Absent or unreadable preferences fall back to the platform default.
  }
  if (platform !== 'darwin' && !hasTray) return true;
  return !keepInTray;
}
