const api = window.toasts;
const stack = document.getElementById('stack');

const SHOW_FOR = 6000; // A banner stays this long.
const AFTER_HOVER = 3000; // After the pointer leaves, each banner stays this long.
const cards = new Map(); // key -> { el, timer }

function svg(viewBox, path, stroke) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  if (stroke) {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.5');
    p.setAttribute('stroke-linecap', 'round');
  }
  el.append(p);
  return el;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fallbackMark(toast) {
  return toast.glyph ? svg('0 0 24 24', toast.glyph) : document.createTextNode(toast.service.slice(0, 1));
}

function dismiss(key) {
  const card = cards.get(key);
  if (!card) return;
  clearTimeout(card.timer);
  card.el.classList.add('out');
  setTimeout(() => api.dismiss(key), 170);
}

function arm(key, ms) {
  const card = cards.get(key);
  if (!card) return;
  clearTimeout(card.timer);
  card.timer = setTimeout(() => dismiss(key), ms);
}

function build(toast) {
  const item = el('li', 'toast');
  item.setAttribute('role', 'button');

  const mark = el('div', 'mark');
  if (toast.icon) {
    // The picture of the sender. If it does not load, show the service glyph.
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => mark.replaceChildren(fallbackMark(toast)));
    img.src = toast.icon;
    mark.append(img);
  } else {
    mark.append(fallbackMark(toast));
  }

  const text = el('div', 'text');
  const head = el('div', 'head');
  head.append(el('span', 'title', toast.title || toast.service), el('span', 'service', toast.service));
  text.append(head);
  if (toast.body) text.append(el('div', 'body', toast.body));

  const close = el('button', 'close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.append(svg('0 0 8 8', 'M1 1l6 6M7 1L1 7', true));
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss(toast.key);
  });

  item.append(mark, text, close);
  item.addEventListener('click', () => api.click(toast.key));
  return item;
}

api.onList((list) => {
  const keys = new Set(list.map((t) => t.key));
  for (const [key, card] of cards) {
    if (keys.has(key)) continue;
    clearTimeout(card.timer);
    card.el.remove();
    cards.delete(key);
  }
  list.forEach((toast, i) => {
    let card = cards.get(toast.key);
    if (!card || card.stamp !== toast.stamp) {
      // New, or the service replaced it (same tag).
      if (card) {
        clearTimeout(card.timer);
        card.el.remove();
      }
      card = { el: build(toast), timer: null, stamp: toast.stamp };
      cards.set(toast.key, card);
      arm(toast.key, SHOW_FOR);
    }
    if (stack.children[i] !== card.el) stack.insertBefore(card.el, stack.children[i] || null);
  });
});

// The banners wait while the pointer is on them.
stack.addEventListener('mouseenter', () => {
  for (const card of cards.values()) clearTimeout(card.timer);
});
stack.addEventListener('mouseleave', () => {
  for (const key of cards.keys()) arm(key, AFTER_HOVER);
});
