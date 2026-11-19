// Runs in each hosted service before its own scripts.
// It sends notifications, unread counts and app-badge counts to the main process.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('__switchboard', {
  notify: (note) => ipcRenderer.send('service:notify', note),
  closeNotification: (id) => ipcRenderer.send('service:notification-close', id),
  onNotificationEvent: (fn) => ipcRenderer.on('service:notification-event', (_e, id, type) => fn(id, type)),
  badge: (n) => ipcRenderer.send('service:badge', n),
});

// The main process sends this when the service has been hidden for some minutes.
ipcRenderer.on('switchboard:trim', () => webFrame.clearCache());

// ------------------------------------------------------------ unread counts
// These read the unread count from the page itself. That is more exact than the window
// title: muted and archived chats do not add to the number.
// The selectors and the database fields are adapted from the Ferdium recipes (MIT).
// See THIRD_PARTY.md. A recipe returns null when it cannot read the page. The main
// process then uses the window title.

const toInt = (text) => {
  const n = parseInt(String(text).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

let whatsappDb = null;

function openWhatsappDb() {
  return new Promise((resolve) => {
    indexedDB.databases().then(
      (dbs) => {
        // Open the database only if WhatsApp made it. An open call would create it.
        if (!dbs.some((d) => d.name === 'model-storage')) return resolve(null);
        const request = indexedDB.open('model-storage');
        request.onupgradeneeded = () => request.transaction.abort();
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          // WhatsApp must be able to change its database. Let go of it on demand.
          db.onversionchange = () => {
            db.close();
            if (whatsappDb === db) whatsappDb = null;
          };
          resolve(db);
        };
      },
      () => resolve(null)
    );
  });
}

async function whatsapp() {
  if (!whatsappDb) whatsappDb = await openWhatsappDb();
  const db = whatsappDb;
  if (!db || !db.objectStoreNames.contains('chat')) return null;
  return new Promise((resolve) => {
    try {
      const query = db.transaction('chat', 'readonly').objectStore('chat').getAll();
      query.onerror = () => resolve(null);
      query.onsuccess = () => {
        // WhatsApp shows the number of unread chats, not of unread messages, and it leaves
        // out muted and archived chats. Measured on 2026-11-18: 5 such chats, title "(5)".
        let count = 0;
        let muted = 0;
        for (const chat of query.result) {
          if (!chat || chat.archive) continue;
          // -1 is a chat that the user marked as unread.
          if (!(chat.unreadCount > 0) && chat.unreadCount !== -1) continue;
          if (chat.muteExpiration || chat.isAutoMuted) muted += 1;
          else count += 1;
        }
        resolve({ count, dot: muted > 0 });
      };
    } catch {
      whatsappDb = null;
      resolve(null);
    }
  });
}

function slack() {
  if (!document.querySelector('.p-channel_sidebar')) return null;
  const unread = '.p-channel_sidebar__channel--unread:not(.p-channel_sidebar__channel--muted)';
  // A badge is a mention or a direct message. Its number is the count.
  let count = 0;
  for (const badge of document.querySelectorAll(`${unread} .p-channel_sidebar__badge`)) {
    count += toInt(badge.textContent) || 1;
  }
  const links =
    '.p-channel_sidebar__link--unread:not([data-sidebar-link-id="Punreads"]):not([data-sidebar-link-id="Pdrafts"]):not([data-sidebar-link-id="Pdms"])';
  return { count, dot: Boolean(document.querySelector(`${unread}, ${links}`)) };
}

function telegram() {
  // Telegram has two web apps. /k/ uses other class names than /a/.
  if (location.pathname.startsWith('/k')) {
    const rows = document.querySelectorAll('.rp');
    if (!rows.length) return null;
    let count = 0;
    let muted = false;
    for (const row of rows) {
      const badge = row.querySelector('.dialog-subtitle-badge');
      if (!badge || !badge.textContent.trim()) continue;
      if (row.classList.contains('is-muted')) muted = true;
      else count += toInt(badge.textContent) || 1;
    }
    return { count, dot: muted };
  }
  const list = document.querySelector('.chat-list');
  if (!list) return null;
  let count = 0;
  for (const badge of list.querySelectorAll('.ListItem .ChatBadge.unread:not(.muted)')) {
    count += toInt(badge.textContent) || 1;
  }
  return { count, dot: Boolean(list.querySelector('.ListItem .ChatBadge.unread.muted')) };
}

const recipe = { 'web.whatsapp.com': whatsapp, 'app.slack.com': slack, 'web.telegram.org': telegram }[location.hostname];

if (recipe) {
  let last = '';
  let timer = null;
  const run = async () => {
    timer = null;
    let result = null;
    try {
      result = await recipe();
    } catch {
      result = null;
    }
    const key = JSON.stringify(result);
    if (key === last) return;
    last = key;
    ipcRenderer.send('service:unread', result);
  };
  // A change in the page starts one read, at most one per second. A hidden page slows
  // repeating timers down to one per minute, but a change in the page still starts a read.
  const poke = () => {
    if (!timer) timer = setTimeout(run, 1000);
  };
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(poke).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    poke();
  });
  setInterval(poke, 15000);
}

function patch() {
  // Firefox has no userAgentData. The Google sign-in page gets a Firefox identity (see main.js).
  if (location.hostname === 'accounts.google.com') {
    try {
      delete Navigator.prototype.userAgentData;
    } catch {}
  }

  const bridge = window.__switchboard;
  if (!bridge) return;

  // The page does not show notifications itself. Each one goes to the main process, which
  // shows a macOS notification, or an in-app banner when macOS refuses (an app with no
  // Apple signature). The main process sends "show", "click" and "close" back.
  let count = 0;
  const open = new Map();
  class Notification extends EventTarget {
    static get permission() {
      return 'granted';
    }
    static get maxActions() {
      return 0;
    }
    static requestPermission(callback) {
      if (typeof callback === 'function') callback('granted');
      return Promise.resolve('granted');
    }
    constructor(title, options) {
      if (!arguments.length) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
      super();
      const o = options || {};
      this.title = String(title);
      this.body = String(o.body ?? '');
      this.tag = String(o.tag ?? '');
      this.icon = String(o.icon ?? '');
      this.data = o.data ?? null;
      this.silent = Boolean(o.silent);
      this.onclick = null;
      this.onshow = null;
      this.onclose = null;
      this.onerror = null;
      this._id = `${Date.now()}-${++count}`;
      open.set(this._id, this);
      bridge.notify({ id: this._id, title: this.title, body: this.body, tag: this.tag, icon: this.icon, via: o.__via });
    }
    close() {
      if (open.delete(this._id)) bridge.closeNotification(this._id);
    }
  }
  bridge.onNotificationEvent((id, type) => {
    const note = open.get(id);
    if (!note || !['show', 'click', 'close'].includes(type)) return;
    if (type !== 'show') open.delete(id);
    const event = new Event(type);
    note.dispatchEvent(event);
    const handler = note[`on${type}`];
    if (typeof handler === 'function') handler.call(note, event);
  });
  window.Notification = Notification;

  // Some services (WhatsApp, Telegram) show notifications through their service worker.
  // Electron does not show those. Send them through the page notification, which works.
  // Only plain fields go through: a page notification refuses "actions".
  if (window.ServiceWorkerRegistration) {
    window.ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      const o = options || {};
      try {
        new window.Notification(String(title || ''), { body: o.body, icon: o.icon, tag: o.tag, silent: o.silent, __via: 'worker' });
      } catch {}
      return Promise.resolve();
    };
  }

  // Web apps that support the Badging API report their unread count here.
  // -1 means "unread, no count".
  navigator.setAppBadge = (n) => {
    bridge.badge(n === undefined ? -1 : Math.max(0, Number(n) || 0));
    return Promise.resolve();
  };
  navigator.clearAppBadge = () => {
    bridge.badge(0);
    return Promise.resolve();
  };
}

webFrame.executeJavaScript(`(${patch.toString()})();`);
