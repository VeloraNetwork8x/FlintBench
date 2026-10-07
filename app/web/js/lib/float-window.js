import { h, icon } from './dom.js';
import { prefs } from './store.js';

/**
 * A floating window above the page: moved by its title bar, resized from any edge or corner,
 * maximised with a double click on the title bar, closed with × or Esc. Its place and size are
 * remembered per kind (`key`), so it opens again where it was left. Not modal: the page under it
 * stays usable. One window per key: opening it again replaces its content.
 */

const MIN_W = 360;
// the app's motion tokens: --t-fast with --ease to change size, --t-quick to leave
const SIZE_MS = 250;
const CLOSE_MS = 150;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_OUT = 'cubic-bezier(0.4, 0, 1, 1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const MIN_H = 220;
const EDGES = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
const open = new Map(); // key -> api

function clamp(r) {
  const vw = innerWidth;
  const vh = innerHeight;
  const width = Math.min(Math.max(MIN_W, r.width), vw);
  const height = Math.min(Math.max(MIN_H, r.height), vh);
  // the title bar always stays reachable
  const left = Math.min(Math.max(r.left, 40 - width), vw - 40);
  const top = Math.min(Math.max(r.top, 0), vh - 40);
  return { left, top, width, height };
}

export function floatWindow({ key, title, body, onClose }) {
  const existing = open.get(key);
  if (existing) {
    existing.set({ title, body });
    existing.focus();
    return existing;
  }
  const prefKey = `float.${key}`;
  const saved = prefs.get(prefKey, null);
  let rect = clamp(saved?.rect ?? { width: Math.min(880, innerWidth - 80), height: Math.min(620, innerHeight - 120), left: Math.max(20, innerWidth - Math.min(880, innerWidth - 80) - 60), top: 80 });
  let maximised = Boolean(saved?.maximised);

  const titleEl = h('div.fwin-title');
  const content = h('div.fwin-body');
  const closeBtn = h('button.btn.sm.icon.ghost', { type: 'button', title: 'Close (Esc)', 'aria-label': 'Close' }, icon('x', 14));
  const maxBtn = h('button.btn.sm.icon.ghost', { type: 'button' });
  const bar = h('header.fwin-bar', titleEl, h('span.spacer'), maxBtn, closeBtn);
  const win = h('section.fwin', { role: 'dialog', 'aria-modal': 'false', tabindex: '-1' },
    bar, content, EDGES.map((e) => h(`div.fwin-edge.is-${e}`, { 'data-edge': e, 'aria-hidden': 'true' })));

  const place = () => {
    win.classList.toggle('is-max', maximised);
    replaceIcon();
    if (maximised) { win.style.cssText = ''; return; }
    Object.assign(win.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  };
  const replaceIcon = () => {
    maxBtn.replaceChildren(icon(maximised ? 'minimize' : 'maximize', 13));
    maxBtn.title = maximised ? 'Restore size' : 'Maximise';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  };
  const save = () => prefs.set(prefKey, { rect, maximised });

  // move: drag the title bar
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || maximised) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ...rect };
    bar.setPointerCapture(e.pointerId);
    win.classList.add('is-dragging');
    const move = (ev) => { rect = clamp({ ...rect, left: start.left + ev.clientX - start.x, top: start.top + ev.clientY - start.y }); place(); };
    const up = () => { bar.removeEventListener('pointermove', move); win.classList.remove('is-dragging'); save(); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up, { once: true });
    bar.addEventListener('pointercancel', up, { once: true });
  });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMax(); });

  // resize: drag an edge or a corner
  win.addEventListener('pointerdown', (e) => {
    const edge = e.target.dataset?.edge;
    if (!edge || e.button !== 0 || maximised) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ...rect };
    e.target.setPointerCapture(e.pointerId);
    win.classList.add('is-dragging');
    const handle = e.target;
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const r = { ...start };
      if (edge.includes('e')) r.width = Math.max(MIN_W, start.width + dx);
      if (edge.includes('s')) r.height = Math.max(MIN_H, start.height + dy);
      if (edge.includes('w')) { r.width = Math.max(MIN_W, start.width - dx); r.left = start.left + start.width - r.width; }
      if (edge.includes('n')) { r.height = Math.max(MIN_H, start.height - dy); r.top = start.top + start.height - r.height; }
      rect = clamp(r);
      place();
    };
    const up = () => { handle.removeEventListener('pointermove', move); win.classList.remove('is-dragging'); save(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });

  // full screen and back: the window grows from where it is to the new size (and back)
  const toggleMax = () => {
    const from = win.getBoundingClientRect();
    maximised = !maximised;
    place();
    save();
    if (reduced()) return;
    const to = win.getBoundingClientRect();
    const box = (r) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    win.getAnimations().forEach((a) => a.cancel());
    win.animate([box(from), box(to)], { duration: SIZE_MS, easing: EASE });
  };
  maxBtn.addEventListener('click', toggleMax);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    open.delete(key);
    win.classList.add('is-closing');
    const done = () => win.remove();
    if (reduced()) done();
    else win.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(0.98)' }], { duration: CLOSE_MS, easing: EASE_OUT, fill: 'forwards' }).finished.then(done, done);
    removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  closeBtn.addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape' && win.contains(document.activeElement)) close(); };
  const onResize = () => { rect = clamp(rect); place(); };
  addEventListener('resize', onResize);
  document.addEventListener('keydown', onKey);
  // the opening motion plays once: a class, not a rule on .fwin, so nothing can restart it
  win.classList.add('is-opening');
  win.addEventListener('animationend', () => win.classList.remove('is-opening'), { once: true });

  const api = {
    el: win,
    set({ title: t, body: b } = {}) {
      if (t !== undefined) titleEl.replaceChildren(...[t].flat(Infinity).filter(Boolean));
      if (b !== undefined) content.replaceChildren(...[b].flat(Infinity).filter(Boolean));
    },
    focus() { win.focus({ preventScroll: true }); },
    close,
    get body() { return content; },
  };
  api.set({ title, body });
  place();
  document.body.append(win);
  open.set(key, api);
  api.focus();
  return api;
}
