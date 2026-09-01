/**
 * The desktop application.
 *
 * ## Why the app *is* the control plane
 *
 * The obvious shape would be a window that launches `ssh-manager control` and
 * points at it. That is what the earlier 104 KB Swift shell did, and it has one
 * flaw that disqualifies it as a product: it needs Node and the npm package
 * already installed. Somebody who downloads a `.dmg` has neither, and telling
 * them to install Node first is telling them to use the CLI.
 *
 * So this process imports the control plane and runs it in-process. Electron
 * already ships a Node runtime; using it means the app is genuinely
 * self-contained, with no second process to supervise, no port handshake to get
 * wrong, and no orphan left behind when the window is closed.
 *
 * ## What the window is
 *
 * A BrowserWindow on `http://127.0.0.1:<port>/?token=…` — the same interface
 * `ssh-manager control` serves, byte for byte. There is deliberately no
 * separate desktop UI: two implementations of the same screens is exactly the
 * trap this project climbed out of when the single-file page was deleted.
 */
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, Tray, nativeImage, Notification } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
// electron-updater is CommonJS: named imports do not resolve through the bridge.
import electronUpdater from 'electron-updater';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The engine lives two directories up in the repository, and inside
 * `app.asar.unpacked` in a packaged build. Resolved rather than assumed,
 * because getting it wrong produces a blank window and no clue why.
 */
// The engine defaults its log and history to files beside its own source, which
// here is *inside the application bundle*. One file added there breaks the code
// signature — `codesign --verify` then reports a sealed resource as invalid and
// Gatekeeper refuses the app — and it happened: a single launch was enough.
// Set before the engine is imported, because the logger reads these once.
const userData = app.getPath('userData');
// Electron does not create this until something asks it to, and the logger
// appends without making directories.
fs.mkdirSync(userData, { recursive: true });
process.env.SSH_LOG_FILE ||= path.join(userData, 'ssh-manager.log');
process.env.SSH_HISTORY_FILE ||= path.join(userData, 'command-history.json');

// node-pty is CommonJS with a native binding; `import` of a .node through the
// ESM bridge does not resolve. createRequire is the supported way in.
const require = createRequire(import.meta.url);

/**
 * A shell on this machine, for the control plane to hand to the interface.
 *
 * This is the whole reason the desktop build differs from the npm one. A
 * pseudo-terminal needs `forkpty`, a native module; the engine has none and is
 * not going to grow one, because it installs on machines with no compiler.
 * Here there is a toolchain, node-pty ships N-API prebuilds that Electron loads
 * as they are, and the result is a real terminal — colours, `vim`, Ctrl-C and
 * a window size that follows the pane.
 *
 * Returns null when the module is missing rather than throwing: a build without
 * it is a build with no local shell, not a broken application. The interface
 * asks the control plane whether one exists before offering it.
 *
 * @returns {import('../../src/control-plane.js').LocalShellFactory|null}
 */
function localShellProvider() {
  /** @type {typeof import('node-pty')} */
  let pty;
  try {
    pty = require('node-pty');
  } catch (error) {
    console.error('No local shell in this build:', error.message);
    return null;
  }

  return async ({ cols, rows, cwd }) => {
    // The user's own login shell, because that is what "a terminal on this
    // machine" means to them — their aliases, their prompt, their PATH.
    const shellPath = process.platform === 'win32'
      ? process.env.COMSPEC || 'powershell.exe'
      : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

    const env = { ...process.env, TERM: 'xterm-256color' };
    // Electron sets this when it runs as a plain Node process; inherited by a
    // shell it makes every `electron` the user runs behave as node instead.
    delete env.ELECTRON_RUN_AS_NODE;

    const term = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env,
    });

    return {
      shell: path.basename(shellPath),
      onData: handler => term.onData(handler),
      onExit: handler => term.onExit(() => handler()),
      // node-pty writes strings. What arrives is the UTF-8 of exactly what the
      // user typed, so decoding it back is lossless.
      write: data => term.write(data.toString('utf8')),
      resize: (nextCols, nextRows) => term.resize(nextCols, nextRows),
      kill: () => term.kill(),
    };
  };
}

function engineRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'engine')
    : path.join(__dirname, '..', '..');
}

/** @type {import('../../src/control-plane.js').ControlPlane|null} */
let plane = null;
/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {Tray|null} Module-level, or it is garbage collected and vanishes. */
let tray = null;
/** What the menu was last built from, so it is only rebuilt when it changed. */
let trayState = '';
/** Requests already announced, so a queue that stays full is not announced twice. */
const announced = new Set();
/** What the updater is doing, for the menu bar to show. */
let update = { status: 'idle', version: null, percent: 0 };

async function startControlPlane() {
  const root = engineRoot();
  const { ControlPlane } = await import(`file://${path.join(root, 'src', 'control-plane.js')}`);
  const { defaultSocketPath } = await import(`file://${path.join(root, 'src', 'approval.js')}`);

  plane = new ControlPlane({
    socketPath: defaultSocketPath(),
    port: 0,
    // Packaged, `dist/ui` sits next to the engine rather than in the source
    // tree; the control plane resolves it relative to its own file, so nothing
    // extra is needed here.
  });
  plane.setLocalShellProvider(localShellProvider());
  return plane.start();
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    // The page's own ground, in whichever theme it will resolve to. A fixed
    // light colour here flashes white for a beat before a dark page paints —
    // the one moment of the launch anybody actually watches.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111418' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Moved down and in, so the buttons sit level with the sidebar's own
    // controls rather than on top of them.
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      // The page is served over HTTP by our own process and needs nothing from
      // Electron: no preload, no node integration, context isolated. It talks
      // to the control plane the same way a browser tab would.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Granted rather than prompted: an approval request that goes unseen is the
  // one failure this whole feature exists to prevent, and a permission dialog
  // for a window the user just opened themselves is noise. Only notifications —
  // everything else is still refused.
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'notifications');
  });

  // Shown once painted rather than immediately: a window that appears empty and
  // fills in a second later looks broken.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Anything that is not our own page opens in the real browser. The window
  // holds a token that approves commands on production servers; a link in a
  // file listing must not be able to navigate it somewhere else.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url.split('/?')[0])) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  // The page has to reserve room for the window buttons, which a hidden title
  // bar draws *over* the content. It cannot know that on its own — the same
  // page is served to an ordinary browser tab, where there is nothing to avoid.
  const inset = process.platform === 'darwin' ? 'macos' : 'plain';
  void mainWindow.loadURL(`${url}&shell=${inset}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** A menu with the shortcuts a terminal-adjacent app is expected to have. */
function buildMenu(url) {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open in browser',
          accelerator: 'CmdOrCtrl+B',
          // The tokenised URL is genuinely useful outside the app — a second
          // screen, a different browser, devtools you are used to.
          click: () => void shell.openExternal(url),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

/**
 * The menu-bar item.
 *
 * ## Why an app that already has a window needs one
 *
 * The window is where you *do* things. The menu bar is where you find out that
 * there is something to do — which matters here more than in most apps, because
 * the thing worth knowing is that an agent is blocked waiting for you, and you
 * are by definition looking at something else when it happens. A notification
 * says it once; the menu bar keeps saying it until you deal with it.
 *
 * The icon carries a count when something is waiting, so the answer to "is
 * anything blocked on me?" costs a glance rather than a window switch.
 *
 * Everything shown here is read straight off the in-process control plane —
 * `pending`, `terminals`, `streams`, the vault — because the app *is* the
 * control plane. There is no IPC and nothing to keep in sync.
 */
/**
 * Native notifications, posted from the main process.
 *
 * The page can raise a Web Notification and does, in a browser tab. Inside the
 * desktop app that is the wrong door: the notification is attributed to the
 * renderer rather than the application, macOS has no authorisation on file for
 * it, and on Windows it needs an AppUserModelID the renderer cannot set. In
 * practice it silently does not appear, which for this feature is the worst
 * possible failure — the whole promise is that you are told when an agent is
 * blocked on you.
 *
 * So the desktop app posts them here instead, with the identity the installer
 * registered, and the page stands down when it is running inside a shell.
 *
 * @param {any[]} pending - Requests currently waiting on a decision
 */
function announce(pending) {
  if (!Notification.isSupported()) return;

  const waiting = new Set(pending.map(request => request.id));
  for (const id of [...announced]) if (!waiting.has(id)) announced.delete(id);

  for (const request of pending) {
    if (announced.has(request.id)) continue;
    announced.add(request.id);

    const notification = new Notification({
      title: request.destructive
        ? `${request.server}: destructive command waiting`
        : `${request.server}: waiting for your decision`,
      body: String(request.command || request.tool || '').slice(0, 220),
      // Destructive requests stay on screen. `rm -rf` on production and
      // `systemctl status` are not the same interruption, and a banner that
      // fades after four seconds is a banner that gets missed.
      urgency: request.destructive ? 'critical' : 'normal',
      timeoutType: request.destructive ? 'never' : 'default',
      silent: false,
    });
    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else if (plane) {
        createWindow(plane.url);
      }
    });
    notification.show();
  }
}

function refreshTray() {
  if (!tray || !plane) return;

  // The map holds { request, settle, receivedAt }; the request is inside it.
  // Reading the wrapper's fields directly is how this first shipped a menu
  // saying "undefined ·" twice.
  const pending = [...plane.pending.values()].map(entry => entry.request);
  const shells = [...plane.terminals.values()];
  const running = plane.streams.list().filter(s => s.code === null);
  let servers = [];
  try {
    servers = plane.store.exists() ? plane.store.listServers() : [];
  } catch {
    // An unreadable vault is the interface's problem to report, not the tray's.
  }

  // Rebuilding a menu the user may have open is disruptive, and this runs on a
  // timer, so only touch it when something actually moved.
  const signature = JSON.stringify([
    pending.map(r => r.id), shells.map(t => t.server),
    running.map(s => s.id), servers, update.status, update.percent,
  ]);
  if (signature === trayState) return;
  trayState = signature;

  announce(pending);

  const focus = () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (plane) {
      createWindow(plane.url);
    }
  };

  /** A command short enough for a menu, with the end kept: that is where the path is. */
  const brief = (text, max = 46) => {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
  };

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [...updateMenuItems()];

  if (pending.length) {
    template.push({ label: `${pending.length} waiting for your decision`, enabled: false });
    for (const request of pending.slice(0, 6)) {
      template.push({
        label: `    ${request.server} · ${brief(request.command)}`,
        click: focus,
      });
    }
    template.push({ type: 'separator' });
  } else {
    template.push({ label: 'Nothing is waiting', enabled: false });
    template.push({ type: 'separator' });
  }

  if (shells.length || running.length) {
    template.push({ label: 'Open right now', enabled: false });
    for (const shell of shells.slice(0, 5)) {
      template.push({ label: `    Shell on ${shell.server}`, click: focus });
    }
    for (const stream of running.slice(0, 5)) {
      template.push({
        label: `    ${stream.server} · ${brief(stream.command, 38)}`,
        click: focus,
      });
    }
    template.push({ type: 'separator' });
  }

  if (servers.length) {
    template.push({
      label: `Servers (${servers.length})`,
      submenu: servers.slice(0, 12).map(name => ({ label: name, click: focus })),
    });
    template.push({ type: 'separator' });
  }

  template.push(
    { label: 'Show SSH Manager', click: focus },
    { label: 'Open in browser', click: () => plane && void shell.openExternal(plane.url) },
    { type: 'separator' },
    { label: 'Quit SSH Manager', click: () => app.quit() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(pending.length
    ? `SSH Manager — ${pending.length} waiting for your decision`
    : 'SSH Manager');

  // The count beside the icon, and on the dock. Only when it is not zero: a
  // permanent "0" is a thing people learn to stop reading.
  if (process.platform === 'darwin') {
    tray.setTitle(pending.length ? ` ${pending.length}` : '');
    app.dock?.setBadge(pending.length ? String(pending.length) : '');
  }
}

/**
 * Updates, offered rather than applied.
 *
 * This application holds SSH connections and the approval socket an agent is
 * blocked on. Downloading 120 MB on somebody's tethered connection because a
 * release happened, or restarting under them while a transfer is running, are
 * both worse than being a version behind for an afternoon.
 *
 * So: it checks, and it says so in the menu bar. Downloading is a click.
 * Installing happens when the application is closed anyway — never in the
 * middle of something.
 */
function setupUpdater() {
  const { autoUpdater } = electronUpdater;
  if (!app.isPackaged) return;          // no feed, and no version to compare

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  const move = (status, extra = {}) => {
    update = { ...update, status, ...extra };
    trayState = '';                     // force the menu to rebuild
    refreshTray();
  };

  autoUpdater.on('update-available', info => move('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => move('idle'));
  autoUpdater.on('download-progress', p => move('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => move('ready', { version: info.version }));
  autoUpdater.on('error', () => {
    // A failed check is not worth telling anybody about: the network is down,
    // or GitHub is. It will try again.
    move('idle');
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* see above */ });
  setTimeout(check, 8000);              // not during launch, when it would compete
  const timer = setInterval(check, 6 * 60 * 60 * 1000);
  timer.unref();
}

/** The menu-bar entry for whatever the updater is up to, or nothing. */
function updateMenuItems() {
  const { autoUpdater } = electronUpdater;
  switch (update.status) {
  case 'available':
    return [{
      label: `Update to ${update.version}`,
      click: () => autoUpdater.downloadUpdate().catch(() => { /* reported by the error handler */ }),
    }, { type: 'separator' }];
  case 'downloading':
    return [{ label: `Downloading update… ${update.percent}%`, enabled: false },
      { type: 'separator' }];
  case 'ready':
    return [{
      label: `Restart to update to ${update.version}`,
      click: () => { app.relaunch(); autoUpdater.quitAndInstall(); },
    }, { type: 'separator' }];
  default:
    return [];
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'resources', 'trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // A missing icon throws inside `new Tray` on macOS and would take the whole
    // app down over a packaging mistake — which is exactly what happened: the
    // first packaged build had no trayTemplate.png, because `resources` is
    // buildResources and electron-builder leaves that out of the asar.
    console.error(`No menu-bar icon at ${iconPath}; continuing without it.`);
    return;
  }
  // macOS repaints template images for the current bar; without this the glyph
  // is a black square on a dark menu bar.
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('SSH Manager');
  // Clicking the icon itself opens the menu on macOS; elsewhere it is expected
  // to raise the window, and the menu is on right-click.
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (mainWindow) mainWindow.show();
      else if (plane) createWindow(plane.url);
    });
  }
  refreshTray();
  // Two seconds: fast enough that a blocked agent is visible almost at once,
  // slow enough to be free. It reads four in-memory collections.
  const timer = setInterval(refreshTray, 2000);
  app.on('before-quit', () => clearInterval(timer));
}

// Windows ties a notification to an Application User Model ID. Without one,
// notifications from a packaged Electron app either do not appear at all or
// appear attributed to "electron.app.Electron" — and the approval feature is
// built on the assumption that the person is told when an agent is blocked.
// This must match `appId` in electron-builder.yml or the toast is orphaned.
if (process.platform === 'win32') app.setAppUserModelId('com.bvisible.ssh-manager');

/**
 * Files dropped on the Dock icon.
 *
 * macOS delivers these as `open-file`, and it delivers them *early* — before
 * `whenReady`, if somebody dropped a file on a cold icon and that is what
 * launched the app. So they are collected here and flushed once there is
 * something to flush them into; dropping the event on the floor because the
 * window was not up yet is the classic way this feature half-works.
 *
 * What happens to them is the page's decision, not this process's: it knows
 * which servers are open, which shells are running, and which remote directory
 * is on screen. All that happens here is that it gets told.
 */
const droppedFiles = [];

function flushDroppedFiles() {
  if (!plane || droppedFiles.length === 0) return;
  const paths = droppedFiles.splice(0, droppedFiles.length);
  plane.announce({ type: 'dropped-files', paths });
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  droppedFiles.push(filePath);
  // Several files arrive as several events in quick succession; coalesce them
  // so the page asks one question about five files rather than five questions.
  setTimeout(flushDroppedFiles, 120);
});

app.whenReady().then(async () => {
  try {
    const { url } = await startControlPlane();
    buildMenu(url);
    createWindow(url);
    createTray();
    setupUpdater();
    // Anything dropped before the window existed.
    setTimeout(flushDroppedFiles, 500);
  } catch (error) {
    // A failure here means no interface at all, so it is a dialog rather than a
    // line in a log nobody is reading — most often an over-long socket path or
    // another copy already running.
    // The hint has to match the failure. A packaged build once shipped without
    // its dependencies and died on "Cannot find package 'dotenv'" — while this
    // box confidently suggested another copy was running, which sent the reader
    // looking in the wrong place entirely.
    const guess = /Cannot find (package|module)/i.test(error.message)
      ? 'The application is missing part of itself. This is a packaging fault, '
        + 'not something you can fix here — please report it with this message.'
      : error.code === 'EADDRINUSE' || /already running|EADDRINUSE/i.test(error.message)
        ? 'Another copy is already running, or a stale socket is in the way.'
        : 'The socket path may be too long for this system, or the port could '
          + 'not be opened.';
    dialog.showErrorBox('SSH Manager could not start', `${error.message}\n\n${guess}`);
    app.quit();
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0 && plane) {
      createWindow(plane.url);
    }
  });
});

// On macOS, closing the window leaves the app in the menu bar. Everywhere else
// it quits.
//
// This used to quit on every platform, and the reason was sound at the time:
// leaving the control plane running with no window means a process holding SSH
// connections that nobody can see — and worse, holding the approval socket, so
// agents block on an interface that is not on screen.
//
// The tray is exactly the thing that was missing. It shows the connections, it
// shows what is waiting, and it carries a Quit. The invisible-process objection
// no longer applies, and quitting a menu-bar app because its window closed is
// not what a macOS user expects.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async event => {
  if (tray) { tray.destroy(); tray = null; }
  if (!plane) return;
  event.preventDefault();
  const closing = plane;
  plane = null;
  try {
    await closing.stop();
  } catch {
    // Shutting down is best effort; failing to release a socket must not stop
    // the app from exiting.
  }
  app.quit();
});
