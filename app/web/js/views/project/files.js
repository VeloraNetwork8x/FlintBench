import { h, icon, replace } from '../../lib/dom.js';
import { api, projectUrl } from '../../lib/api.js';
import { ago, bytes } from '../../lib/format.js';
import { renderMarkdown, toast } from '../../lib/ui.js';
import { contextMenu, copyText } from '../../lib/menu.js';
import { editorItems } from '../../lib/editor-menu.js';
import { fileBadge, folderIcon } from '../../lib/file-icons.js';
import { highlight } from '../../lib/highlight.js';

const MD = /\.(md|mdx|markdown)$/i;

// a file to select when the Files tab opens next (Show in Files, from elsewhere in the project)
const pendingReveal = new Map(); // projectId -> path
export function showInFiles(ctx, filePath) {
  pendingReveal.set(ctx.projectId, filePath);
  ctx.go('files');
}


/**
 * The whole project folder, read-only: a lazily loaded tree on the left, the selected file on
 * the right. Generated folders (node_modules, .git, build output…) are listed but dimmed.
 */
export function render(ctx) {
  const tree = h('ul.ft-tree', { role: 'tree', 'aria-label': 'Project files' });
  const filter = h('input.input', { type: 'search', placeholder: 'Filter loaded files', 'aria-label': 'Filter files', spellcheck: false });
  const viewer = h('section.ft-viewer', { 'aria-live': 'polite' });
  const el = h('div.ft',
    h('aside.ft-side', h('div.ft-filter', icon('search', 13), filter), h('div.ft-scroll', tree)),
    viewer);
  const open = new Set(['']); // expanded folders
  const cache = new Map(); // folder path -> entries
  let selected = null;
  let showRaw = false;

  async function loadDir(dirPath) {
    if (cache.has(dirPath)) return cache.get(dirPath);
    const r = await api.get(projectUrl(ctx.projectId, `/files?path=${encodeURIComponent(dirPath)}`)).catch((e) => ({ error: e.message, entries: [] }));
    cache.set(dirPath, r);
    return r;
  }

  function row(entry, depth) {
    const isDir = entry.type === 'dir';
    const expanded = isDir && open.has(entry.path);
    const btn = h(`button.ft-row${entry.heavy ? '.is-heavy' : ''}${selected === entry.path ? '.is-selected' : ''}`, {
      type: 'button',
      role: 'treeitem',
      'aria-expanded': isDir ? String(expanded) : undefined,
      'aria-selected': String(selected === entry.path),
      style: { paddingLeft: `${8 + depth * 14}px` },
      title: entry.path,
      onclick: () => (isDir ? toggle(entry.path) : openFile(entry)),
      onkeydown: (e) => keyNav(e, entry),
      dataset: { path: entry.path },
    },
    isDir ? h('span.ft-chev', { class: expanded ? 'is-open' : '' }, icon('chevron', 11)) : h('span.ft-chev'),
    isDir ? folderIcon(entry.name, expanded) : fileBadge(entry.name),
    h('span.ellipsis', entry.name),
    !isDir && entry.size !== null ? h('span.ft-size', bytes(entry.size)) : null);
    contextMenu(btn, () => {
      const full = `${ctx.project()?.path ?? ''}\\${entry.path.replaceAll('/', '\\')}`;
      return [
        isDir
          ? { label: open.has(entry.path) ? 'Collapse' : 'Expand', icon: 'chevron', run: () => toggle(entry.path) }
          : { label: 'Open', icon: 'file', run: () => openFile(entry) },
        ...(isDir ? [] : editorItems(ctx.projectId, { path: entry.path })),
        '-',
        { label: isDir ? 'Open in File Explorer' : 'Show in File Explorer', icon: 'folder', run: () => api.post(projectUrl(ctx.projectId, '/reveal'), { path: entry.path }).catch((e) => toast(e.message, { kind: 'err' })) },
        '-',
        { label: 'Copy relative path', icon: 'file', run: () => copyText(entry.path, toast) },
        { label: 'Copy full path', icon: 'folder', run: () => copyText(full, toast) },
      ];
    }, { label: `${entry.name} actions` });
    return btn;
  }

  async function drawTree() {
    const q = filter.value.trim().toLowerCase();
    const items = [];
    const walk = async (dirPath, depth) => {
      const listing = await loadDir(dirPath);
      if (listing.error) {
        items.push(h('li.ft-note', { style: { paddingLeft: `${8 + depth * 14}px` } }, listing.error));
        return;
      }
      for (const entry of listing.entries) {
        const match = !q || entry.name.toLowerCase().includes(q);
        if (entry.type === 'dir') {
          if (q) {
            // while filtering, search inside the folders already opened
            const before = items.length;
            if (open.has(entry.path)) await walk(entry.path, depth + 1);
            if (match || items.length > before) items.splice(before, 0, h('li', row(entry, depth)));
          } else {
            items.push(h('li', row(entry, depth)));
            if (open.has(entry.path)) await walk(entry.path, depth + 1);
          }
        } else if (match) {
          items.push(h('li', row(entry, depth)));
        }
      }
      if (listing.truncated) items.push(h('li.ft-note', { style: { paddingLeft: `${8 + depth * 14}px` } }, 'Only the first 3000 entries are listed.'));
    };
    await walk('', 0);
    const focused = document.activeElement?.dataset?.path;
    replace(tree, items.length ? items : h('li.ft-note', q ? 'No loaded file matches.' : 'Empty folder.'));
    if (focused) tree.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
  }

  /** Rows inside a folder (any depth), as their <li>. */
  const inside = (dirPath) => [...tree.querySelectorAll('.ft-row')].filter((r) => r.dataset.path?.startsWith(`${dirPath}/`)).map((r) => r.closest('li'));

  /** Folders open and close with motion: children fade in one after another, or fold away first. */
  async function toggle(dirPath) {
    const rowEl = tree.querySelector(`.ft-row[data-path="${CSS.escape(dirPath)}"]`);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (open.has(dirPath)) {
      rowEl?.querySelector('.ft-chev')?.classList.remove('is-open');
      const leaving = inside(dirPath);
      leaving.forEach((li) => li.classList.add('ft-leave'));
      if (leaving.length && !reduced) await new Promise((r) => setTimeout(r, 140));
      open.delete(dirPath);
      await drawTree();
      return;
    }
    rowEl?.querySelector('.ft-chev')?.classList.add('is-open');
    open.add(dirPath);
    await drawTree();
    inside(dirPath).forEach((li, i) => { li.style.setProperty('--i', String(Math.min(i, 14))); li.classList.add('ft-enter'); });
  }

  function keyNav(e, entry) {
    const rows = [...tree.querySelectorAll('.ft-row')];
    const i = rows.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[i + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[i - 1]?.focus(); }
    else if (e.key === 'ArrowRight' && entry.type === 'dir' && !open.has(entry.path)) { e.preventDefault(); toggle(entry.path); }
    else if (e.key === 'ArrowLeft' && entry.type === 'dir' && open.has(entry.path)) { e.preventDefault(); toggle(entry.path); }
  }

  function crumbs(filePath) {
    const parts = filePath.split('/');
    return h('nav.ft-crumbs', { 'aria-label': 'Path' }, parts.map((p, i) => [i ? h('span.faint', '/') : null, h(i === parts.length - 1 ? 'strong' : 'span', p)]));
  }

  async function openFile(entry) {
    selected = entry.path;
    showRaw = false;
    tree.querySelectorAll('.ft-row.is-selected').forEach((b) => { b.classList.remove('is-selected'); b.setAttribute('aria-selected', 'false'); });
    const btn = tree.querySelector(`[data-path="${CSS.escape(entry.path)}"]`);
    btn?.classList.add('is-selected');
    btn?.setAttribute('aria-selected', 'true');
    replace(viewer, h('p.ov-empty', 'Opening…'));
    let file;
    try {
      file = await api.get(projectUrl(ctx.projectId, `/files/content?path=${encodeURIComponent(entry.path)}`));
    } catch (error) {
      replace(viewer, h('div.ft-head', crumbs(entry.path)), h('p.ov-empty', error.status === 415 ? 'Binary file: not shown.' : error.message));
      return;
    }
    if (selected !== entry.path) return;
    drawFile(file);
  }

  function drawFile(file) {
    const isMd = MD.test(file.path);
    const toggleBtn = isMd ? h('button.btn.sm', { type: 'button', onclick: () => { showRaw = !showRaw; drawFile(file); } }, showRaw ? 'Formatted' : 'Raw text') : null;
    let body;
    if (isMd && !showRaw) {
      body = h('div.ft-md', renderMarkdown(file.content));
    } else {
      // coloured like the editor (VS Code Dark+ / Light+)
      const lines = highlight(file.content, file.path);
      body = h('div.ft-code', h('pre', lines.map((tokens, i) => h('div.ft-line', h('span.ft-ln', String(i + 1)),
        h('span.ft-src', tokens.length ? tokens.map(([text, cls]) => (cls ? h('span', { class: cls }, text) : text)) : ' ')))));
    }
    replace(viewer,
      h('div.ft-head', fileBadge(file.path), crumbs(file.path), h('span.spacer'),
        h('span.faint.small', `${bytes(file.size)} · modified ${ago(file.modifiedAt)}${file.truncated ? ' · first 512 KB shown' : ''}`),
        toggleBtn),
      body);
  }

  let filterTimer = 0;
  filter.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(drawTree, 150);
  });

  replace(viewer, h('div.ft-empty', icon('file', 22), h('p', 'Select a file to read it here.'), h('p.faint.small', 'Read-only. Folders load when you open them.')));
  // arriving from "Show in Files": open the folders down to the file, then the file
  const reveal = pendingReveal.get(ctx.projectId);
  pendingReveal.delete(ctx.projectId);
  if (reveal) {
    const parts = reveal.split('/');
    for (let i = 1; i < parts.length; i += 1) open.add(parts.slice(0, i).join('/'));
    drawTree().then(() => {
      tree.querySelector(`[data-path="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: 'center' });
      openFile({ path: reveal, name: parts.at(-1), type: 'file' });
    });
  } else drawTree();
  return {
    el,
    destroy() { clearTimeout(filterTimer); },
  };
}
