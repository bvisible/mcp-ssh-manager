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
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The engine lives two directories up in the repository, and inside
 * `app.asar.unpacked` in a packaged build. Resolved rather than assumed,
 * because getting it wrong produces a blank window and no clue why.
 */
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
    running.map(s => s.id), servers,
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
  const template = [];

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

app.whenReady().then(async () => {
  try {
    const { url } = await startControlPlane();
    buildMenu(url);
    createWindow(url);
    createTray();
  } catch (error) {
    // A failure here means no interface at all, so it is a dialog rather than a
    // line in a log nobody is reading — most often an over-long socket path or
    // another copy already running.
    dialog.showErrorBox(
      'SSH Manager could not start',
      `${error.message}\n\nThis usually means another copy is already running, `
      + 'or the socket path is too long for this system.'
    );
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
