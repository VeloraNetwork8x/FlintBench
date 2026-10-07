// Tiny hyperscript. All text goes through text nodes: no innerHTML with data.

export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && !key.includes('-') && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2.5h7.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  agent: 'M12 3v3M12 18v3M3 12h3M18 12h3M7.8 7.8 6 6M18 18l-1.8-1.8M16.2 7.8 18 6M6 18l1.8-1.8M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  terminal: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  branch: 'M7 4v16M7 8a3 3 0 1 0 0-.01M17 6a2.5 2.5 0 1 0 0 .01M17 8.5c0 5-10 3-10 8',
  play: 'M8 5.5v13l10-6.5z',
  stop: 'M7 7h10v10H7z',
  restart: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  box: 'M12 3 20 7.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  check: 'M5 12.5 10 17 19 7',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  panel: 'M4 5h16v14H4zM15 5v14',
  dock: 'M4 5h16v14H4zM4 14h16',
  refresh: 'M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5',
  resume: 'M5 12a7 7 0 1 0 2-4.9M5 4v4h4M12 8.5V12l2.5 2',
  overview: 'M4 5h7v6H4zM13 5h7v3h-7zM13 10h7v9h-7zM4 13h7v6H4z',
  workspace: 'M4 5h16v14H4zM9 5v14M9 13h11',
  context: 'M5 4h10l4 4v12H5zM8.5 11h7M8.5 14.5h7M8.5 18h4',
  work: 'M5 6h14M5 12h14M5 18h9M3 6h.01M3 12h.01M3 18h.01',
  editor: 'M8 7 3 12l5 5M16 7l5 5-5 5M13.5 4l-3 16',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  minimize: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  'st-ok': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.2 12.3l2.6 2.6 5-5.4',
  'st-err': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6',
  'st-warn': 'M10.3 4.2 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0zM12 9.5v4.2M12 17v.1',
  'st-info': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5.3M12 7.9v.1',
  timer: 'M12 5.5a7.75 7.75 0 1 0 0 15.5 7.75 7.75 0 0 0 0-15.5zM12 9.5v3.9l2.6 1.6M9.5 2.5h5M12 2.5v3M18.6 6.4l1.4-1.4',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14',
  pencil: 'M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16zM13.5 6.5l4 4',
  // GitHub's mark as a line icon (Lucide "github", ISC), for the rail
  github: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2',
  commit: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM3 12h5.5M15.5 12H21',
  graph: 'M6 5.5a2 2 0 1 0 0 .01M18 5.5a2 2 0 1 0 0 .01M12 18.5a2 2 0 1 0 0 .01M8 6.5h8M7 7.5l4 9M17 7.5l-4 9',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'dots' ? '3' : '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.dots);
  if (name === 'play') path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

/**
 * The FlintBench logo (the bench with its flint and spark, app/web/brand). It fills the .brand-mark
 * tile it sits in; `size` is only its intrinsic size before CSS. Decorative: the name is next to it.
 */
export function brandMark(size = 30) {
  return h('img.brand-logo', { src: '/brand/logo-128.webp', width: size, height: size, alt: '', decoding: 'async', draggable: false });
}

/** Button that shows a busy state while its async handler runs. */
export function actionButton(label, handler, { cls = 'btn', iconName, title, disabled } = {}) {
  const btn = h(`button.${cls.split(' ').join('.')}`, { type: 'button', title, disabled, 'aria-label': title && !label ? title : undefined });
  if (iconName) btn.append(icon(iconName, 14));
  if (label) btn.append(label);
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    btn.setAttribute('aria-busy', 'true');
    try {
      await handler(event);
    } finally {
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
    }
  });
  return btn;
}
