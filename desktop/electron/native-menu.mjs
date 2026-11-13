import { nativeLanguage, nativeText } from './locale.mjs';

// Electron's aggregate menu roles generate English child labels regardless of
// the in-app language. Keep individual roles for native shortcuts and behavior,
// and supply each visible label from the same saved preference as the UI.
export function applicationMenuTemplate({ isMac, onOpenBrowser, onCheckUpdates, language = nativeLanguage() }) {
  const text = message => nativeText(message, {}, language);
  const item = (role, label) => ({ role, label: text(label) });
  const separator = () => ({ type: 'separator' });
  return [
    ...(isMac ? [{ label: 'SSH Manager', submenu: [
      item('about', 'About SSH Manager'), separator(),
      { role: 'services', label: text('Services'), submenu: [] }, separator(),
      item('hide', 'Hide SSH Manager'), item('hideOthers', 'Hide Others'),
      item('unhide', 'Show All'), separator(), item('quit', 'Quit SSH Manager'),
    ] }] : []),
    { label: text('File'), submenu: [
      { label: text('Open in browser'), accelerator: 'CmdOrCtrl+B', click: onOpenBrowser },
      separator(), isMac ? item('close', 'Close') : item('quit', 'Quit'),
    ] },
    { label: text('Edit'), submenu: [
      item('undo', 'Undo'), item('redo', 'Redo'), separator(),
      item('cut', 'Cut'), item('copy', 'Copy'), item('paste', 'Paste'),
      item('pasteAndMatchStyle', 'Paste and Match Style'), item('delete', 'Delete'),
      item('selectAll', 'Select All'),
      ...(isMac ? [separator(), { label: text('Speech'), submenu: [
        item('startSpeaking', 'Start Speaking'), item('stopSpeaking', 'Stop Speaking'),
      ] }] : []),
    ] },
    { label: text('View'), submenu: [
      item('reload', 'Reload'), item('forceReload', 'Force reload'),
      item('toggleDevTools', 'Developer tools'), separator(),
      item('resetZoom', 'Actual size'), item('zoomIn', 'Zoom in'), item('zoomOut', 'Zoom out'),
      separator(), item('togglefullscreen', 'Toggle fullscreen'),
    ] },
    { label: text('Window'), submenu: [
      item('minimize', 'Minimize'), item('zoom', 'Zoom'),
      ...(isMac ? [separator(), item('front', 'Bring All to Front')] : [item('close', 'Close')]),
    ] },
    { role: 'help', label: text('Help'), submenu: [
      { label: text('Check for Updates…'), click: onCheckUpdates },
    ] },
  ];
}
