const api = window.switchboard;
const railEl = document.getElementById('services');
const stageEl = document.getElementById('stage');
const addBtn = document.getElementById('add');
const updateBtn = document.getElementById('update');

let presets = [];
let state = { services: [], activeId: null, panel: null };
const tiles = new Map(); // service id -> button
let stageKey = null;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
}

function glyph(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

function mark(svc) {
  if (svc.icon) return glyph(svc.icon);
  const mono = h('span', { class: 'mono' }, svc.name.trim().slice(0, 1) || '?');
  if (!svc.favicon) return mono;
  const img = h('img', { src: svc.favicon, alt: '' });
  img.addEventListener('error', () => img.replaceWith(mono));
  return img;
}

// ------------------------------------------------------------------ rail

function renderRail() {
  const seen = new Set();

  state.services.forEach((svc, i) => {
    seen.add(svc.id);
    let tile = tiles.get(svc.id);
    const markKey = svc.icon ? 'icon' : svc.favicon || 'mono';

    if (!tile) {
      tile = h('button', { class: 'tile', type: 'button' });
      tile.addEventListener('click', () => api.activate(svc.id));
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.contextMenu(svc.id);
      });
      tiles.set(svc.id, tile);
    }
    if (tile.dataset.mark !== markKey) {
      tile.querySelector(':scope > :not(.badge)')?.remove();
      tile.prepend(mark(svc));
      tile.dataset.mark = markKey;
    }

    const { count, dot } = svc.unread;
    const unreadText = count ? `, ${count} unread` : dot ? ', unread' : '';
    const label = svc.asleep ? `${svc.name} (asleep)` : svc.name;
    const modKey = api.platform === 'darwin' ? '⌘' : 'Ctrl+';
    tile.title = i < 9 ? `${label}  ${modKey}${i + 1}` : label;
    tile.setAttribute('aria-label', svc.name + unreadText);
    tile.setAttribute('aria-current', String(svc.id === state.activeId && !state.panel));
    tile.classList.toggle('loading', svc.loading);
    tile.classList.toggle('asleep', svc.asleep);

    let badge = tile.querySelector('.badge');
    if (count || dot) {
      if (!badge) tile.append((badge = h('span', { class: 'badge' })));
      badge.classList.toggle('dot', !count);
      badge.textContent = count ? (count > 99 ? '99+' : String(count)) : '';
    } else if (badge) {
      badge.remove();
    }

    if (railEl.children[i] !== tile) railEl.insertBefore(tile, railEl.children[i] || null);
  });

  for (const [id, tile] of tiles) {
    if (seen.has(id)) continue;
    tile.remove();
    tiles.delete(id);
  }

  addBtn.setAttribute('aria-current', String(state.panel === 'add'));
  updateBtn.hidden = !state.update;
  if (state.update) updateBtn.title = `Switchboard ${state.update} is ready. Click to install.`;
}

// ----------------------------------------------------------------- stage

function addPanel() {
  const canClose = state.services.length > 0;
  const name = h('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Name', spellcheck: 'false' });
  const url = h('input', {
    type: 'text',
    placeholder: 'Web address',
    'aria-label': 'Web address',
    spellcheck: 'false',
    autocapitalize: 'off',
  });
  const form = h(
    'form',
    {
      class: 'custom',
      onsubmit: (e) => {
        e.preventDefault();
        if (!url.value.trim()) return url.focus();
        api.addCustom(name.value, url.value.trim());
      },
    },
    name,
    url,
    h('button', { class: 'button', type: 'submit' }, 'Add')
  );

  return [
    canClose
      ? h('button', { class: 'button quiet done', type: 'button', title: 'Esc', onclick: () => api.setPanel(null) }, 'Done')
      : '',
    h(
      'section',
      { class: 'panel' },
      h('h1', {}, canClose ? 'Add a service' : 'Add your first service'),
      h('p', { class: 'sub' }, 'Each service keeps its own sign-in. Add one twice to use two accounts.'),
      h('div', { class: 'label' }, 'Services'),
      h(
        'div',
        { class: 'grid' },
        ...presets.map((p) =>
          h('button', { class: 'preset', type: 'button', onclick: () => api.addPreset(p.id) }, glyph(p.icon), p.name)
        )
      ),
      h('div', { class: 'label' }, 'Any web app'),
      form
    ),
  ];
}

function errorNotice(svc) {
  return [
    h(
      'section',
      { class: 'notice' },
      h('h1', {}, `${svc.name} did not load`),
      h('p', {}, 'Make sure that you are online, then try again.'),
      h('button', { class: 'button', type: 'button', onclick: () => api.retry(svc.id) }, 'Try again')
    ),
  ];
}

function renderStage() {
  const active = state.services.find((s) => s.id === state.activeId);
  let key = '';
  if (state.panel === 'add') key = `add:${state.services.length > 0}`;
  else if (active && active.error) key = `error:${active.id}`;
  if (key === stageKey) return;
  stageKey = key;

  if (key.startsWith('add')) stageEl.replaceChildren(...addPanel());
  else if (key.startsWith('error')) stageEl.replaceChildren(...errorNotice(active));
  else stageEl.replaceChildren();
}

// ------------------------------------------------------------- dock icon

// Draws the unread number into the Dock icon. See the note at state.dock in main.js.
let dockText = null;
let appIcon = null;

function loadAppIcon() {
  appIcon ||= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = 'app-icon.png';
  });
  return appIcon;
}

async function drawDock(text) {
  if (!text) return api.setDockIcon(null);
  let icon;
  try {
    icon = await loadAppIcon();
  } catch {
    return;
  }
  if (text !== dockText) return; // A newer value came in the meantime.
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.drawImage(icon, 0, 0, size, size);

  // The badge sits on the top right corner, as the macOS badge does.
  const dot = text === '•';
  const height = dot ? 96 : 168;
  g.font = '600 108px -apple-system, "SF Pro Text", system-ui, sans-serif';
  const width = dot ? height : Math.max(height, g.measureText(text).width + 78);
  const x = 490 - width;
  const y = 22;
  g.fillStyle = '#ff3b30';
  g.beginPath();
  g.roundRect(x, y, width, height, height / 2);
  g.fill();
  if (!dot) {
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x + width / 2, y + height / 2 + 6);
  }
  api.setDockIcon(canvas.toDataURL('image/png'));
}

function render(next) {
  state = next;
  if ((state.dock || '') !== dockText) {
    dockText = state.dock || '';
    drawDock(dockText);
  }
  document.body.classList.toggle('fullscreen', Boolean(state.fullscreen));
  renderRail();
  renderStage();
}

// ---------------------------------------------------------------- events

addBtn.addEventListener('click', () => api.setPanel(state.panel === 'add' ? null : 'add'));
updateBtn.addEventListener('click', () => api.installUpdate());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.panel && state.services.length) api.setPanel(null);
});

api.onState(render);
api.init().then((init) => {
  if (api.platform !== 'darwin') {
    addBtn.title = 'Add a service  Ctrl+N';
  }
  presets = init.presets;
  render(init.state);
});
