const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  ipcMain,
  shell,
  session,
  dialog,
  nativeTheme,
  clipboard,
  desktopCapturer,
  powerMonitor,
  screen,
  Notification,
  nativeImage,
  Tray,
} = require('electron');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
if (isWin) {
  app.setAppUserModelId('co.daviddiaz.switchboard');
}

// The test hooks work in a dev run only. A packaged app ignores them.
if (!app.isPackaged && process.env.SWITCHBOARD_USER_DATA) {
  app.setPath('userData', process.env.SWITCHBOARD_USER_DATA);
}

// A debug port gives full control of each signed-in service. A packaged app refuses to start with one.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'inspect', 'inspect-brk'];
if (app.isPackaged && DEBUG_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) app.exit(1);

const store = require('./store');
const { presets, presetById } = require('./services');
const { createToasts } = require('./toasts');
const { createUpdater } = require('./updater');
const { RELEASES } = require('./update-config');

// The window is a top bar, a rail, and a rounded card for the service.
// Keep these in sync with the variables in ui.css.
const RAIL = 72;
const TOP = 44;
const GAP = 8;
const RADIUS = 12;

// A hidden service releases its page caches after TRIM_AFTER.
// A service with sleep on unloads after SLEEP_AFTER and loads again on demand.
const TRIM_AFTER = 2 * 60 * 1000;
const SLEEP_AFTER = 10 * 60 * 1000;
const SLEEP_BY_DEFAULT = new Set(['notion', 'linear', 'claude']); // No message notifications to miss.

// A service that cannot load tries again by itself after these delays. After the last
// one it waits for the user. Only network errors that can go away are in the list.
// Certificate, permission and sign-in errors need the user.
const RETRY_DELAYS = [10 * 1000, 30 * 1000, 60 * 1000];
const RETRYABLE = new Set([
  -7, // TIMED_OUT
  -21, // NETWORK_CHANGED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -102, // CONNECTION_REFUSED
  -104, // CONNECTION_FAILED
  -105, // NAME_NOT_RESOLVED
  -106, // INTERNET_DISCONNECTED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
  -137, // NAME_RESOLUTION_FAILED
  -352, // HTTP2_PING_FAILED
]);
const COLORS = {
  dark: { rail: '#161618', stage: '#1c1c1f' },
  light: { rail: '#e9e9eb', stage: '#ffffff' },
};

// Slack and WhatsApp Web refuse browsers that they do not know.
const chromeMajor = process.versions.chrome.split('.')[0];
const defaultUA = isWin
  ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36 Edg/${chromeMajor}.0.0.0`
  : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
app.userAgentFallback = defaultUA;

// Google refuses sign-in from an embedded Chromium. Its sign-in pages get a Firefox identity:
// the user agent changes and the Chrome-only client hint headers go away. Other pages keep Chrome.
const GOOGLE_AUTH_HOST = 'accounts.google.com';
const FIREFOX_UA = isWin
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
  : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0';
const isGoogleAuth = (url) => {
  try {
    return new URL(url).hostname === GOOGLE_AUTH_HOST;
  } catch {
    return false;
  }
};

let cfg;
let win = null;
let panel = null; // null | 'add'
let quitting = false;
const live = new Map(); // Loaded services. id -> { view, title, badge, loading, error, favicon, ready }
const idle = new Map(); // Hidden services. id -> { trim, sleep } timers

const palette = () => (nativeTheme.shouldUseDarkColors ? COLORS.dark : COLORS.light);
const serviceById = (id) => cfg.services.find((s) => s.id === id);
const sleepEnabled = (svc) => (typeof svc.sleep === 'boolean' ? svc.sleep : SLEEP_BY_DEFAULT.has(svc.preset));

// ---------------------------------------------------------------- unread

function parseTitle(title, svc) {
  let m = title.match(/^\((\d+)\+?\)/) || title.match(/\((\d+)\+?\)/);
  if (m) return { count: Number(m[1]), dot: false };
  if (svc.preset === 'slack' || /(^|\.)slack\.com$/.test(new URL(svc.url).hostname)) {
    m = title.match(/(\d+) new items?/i);
    if (m) return { count: Number(m[1]), dot: false };
    if (/^[!*]\s/.test(title)) return { count: 0, dot: true };
  }
  return { count: 0, dot: false };
}

function unreadOf(svc) {
  const s = live.get(svc.id);
  if (!s) return { count: 0, dot: false };
  const fromTitle = parseTitle(s.title || '', svc);
  const badge = s.badge || 0;
  // A count that the page recipe read is exact (no muted chats). The title then only
  // tells that some other unread item exists, which shows as a dot.
  if (s.scraped) {
    return {
      count: s.scraped.count,
      dot: s.scraped.dot || fromTitle.dot || fromTitle.count > 0 || badge !== 0,
    };
  }
  return {
    count: Math.max(fromTitle.count, badge > 0 ? badge : 0),
    dot: fromTitle.dot || badge === -1,
  };
}

// ----------------------------------------------------------------- state

function snapshot() {
  return {
    activeId: cfg.activeId,
    panel,
    notificationsEnabled: cfg.notificationsEnabled !== false,
    soundEnabled: cfg.soundEnabled !== false,
    update: updater && updater.state().status === 'ready' ? updater.state().version : null,
    fullscreen: Boolean(win && !win.isDestroyed() && win.isFullScreen()),
    services: cfg.services.map((svc) => {
      const s = live.get(svc.id) || {};
      const preset = presetById.get(svc.preset);
      return {
        id: svc.id,
        name: svc.name,
        icon: preset ? preset.icon : null,
        favicon: preset ? null : s.favicon || null,
        unread: unreadOf(svc),
        loading: Boolean(s.loading),
        error: s.error || null,
        asleep: !live.has(svc.id),
      };
    }),
  };
}

let pushQueued = false;
function push() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    if (!win || win.isDestroyed()) return;
    const state = snapshot();
    let total = 0;
    let dot = false;
    for (const s of state.services) {
      total += s.unread.count;
      dot = dot || s.unread.dot;
    }
    // macOS hides the Dock badge of an app with no notification permission, and an app
    // with no Apple signature cannot get that permission. So the rail page draws the
    // number into the Dock icon (see ui.js and the ui:dock-icon handler).
    // The Dock shows a dot only, never a number. The numbers are on the rail.
    state.dock = total > 0 || dot ? '•' : '';
    win.webContents.send('state', state);
  });
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const top = win.isFullScreen() ? GAP : TOP;
  // The view covers the card exactly, with the same radius. Do not put a border under it:
  // the rounded corner of the view is antialiased, and a border shows through as a ring.
  const bounds = {
    x: RAIL,
    y: top,
    width: Math.max(0, width - RAIL - GAP),
    height: Math.max(0, height - top - GAP),
  };
  for (const [id, s] of live) {
    const visible = !panel && id === cfg.activeId && s.ready && !s.error;
    s.view.setVisible(visible);
    if (visible) s.view.setBounds(bounds);
  }
}

// ------------------------------------------------------------------- tint

// The rounded corner of a view is antialiased against the background of the view.
// A white background shows as a light ring around a dark page. So the background
// follows the color of the page at its top left corner.
async function tint(id) {
  const s = live.get(id);
  if (!s || !s.ready || s.error || panel || id !== cfg.activeId) return;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try {
    const image = await s.view.webContents.capturePage({ x: 2, y: 2, width: 2, height: 2 });
    const px = image.toBitmap(); // BGRA
    if (px.length < 4 || px[3] !== 255) return;
    const hex = `#${[px[2], px[1], px[0]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    if (hex === s.tint || live.get(id) !== s) return;
    s.tint = hex;
    s.view.setBackgroundColor(hex);
  } catch {
    /* The view was hidden or closed during the capture. */
  }
}

// A page gets its final colors some time after it loads (themes, dark mode).
function scheduleTint(id) {
  for (const ms of [400, 1500, 5000, 12000]) setTimeout(() => tint(id), ms);
}

// ----------------------------------------------------------------- memory

function clearIdle(id) {
  const t = idle.get(id);
  if (!t) return;
  clearTimeout(t.trim);
  clearTimeout(t.sleep);
  idle.delete(id);
}

// Starts the timers for each loaded service that the user does not look at.
function scheduleIdle() {
  const front = win && !win.isDestroyed() && win.isVisible() ? cfg.activeId : null;
  for (const svc of cfg.services) {
    if (!live.has(svc.id) || svc.id === front) {
      clearIdle(svc.id);
      continue;
    }
    if (idle.has(svc.id)) continue;
    idle.set(svc.id, {
      trim: setTimeout(() => live.get(svc.id)?.view.webContents.send('switchboard:trim'), TRIM_AFTER),
      sleep: sleepEnabled(svc) ? setTimeout(() => sleep(svc.id), SLEEP_AFTER) : null,
    });
  }
}

function sleep(id, { force = false } = {}) {
  const s = live.get(id);
  if (!s) return;
  if (id === cfg.activeId && win.isVisible()) return;
  // A call, a voice message or a video keeps the service awake. Try again later.
  // "Sleep Now" from the menu uses force: the user asked for it.
  if (!force && (s.playing || s.view.webContents.isCurrentlyAudible())) {
    clearIdle(id);
    scheduleIdle();
    return;
  }
  unmount(id);
  layout();
  push();
}

function wake(id) {
  const svc = serviceById(id);
  if (svc && !live.has(id)) mount(svc);
}

function setSleep(id, on) {
  const svc = serviceById(id);
  if (!svc) return;
  svc.sleep = on;
  store.save(cfg);
  clearIdle(id);
  scheduleIdle();
}

function memoryOf(id) {
  const s = live.get(id);
  if (!s) return null;
  const pid = s.view.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((m) => m.pid === pid);
  return metric ? Math.round(metric.memory.workingSetSize / 1024) : null;
}

function activate(id, { focus = true } = {}) {
  if (!serviceById(id)) return;
  cfg.activeId = id;
  panel = null;
  store.save(cfg);
  wake(id);
  layout();
  scheduleIdle();
  scheduleTint(id);
  if (focus) live.get(id)?.view.webContents.focus();
  push();
}

function setPanel(name) {
  panel = name || null;
  layout();
  if (panel) win.webContents.focus();
  else live.get(cfg.activeId)?.view.webContents.focus();
  push();
}

function cycle(step) {
  const n = cfg.services.length;
  if (!n) return;
  const i = cfg.services.findIndex((s) => s.id === cfg.activeId);
  activate(cfg.services[(i + step + n) % n].id);
}

// -------------------------------------------------------------- services

// A service gets these with no prompt, but only on its own site (see setupSession).
// Clipboard read is not in the list: paste with Cmd+V needs no permission, and the
// clipboard can hold a password.
const GRANTED = new Set([
  'notifications',
  'media',
  'mediaKeySystem',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'speaker-selection',
]);

const AUTH_HOSTS = [
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'github.com',
];

const site = (hostname) => hostname.split('.').slice(-2).join('.');

function openExternal(url) {
  if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
}

function useGoogleIdentity(wc) {
  let reloaded = false;
  wc.on('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isSameDocument) return;
    const want = isGoogleAuth(e.url) ? FIREFOX_UA : app.userAgentFallback;
    if (wc.getUserAgent() !== want) wc.setUserAgent(want);
  });

  // A redirect (for example from Gmail) reaches the sign-in page with the Chrome identity.
  // The identity must not change in the middle of a navigation, so the page reloads one time.
  wc.on('did-navigate', async (_e, url) => {
    if (!isGoogleAuth(url)) {
      reloaded = false;
      return;
    }
    const ua = String(await wc.executeJavaScript('navigator.userAgent').catch(() => ''));
    if (ua.includes('Firefox') || reloaded || wc.isDestroyed()) return;
    reloaded = true;
    wc.setUserAgent(FIREFOX_UA);
    wc.reload();
  });
}

function setupSession(ses, svc) {
  // Permissions go to the site of the service only. A page of another site that loads in
  // the view (a link, a redirect, a sign-in provider) gets no camera, microphone or notifications.
  const home = site(new URL(svc.url).hostname);
  const trusted = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && site(u.hostname) === home;
    } catch {
      return false;
    }
  };

  ses.webRequest.onBeforeSendHeaders({ urls: [`https://${GOOGLE_AUTH_HOST}/*`] }, (details, done) => {
    const headers = details.requestHeaders;
    for (const name of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(name)) delete headers[name];
    }
    headers['User-Agent'] = FIREFOX_UA;
    done({ requestHeaders: headers });
  });
  ses.setPermissionRequestHandler((_wc, permission, done, details) =>
    done(GRANTED.has(permission) && trusted(details.requestingUrl))
  );
  ses.setPermissionCheckHandler((_wc, permission, origin) => GRANTED.has(permission) && trusted(origin));
  // Screen share for calls. macOS shows its own picker when it can.
  ses.setDisplayMediaRequestHandler(
    async (request, done) => {
      if (!trusted(request.securityOrigin)) return done({});
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      done(sources.length ? { video: sources[0] } : {});
    },
    { useSystemPicker: true }
  );
}

// A page passes its own options with window.open, and Electron turns them into window
// options. Slack opens its huddle window with "show=no,alwaysOnTop=yes" and shows it later
// through its desktop app. In Switchboard that window would stay invisible. These values
// win over the options of the page, so a popup always acts like a browser popup.
const POPUP_OPTIONS = {
  show: true,
  alwaysOnTop: false,
  frame: true,
  transparent: false,
  skipTaskbar: false,
  focusable: true,
  kiosk: false,
  fullscreen: false,
  simpleFullscreen: false,
  modal: false,
  opacity: 1,
  closable: true,
  minimizable: true,
  maximizable: true,
  movable: true,
  fullscreenable: true,
  hasShadow: true,
  titleBarStyle: 'default',
};

// A page remembers the last position of its popup. Drop a position that is not on a
// connected display, so that the window opens in the center.
function popupOptions(features) {
  const options = { ...POPUP_OPTIONS };
  const asked = {};
  for (const pair of String(features || '').split(',')) {
    const [key, value] = pair.split('=').map((part) => part.trim());
    if (key) asked[key] = Number.parseInt(value, 10);
  }
  const x = Number.isNaN(asked.x) ? asked.left : (asked.x ?? asked.left);
  const y = Number.isNaN(asked.y) ? asked.top : (asked.y ?? asked.top);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const onScreen = screen.getAllDisplays().some(({ bounds: b }) => {
      return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    });
    if (!onScreen) {
      options.x = undefined;
      options.y = undefined;
    }
  }
  return options;
}

function windowOpenHandler(svc) {
  return ({ url, features }) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* about:blank and similar */
    }
    const internal =
      url === 'about:blank' ||
      AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ||
      (host && site(host) === site(new URL(svc.url).hostname));
    if (!internal) {
      openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: popupOptions(features) };
  };
}

function pageContextMenu(wc, p) {
  const t = [];
  const sep = () => t.length && t[t.length - 1].type !== 'separator' && t.push({ type: 'separator' });

  for (const word of p.dictionarySuggestions.slice(0, 5)) {
    t.push({ label: word, click: () => wc.replaceMisspelling(word) });
  }
  if (p.misspelledWord) {
    t.push({
      label: 'Add to Dictionary',
      click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord),
    });
    sep();
  }
  if (p.linkURL) {
    t.push({ label: 'Open Link in Browser', click: () => openExternal(p.linkURL) });
    t.push({ label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) });
    sep();
  }
  if (p.mediaType === 'image') {
    t.push({ label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) });
    t.push({ label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) });
    sep();
  }
  if (p.isEditable) {
    t.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' });
  } else if (p.selectionText) {
    t.push({ role: 'copy' });
  }
  if (!app.isPackaged) {
    sep();
    t.push({ label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) });
  }
  while (t.length && t[t.length - 1].type === 'separator') t.pop();
  if (t.length) Menu.buildFromTemplate(t).popup({ window: win });
}

function mount(svc) {
  const partition = `persist:${svc.id}`;
  setupSession(session.fromPartition(partition), svc);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload-service.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      // Background throttling stays on (the default). A hidden service then behaves like a
      // background browser tab: it stays connected, but it stops frames and releases GPU memory.
    },
  });
  view.setBorderRadius(RADIUS);
  // White is the default canvas of a browser. Some pages rely on it.
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  win.contentView.addChildView(view);

  const s = {
    view,
    title: '',
    badge: 0,
    loading: true,
    error: null,
    favicon: null,
    ready: false,
    tint: '#ffffff',
    playing: false,
    retries: 0,
    retryTimer: null,
  };
  live.set(svc.id, s);
  const wc = view.webContents;
  try {
    wc.setAudioMuted(cfg.soundEnabled === false);
  } catch {}

  wc.on('page-title-updated', (_e, title) => {
    s.title = title;
    push();
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    s.favicon = favicons.find((f) => f.startsWith('https:')) || null;
    push();
  });
  // The view stays hidden until its first page exists. The stage shows until then.
  wc.once('dom-ready', () => {
    s.ready = true;
    layout();
  });
  // A new page starts on white again. Some pages rely on the white default.
  wc.on('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isSameDocument || s.tint === '#ffffff') return;
    s.tint = '#ffffff';
    view.setBackgroundColor('#ffffff');
  });
  wc.on('did-start-loading', () => {
    s.loading = true;
    push();
  });
  wc.on('did-stop-loading', () => {
    s.loading = false;
    push();
    scheduleTint(svc.id);
    // Put the keyboard in the page, so that the user can type with no click first.
    if (svc.id === cfg.activeId && !panel && !s.error && win.isFocused()) wc.focus();
  });
  wc.on('did-finish-load', () => {
    // This event also comes after a failed load. Only a page that did load ends the retries.
    if (!s.error) s.retries = 0;
  });
  wc.on('media-started-playing', () => {
    s.playing = true;
  });
  wc.on('media-paused', () => {
    s.playing = false;
  });
  wc.on('did-navigate', () => {
    s.scraped = null; // The new page reports its own count.
    if (!s.error) return;
    s.error = null;
    layout();
    push();
  });
  wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 is a cancelled load, for example a redirect.
    s.error = description || 'The page did not load.';
    clearTimeout(s.retryTimer);
    if (RETRYABLE.has(code) && s.retries < RETRY_DELAYS.length) {
      s.retryTimer = setTimeout(() => reload(svc.id, { auto: true }), RETRY_DELAYS[s.retries]);
      s.retries += 1;
    }
    layout();
    push();
  });
  wc.on('render-process-gone', () => {
    s.error = 'The page stopped.';
    layout();
    push();
  });

  // A link to another app (slack://, tg://) must not start that app.
  const httpOnly = (e, url) => {
    if (!/^(https?|about|blob|data):/i.test(url)) e.preventDefault();
  };

  // Windows that the service opens (sign-in, calls) follow the same rules as the service.
  const onOpen = windowOpenHandler(svc);
  const adopt = (contents) => {
    contents.on('will-navigate', httpOnly);
    contents.on('will-frame-navigate', (e) => httpOnly(e, e.url));
    contents.setWindowOpenHandler(onOpen);
    useGoogleIdentity(contents);
    contents.on('did-navigate', (_e, url) => {
      if ((svc.preset === 'slack' || svc.id === 'slack') && (url.includes('/downloads') || url.includes('/unsupported'))) {
        contents.loadURL('https://slack.com/signin').catch(() => {});
      }
    });
    contents.on('did-create-window', (child) => adopt(child.webContents));
  };
  adopt(wc);
  wc.on('context-menu', (_e, params) => pageContextMenu(wc, params));

  wc.loadURL(svc.url).catch(() => {});
  return s;
}

function unmount(id, { wipe = false } = {}) {
  const s = live.get(id);
  if (!s) return;
  clearIdle(id);
  clearTimeout(s.retryTimer);
  live.delete(id);
  win.contentView.removeChildView(s.view);
  s.view.webContents.close();
  if (wipe) {
    const ses = session.fromPartition(`persist:${id}`);
    Promise.all([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()]).catch(() => {});
  }
}

function addService({ presetId, name, url }) {
  let svc;
  const id = crypto.randomUUID().slice(0, 8);
  if (presetId) {
    const p = presetById.get(presetId);
    if (!p) return;
    const same = cfg.services.filter((s) => s.preset === presetId).length;
    svc = { id, preset: presetId, name: same ? `${p.name} ${same + 1}` : p.name, url: p.url };
  } else {
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    } catch {
      return;
    }
    svc = { id, preset: null, name: (name || '').trim() || parsed.hostname.replace(/^www\./, ''), url: parsed.href };
  }
  cfg.services.push(svc);
  mount(svc);
  activate(svc.id);
  buildMenu();
}

async function removeService(id) {
  const svc = serviceById(id);
  if (!svc) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: `Remove ${svc.name}?`,
    detail: 'This signs you out of the service in Switchboard and deletes its local data.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  const i = cfg.services.findIndex((s) => s.id === id);
  cfg.services.splice(i, 1);
  unmount(id, { wipe: true });
  if (cfg.activeId === id) cfg.activeId = (cfg.services[i] || cfg.services[i - 1] || {}).id || null;
  if (!cfg.services.length) panel = 'add';
  store.save(cfg);
  layout();
  buildMenu();
  push();
}

function moveService(id, step) {
  const i = cfg.services.findIndex((s) => s.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= cfg.services.length) return;
  [cfg.services[i], cfg.services[j]] = [cfg.services[j], cfg.services[i]];
  store.save(cfg);
  buildMenu();
  push();
}

function reload(id, { hard = false, auto = false } = {}) {
  const svc = serviceById(id);
  if (!svc) return;
  if (!live.has(id)) return wake(id);
  const s = live.get(id);
  clearTimeout(s.retryTimer);
  if (!auto) s.retries = 0; // A reload by the user starts the count again.
  const wc = s.view.webContents;
  if (s.error) {
    s.error = null;
    wc.loadURL(svc.url).catch(() => {});
    layout();
    push();
  } else if (hard) wc.reloadIgnoringCache();
  else wc.reload();
}

function railContextMenu(id) {
  const svc = serviceById(id);
  if (!svc) return;
  const i = cfg.services.indexOf(svc);
  const wc = live.get(id)?.view.webContents;
  const mb = memoryOf(id);
  const status = !live.has(id) ? 'asleep' : mb ? `${mb} MB` : null;
  Menu.buildFromTemplate([
    { label: status ? `${svc.name} - ${status}` : svc.name, enabled: false },
    { type: 'separator' },
    { label: 'Reload', click: () => reload(id) },
    { label: 'Go to Start Page', enabled: Boolean(wc), click: () => wc?.loadURL(svc.url).catch(() => {}) },
    {
      label: 'Limpiar caché y reiniciar',
      click: () => {
        unmount(id, { wipe: true });
        setTimeout(() => {
          wake(id);
          layout();
          push();
        }, 300);
      },
    },
    { label: 'Open in Browser', click: () => openExternal(wc?.getURL() || svc.url) },
    { type: 'separator' },
    {
      label: 'Sleep in Background',
      type: 'checkbox',
      checked: sleepEnabled(svc),
      click: (item) => setSleep(id, item.checked),
    },
    {
      label: 'Sleep Now',
      enabled: live.has(id) && id !== cfg.activeId,
      click: () => sleep(id, { force: true }),
    },
    { type: 'separator' },
    { label: 'Move Up', enabled: i > 0, click: () => moveService(id, -1) },
    { label: 'Move Down', enabled: i < cfg.services.length - 1, click: () => moveService(id, 1) },
    { type: 'separator' },
    { label: 'Remove…', click: () => removeService(id) },
  ]).popup({ window: win });
}

// ------------------------------------------------------------------ menu

function activeContents() {
  return live.get(cfg.activeId)?.view.webContents || null;
}

function zoom(step) {
  const wc = activeContents();
  if (!wc) return;
  wc.setZoomLevel(step === 0 ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + step * 0.5)));
}

function applyAudioSettings() {
  const muted = cfg.soundEnabled === false;
  for (const [, s] of live) {
    try {
      s.view.webContents.setAudioMuted(muted);
    } catch {}
  }
}

function setSoundEnabled(enabled) {
  cfg.soundEnabled = Boolean(enabled);
  applyAudioSettings();
  store.save(cfg);
  updateTrayMenu();
  buildMenu();
  push();
}

function setNotificationsEnabled(enabled) {
  cfg.notificationsEnabled = Boolean(enabled);
  if (!cfg.notificationsEnabled && toasts) {
    for (const [key] of notes) {
      toasts.close(key);
    }
  }
  store.save(cfg);
  updateTrayMenu();
  buildMenu();
  push();
}

let tray = null;
function updateTrayMenu() {
  if (!tray || isMac) return;
  const notifOn = cfg.notificationsEnabled !== false;
  const soundOn = cfg.soundEnabled !== false;
  const gameModeOn = !notifOn && !soundOn;

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Switchboard', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Mostrar notificaciones en pantalla',
      type: 'checkbox',
      checked: notifOn,
      click: (item) => setNotificationsEnabled(item.checked),
    },
    {
      label: 'Sonido de mensajes',
      type: 'checkbox',
      checked: soundOn,
      click: (item) => setSoundEnabled(item.checked),
    },
    {
      label: gameModeOn ? '🎮 Modo Juego: ACTIVO (Desactivar)' : '🎮 Activar Modo Juego (Silenciar todo)',
      click: () => {
        const turnOff = !gameModeOn;
        setNotificationsEnabled(!turnOff);
        setSoundEnabled(!turnOff);
      },
    },
    { type: 'separator' },
    ...cfg.services.map((svc) => ({
      label: svc.name,
      click: () => {
        showWindow();
        activate(svc.id);
      },
    })),
    { type: 'separator' },
    {
      label: '🔄 Buscar actualizaciones…',
      click: () => checkForUpdates(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function setupTray() {
  if (tray || isMac) return;
  const iconPath = path.join(__dirname, 'ui', isWin ? 'app-icon.ico' : 'app-icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Switchboard');
  tray.on('click', () => {
    if (win && win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      showWindow();
    }
  });
  updateTrayMenu();
}

function buildMenu() {
  const serviceItems = cfg.services.map((svc, i) => ({
    label: svc.name,
    accelerator: i < 9 ? `CommandOrControl+${i + 1}` : undefined,
    click: () => {
      showWindow();
      activate(svc.id);
    },
  }));

  const notifOn = cfg.notificationsEnabled !== false;
  const soundOn = cfg.soundEnabled !== false;

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: () => checkForUpdates() },
              { type: 'separator' },
              {
                label: 'Show Notifications Overlay',
                type: 'checkbox',
                checked: notifOn,
                click: (item) => setNotificationsEnabled(item.checked),
              },
              {
                label: 'Message Sounds',
                type: 'checkbox',
                checked: soundOn,
                click: (item) => setSoundEnabled(item.checked),
              },
              { type: 'separator' },
              {
                label: 'Open at Login',
                type: 'checkbox',
                visible: app.isPackaged,
                checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
                click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [
          {
            label: '&File',
            submenu: [
              { label: 'Add Service…', accelerator: 'CommandOrControl+N', click: () => (showWindow(), setPanel('add')) },
              { type: 'separator' },
              { label: 'Buscar actualizaciones…', click: () => checkForUpdates() },
              { type: 'separator' },
              {
                label: 'Show Notifications Overlay',
                type: 'checkbox',
                checked: notifOn,
                accelerator: 'CommandOrControl+Shift+N',
                click: (item) => setNotificationsEnabled(item.checked),
              },
              {
                label: 'Message Sounds',
                type: 'checkbox',
                checked: soundOn,
                accelerator: 'CommandOrControl+Shift+M',
                click: (item) => setSoundEnabled(item.checked),
              },
              {
                label: 'Game Mode (Mute All)',
                type: 'checkbox',
                checked: !notifOn && !soundOn,
                click: (item) => {
                  setNotificationsEnabled(!item.checked);
                  setSoundEnabled(!item.checked);
                },
              },
              { type: 'separator' },
              {
                label: 'Open at Login',
                type: 'checkbox',
                visible: app.isPackaged,
                checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
                click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
              },
              { type: 'separator' },
              {
                label: 'Exit',
                accelerator: 'Alt+F4',
                click: () => {
                  quitting = true;
                  app.quit();
                },
              },
            ],
          },
        ]),
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { label: 'Reload Service', accelerator: 'CommandOrControl+R', click: () => reload(cfg.activeId) },
        { label: 'Reload Without Cache', accelerator: 'CommandOrControl+Shift+R', click: () => reload(cfg.activeId, { hard: true }) },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CommandOrControl+[', click: () => activeContents()?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CommandOrControl+]', click: () => activeContents()?.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => zoom(0) },
        { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: () => zoom(1) },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => zoom(-1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Developer Tools for Service',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => activeContents()?.openDevTools({ mode: 'detach' }),
        },
      ],
    },
    {
      label: '&Services',
      submenu: [
        ...serviceItems,
        { type: 'separator' },
        { label: 'Next Service', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: 'Previous Service', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        { type: 'separator' },
        { label: 'Add Service…', accelerator: 'CommandOrControl+N', click: () => (showWindow(), setPanel('add')) },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Buscar actualizaciones…', click: () => checkForUpdates() },
        { type: 'separator' },
        {
          label: 'Send Feedback…',
          click: () => openExternal(`https://github.com/${RELEASES}/issues/new`),
        },
        { label: 'Release Notes', click: () => openExternal(`https://github.com/${RELEASES}/releases`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  updateTrayMenu();
}

// ---------------------------------------------------------------- window

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (cfg.activeId && !live.has(cfg.activeId)) {
    wake(cfg.activeId);
    layout();
    push();
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...cfg.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : {
          titleBarOverlay: {
            color: palette().rail,
            symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f3f4' : '#111113',
            height: 44,
          },
        }),
    backgroundColor: palette().rail,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'ui', isWin ? 'app-icon.ico' : 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (isWin) setupTray();

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    if (!app.isPackaged && process.env.SWITCHBOARD_SHOT_DIR) win.showInactive();
    else win.show();
  });

  // The rail must not navigate away or open windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('resize', layout);
  for (const event of ['enter-full-screen', 'leave-full-screen']) {
    win.on(event, () => {
      layout();
      push();
    });
  }
  win.on('show', scheduleIdle);
  win.on('show', () => cfg.activeId && scheduleTint(cfg.activeId));
  win.on('hide', scheduleIdle);
  const remember = () => {
    if (win.isFullScreen() || win.isMinimized()) return;
    cfg.bounds = win.getBounds();
    store.save(cfg);
  };
  win.on('resized', remember);
  win.on('moved', remember);

  // Close hides the window. The services stay connected for notifications.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide());
      win.setFullScreen(false);
    } else win.hide();
  });

  if (!serviceById(cfg.activeId)) cfg.activeId = cfg.services[0]?.id || null;
  // A service with sleep on does not load until the user opens it.
  for (const svc of cfg.services) {
    if (!sleepEnabled(svc) || svc.id === cfg.activeId) mount(svc);
  }
  if (!cfg.services.length) panel = 'add';
  layout();
  scheduleIdle();
}

// ------------------------------------------------------------------- ipc

// The rail is the only page that can use these. A service page cannot.
const fromRail = (e) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents);
ipcMain.handle('ui:init', (e) => (fromRail(e) ? { presets, state: snapshot(), version: app.getVersion() } : null));
ipcMain.on('ui:activate', (e, id) => fromRail(e) && activate(id));
ipcMain.on('ui:context', (e, id) => fromRail(e) && railContextMenu(id));
ipcMain.on('ui:retry', (e, id) => fromRail(e) && reload(id));
ipcMain.on('ui:panel', (e, name) => fromRail(e) && setPanel(name === 'add' ? 'add' : null));
ipcMain.on('ui:add', (e, payload) => fromRail(e) && addService(payload || {}));
ipcMain.on('ui:update', (e) => fromRail(e) && installUpdate());
ipcMain.on('ui:check-updates', (e) => fromRail(e) && checkForUpdates());
ipcMain.on('ui:toggle-notifications', (e) => fromRail(e) && setNotificationsEnabled(cfg.notificationsEnabled === false));
ipcMain.on('ui:toggle-sound', (e) => fromRail(e) && setSoundEnabled(cfg.soundEnabled === false));

let dockIcon = null; // The last drawn icon. The test harness reads it.
ipcMain.on('ui:dock-icon', (e, dataUrl) => {
  if (!fromRail(e)) return;
  if (app.dock) {
    if (!dataUrl) {
      dockIcon = null;
      try {
        app.dock.setIcon(null); // Back to the icon of the app bundle.
      } catch {
        app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'ui', 'app-icon.png')));
      }
      return;
    }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 3_000_000) return;
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return;
    dockIcon = image;
    app.dock.setIcon(image);
  } else if (isWin && win && !win.isDestroyed()) {
    if (!dataUrl) {
      win.setOverlayIcon(null, '');
    } else {
      const image = nativeImage.createFromDataURL(dataUrl);
      if (!image.isEmpty()) {
        win.setOverlayIcon(image, 'Unread messages');
      }
    }
  }
});

const idOfSender = (sender) => {
  for (const [id, s] of live) if (s.view.webContents === sender) return id;
  return null;
};
// ----------------------------------------------------------------- updates

let updater = null;

async function installUpdate({ ask = true } = {}) {
  const state = updater.state();
  if (state.status !== 'ready') return;
  if (isWin) {
    if (ask) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Actualización disponible',
        message: `¡Switchboard v${state.version} está disponible!`,
        detail: state.notes
          ? `Novedades:\n${state.notes.slice(0, 300)}\n\n¿Deseas descargar la actualización ahora?`
          : '¿Deseas descargar la última versión de Switchboard desde GitHub?',
        buttons: ['Descargar actualización', 'Ver en GitHub', 'Más tarde'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) {
        updater.apply();
      } else if (response === 1) {
        shell.openExternal(state.releaseUrl || `https://github.com/${RELEASES}/releases`);
      }
      return;
    }
    updater.apply();
    return;
  }

  if (ask) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `Install Switchboard ${state.version}?`,
      detail: 'The app closes and opens again. Your sign-ins stay.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  if (!updater.apply()) return;
  quitting = true;
  app.quit();
}

// "Check for Updates" in the menu: do the check, then tell the result.
async function checkForUpdates() {
  const state = await updater.check();
  if (state.status === 'ready') return installUpdate();
  if (isWin) {
    if (state.status === 'idle') {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Actualizaciones de Switchboard',
        message: 'Switchboard está actualizado',
        detail: `Estás utilizando la versión más reciente (v${app.getVersion()}). No hay actualizaciones pendientes.`,
        buttons: ['Aceptar'],
      });
      return;
    }
    if (state.status === 'error') {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Comprobar actualizaciones',
        message: 'No se pudo comprobar si hay actualizaciones',
        detail: `Detalle: ${state.error || 'Verifica tu conexión a internet.'}`,
        buttons: ['Aceptar'],
      });
      return;
    }
    if (state.status === 'checking') {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Actualizaciones',
        message: 'Comprobando actualizaciones...',
        buttons: ['Aceptar'],
      });
      return;
    }
  }

  const text = {
    idle: [`Switchboard ${app.getVersion()} is the latest version.`, ''],
    checking: ['A check is in progress.', ''],
    downloading: [`Switchboard ${state.version} is on its way.`, 'The app tells you when it is ready.'],
    blocked: ['Switchboard cannot update itself here.', state.error || ''],
    error: ['The update check did not work.', state.error || ''],
  }[state.status] || ['The update check did not work.', ''];
  dialog.showMessageBox(win, { type: 'info', message: text[0], detail: text[1], buttons: ['OK'] });
}

// ---------------------------------------------------------- notifications

// macOS shows notifications only for an app with an Apple signature. Without one, macOS
// gives no reliable answer: a test copy got a "failed" event, but the real app got a "show"
// event and nothing came on screen. So the app does not ask macOS. It reads its own
// signature at start, and uses the in-app banners (toasts.js) when no Apple team signed it.
function hasAppleSignature() {
  if (!isMac) return false;
  try {
    const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
    const { stderr } = spawnSync('/usr/bin/codesign', ['-dv', bundle], { encoding: 'utf8', timeout: 5000 });
    return /^TeamIdentifier=(?!not set)\S+/m.test(stderr || '');
  } catch {
    return false;
  }
}
const appleSigned = hasAppleSignature();
let nativeNotifications = appleSigned && !(!app.isPackaged && process.env.SWITCHBOARD_FORCE_TOASTS);
let toasts = null;
const notes = new Map(); // key -> { svcId, id, key, title, body, icon, service, glyph, native }
const noteTimes = new Map(); // service id -> times of its last notifications

const clip = (value, max) => String(value ?? '').slice(0, max);

// A short record of what happened to each notification. It holds no message text.
const noteLog = [];
function logNote(service, step, detail) {
  noteLog.push({ time: new Date().toISOString(), service, step, ...(detail ? { detail } : {}) });
  if (noteLog.length > 60) noteLog.shift();
}

function noteEvent(key, type) {
  const note = notes.get(key);
  if (!note) return;
  if (type !== 'show') notes.delete(key);
  live.get(note.svcId)?.view.webContents.send('service:notification-event', note.id, type);
}

function noteClicked(key) {
  const note = notes.get(key);
  if (!note) return;
  logNote(note.service, 'click');
  showWindow();
  activate(note.svcId);
  noteEvent(key, 'click');
}

function showBanner(note) {
  logNote(note.service, 'banner');
  toasts.show({
    key: note.key,
    stamp: `${note.id}`,
    service: note.service,
    glyph: note.glyph,
    title: note.title,
    body: note.body,
    icon: note.icon,
  });
  noteEvent(note.key, 'show');
}

function present(note) {
  if (cfg.notificationsEnabled === false) {
    logNote(note.service, 'muted-by-user');
    return;
  }
  if (!nativeNotifications || !Notification.isSupported()) return showBanner(note);
  logNote(note.service, 'macos-try');
  // The service plays its own sound, so the macOS notification is silent.
  const native = new Notification({ title: note.title || note.service, body: note.body, silent: true });
  note.native = native;
  native.on('show', () => {
    logNote(note.service, 'macos-show');
    noteEvent(note.key, 'show');
  });
  native.on('click', () => noteClicked(note.key));
  native.on('close', () => noteEvent(note.key, 'close'));
  native.on('failed', (_e, error) => {
    logNote(note.service, 'macos-failed', String(error));
    nativeNotifications = false;
    note.native = null;
    if (notes.get(note.key) === note) showBanner(note);
  });
  native.show();
}

ipcMain.on('service:notify', (e, p) => {
  const svcId = idOfSender(e.sender);
  const svc = serviceById(svcId);
  if (!svc || !p || typeof p !== 'object') return;

  // Only the own site of the service can notify. A foreign page in the view cannot.
  let own = false;
  try {
    const page = new URL(e.sender.getURL());
    own = page.protocol === 'https:' && site(page.hostname) === site(new URL(svc.url).hostname);
  } catch {}
  logNote(svc.name, 'received', p.via === 'worker' ? 'through the service worker' : 'from the page');
  if (!own) return logNote(svc.name, 'dropped', 'the page is not on the site of the service');

  // At most 6 notifications in 10 seconds for each service.
  const now = Date.now();
  const times = (noteTimes.get(svcId) || []).filter((t) => now - t < 10000);
  if (times.length >= 6) return logNote(svc.name, 'dropped', 'too many in 10 seconds');
  times.push(now);
  noteTimes.set(svcId, times);

  const id = clip(p.id, 64);
  const tag = clip(p.tag, 80);
  const key = `${svcId}:${tag || id}`;
  let icon = null;
  try {
    const url = new URL(String(p.icon));
    if (url.protocol === 'https:') icon = url.href;
  } catch {}

  // A notification with the same tag replaces the old one.
  const old = notes.get(key);
  if (old) {
    old.native?.close();
    noteEvent(key, 'close');
  }

  const preset = presetById.get(svc.preset);
  const note = {
    svcId,
    id,
    key,
    title: clip(p.title, 120),
    body: clip(p.body, 400),
    icon,
    service: svc.name,
    glyph: preset ? preset.icon : null,
    native: null,
  };
  notes.set(key, note);

  // The user looks at this service now. No banner is necessary.
  if (win.isFocused() && cfg.activeId === svcId && !panel) {
    logNote(svc.name, 'no banner', 'the user looks at this service');
    noteEvent(key, 'show');
    notes.delete(key);
    return;
  }
  present(note);
});

// `Switchboard --test-notification` sends a fake notification through the same path as a real one.
function testNotification() {
  const svc = cfg.services[0];
  const preset = svc && presetById.get(svc.preset);
  const note = {
    svcId: svc ? svc.id : null,
    id: `test-${Date.now()}`,
    key: 'test',
    title: 'Switchboard',
    body: 'This is a test notification.',
    icon: null,
    service: svc ? svc.name : 'Test',
    glyph: preset ? preset.icon : null,
    native: null,
  };
  logNote(note.service, 'received', 'test');
  notes.set(note.key, note);
  present(note);
}

// `Switchboard --diagnose` writes the state of the app to diagnose.json in the user data
// folder. The report has no message text, no cookies and no account names.
async function diagnose() {
  const banner = toasts && toasts.window();
  const services = [];
  for (const svc of cfg.services) {
    const s = live.get(svc.id);
    const entry = { name: svc.name, preset: svc.preset, asleep: !s, unread: unreadOf(svc) };
    if (s) {
      const wc = s.view.webContents;
      let host = '';
      try {
        host = new URL(wc.getURL()).hostname;
      } catch {}
      entry.host = host;
      entry.countFromPage = s.scraped ? 'yes' : 'no (uses the title)';
      entry.error = s.error;
      entry.page = await wc
        .executeJavaScript(
          `JSON.stringify({
            notificationPermission: Notification.permission,
            notificationIsOurs: !/native code/.test(Function.prototype.toString.call(Notification)),
            workerNotificationIsOurs: !!window.ServiceWorkerRegistration && !/native code/.test(Function.prototype.toString.call(ServiceWorkerRegistration.prototype.showNotification)),
            visibility: document.visibilityState,
            asksToTurnOnNotifications: /desktop notifications|notificaciones de escritorio|turn on notifications|activar notificaciones/i.test(document.body ? document.body.innerText : ''),
            pathStart: location.pathname.split('/').slice(0, 2).join('/'),
            classCounts: Object.fromEntries(['.chat-list', '.ListItem', '.ChatBadge', '.ChatBadge.unread', '.rp', '.dialog-subtitle-badge', '.chatlist', '.chatlist-chat', '.p-channel_sidebar', '.p-channel_sidebar__channel--unread', '.p-channel_sidebar__badge'].map((q) => [q, document.querySelectorAll(q).length])),
          })`
        )
        .then(JSON.parse, (err) => ({ error: String(err) }));
      entry.title = parseTitle(s.title || '', svc);
      // WhatsApp: the numbers behind the count, to compare the count methods. Counts only.
      if (host === 'web.whatsapp.com') {
        entry.whatsapp = await wc
          .executeJavaScript(
            `new Promise((resolve) => {
              setTimeout(() => resolve({ error: 'timeout' }), 5000);
              const request = indexedDB.open('model-storage');
              request.onerror = () => resolve({ error: 'open failed' });
              request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('chat')) { db.close(); return resolve({ error: 'no chat store' }); }
                const query = db.transaction('chat', 'readonly').objectStore('chat').getAll();
                query.onerror = () => { db.close(); resolve({ error: 'read failed' }); };
                query.onsuccess = () => {
                  const out = { chats: query.result.length, unreadChats: 0, unreadChatsMuted: 0, unreadChatsArchived: 0, markedUnread: 0, messages: 0, messagesMuted: 0, messagesArchived: 0, fieldNames: {} };
                  for (const chat of query.result) {
                    for (const k of Object.keys(chat)) if (/mute|unread|archive|lock|community|group|news|broadcast/i.test(k)) out.fieldNames[k] = (out.fieldNames[k] || 0) + (chat[k] ? 1 : 0);
                    const n = chat.unreadCount > 0 ? chat.unreadCount : 0;
                    const marked = chat.unreadCount === -1;
                    if (!n && !marked) continue;
                    if (marked) out.markedUnread += 1;
                    if (chat.archive) { out.unreadChatsArchived += 1; out.messagesArchived += n; }
                    else if (chat.muteExpiration || chat.isAutoMuted) { out.unreadChatsMuted += 1; out.messagesMuted += n; }
                    else { out.unreadChats += 1; out.messages += n; }
                  }
                  db.close();
                  resolve(out);
                };
              };
            })`
          )
          .catch((err) => ({ error: String(err) }));
      }
    }
    services.push(entry);
  }
  const report = {
    time: new Date().toISOString(),
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    appPath: app.getPath('exe'),
    window: { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() },
    activeService: (serviceById(cfg.activeId) || {}).name || null,
    appleSigned,
    update: updater ? updater.state() : null,
    macosNotificationsInUse: nativeNotifications,
    bannerWindow: banner && !banner.isDestroyed() ? { visible: banner.isVisible(), bounds: banner.getBounds() } : null,
    displays: screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea, primary: d.id === screen.getPrimaryDisplay().id })),
    cursor: screen.getCursorScreenPoint(),
    dockIconDrawn: Boolean(dockIcon),
    services,
    notificationLog: noteLog,
  };
  fs.writeFileSync(path.join(app.getPath('userData'), 'diagnose.json'), JSON.stringify(report, null, 2));
}

ipcMain.on('service:notification-close', (e, id) => {
  const svcId = idOfSender(e.sender);
  for (const [key, note] of notes) {
    if (note.svcId !== svcId || note.id !== id) continue;
    note.native?.close();
    toasts.close(key);
    notes.delete(key);
  }
});

ipcMain.on('service:unread', (e, result) => {
  const s = live.get(idOfSender(e.sender));
  if (!s) return;
  s.scraped =
    result && Number.isInteger(result.count)
      ? { count: Math.max(0, Math.min(result.count, 99999)), dot: Boolean(result.dot) }
      : null;
  push();
});
ipcMain.on('service:badge', (e, n) => {
  const s = live.get(idOfSender(e.sender));
  if (!s) return;
  s.badge = Number.isInteger(n) ? Math.max(-1, Math.min(n, 99999)) : 0;
  push();
});

// ------------------------------------------------------------------- app

// The support arguments (--diagnose and the others) are messages for a running app.
// With no running app there is nothing to do. Without this check the command starts a
// new app that stays attached to the terminal.
const SUPPORT_ARGS = ['--test-notification', '--diagnose', '--check-updates', '--apply-update'];
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else if (app.isPackaged && process.argv.some((arg) => SUPPORT_ARGS.includes(arg))) {
  console.error('Switchboard is not running.');
  app.exit(2);
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--test-notification')) testNotification();
    else if (argv.includes('--diagnose')) diagnose().catch(() => {});
    else if (argv.includes('--check-updates')) updater.check();
    else if (argv.includes('--apply-update')) installUpdate({ ask: false });
    else showWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    if (cfg) store.flush(cfg);
  });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {});

  nativeTheme.on('updated', () => {
    if (!win || win.isDestroyed()) return;
    if (isWin) {
      try {
        win.setTitleBarOverlay({
          color: palette().rail,
          symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f3f4' : '#111113',
          height: 44,
        });
      } catch {}
    }
    win.setBackgroundColor(palette().rail);
    if (cfg.activeId) scheduleTint(cfg.activeId);
  });

  app.whenReady().then(() => {
    cfg = store.load();
    createWindow();
    applyAudioSettings();
    buildMenu();
    toasts = createToasts({ onClick: noteClicked, onClose: (key) => noteEvent(key, 'close') });
    updater = createUpdater({ onChange: () => push() });
    updater.start();
    // After the Mac wakes up, the network needs a moment. Then load each failed service again.
    // A service that works is not reloaded: a reload discards a message that the user typed.
    powerMonitor.on('resume', () => {
      setTimeout(() => {
        for (const [id, s] of live) if (s.error) reload(id);
      }, 5000);
    });
    if (!app.isPackaged && process.env.SWITCHBOARD_SHOT_DIR) {
      require('../scripts/shot')({ win, live, cfg, setPanel, activate, push, snapshot, toasts, dockIcon: () => dockIcon });
      // The harness shows the "update ready" control without a real update.
      if (process.env.SWITCHBOARD_SHOT_UPDATE) updater.state = () => ({ status: 'ready', version: '9.9.9' });
    }
  });
}
