import { h, replace, actionButton } from '../../lib/dom.js';
import { selectField } from '../../lib/select-menu.js';
import { api, projectUrl } from '../../lib/api.js';
import { when } from '../../lib/format.js';
import { attempt, confirmDialog } from '../../lib/ui.js';

export const STATUSES = [
  ['in_progress', 'In progress'],
  ['planned', 'Planned'],
  ['blocked', 'Blocked'],
  ['completed', 'Completed'],
];
const CHIP = { in_progress: 'accent', planned: '', blocked: 'warn', completed: 'ok' };

export function render(ctx) {
  const listBox = h('div');
  const title = h('input.input', { placeholder: 'What are you working on?', 'aria-label': 'Work item title', maxLength: 160 });
  const status = selectField({ label: 'Status', width: '150px', value: 'planned', options: STATUSES.map(([value, text]) => ({ value, text })) });
  const form = h('form.row', title, status, h('button.btn.primary', { type: 'submit' }, 'Add'));
  const el = h('div.p-center-inner',
    h('div.section-title', h('span.label', 'Current work'), h('span.faint', { style: { fontSize: '12px' } }, 'stored in FlintBench, never in the repository')),
    h('div.panel.panel-body', { style: { marginBottom: '14px' } }, form),
    listBox);
  let items = [];

  async function load() {
    items = await api.get(projectUrl(ctx.projectId, '/work')).catch(() => []);
    draw();
  }

  async function patch(item, body) {
    const r = await attempt(() => api.patch(projectUrl(ctx.projectId, `/work/${item.id}`), body), { failure: 'Could not update' });
    if (r) {
      Object.assign(item, r);
      draw();
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    const r = await attempt(() => api.post(projectUrl(ctx.projectId, '/work'), { title: title.value, status: status.value }), { failure: 'Could not add' });
    if (r) {
      title.value = '';
      items.unshift(r);
      draw();
    }
  });

  function itemRow(item) {
    const sel = selectField({ label: `Status of ${item.title}`, size: 'sm', width: '150px', value: item.status, options: STATUSES.map(([value, text]) => ({ value, text })) });
    sel.addEventListener('change', () => patch(item, { status: sel.value }));
    const notes = h('textarea.textarea', { rows: 3, value: item.notes ?? '', placeholder: 'Notes', 'aria-label': 'Notes' });
    notes.addEventListener('change', () => patch(item, { notes: notes.value }));
    return h(`li.work-item${item.status === 'completed' ? '.done' : ''}`, { style: { boxShadow: item.status === 'in_progress' ? 'inset 2px 0 0 var(--accent)' : item.status === 'blocked' ? 'inset 2px 0 0 var(--warn)' : '' } },
      h('div', { style: { minWidth: 0 } },
        h('div.row', h('span.title.ellipsis', item.title), h(`span.chip${CHIP[item.status] ? `.${CHIP[item.status]}` : ''}`, STATUSES.find(([v]) => v === item.status)[1])),
        h('div.faint', { style: { fontSize: '11px', marginTop: '2px' } },
          item.branch ? h('span.mono', item.branch) : 'no branch',
          ` · created ${when(item.createdAt)}`,
          item.completedAt ? ` · completed ${when(item.completedAt)}` : '')),
      h('div.row', sel, actionButton('', async () => {
        if (await confirmDialog({ title: 'Delete work item?', body: item.title, confirm: 'Delete', danger: true })) {
          await attempt(() => api.del(projectUrl(ctx.projectId, `/work/${item.id}`)));
          items = items.filter((i) => i.id !== item.id);
          draw();
        }
      }, { cls: 'btn sm icon ghost', iconName: 'trash', title: 'Delete' })),
      h('details', { open: Boolean(item.notes) && item.status !== 'completed' }, h('summary', item.notes ? 'Notes' : 'Add notes'), h('div', { style: { marginTop: '6px' } }, notes)));
  }

  function draw() {
    if (!items.length) {
      replace(listBox, h('div.empty-state', h('h3', 'No work items'), h('p', 'Track what you are building in this project: a ticket, a feature, a fix. Lightweight, local, not Jira.')));
      return;
    }
    const order = Object.fromEntries(STATUSES.map(([v], i) => [v, i]));
    const sorted = [...items].sort((a, b) => order[a.status] - order[b.status] || b.updatedAt - a.updatedAt);
    replace(listBox, h('div.panel', h('ul.list', sorted.map(itemRow))));
  }

  load();
  return { el };
}
