import { h, icon, replace, actionButton } from '../../lib/dom.js';
import { store, subscribe } from '../../lib/store.js';
import { api, projectUrl } from '../../lib/api.js';
import { navigate, projectPath } from '../../lib/router.js';
import { attempt, projectStatus, statusDot } from '../../lib/ui.js';
import { createDock } from '../../terminal/dock.js';
import { launchAgent } from './agent-panel.js';
import { startProject, stopProject, canStart } from '../home.js';
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

  function renderHead() {
    const p = store.project(projectId);
    if (!p) return;
    const st = projectStatus(p);
    const g = p.git;
    replace(head,
      h('div', { style: { minWidth: 0 } },
        h('div.row', h('h1.ellipsis', p.name),
          h(`span.chip${st.cls ? `.${st.cls}` : ''}`, statusDot(st.dot, st.label), st.label),
          g?.isRepo ? h('span.chip.mono', { title: 'Current branch' }, icon('branch', 11), g.detached ? 'detached' : g.branch) : null),
        h('div.path.ellipsis', { title: p.path }, p.path)),
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
      document.removeEventListener('keydown', onKey);
    },
  };
}
