import { h, icon, replace, actionButton } from '../lib/dom.js';
import { store, subscribe } from '../lib/store.js';
import { api, projectUrl } from '../lib/api.js';
import { projectPath } from '../lib/router.js';
import { ago, when } from '../lib/format.js';
import { attempt, confirmDialog, dialog, projectStatus, statusDot, toast } from '../lib/ui.js';
import { browseButton } from '../lib/picker.js';

export async function rescan() {
  const r = await attempt(() => api.post('/api/projects/scan'), { success: 'Scan complete', failure: 'Scan failed' });
  if (r) store.set('lastScanAt', r.lastScanAt);
}

/**
 * Forget a project: only FlintBench metadata goes, the folder on disk is never touched.
 * The dialog says exactly that in two lists (what goes, what stays) and offers to keep the folder
 * out of future scans, so it does not come straight back as "new project detected".
 */
export async function removeProject(p) {
  const ignore = h('input', { type: 'checkbox' }); // off by default: skipping the folder is a choice
  const folder = p.path.split(/[\\/]/).filter(Boolean);
  const sep = p.path.includes('\\') ? '\\' : '/';
  const answer = await dialog((done) => h('form.rm', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); done({ ignore: ignore.checked }); } },
    h('h2', 'Remove ', h('span.rm-name', p.name), ' from FlintBench?'),
    h('p.rm-lead', 'FlintBench forgets its notes, work items, agent journal and activity. ', h('strong', 'Nothing on disk changes'), ': the folder, its files and its Git history stay exactly as they are.'),
    h('div.rm-target', { title: p.path },
      icon('folder', 15),
      h('span.rm-path', h('span.rm-parent', `${p.path.startsWith('/') ? sep : ''}${folder.slice(0, -1).join(sep)}${sep}`), h('strong', folder.at(-1) ?? p.path)),
      h('span.rm-kept', 'stays on disk')),
    h('label.rm-option', ignore,
      h('span', h('span.rm-option-title', 'Skip this folder in future scans'),
        h('span.rm-option-hint', 'Otherwise the next scan offers it again as a new project.'))),
    h('div.actions',
      h('button.btn.ghost', { type: 'button', autofocus: true, onclick: () => done(null) }, 'Cancel'),
      h('button.btn.danger-solid', { type: 'submit' }, `Remove ${p.name}`))), { cls: 'is-remove' });
  if (!answer) return;
  const removed = await attempt(() => api.del(projectUrl(p.id)), { success: `${p.name} removed from FlintBench` });
  if (removed !== undefined && answer.ignore) {
    const r = await attempt(() => api.post('/api/candidates/ignore', { paths: [p.path] }), { failure: 'Could not skip the folder in scans' });
    if (r) store.set('ignored', r.ignored);
  }
}

export function mount(container) {
  const inner = h('div.view-inner');
  container.append(h('div.view', inner));
  const pathInput = h('input.input.mono', { placeholder: store.state.platform === 'win32' ? 'C:\\Dev\\my-project' : '~/Projects/my-project', 'aria-label': 'Project folder', spellcheck: false });
  const addError = h('p.field-error', { role: 'alert' });
  const addPath = async (dir) => {
    addError.textContent = '';
    try {
      const p = await api.post('/api/projects', { path: dir });
      pathInput.value = '';
      toast(`${p.name} added`, { kind: 'ok' });
    } catch (err) {
      if (err.status === 409) toast(err.message, { kind: 'warn', detail: dir });
      else addError.textContent = err.message;
    }
  };
  // the folder is chosen in the system's own dialog; typing a path stays possible
  const addForm = h('form.row.wrap', { style: { maxWidth: '760px' } },
    browseButton('Choose folder…', { kind: 'folder', title: 'Add a project to FlintBench' }, addPath, { cls: 'btn primary' }),
    h('span.faint.small', 'or'), pathInput, h('button.btn', { type: 'submit' }, icon('plus', 14), 'Add path'));
  pathInput.style.flex = '1 1 260px';
  pathInput.style.width = 'auto';
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (pathInput.value.trim()) addPath(pathInput.value.trim());
  });
  const filter = h('input.input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter projects', 'data-search': true, style: { maxWidth: '260px' } });
  const table = h('div');
  const candidatesBox = h('div');
  filter.addEventListener('input', () => render());

  replace(inner,
    h('header.page-head',
      h('div', h('h1', 'Projects'), h('p.sub', 'Projects known to FlintBench. Removing one deletes only its FlintBench metadata.')),
      h('span.spacer'),
      actionButton('Rescan', rescan, { cls: 'btn', iconName: 'refresh' })),
    h('div.panel.panel-body', { style: { marginBottom: '14px' } },
      h('div.label', { style: { marginBottom: '8px' } }, 'Add a project'),
      addForm, addError),
    candidatesBox,
    h('div.toolbar', filter),
    table);

  function render() {
    const q = filter.value.trim().toLowerCase();
    const list = [...store.state.projects.values()]
      .filter((p) => !q || `${p.name} ${p.path}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const cands = store.state.candidates;
    replace(candidatesBox, cands.length ? h('div.panel', { style: { marginBottom: '14px' } },
      h('div.panel-head', h('span.label', `Detected, not added (${cands.length})`), h('span.spacer'),
        actionButton('Add all', () => attempt(() => api.post('/api/candidates/add', { paths: cands.map((c) => c.path) }), { success: 'Projects added' }), { cls: 'btn sm' })),
      h('div.table-wrap', { style: { border: 0, borderRadius: 0 } }, h('table.table', h('tbody', cands.map((c) => h('tr',
        h('td', h('strong', c.name)),
        h('td.dim', c.stack.join(' · ')),
        h('td.faint.mono', { style: { fontSize: '11px' } }, c.path),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          actionButton('Add', () => attempt(() => api.post('/api/candidates/add', { paths: [c.path] })), { cls: 'btn sm primary' }), ' ',
          actionButton('Skip in scans', async () => {
            const r = await attempt(() => api.post('/api/candidates/ignore', { paths: [c.path] }));
            if (r) store.set('ignored', r.ignored);
          }, { cls: 'btn sm ghost', title: 'Never offer this folder again (undo in Settings › Project directories)' })))))))) : null);

    replace(table, list.length ? h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Project'), h('th', 'Stack'), h('th', 'Path'), h('th', 'Added'), h('th', 'Last activity'), h('th', ''))),
      h('tbody', list.map((p) => {
        const st = projectStatus(p);
        return h('tr',
          h('td', h('a.row', { href: projectPath(p.id) }, statusDot(st.dot, st.label), h('strong', p.name))),
          h('td.dim', (p.stack ?? []).join(' · ')),
          h('td.faint.mono', { style: { fontSize: '11px' } }, p.path),
          h('td.dim', { title: p.source === 'auto' ? 'Added automatically (Git repository)' : '' }, `${when(p.addedAt)}${p.source === 'auto' ? ' · auto' : ''}`),
          h('td.dim', ago(p.activity?.lastActivityAt)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            actionButton('', () => attempt(() => api.post(projectUrl(p.id, '/open-editor')), { success: `Opening ${p.name} in editor` }), { cls: 'btn sm icon ghost', iconName: 'editor', title: 'Open in editor' }),
            actionButton('', () => attempt(() => api.post(projectUrl(p.id, '/reveal'))), { cls: 'btn sm icon ghost', iconName: 'folder', title: 'Open in File Explorer' }),
            actionButton('Remove', () => removeProject(p), { cls: 'btn sm ghost danger', iconName: 'trash', title: 'Remove from FlintBench (the folder is not touched)' })));
      })))) : h('div.empty-state', h('h3', 'No projects yet'), h('p', 'Add a folder above, or configure project directories in Settings to discover projects automatically.')));
  }

  const unsub = subscribe(['projects', 'candidates'], render);
  render();
  return { destroy: unsub };
}
