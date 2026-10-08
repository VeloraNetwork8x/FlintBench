import { dockerLogo } from '../lib/agent-icons.js';
import { h, icon, brandMark, replace } from '../lib/dom.js';
import { store, subscribe, prefs, notify } from '../lib/store.js';
import { current, navigate, onRoute, projectPath } from '../lib/router.js';
import { reportActivity, onServerEvent } from '../lib/ws.js';
import { play } from '../lib/sound.js';
import { agentFinishedToast, commitToast, githubNotificationToast, githubRepoToast, pushToast, serviceStartedToast } from '../lib/notify.js';
import { ledClock } from '../lib/led-clock.js';
import { timer, formatDuration } from '../lib/timer.js';
import { openPalette, toast } from '../lib/ui.js';
import { ago } from '../lib/format.js';
import { isTestProfile, applySettingsLook } from '../lib/theme.js';
import { has, agentsInUse } from '../lib/feature.js';
import { resolveProfile } from '../lib/profiles.js';
import { eventLine } from '../lib/events.js';
import * as home from './home.js';
import * as projectsView from './projects.js';
import * as agentsView from './agents.js';
import * as activityView from './activity.js';
import * as settingsView from './settings.js';
import * as githubView from './github.js';
import * as projectView from './project/index.js';

const NAV = [
  { name: 'home', path: '/', label: 'Home', icon: 'home', key: '1' },
  { name: 'projects', path: '/projects', label: 'Projects', icon: 'folder', key: '2' },
  { name: 'agents', path: '/agents', label: 'Agents', icon: 'agent', key: '3', feature: 'nav.agents' },
  { name: 'activity', path: '/activity', label: 'Activity', icon: 'activity', key: '4', feature: 'nav.activity' },
  { name: 'github', path: '/github', label: 'GitHub', icon: 'github', key: '6', feature: 'nav.github' }, // `test: true` keeps an entry to the Labs profile
  { name: 'settings', path: '/settings', label: 'Settings', icon: 'settings', key: '5' },
];
// a section shows when the profile has it (and, for test entries, only in Labs)
const navShown = (n) => (!n.test || isTestProfile()) && (!n.feature || has(n.feature));
// notification level (Settings › Notifications): all | important | quiet
const level = () => store.state.settings?.notifications?.level ?? 'all';
// what a profile decides: when it changes, the view on show is drawn again
const profileSignature = () => JSON.stringify([resolveProfile(store.state.settings), store.state.settings?.agents?.use]);

const VIEWS = { home, projects: projectsView, agents: agentsView, activity: activityView, github: githubView, settings: settingsView, project: projectView };

export function mountShell(root, actions) {
  // icon fixed in place; two labels (small under it when closed, beside it when open) cross-fade,
  // so opening or closing the menu never moves the icons or resizes text mid-way
  const labels = (text) => [h('span.rl-below', { 'aria-hidden': 'true' }, text), h('span.rl-side', text)];
  const links = NAV.map((n) => h(`a.rail-link${n.test ? '.is-test-only' : ''}`, { href: n.path, title: `${n.label} (Alt+${n.key})` }, icon(n.icon, 22), labels(n.label)));
  const lockBtn = h('button.rail-link', { type: 'button', title: 'Lock (Ctrl+Shift+L)', onclick: () => actions.lock() }, icon('lock', 22), labels('Lock'));
  // one indicator that slides to the current section (orientation: where am I, where did I come from)
  const indicator = h('span.rail-indicator', { 'aria-hidden': 'true' });
  // the logo opens and closes the menu: icons only, or icons with their names beside them
  const brand = h('button.rail-brand', { type: 'button', onclick: () => setRailOpen(!railOpen) },
    h('span.brand-mark', brandMark()), h('span.brand-name', 'Flint', h('span', 'Bench')));
  const rail = h('nav.rail', { 'aria-label': 'Global' }, indicator, brand, ...links, h('div.spacer'), lockBtn);
  const main = h('main.main', { id: 'main' });
  const status = h('footer.statusbar');
  // date and time: a digital clock in the main sections, the status bar inside a project
  const clock = ledClock();
  const now = () => new Date();
  const timeText = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateText = (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const app = h('div.app', rail, main, status, clock.el);
  let railOpen = prefs.get('rail.open', false);
  function setRailOpen(open) {
    railOpen = open;
    prefs.set('rail.open', open);
    app.classList.toggle('rail-open', open);
    brand.setAttribute('aria-expanded', String(open));
    brand.title = open ? 'Collapse the menu' : 'Expand the menu';
  }
  setRailOpen(railOpen);
  replace(root, app);

  let view = null;
  let viewName = null;

  function placeIndicator() {
    const link = links.find((a) => a.getAttribute('aria-current') === 'page');
    indicator.classList.toggle('is-hidden', !link);
    if (!link) return;
    indicator.style.setProperty('--ind-x', `${link.offsetLeft}px`);
    indicator.style.setProperty('--ind-y', `${link.offsetTop}px`);
    indicator.style.setProperty('--ind-w', `${link.offsetWidth}px`);
    indicator.style.setProperty('--ind-h', `${link.offsetHeight}px`);
  }

  function applyNav() {
    links.forEach((a, i) => { a.style.display = navShown(NAV[i]) ? '' : 'none'; });
    placeIndicator();
  }

  function renderRoute(route, { remount = false } = {}) {
    links.forEach((a, i) => {
      const active = NAV[i].name === route.name || (route.name === 'project' && NAV[i].name === 'projects');
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    placeIndicator();
    document.body.classList.toggle('in-project', route.name === 'project');
    renderStatus();
    if ((route.name === 'project' && !store.project(route.id)) || NAV.some((n) => n.name === route.name && !navShown(n))) {
      navigate('/', { replace: true });
      return;
    }
    if (!remount && view && viewName === route.name && view.update && (route.name !== 'project' || view.projectId === route.id)) {
      view.update(route);
      return;
    }
    view?.destroy?.();
    main.replaceChildren();
    viewName = route.name;
    view = VIEWS[route.name].mount(main, route, actions) ?? null;
    const p = route.name === 'project' ? store.project(route.id) : null;
    document.title = p ? `${p.name} — FlintBench` : `${NAV.find((n) => n.name === route.name)?.label ?? 'Home'} — FlintBench`;
  }

  function renderBadges() {
    // folders hidden from the Home inbox with Ignore are not counted: the badge matches what Home shows
    const attention = [...store.state.projects.values()].filter((p) => p.needsAttention).length + home.visibleCandidates().length;
    const homeLink = links[0];
    homeLink.querySelector('.badge')?.remove();
    if (attention) homeLink.append(h('span.badge', { 'aria-label': `${attention} need attention` }, String(attention)));
    // unread GitHub notifications on the GitHub entry
    const githubLink = links[NAV.findIndex((n) => n.name === 'github')];
    const unread = store.state.githubUnread;
    githubLink?.querySelector('.badge')?.remove();
    if (githubLink && unread) githubLink.append(h('span.badge.is-info', { 'aria-label': `${unread} unread GitHub notifications` }, unread > 99 ? '99+' : String(unread)));
  }

  // the timer in the status bar too: inside a project the clock is hidden, the countdown is not
  const sbTimer = h('button.sb-timer', { type: 'button', hidden: true, title: 'Timer', onclick: () => { if (timer.status() === 'ringing') timer.stop(); } }, icon('timer', 12), h('span'));
  const offTimer = timer.on(() => {
    const st = timer.status();
    sbTimer.hidden = st === 'idle';
    sbTimer.classList.toggle('is-ringing', st === 'ringing');
    sbTimer.title = st === 'ringing' ? 'Stop the alarm' : 'Timer';
    sbTimer.lastChild.textContent = st === 'ringing' ? 'Time\u2019s up · stop' : `${formatDuration(timer.remaining())}${st === 'paused' ? ' · paused' : ''}`;
  });

  let everConnected = false;
  /** Docker Up in Docker blue, Docker Down / Docker Off in grey, after the whale. */
  function dockerStatus(docker) {
    const up = docker.enabled && docker.running;
    const text = `Docker ${docker.enabled ? (docker.running ? 'Up' : 'Down') : 'Off'}`;
    return h(`span.row.sb-docker${up ? '.is-up' : ''}`, { title: up ? 'Docker engine running' : docker.enabled ? 'Docker engine not running' : 'Docker integration off (Settings)' }, dockerLogo(14), text);
  }

  function renderStatus() {
    const s = store.state;
    if (s.connected) everConnected = true;
    const projects = [...s.projects.values()];
    const running = projects.filter((p) => p.running).length;
    const agents = s.agents.active?.length ?? 0;
    const docker = s.integrations?.docker;
    const ev = s.lastEvent;
    replace(status,
      // every word starts with a capital, like the rest of the console's labels
      h('span.row', h(`span.dot.${s.connected ? 'ok' : 'warn'}`), s.connected ? 'Live' : (everConnected ? 'Reconnecting…' : 'Connecting…')),
      h('span', `${projects.length} ${projects.length === 1 ? 'Project' : 'Projects'}`),
      h('span', `${running} Running`),
      agents ? h('span.agent-text', `${agents} ${agents > 1 ? 'Agents' : 'Agent'} Active`) : null,
      docker && has('ui.technical') ? dockerStatus(docker) : null,
      h('span.event', { title: ev ? eventLine(ev) : '' }, ev ? `${eventLine(ev)} · ${ago(ev.at)}` : ''),
      sbTimer,
      current().name === 'project' ? h('span.sb-clock', { title: dateText(now()) }, `${now().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${timeText(now())}`) : null);
  }

  function paletteItems() {
    const route = current();
    const items = [];
    const projects = [...store.state.projects.values()].sort((a, b) => (b.activity?.lastActivityAt ?? 0) - (a.activity?.lastActivityAt ?? 0));
    for (const p of projects) {
      items.push({ label: p.name, hint: p.git?.branch ?? '', icon: 'folder', keywords: `${p.path} ${p.stack?.join(' ')}`, run: () => navigate(projectPath(p.id)) });
    }
    for (const n of NAV.filter(navShown)) items.push({ label: `Go to ${n.label}`, icon: n.icon, hint: `Alt+${n.key}`, run: () => navigate(n.path) });
    if (route.name === 'project') {
      const p = store.project(route.id);
      for (const [tab, label, feature] of [['overview', 'Overview'], ['files', 'Files'], ['git', 'Git'], ['services', 'Services', 'tab.services'], ['agents', 'Agents', 'tab.agents'], ['context', 'Docs', 'tab.docs'], ['work', 'Tasks', 'tab.tasks']]) {
        if (feature && !has(feature)) continue;
        items.push({ label: `${p.name}: ${label}`, icon: 'chevron', run: () => navigate(projectPath(p.id, tab)) });
      }
      for (const cmd of view?.commands?.() ?? []) items.push(cmd);
    }
    items.push({ label: 'Rescan project directories', icon: 'refresh', run: () => projectsView.rescan() });
    items.push({ label: 'Lock FlintBench', icon: 'lock', hint: 'Ctrl+Shift+L', run: () => actions.lock() });
    items.push({ label: 'Log out', icon: 'logout', run: () => actions.logout() });
    return items;
  }

  const inTerminal = (el) => el?.closest?.('.xterm');
  const inField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  function onKey(e) {
    reportActivity();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k' && !inTerminal(e.target)) {
      e.preventDefault();
      openPalette(paletteItems());
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openPalette(paletteItems());
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      actions.lock();
    } else if (e.altKey && NAV.some((n) => n.key === e.key && navShown(n))) {
      e.preventDefault();
      navigate(NAV.find((n) => n.key === e.key).path);
    } else if (e.key === '/' && !inField(e.target) && !inTerminal(e.target)) {
      const search = document.querySelector('[data-search]');
      if (search) {
        e.preventDefault();
        search.focus();
      }
    }
  }

  const onPointer = () => reportActivity();
  const railObserver = new ResizeObserver(placeIndicator);
  const clockObserver = new ResizeObserver(() => document.documentElement.style.setProperty('--clock-h', `${clock.el.offsetHeight}px`));
  clockObserver.observe(clock.el);
  railObserver.observe(rail);
  // agents starting and stopping are the outcomes worth hearing; everything else stays silent
  const offEvents = onServerEvent((msg) => {
    if (msg.t !== 'event') return;
    if (msg.e?.type === 'agent.started') play('agentStart');
    else if (msg.e?.type === 'agent.stopped') play('agentStop');
    else if (msg.e?.type === 'agent.moved') {
      // a move asked for "when it finishes" happens later: say when it does
      const d = msg.e.data ?? {};
      const p = store.project(msg.e.projectId);
      toast(d.direction === 'in' ? `${d.agentName} moved into FlintBench` : `${d.agentName} continues in ${d.app}`, { kind: 'ok', detail: p?.name });
    } else if (msg.e?.type === 'project.relocation_found') {
      // a missing project's folder turned up somewhere else: ask before changing anything
      const d = msg.e.data ?? {};
      toast(d.kind === 'renamed' ? `The folder is now ${d.newName}. Update the project?` : `Found at ${d.to}. Update the project?`, {
        kind: 'warn',
        title: d.kind === 'renamed' ? `${d.name} was renamed` : `${d.name} was moved`,
        detail: 'Click to review: history, notes and sessions stay with the project.',
        timeout: 15_000,
        onClick: () => navigate(projectPath(msg.e.projectId)),
      });
    } else if (msg.e?.type === 'github.inbox') {
      store.state.githubUnread = msg.e.data?.unread ?? 0;
      notify('github');
      renderBadges();
    } else if (msg.e?.type === 'github.repo_changed' || msg.e?.type === 'github.notification') {
      // stars, forks and the GitHub inbox: unless notifications are quiet, or the GitHub section is off
      if (level() !== 'quiet' && has('nav.github')) (msg.e.type === 'github.repo_changed' ? githubRepoToast : githubNotificationToast)(msg.e.data ?? {});
    } else if (msg.e?.type === 'agent.turn_completed') {
      const p = store.project(msg.e.projectId);
      if (p && level() !== 'quiet' && agentsInUse()) agentFinishedToast(msg.e.data, p);
    } else if ((msg.e?.type === 'git.commit_created' || msg.e?.type === 'git.pushed') && msg.e.data?.source === 'external') {
      // commits and pushes made elsewhere (terminal, editor, agent): FlintBench's own Git actions already say so
      // (notification level: every commit only with "Everything", pushes unless "Quiet")
      const p = store.project(msg.e.projectId);
      const lvl = level();
      if (p && (msg.e.type === 'git.pushed' ? lvl !== 'quiet' : lvl === 'all')) (msg.e.type === 'git.pushed' ? pushToast : commitToast)(msg.e.data, p);
    } else if ((msg.e?.type === 'process.started' && msg.e.data?.managed) || msg.e?.type === 'docker.container_started') {
      // a service FlintBench started, or a compose container, came up: one notification each
      const p = store.project(msg.e.projectId);
      const d = msg.e.data ?? {};
      if (p && level() === 'all') serviceStartedToast({ name: d.service ?? d.name, container: msg.e.type === 'docker.container_started' }, p);
    }
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer);
  const unsubs = [
    subscribe(['projects', 'candidates'], () => { renderBadges(); renderStatus(); }),
    subscribe(['connected', 'event', 'agents', 'integrations'], renderStatus),
    subscribe('settings', () => {
      // a profile change reshapes the console at once: style, sections, and the view on show
      applySettingsLook(store.state.settings);
      applyNav();
      renderStatus();
      const sig = profileSignature();
      if (sig !== shownProfile) {
        shownProfile = sig;
        renderRoute(current(), { remount: true });
      }
    }),
  ];
  const tick = setInterval(renderStatus, 30_000);
  // the clock shows seconds; inside a project only the status bar's minutes need refreshing
  let shownMinute = -1;
  const clockTick = setInterval(() => {
    const d = now();
    if (current().name !== 'project') clock.update(d);
    else if (d.getMinutes() !== shownMinute) { shownMinute = d.getMinutes(); renderStatus(); }
  }, 1000);
  let shownProfile = profileSignature();
  applyNav();
  const offRoute = onRoute(renderRoute);
  renderRoute(current());
  renderBadges();
  renderStatus();

  return {
    destroy() {
      view?.destroy?.();
      offRoute();
      offEvents();
      offTimer();
      railObserver.disconnect();
      clockObserver.disconnect();
      unsubs.forEach((u) => u());
      clearInterval(tick);
      clearInterval(clockTick);
      document.body.classList.remove('in-project');
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      root.replaceChildren();
    },
  };
}
