import { h, icon, replace } from '../../lib/dom.js';
import { api, projectUrl } from '../../lib/api.js';
import { prefs } from '../../lib/store.js';
import { clock, duration, plural } from '../../lib/format.js';
import { agentMark } from '../../lib/agent-icons.js';

/**
 * Work sessions (profile Test): the project's activity grouped into periods of work — "what
 * happened while I was working?". Built by the server from observed facts only (file changes,
 * own commits, agent sessions, services started, editor windows); see insights/work-sessions.js.
 */

const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days']];

function dayLabel(ts) {
  const day = new Date(ts).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return 'Today';
  if (day === today - 86_400_000) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

/** "18 files" when every changed path is known, "12+ files" when only per-bucket counts were recorded. */
export function filesText(w) {
  if (!w.files) return null;
  return w.filesExact ? plural(w.files, 'file') : `${w.files}+ files`;
}

/** One line of facts for a session: "2h 12m · VS Code, Claude Code · 18 files · 4 commits". */
export function sessionFacts(w) {
  return [
    w.durationMs >= 60_000 ? duration(w.durationMs) : 'under a minute',
    w.tools.length ? w.tools.join(', ') : null,
    filesText(w),
    w.commits.length ? plural(w.commits.length, 'commit') : null,
  ].filter(Boolean).join(' · ');
}

function sessionCard(w) {
  const facts = [
    filesText(w) ? [icon('file', 13), filesText(w)] : null,
    w.commits.length ? [icon('commit', 13), plural(w.commits.length, 'commit')] : null,
    w.services.length ? [icon('play', 13), `${w.services.join(', ')} run`] : null,
    w.branches.length ? [icon('branch', 13), w.branches.join(' → ')] : null,
    w.processes ? [icon('activity', 13), `${plural(w.processes, 'process', 'processes')} outside FlintBench`] : null,
  ].filter(Boolean);
  return h(`li.ws${w.live ? '.is-live' : ''}`,
    h('div.ws-time',
      h('strong.mono', `${clock(w.startedAt)} → ${w.live ? 'now' : clock(w.endedAt)}`),
      h('span', w.durationMs >= 60_000 ? duration(w.durationMs) : '<1m'),
      w.live ? h('span.chip.ok', 'in progress') : null),
    h('div.ws-body',
      w.tools.length || w.agents.length
        ? h('div.ws-tools',
          w.editors.map((name) => h('span.ws-tool', icon('editor', 13), name)),
          w.agents.map((a) => h('span.ws-tool.is-agent', agentMark(a.agent, 13), a.name, a.ms >= 60_000 ? h('span.faint', `active ${duration(a.ms)}`) : null)))
        : h('div.ws-tools', h('span.faint', 'No editor or agent observed')),
      facts.length ? h('div.ws-facts', facts.map(([ic, text]) => h('span', ic, text))) : null,
      w.agents.some((a) => a.tasks.length) ? h('ul.ws-tasks', w.agents.flatMap((a) => a.tasks.map((t) => h('li', h('span.faint', `${a.name}:`), ' ', t)))) : null,
      w.commits.length ? h('ul.ws-commits', w.commits.slice(-6).map((c) => h('li', h('code', c.short), h('span.ellipsis', c.subject)))) : null,
      w.topPaths.length ? h('div.ws-paths.mono', { title: w.topPaths.join('\n') }, w.topPaths.slice(0, 5).join('  ·  ')) : null));
}

export function render(ctx) {
  const el = h('div.p-center-inner');
  let days = PERIODS.some(([d]) => d === prefs.get('sessions.days')) ? prefs.get('sessions.days') : 30;
  let sessions = null;
  let failed = false;
  let seq = 0;

  async function load() {
    const mine = ++seq;
    const r = await api.get(projectUrl(ctx.projectId, `/work-sessions?days=${days}`)).catch(() => null);
    if (mine !== seq) return;
    failed = !r;
    sessions = r?.sessions ?? [];
    draw();
  }

  function draw() {
    const tabs = h('div.tabs', { role: 'group', 'aria-label': 'Period' }, PERIODS.map(([d, label]) => h('button', {
      type: 'button', 'aria-pressed': String(days === d),
      onclick: () => { if (d === days) return; days = d; prefs.set('sessions.days', d); sessions = null; draw(); load(); },
    }, label)));
    const total = (sessions ?? []).reduce((n, w) => n + w.durationMs, 0);
    const head = h('div.section-title.ws-head', h('span.label', 'Work sessions'),
      sessions?.length ? h('span.faint', { style: { fontSize: '12px' } }, `${plural(sessions.length, 'session')} · ${duration(total)}`) : null,
      h('span.spacer'), tabs);
    const how = h('p.ws-how', 'A session is continuous work on the project: file changes, your commits, agent activity, services started here. ',
      'A pause longer than 30 minutes ends it. An editor window left open does not count as work on its own.');
    if (sessions === null) { replace(el, head, h('div.panel.panel-empty', 'Reading the project history…')); return; }
    if (failed) { replace(el, head, h('div.panel.panel-empty', 'Could not read the work sessions.')); return; }
    if (!sessions.length) { replace(el, head, h('div.panel.panel-empty', `No work recorded in the last ${days} days.`), how); return; }
    const byDay = new Map();
    for (const w of sessions) {
      const key = new Date(w.startedAt).setHours(0, 0, 0, 0);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(w);
    }
    replace(el, head,
      [...byDay].map(([day, list]) => h('section.ws-day',
        h('div.ws-day-head', h('strong', dayLabel(day)), h('span.faint', duration(list.reduce((n, w) => n + w.durationMs, 0)))),
        h('ol.ws-list', list.map(sessionCard)))),
      how);
  }

  draw();
  load();
  const timer = setInterval(() => { if (sessions?.[0]?.live) load(); }, 60_000);
  // an agent opening or closing changes what is in progress: read the sessions again
  const agentsKey = () => (ctx.project()?.agents?.active ?? []).map((s) => s.id).sort().join(',');
  let lastAgents = agentsKey();
  let reloadTimer = 0;
  return {
    el,
    update() {
      const key = agentsKey();
      if (key === lastAgents) return;
      lastAgents = key;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 1200);
    },
    destroy() { clearInterval(timer); clearTimeout(reloadTimer); },
  };
}
