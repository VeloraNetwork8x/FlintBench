import { h, replace } from '../../lib/dom.js';
import { api, projectUrl } from '../../lib/api.js';
import { ago, when, plural } from '../../lib/format.js';
import { fileBadge } from '../../lib/file-icons.js';
import { onServerEvent } from '../../lib/ws.js';
import { floatWindow } from '../../lib/float-window.js';
import { contextMenu, copyText } from '../../lib/menu.js';
import { editorItems } from '../../lib/editor-menu.js';
import { toast } from '../../lib/ui.js';
import { showInFiles } from './files.js';

/**
 * Files changed (profile Test): the files touched in the last 7 days, most recent first, with the
 * lines added and removed — live: a saved file shows up within a second. FlintBench's own file
 * history makes this work without git; with git, what is not committed and the commits of the
 * window are added. A click opens the file's changes in a floating window that can be moved and
 * resized; it follows the file while it keeps changing.
 * The element is kept across the overview's redraws.
 */

const LIMIT = 12;
const MAX_COMMITS = 5;
const DAYS = 7;

export function diffView(text) {
  const lines = (text || '(no textual changes)').split('\n').map((line) => {
    const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta'
      : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    return h(cls ? `div.${cls}` : 'div', line || ' ');
  });
  return h('pre.diff', lines);
}

const counts = (added, removed) => (added === null || added === undefined
  ? h('span.fc-lines.faint', { title: 'Lines not known for this change' }, '—')
  : h('span.fc-lines', h('span.ln-add', `+${added}`), h('span.ln-del', `−${removed}`)));

/** What the row says about the file: git's state first, else how FlintBench saw it change. */
function stateOf(f) {
  if (f.uncommitted) return [f.uncommitted.untracked ? 'new, not committed' : 'not committed', '.is-open'];
  if (f.commits?.length) return [plural(f.commits.length, 'commit'), ''];
  if (f.earlier) return ['before tracking', '.is-faint'];
  return [{ new: 'new', deleted: 'deleted', binary: 'binary', edited: f.saves > 1 ? `${f.saves} saves` : 'edited' }[f.status] ?? 'edited', f.status === 'deleted' ? '.is-del' : ''];
}

const rowKey = (f) => JSON.stringify([f.path, f.at, f.added, f.removed, f.saves, f.uncommitted, (f.commits ?? []).map((c) => c.sha)]);

// each project's last list: switching back draws it at once, then it is read again
const lastLists = new Map(); // projectId -> file-changes data

export function createFileChanges(ctx) {
  const list = h('ul.fc-list', { 'aria-label': 'Files changed' });
  const more = h('button.btn.sm.ghost.fc-more', { type: 'button', hidden: true });
  const foot = h('p.ov-foot');
  const el = h('div.fc', list, more, foot);
  const meta = h('span.faint.small');
  let data = lastLists.get(ctx.projectId) ?? null;
  let failed = false;
  let all = false;
  let win = null; // the floating diff window, while open
  let winPath = null;
  let winKey = null;
  let winText = null; // what the window shows, to skip identical refreshes
  let seq = 0;
  let liveTimer = 0;

  more.addEventListener('click', () => { all = !all; draw(); });

  // live: a change kept in the file history reloads the list (and the open window if it is that file)
  const off = onServerEvent((msg) => {
    if (msg.t !== 'event' || msg.e?.projectId !== ctx.projectId) return;
    if (msg.e.type !== 'file.recorded' && msg.e.type !== 'git.commit_created') return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(load, 300);
  });

  function sectionsOf(f) {
    const parts = [];
    if (f.saves) parts.push({ title: `Changes seen by FlintBench · last ${DAYS} days`, q: 'kind=history', added: f.uncommitted || f.commits?.length ? null : f.added, removed: f.removed });
    if (f.uncommitted) parts.push({ title: f.uncommitted.untracked ? 'New file, not committed' : 'Not committed (against the last commit)', q: 'kind=working', added: f.uncommitted.added, removed: f.uncommitted.removed });
    for (const c of (f.commits ?? []).slice(0, MAX_COMMITS)) parts.push({ title: `${c.short} “${c.subject}”`, q: `kind=commit&sha=${c.sha}`, at: c.at, added: c.added, removed: c.removed });
    return parts;
  }

  /**
   * Opens the file's changes, or refreshes them in place (`refresh`): a live update keeps what is
   * shown, and the scroll position, until the new changes are read, and replaces nothing when
   * they are the same — the window never flashes.
   */
  async function openDiff(f, { refresh = false } = {}) {
    const mine = ++seq;
    const sameFile = winPath === f.path;
    winPath = f.path;
    winKey = rowKey(f);
    const title = [fileBadge(f.path), h('code.fwin-path', f.path), counts(f.added, f.removed), h('span.faint.small', { title: when(f.at) }, ago(f.at))];
    const parts = sectionsOf(f);
    if (!win) {
      win = floatWindow({ key: 'file-diff', title, body: h('p.fc-loading.faint', 'Reading changes…'), onClose: () => { win = null; winPath = null; winText = null; draw(); } });
      draw();
    } else if (!(refresh && sameFile)) {
      win.set({ title, body: h('p.fc-loading.faint', 'Reading changes…') });
      winText = null;
      draw();
    }
    if (!parts.length) {
      win.set({ body: h('p.fc-loading.faint', f.earlier
        ? 'This file changed before FlintBench kept versions of it: there is no line-by-line record of that change. Its next changes will be shown here.'
        : 'No changes to show.') });
      return;
    }
    const diffs = await Promise.all(parts.map((p) => api.get(projectUrl(ctx.projectId, `/file-changes/diff?path=${encodeURIComponent(f.path)}&${p.q}&days=${DAYS}`))
      .then((r) => r.diff, (e) => `error: ${e.message}`)));
    if (mine !== seq || !win) return;
    const text = JSON.stringify([parts.map((p) => [p.title, p.added, p.removed]), diffs]);
    win.set({ title });
    if (text === winText) return;
    winText = text;
    const scroll = win.body.scrollTop;
    win.set({
      body: [parts.map((p, i) => h('section.fc-part',
        h('header.fc-part-head', h('span.ellipsis', p.title), h('span.spacer'), p.added !== null && p.added !== undefined ? counts(p.added, p.removed) : null, p.at ? h('span.faint.small', { title: when(p.at) }, ago(p.at)) : null),
        diffView(diffs[i]))),
      (f.commits?.length ?? 0) > MAX_COMMITS ? h('p.ov-foot', `${f.commits.length - MAX_COMMITS} older commits not shown`) : null],
    });
    if (refresh && sameFile) win.body.scrollTop = scroll;
  }

  function row(f) {
    const name = f.path.split('/').pop();
    const dir = f.path.slice(0, -name.length);
    const [state, tone] = stateOf(f);
    const isOpen = winPath === f.path;
    const gone = f.status === 'deleted';
    const btn = h('button.fc-row', {
      type: 'button', 'aria-haspopup': 'dialog', title: `${f.path} — show what changed`,
      onclick: () => openDiff(f),
    },
    fileBadge(f.path),
    h('span.fc-path', h('span.fc-dir', dir), h('span.fc-name', name)),
    h(`span.fc-state${tone}`, state),
    counts(f.added, f.removed),
    h('span.fc-ago', { title: when(f.at) }, ago(f.at)));
    contextMenu(btn, () => [
      { label: 'Show changes', icon: 'file', run: () => openDiff(f) },
      { label: 'Show in Files', icon: 'folder', disabled: gone, run: () => showInFiles(ctx, f.path) },
      ...editorItems(ctx.projectId, { path: f.path, disabled: gone }),
      '-',
      { label: 'Show in File Explorer', icon: 'folder', disabled: gone, run: () => api.post(projectUrl(ctx.projectId, '/reveal'), { path: f.path }).catch((e) => toast(e.message, { kind: 'err' })) },
      { label: 'Copy relative path', icon: 'file', run: () => copyText(f.path, toast) },
    ], { label: `${name} actions` });
    return h(`li${isOpen ? '.is-open' : ''}`, btn);
  }

  function draw() {
    if (!data) {
      replace(list, h('li.ov-empty', failed ? 'Could not read the changes.' : 'Reading changes…'));
      return;
    }
    if (!data.files.length) {
      replace(list, h('li.ov-empty', `No files changed in the last ${DAYS} days.`));
      more.hidden = true;
    } else {
      const shown = all ? data.files : data.files.slice(0, LIMIT);
      replace(list, shown.map(row));
      more.hidden = data.files.length <= LIMIT;
      more.textContent = all ? 'Show less' : `Show ${data.files.length - LIMIT} more`;
    }
    const notes = [];
    if (data.trackedSince && data.trackedSince > data.since) notes.push(`Line-by-line record since ${when(data.trackedSince).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}${data.git ? '' : ' (no git: FlintBench keeps the versions itself)'}.`);
    if (data.total > data.files.length) notes.push(`${data.total - data.files.length} more files not listed.`);
    foot.hidden = !notes.length;
    foot.textContent = notes.join(' ');
  }

  async function load() {
    const r = await api.get(projectUrl(ctx.projectId, `/file-changes?days=${DAYS}`)).catch(() => null);
    if (!r) { failed = !data; draw(); return; }
    data = r;
    lastLists.set(ctx.projectId, r);
    failed = false;
    meta.replaceChildren(...(data.files.length ? [counts(data.added, data.removed), ` · ${plural(data.total, 'file')} · ${DAYS} days`] : []));
    draw();
    // the open window follows its file while it changes
    const f = winPath && data.files.find((x) => x.path === winPath);
    if (win && f && rowKey(f) !== winKey) openDiff(f, { refresh: true });
  }

  draw();
  return {
    el,
    meta,
    load,
    destroy() {
      off?.();
      clearTimeout(liveTimer);
      win?.close();
    },
  };
}
