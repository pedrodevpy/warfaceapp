// In-app notification banners.
// macOS refuses notifications from an app with no Apple signature ("Notifications are not
// allowed for this application"). These banners need no permission. One small window in
// the top right corner of the screen holds a stack of them.
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');

const WIDTH = 380; // The card is 348. The rest is room for the shadow.
const CARD = 76;
const GAP = 10;
const PAD = 16;
const MAX = 4;

function createToasts({ onClick, onClose }) {
  let win = null;
  let ready = false;
  const list = []; // { key, service, glyph, title, body, icon }

  const fromToasts = (e) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents);

  function place() {
    // The display with the pointer is the one that the user works on.
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const height = list.length * (CARD + GAP) - GAP + PAD * 2;
    win.setBounds({ x: workArea.x + workArea.width - WIDTH, y: workArea.y, width: WIDTH, height });
  }

  function render() {
    if (!win || win.isDestroyed() || !ready) return;
    if (!list.length) return win.hide();
    place();
    win.webContents.send('toasts', list);
    if (!win.isVisible()) win.showInactive();
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return;
    ready = false;
    const isMac = process.platform === 'darwin';
    win = new BrowserWindow({
      width: WIDTH,
      height: CARD + PAD * 2,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false, // A banner must not take the keyboard from the app in front.
      skipTaskbar: true,
      type: isMac ? 'panel' : 'toolbar',
      webPreferences: {
        preload: path.join(__dirname, 'preload-toast.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    if (isMac) {
      win.setAlwaysOnTop(true, 'floating');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    } else {
      win.setAlwaysOnTop(true);
    }
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.once('did-finish-load', () => {
      ready = true;
      render();
    });
    win.loadFile(path.join(__dirname, 'ui', 'toast.html'));
  }

  function remove(key, reason) {
    const i = list.findIndex((t) => t.key === key);
    if (i < 0) return;
    list.splice(i, 1);
    render();
    if (reason) onClose(key, reason);
  }

  ipcMain.on('toast:click', (e, key) => {
    if (!fromToasts(e) || !list.some((t) => t.key === key)) return;
    remove(key, null);
    onClick(key);
  });
  ipcMain.on('toast:dismiss', (e, key) => fromToasts(e) && remove(key, 'close'));

  return {
    // A banner with the same key replaces the old one (same service and same tag).
    show(toast) {
      const i = list.findIndex((t) => t.key === toast.key);
      if (i >= 0) list.splice(i, 1);
      list.unshift(toast);
      while (list.length > MAX) onClose(list.pop().key, 'close');
      ensureWindow();
      render();
    },
    close: (key) => remove(key, null),
    window: () => win,
  };
}

module.exports = { createToasts };
