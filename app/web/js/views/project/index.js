import { h, icon, replace, actionButton } from '../../lib/dom.js';
import { store, subscribe } from '../../lib/store.js';
import { api, projectUrl } from '../../lib/api.js';
import { navigate, projectPath } from '../../lib/router.js';
import { attempt, projectStatus, statusDot, agentWorking } from '../../lib/ui.js';
import { toolMarks } from '../../lib/agent-icons.js';
import { createDock } from '../../terminal/dock.js';
import { launchAgent } from './agent-panel.js';
import { startProject, stopProject, canStart, liveSignal } from '../home.js';
import { removeProject } from '../projects.js';
import * as overview from './overview.js';
import * as git from './git.js';
import * as services from './services.js';
import * as agentsTab from './agents-tab.js';
import * as context from './context.js';
import * as work from './work.js';
import * as graphView from './graph.js';
import * as filesView from './files.js';
import * as sessionsView from './sessions.js';
import { isTestProfile } from '../../lib/theme.js';
import { has, currentProfile } from '../../lib/feature.js';
import { defaultEditorName } from '../../lib/editor-menu.js';
import { resumeWork } from '../../lib/resume.js';
import { openProjects, touchProject, closeProject } from '../../lib/open-projects.js';

// Two regions only: the section menu and its content, with the terminal dock below.
const TABS = [
  { id: 'overview', label: 'Overview', icon: 'overview', module: overview },
  { id: 'files', label: 'Files', icon: 'folder', module: filesView },
  { id: 'git', label: 'Git', icon: 'branch', module: git },
  { id: 'services', label: 'Services', icon: 'play', module: services, feature: 'tab.services' },
  { id: 'agents', label: 'Agents', icon: 'agent', module: agentsTab, feature: 'tab.agents' },
  { id: 'context', label: 'Docs', icon: 'context', module: context, feature: 'tab.docs' },
  { id: 'sessions', label: 'Sessions', icon: 'timer', module: sessionsView, feature: 'tab.sessions' },
  { id: 'work', label: 'Tasks', icon: 'work', module: work, feature: 'tab.tasks' },
  // shown only when the project has graphify-out/graph.json
  { id: 'graph', label: 'Graph', icon: 'graph', module: graphView, optional: true, feature: 'tab.graph' },
];

/** A tab is there when the profile has it (and, for test tabs, only in Labs). */
const tabShown = (x) => (!x.test || isTestProfile()) && (!x.feature || has(x.feature));

/**
 * The tab to show: the one asked for when the profile has it; with none asked, the tab the profile
 * opens projects on. Old links (Home "Resume", the Agents page) say "workspace": the overview with the terminal open.
 */
const resolveTab = (t) => {
  if (t === 'workspace') return 'overview';
  if (TABS.some((x) => x.id === t && tabShown(x))) return t;
  const start = currentProfile().startTab;
  return !t && TABS.some((x) => x.id === start && tabShown(x)) ? start : 'overview';
};

/**
 * The agents at work on a project, as on Home: their marks, in their colour, with the live signal of
 * the one answering (Claude Code's spark, Codex's dot…) or a grey dot while they wait. `compact`
 * (a tab in the back) keeps the marks and the signal only.
 */
function agentChip(p, { compact = false } = {}) {
  const agents = p.agents?.active ?? [];
  const ids = [...new Set(agents.map((s) => s.agent))];
  const names = [...new Set(agents.map((s) => s.agentName))].join(' + ');
  const answering = agents.find((s) => agentWorking(s));
  const signal = liveSignal(answering ? answering.agent : 'idle');
  // the spark keeps its pace across redraws: its frames follow one clock, not the element's birth
  const cycle = (el) => parseFloat(el.style.animationDuration) || 0;
  for (const frame of signal.querySelectorAll('span')) {
    const phase = (performance.now() / 1000) % (cycle(frame) || 1);
    frame.style.animationDelay = `${(parseFloat(frame.style.animationDelay) - phase).toFixed(2)}s`;
  }
  const state = `${names} ${answering ? 'working' : 'waiting'}`;
  return h(`span.chip.agent-live.is-${ids[0]}${compact ? '.is-compact' : '.p-wtab-state'}`, { title: state, 'aria-label': state },
    toolMarks(ids, compact ? 12 : 13), compact ? null : h('span.agent-live-name', names), signal);
}

/** Where `id` was left (its open tab), for a one-click way back. */
const tabPath = (x) => projectPath(x.id, x.tab);

export function mount(container, route) {
  const projectId = route.id;
  let tab = resolveTab(route.tab);
  const openTerminal = route.tab === 'workspace';
  let hasGraph = false;
  const visibleTabs = () => TABS.filter((t) => (!t.optional || (t.id === 'graph' && hasGraph)) && tabShown(t));

  const head = h('header.p-head');
  const nav = h('nav.p-nav', { 'aria-label': 'Project' });
  const center = h('section.p-center', { 'aria-live': 'off' });
  const dock = createDock(projectId);
  const ctx = {
    projectId,
    dock,
    go: (t) => navigate(projectPath(projectId, t)),
    project: () => store.project(projectId),
  };
  const bodyEl = h('div.p-body', nav, center);
  const root = h('div.project', head, bodyEl, dock.el);
  container.append(root);
  // a maximised terminal covers the whole project area but the header: it needs the header height
  const headObserver = new ResizeObserver(() => root.style.setProperty('--p-head-h', `${head.offsetHeight}px`));
  headObserver.observe(head);

  let current = null;

  /** Restore the project's terminals and show the dock (the old "workspace"). */
  async function openWorkspace() {
    const r = await attempt(() => api.post(projectUrl(projectId, '/resume')), { failure: 'Could not resume' });
    if (!r) return;
    dock.open();
    if (!store.projectTerminals(projectId).some((t) => !t.exited)) dock.newTerminal(undefined, 'Terminal');
  }

  /** The one Resume (lib/resume.js), then the terminal panel on what it reopened. */
  async function resumeHere() {
    const r = await resumeWork(projectId);
    if (!r) return;
    await openWorkspace();
    if (r.agentTerminal) dock.show(r.agentTerminal.id);
  }

  /** Close an open project's tab; closing this one goes to its neighbour, or to Projects. */
  // tabs folding away: a redraw meanwhile draws them folded, it does not bring them back
  const closing = new Set();

  function closeTab(id) {
    closing.delete(id);
    const open = openProjects();
    const i = open.findIndex((x) => x.id === id);
    closeProject(id);
    if (id !== projectId) return;
    const next = open[i + 1] ?? open[i - 1];
    navigate(next ? tabPath(next) : '/projects');
  }

  /**
   * One browser-like tab per open project, drawn like the project title: name, state, branch, path.
   * The others say which section they were left on, and a click goes back there.
   */
  function projectTab(x) {
    const p = store.project(x.id);
    const active = x.id === projectId;
    const st = projectStatus(p);
    const g = p.git;
    const def = TABS.find((t) => t.id === x.tab) ?? TABS[0];
    const close = h('button.p-wtab-x', {
      type: 'button',
      title: `Close ${p.name}`,
      'aria-label': `Close ${p.name}`,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        // the tab folds away first (from its current width to none), then it is gone
        const el = e.currentTarget.closest('.p-wtab');
        if (closing.has(x.id)) return;
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return closeTab(x.id);
        closing.add(x.id);
        el.style.maxWidth = `${el.offsetWidth}px`;
        void el.offsetWidth; // start the fold from that width
        el.classList.add('is-closing');
        setTimeout(() => closeTab(x.id), 200);
      },
    }, icon('x', 11));
    const body = h('div.p-wtab-body',
      h('div.row',
        active ? h('h1.ellipsis', p.name) : h('span.p-wtab-name.ellipsis', p.name),
        // a tab in the back keeps its name readable: its state is the dot alone (the label on hover)
        p.agents?.active?.length ? agentChip(p, { compact: !active })
          : active ? h(`span.chip.p-wtab-state${st.cls ? `.${st.cls}` : ''}`, statusDot(st.dot, st.label), st.label) : statusDot(st.dot, st.label),
        g?.isRepo ? h('span.chip.mono.p-wtab-branch', { title: 'Current branch' }, icon('branch', 11), g.detached ? 'detached' : g.branch) : null,
      ),
      // under the name: the path; a tab in the back first says which section it was left on
      h('div.p-wtab-sub',
        active ? null : h('span.p-wtab-sec', { title: `Left on ${def.label}` }, icon(def.icon, 11), h('span', def.label)),
        h('span.path.ellipsis', { title: p.path }, p.path)));
    const folding = closing.has(x.id) ? '.is-closing' : '';
    if (active) return h(`div.p-wtab.is-active${folding}`, { role: 'tab', 'aria-selected': 'true' }, body, openProjects().length > 1 ? close : null);
    return h(`a.p-wtab${folding}`, {
      href: tabPath(x),
      role: 'tab',
      'aria-selected': 'false',
      title: `Switch to ${p.name} · ${def.label} (Alt+PgUp / Alt+PgDn)`,
    }, body, close);
  }

  function renderHead() {
    const p = store.project(projectId);
    if (!p) return;
    const open = openProjects();
    replace(head,
      h('div.p-wtabs', { role: 'tablist', 'aria-label': 'Open projects' }, (open.some((x) => x.id === projectId) ? open : [{ id: projectId, tab }]).map(projectTab)),
      h('div.actions',
        actionButton('Resume', resumeHere, { cls: 'btn sm primary', iconName: 'resume', title: 'Reopen the last agent conversation, start the services that were running and restore your terminals' }),
        p.running
          ? actionButton('Stop', () => stopProject(p), { cls: 'btn sm', iconName: 'stop' })
          : actionButton('Start', () => startProject(p), { cls: 'btn sm', iconName: 'play', disabled: !p.exists || !canStart(p), title: canStart(p) ? 'Start services' : 'Define a service in Services first' }),
        actionButton('', () => attempt(() => api.post(projectUrl(projectId, '/open-editor')), { success: `Opening in ${defaultEditorName()}` }), { cls: 'btn sm icon', iconName: 'editor', title: `Open in ${defaultEditorName()}` }),
        actionButton('', () => attempt(() => api.post(projectUrl(projectId, '/reveal'))), { cls: 'btn sm icon', iconName: 'folder', title: 'Open in File Explorer' }),
        actionButton('', () => removeProject(p), { cls: 'btn sm icon danger', iconName: 'trash', title: 'Remove from FlintBench (the folder is not touched)' })));
  }

  function renderNav() {
    const p = store.project(projectId);
    if (!p) return;
    const running = (p.runtime?.services ?? []).filter((s) => s.status === 'running').length + (p.docker?.running ?? 0);
    const counts = {
      git: p.git?.changed ? [p.git.changed, 'warn'] : null,
      services: running ? [running, 'ok'] : null,
      agents: p.agents?.active?.length ? ['●', 'agent'] : null,
      work: p.work?.open ? [p.work.open, ''] : null,
    };
    const terms = store.projectTerminals(projectId).filter((t) => !t.exited).length;
    replace(nav,
      visibleTabs().map((t) => h('a', {
        href: projectPath(projectId, t.id),
        'aria-current': tab === t.id ? 'page' : undefined,
        title: t.label,
      }, icon(t.icon, 15), h('span.lbl', t.label), counts[t.id] ? h(`span.count.${counts[t.id][1] || 'x'}`, String(counts[t.id][0])) : null)),
      h('hr'),
      h('button', { type: 'button', title: 'Show or hide the terminal (Ctrl+`)', onclick: () => dock.toggle() }, icon('dock', 15), h('span.lbl', 'Terminal'), terms ? h('span.count', String(terms)) : h('kbd.kbd-hint', 'Ctrl `')));
  }

  function renderTab() {
    current?.destroy?.();
    center.replaceChildren();
    const def = TABS.find((t) => t.id === tab);
    current = def.module.render(ctx);
    center.append(current.el);
    center.scrollTop = 0;
  }

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '`') {
      e.preventDefault();
      dock.toggle();
    } else if (e.altKey && !e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      // the next / previous open project, on the section it was left on
      const open = openProjects();
      const i = open.findIndex((x) => x.id === projectId);
      if (open.length < 2 || i === -1) return;
      e.preventDefault();
      navigate(tabPath(open[(i + (e.key === 'PageDown' ? 1 : -1) + open.length) % open.length]));
    }
  };
  document.addEventListener('keydown', onKey);

  const unsub = subscribe([`project:${projectId}`, 'agents'], () => {
    if (!store.project(projectId)) {
      navigate('/', { replace: true });
      return;
    }
    renderHead();
    renderNav();
    current?.update?.();
  });
  const unsubTerms = subscribe('terminals', renderNav);
  // the tabs follow the other open projects too (their state, their branch, a tab closed)
  const unsubStrip = subscribe(['openProjects', 'projects'], renderHead);

  touchProject(projectId, tab);
  renderHead();
  renderNav();
  renderTab();
  if (openTerminal) openWorkspace();
  api.get(projectUrl(projectId, '/graph?meta=1')).then((g) => {
    hasGraph = Boolean(g?.available);
    renderNav();
  }).catch(() => {});
  api.post(projectUrl(projectId, '/open')).catch(() => {});

  return {
    projectId,
    update(next) {
      const nextTab = resolveTab(next.tab);
      if (next.tab === 'workspace') openWorkspace();
      if (nextTab !== tab) {
        tab = nextTab;
        touchProject(projectId, tab);
        renderHead();
        renderNav();
        renderTab();
      }
    },
    commands() {
      const p = store.project(projectId);
      const tools = store.state.agents.tools.filter((t) => t.installed && t.launchable);
      return [
        { label: `${p.name}: New terminal`, icon: 'terminal', run: () => dock.newTerminal() },
        { label: `${p.name}: Toggle terminal`, icon: 'dock', hint: 'Ctrl+`', run: () => dock.toggle() },
        ...tools.flatMap((t) => [
          { label: `${p.name}: Launch ${t.name}`, icon: 'agent', run: () => launchAgent(projectId, t.id, 'new') },
          { label: `${p.name}: Continue last ${t.name} session`, icon: 'resume', run: () => launchAgent(projectId, t.id, 'resume') },
        ]),
        { label: `${p.name}: Open in editor`, icon: 'editor', run: () => api.post(projectUrl(projectId, '/open-editor')) },
      ];
    },
    destroy() {
      current?.destroy?.();
      headObserver.disconnect();
      dock.destroy();
      unsub();
      unsubTerms();
      unsubStrip();
      document.removeEventListener('keydown', onKey);
    },
  };
}
