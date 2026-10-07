import { h, icon } from '../../lib/dom.js';
import { selectField } from '../../lib/select-menu.js';
import { api, projectUrl } from '../../lib/api.js';
import { dialog } from '../../lib/ui.js';
import { plural } from '../../lib/format.js';
import { fileBadge, folderIcon } from '../../lib/file-icons.js';

export const IGNORE_TEMPLATES = [
  { value: 'node', text: 'Node.js' },
  { value: 'python', text: 'Python' },
  { value: 'basic', text: 'Basic (.env, logs, OS files)' },
  { value: '', text: 'Nothing' },
];

/** The line the server writes for one chosen path (anchored, pattern characters escaped). */
const ignoreLine = ({ path, dir }) => `/${path.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ ')}${dir ? '/' : ''}`;

/**
 * A custom .gitignore: the project's file tree with a checkbox per file and folder (a ticked
 * folder covers everything in it), on top of an optional starter template.
 * Resolves to { base, paths: [{ path, dir }] }, or null when cancelled.
 */
export function chooseIgnored(projectId, { base = 'node', paths = [] } = {}) {
  return dialog((done) => {
    const chosen = new Map(paths.map((p) => [p.path, p]));
    const open = new Set();
    const cache = new Map();
    const start = selectField({ label: 'Start from', value: base, options: IGNORE_TEMPLATES, size: 'sm' });
    const tree = h('ul.ig-tree', { role: 'tree', 'aria-label': 'Project files' });
    const count = h('span.ig-count');
    const preview = h('pre.ig-preview');

    const loadDir = async (dir) => {
      if (!cache.has(dir)) {
        const r = await api.get(projectUrl(projectId, `/files?path=${encodeURIComponent(dir)}`)).catch((e) => ({ error: e.message, entries: [] }));
        cache.set(dir, { ...r, entries: (r.entries ?? []).filter((e) => e.name !== '.git') });
      }
      return cache.get(dir);
    };
    const coveredBy = (path) => [...chosen.keys()].find((c) => chosen.get(c).dir && path.startsWith(`${c}/`));

    function pick(entry, on) {
      const dir = entry.type === 'dir';
      if (on) {
        chosen.set(entry.path, { path: entry.path, dir });
        // a ticked folder already covers what was ticked inside it
        if (dir) for (const c of [...chosen.keys()]) if (c.startsWith(`${entry.path}/`)) chosen.delete(c);
      } else {
        chosen.delete(entry.path);
      }
      draw();
    }

    function row(entry, depth) {
      const dir = entry.type === 'dir';
      const covered = coveredBy(entry.path);
      const box = h('input', {
        type: 'checkbox',
        checked: chosen.has(entry.path) || Boolean(covered),
        disabled: Boolean(covered),
        'aria-label': `Ignore ${entry.path}`,
        onchange: (e) => pick(entry, e.target.checked),
      });
      const expanded = open.has(entry.path);
      return h(`li.ig-row${entry.heavy ? '.is-heavy' : ''}${covered ? '.is-covered' : ''}`, { role: 'treeitem', 'aria-expanded': dir ? String(expanded) : undefined, style: { paddingLeft: `${6 + depth * 16}px` }, title: covered ? `Covered by ${covered}/` : entry.path },
        dir
          ? h('button.ig-chev', { type: 'button', class: expanded ? 'is-open' : '', 'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${entry.name}`, onclick: () => { if (expanded) open.delete(entry.path); else open.add(entry.path); draw(); } }, icon('chevron', 11))
          : h('span.ig-chev'),
        h('label.ig-label', box, dir ? folderIcon(entry.name, expanded) : fileBadge(entry.name), h('span.ellipsis', entry.name)));
    }

    let drawing = 0;
    async function draw() {
      const ticket = ++drawing;
      const items = [];
      const walk = async (dir, depth) => {
        const listing = await loadDir(dir);
        if (listing.error) items.push(h('li.ig-note', { style: { paddingLeft: `${6 + depth * 16}px` } }, listing.error));
        for (const entry of listing.entries) {
          items.push(row(entry, depth));
          if (entry.type === 'dir' && open.has(entry.path)) await walk(entry.path, depth + 1);
        }
        if (listing.truncated) items.push(h('li.ig-note', { style: { paddingLeft: `${6 + depth * 16}px` } }, 'Only the first 3000 entries are listed.'));
      };
      await walk('', 0);
      if (ticket !== drawing) return;
      const focused = document.activeElement?.getAttribute('aria-label');
      tree.replaceChildren(...items);
      if (focused) [...tree.querySelectorAll('[aria-label]')].find((n) => n.getAttribute('aria-label') === focused)?.focus();
      const list = [...chosen.values()].sort((a, b) => a.path.localeCompare(b.path));
      count.textContent = list.length ? `${plural(list.length, 'item')} chosen` : 'Nothing chosen yet';
      const template = IGNORE_TEMPLATES.find((t) => t.value === start.value && t.value);
      preview.textContent = [template ? `# ${template.text} template` : null, ...list.map(ignoreLine)].filter(Boolean).join('\n') || '# empty';
    }
    start.addEventListener('change', draw);
    draw();

    return h('form.ig', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); done({ base: start.value, paths: [...chosen.values()].sort((x, y) => x.path.localeCompare(y.path)) }); } },
      h('h2', 'Choose what to ignore'),
      h('p.dim', 'Ticked files and folders stay out of the repository. A ticked folder covers everything in it.'),
      h('label.field.ig-start', h('span', 'Start from'), start),
      h('div.ig-scroll', tree),
      h('details.ig-details', h('summary', 'Preview .gitignore'), preview),
      h('div.actions', count, h('span.spacer'),
        h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button.btn.primary', { type: 'submit' }, 'Use these')));
  }, { cls: 'is-ignore' });
}
