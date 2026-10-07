import { h, icon, replace } from '../../lib/dom.js';
import { api, projectUrl } from '../../lib/api.js';
import { ago, bytes } from '../../lib/format.js';
import { renderMarkdown } from '../../lib/ui.js';

const GROUP_LABEL = { 'agent-and-readme': 'Agent & readme', root: 'Root', docs: 'docs/', doc: 'doc/', '.claude': '.claude/' };

export function render(ctx) {
  const list = h('nav.panel.ctx-list', { 'aria-label': 'Context files' });
  const viewer = h('div.panel', { style: { minHeight: '320px' } });
  const el = h('div.p-center-inner',
    h('div.section-title', h('span.label', 'Project context'), h('span.faint', { style: { fontSize: '12px' } }, 'read-only · files stay in the repository')),
    h('div.ctx', list, viewer));
  let files = [];
  let active = null;

  async function open(file) {
    active = file.path;
    drawList();
    replace(viewer, h('div.panel-empty', 'Loading…'));
    try {
      const r = await api.get(projectUrl(ctx.projectId, `/context/file?path=${encodeURIComponent(file.path)}`));
      const isMd = /\.(md|mdx|markdown)$/i.test(file.path);
      replace(viewer,
        h('div.panel-head', icon('file', 13), h('code.ellipsis', file.path), h('span.spacer'), h('span.faint', { style: { fontSize: '11px' } }, `${bytes(r.size)} · ${ago(r.modifiedAt)}${r.truncated ? ' · truncated' : ''}`)),
        isMd ? renderMarkdown(r.content) : h('pre.diff', { style: { maxHeight: 'none', borderTop: 0 } }, r.content));
    } catch (error) {
      replace(viewer, h('div.panel-empty.error-text', error.message));
    }
  }

  function drawList() {
    if (!files.length) {
      replace(list, h('div.panel-empty', 'No CLAUDE.md, AGENTS.md, README or docs/ found.'));
      return;
    }
    const groups = new Map();
    for (const f of files) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    replace(list, [...groups].map(([group, items]) => [
      h('div.group.label', GROUP_LABEL[group] ?? `${group}/`),
      items.map((f) => h('button', { type: 'button', 'aria-current': String(active === f.path), title: f.path, onclick: () => open(f) }, icon('file', 12), h('span.ellipsis', f.group === 'agent-and-readme' || f.group === 'root' ? f.path : f.path.split('/').slice(1).join('/')))),
    ]));
  }

  (async () => {
    files = await api.get(projectUrl(ctx.projectId, '/context')).catch(() => []);
    drawList();
    const first = files.find((f) => /^(CLAUDE|AGENTS)\.md$/i.test(f.path)) ?? files.find((f) => /^readme/i.test(f.path)) ?? files[0];
    if (first) open(first);
    else replace(viewer, h('div.panel-empty', 'Nothing to show.'));
  })();

  return { el };
}
