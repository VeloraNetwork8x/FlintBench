import { agentMark } from '../lib/agent-icons.js';
import { h, icon, replace, actionButton } from '../lib/dom.js';
import { store, subscribe } from '../lib/store.js';
import { api } from '../lib/api.js';
import { navigate, projectPath } from '../lib/router.js';
import { ago, when, duration, clock } from '../lib/format.js';
import { attempt, statusDot } from '../lib/ui.js';
import { selectMenu } from '../lib/select-menu.js';

export function evidenceText(s) {
  if (s.evidence === 'pty') return 'Started by FlintBench in this project folder.';
  if (s.evidence === 'session-file') return `Detected from ${s.agentName}'s own session file for this folder (started outside FlintBench).`;
  if (s.evidence === 'process') return `Detected from the running ${s.agentName} process, whose working folder is this project (started outside FlintBench).`;
  return '';
}

export function filesText(s) {
  if (s.filesChanged === null || s.filesChanged === undefined) return s.source === 'external' && !s.filesObserved ? 'not observed' : '—';
  return `${s.filesChanged} changed while active`;
}

const DAY = 86_400_000;
function dayLabel(ts) {
  const day = new Date(ts).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return 'Today';
  if (day === today - DAY) return 'Yesterday';
  return new Date(ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Open the live conversation tab of an external session (Claude Code, Codex) in its project. */
function openConversation(s) {
  navigate(projectPath(s.projectId));
  setTimeout(() => window.dispatchEvent(new CustomEvent('flintbench:show-tab', { detail: { projectId: s.projectId, tabId: `tx:${s.id}` } })), 0);
}

const metric = (value, label, title) => h('span.ag-metric', { title }, h('strong', value), h('span', label));

/**
 * The journal as a log grouped by day: one row per session — who and where on the left, when and
 * how long in the middle, what changed around it on the right. Only real facts are shown: no
 * "unknown" task, no dot on every ended row.
 */
export function journalList(rows, { showProject = true } = {}) {
  if (!rows.length) return h('div.panel.panel-empty', 'No agent sessions recorded yet.');
  const groups = [];
  for (const s of rows) {
    const label = dayLabel(s.startedAt);
    if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
    groups.at(-1).rows.push(s);
  }
  return h('div.journal', groups.map((g) => h('section.jr-day',
    h('div.jr-day-head', h('span.label', g.label), h('span.faint.small', `${g.rows.length} session${g.rows.length > 1 ? 's' : ''}`)),
    h('ol.jr-list', g.rows.map((s) => {
      const p = store.project(s.projectId);
      const files = s.filesChanged ?? null;
      return h(`li.jr-row${s.live ? '.is-live' : ''}.is-${s.agent}`,
        h('span.jr-mark', agentMark(s.agent, 16)),
        h('div.jr-who',
          h('div.jr-line', h('strong', s.agentName), showProject ? (p ? h('a.jr-project', { href: projectPath(p.id) }, p.name) : h('span.faint', 'removed project')) : null,
            s.live ? h('span.chip.agent', statusDot('agent live', 'Active'), 'active') : null),
          s.task ? h('div.jr-task', s.task) : null),
        h('div.jr-when', { title: new Date(s.startedAt).toLocaleString() },
          h('span.mono', `${clock(s.startedAt)}${s.endedAt ? ` – ${clock(s.endedAt)}` : ''}`),
          h('span.jr-dur', s.live ? `${duration(Date.now() - s.startedAt)} so far` : duration(s.durationMs ?? (s.endedAt - s.startedAt)))),
        h('div.jr-facts',
          files === null ? h('span.faint.small', { title: 'Files are counted only while FlintBench watches the session' }, 'files not observed')
            : metric(String(files), files === 1 ? 'file' : 'files', 'Files changed in the project while the session was active. Not attributed to the agent.'),
          metric(String(s.commits?.length ?? 0), (s.commits?.length ?? 0) === 1 ? 'commit' : 'commits', (s.commits ?? []).map((c) => `${c.short} ${c.subject}`).join('\n') || 'No commits in the session window')),
        h(`span.jr-source${s.source === 'flintbench' ? '.is-own' : ''}`, { title: evidenceText(s) }, s.source === 'flintbench' ? 'FlintBench' : 'outside'));
    })))));
}

/** One active session: who, where, how long, what changed — and what can be done with it. */
function sessionCard(s) {
  const p = store.project(s.projectId);
  const canWatch = s.source === 'external' && ['claude', 'codex', 'antigravity'].includes(s.agent) && s.agentSessionId && !s.terminalId;
  return h(`article.ag-session.is-${s.agent}`,
    h('div.ag-head',
      agentMark(s.agent, 20),
      h('div.ag-title',
        h('div.jr-line', h('strong', s.agentName), statusDot('agent live', 'Active'), h('span.agent-text.small', 'active')),
        h('div.faint.small', p ? ['in ', h('a', { href: projectPath(p.id, 'agents') }, p.name)] : 'project unknown')),
      h('span.spacer'),
      h('div.ag-actions',
        canWatch ? h('button.btn.sm', { type: 'button', onclick: () => openConversation(s) }, icon('eye', 13), 'Conversation') : null,
        p ? h('a.btn.sm', { href: projectPath(p.id) }, 'Open project') : null,
        s.source === 'flintbench' ? actionButton('Stop', () => attempt(() => api.post(`/api/agent-sessions/${s.id}/stop`)), { cls: 'btn sm danger' }) : null)),
    h('div.ag-metrics',
      metric(clock(s.startedAt), 'started'),
      metric(duration(Date.now() - s.startedAt), 'running'),
      metric(ago(s.lastActivityAt), 'last activity'),
      s.filesChanged === null || s.filesChanged === undefined ? null : metric(String(s.filesChanged), 'files changed')),
    h('p.ag-evidence', icon('eye', 12), evidenceText(s)));
}

export function mount(container) {
  const inner = h('div.view-inner');
  container.append(h('div.view', inner));
  let journal = [];
  let projectFilter = '';

  async function loadJournal() {
    journal = (await attempt(() => api.get(`/api/agents/journal?limit=200${projectFilter ? `&project=${encodeURIComponent(projectFilter)}` : ''}`))) ?? [];
    render();
  }

  function render() {
    const a = store.state.agents;
    const projects = [...store.state.projects.values()].sort((x, y) => x.name.localeCompare(y.name));
    const filterMenu = selectMenu({
      label: 'Journal project', prefix: 'Project', width: '240px', value: projectFilter,
      options: [{ value: '', text: 'All projects' }, ...projects.map((p) => ({ value: p.id, text: p.name }))],
      onChange: (v) => { projectFilter = v; loadJournal(); },
    });
    // agents working in folders that are not FlintBench projects are none of its business: not listed

    replace(inner,
      h('header.page-head',
        h('div', h('h1', 'Agents'), h('p.sub', 'Installed CLIs run with their own login and limits. FlintBench never proxies requests or stores API keys.')),
        h('span.spacer'),
        actionButton('Re-detect', async () => { const r = await attempt(() => api.post('/api/agents/detect')); if (r) store.set('agents', r); }, { cls: 'btn', iconName: 'refresh' })),
      h('div.telemetry', a.tools.map((t) => h(`div${t.active ? '.is-agent' : ''}`,
        h('div.row', agentMark(t.id, 16), h('span.label', t.name)),
        h('div.value', { style: { fontSize: '15px' } }, t.installed ? (t.active ? `${t.active} active` : 'Installed') : 'Not detected'),
        h('div.faint.mono', { style: { fontSize: '11px', marginTop: '4px' } }, t.installed ? `${t.version ?? ''}${t.launchable ? '' : ' · launch not supported yet'}` : 'not on PATH')))),
      h('div.section-title', h('span.label', 'Active sessions'), a.active.length ? h('span.faint.small', String(a.active.length)) : null),
      a.active.length ? h('div.ag-sessions', a.active.map(sessionCard)) : h('div.panel.panel-empty', 'No agent sessions active.'),
      h('div.section-title', h('span.label', 'AI coding journal'), h('span.spacer'), filterMenu.el),
      journalList(journal),
      h('p.evidence', { style: { marginTop: '10px' } }, 'Files and commits are counted inside the session window. They are not claims that the agent made those changes. Tasks appear only when typed at launch.'));
  }

  const unsub = subscribe(['agents', 'projects'], render);
  const unsubEvents = subscribe('event', () => {
    if (store.state.lastEvent?.type?.startsWith('agent.')) loadJournal();
  });
  render();
  loadJournal();
  return { destroy() { unsub(); unsubEvents(); } };
}
