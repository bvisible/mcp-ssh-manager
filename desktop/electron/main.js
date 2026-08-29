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
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
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
    // Matches the interface's own ground so there is no white flash on launch,
    // and no seam between the frame and the page.
    backgroundColor: '#f6f7f9',
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

app.whenReady().then(async () => {
  try {
    const { url } = await startControlPlane();
    buildMenu(url);
    createWindow(url);
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

// Closing the last window quits everywhere, macOS included. This app is one
// window onto one control plane; leaving the plane running with no window would
// leave a process holding SSH connections nobody can see.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', async event => {
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
