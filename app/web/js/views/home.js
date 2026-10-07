import { h, icon, replace, actionButton } from '../lib/dom.js';
import { store, subscribe, prefs, notify } from '../lib/store.js';
import { api, projectUrl } from '../lib/api.js';
import { navigate, projectPath } from '../lib/router.js';
import { ago, plural, shortPath, duration } from '../lib/format.js';
import { statusDot, attempt, nowState, projectMoving, agentWorking, FILES_MOVING_MS } from '../lib/ui.js';
import { addRootForm } from './settings.js';
import { greeting } from '../lib/sound.js';
import { toolMarks, agentMark } from '../lib/agent-icons.js';
import { contextMenu, copyText } from '../lib/menu.js';
import { toast } from '../lib/ui.js';
import { removeProject } from './projects.js';
import { has, agentsInUse } from '../lib/feature.js';
import { editorItems } from '../lib/editor-menu.js';
import { selectMenu } from '../lib/select-menu.js';
import { AWAY_MS } from './project/briefing.js';
import { closedNotice, dismissClosed, reopenConversation, moveHere } from './project/agent-panel.js';
import { resumeWork } from '../lib/resume.js';
import { relocationText, relocationActions } from '../lib/relocation.js';

/** Something FlintBench can start: a defined service or a compose file with Docker available. */
export function canStart(p) {
  return (p.runtime?.services ?? []).some((s) => s.kind !== 'test') || Boolean(p.docker?.composeFiles?.length && p.docker?.available);
}

export async function startProject(p) {
  // each service that comes up gets its own "Service started" notification (shell, from the server event)
  const r = await attempt(() => api.post(projectUrl(p.id, '/start')), { failure: `Could not start ${p.name}` });
  if (r && !r.started?.length) toast(`${p.name}: nothing to start`, { kind: 'info' });
  return r;
}

export async function stopProject(p) {
  // stopping is what was asked: no notification, except for what was stopped in another window
  // (a dev server started from your own terminal) and when there was nothing to stop
  const r = await attempt(() => api.post(projectUrl(p.id, '/stop')), { failure: `Could not stop ${p.name}` });
  if (r?.external?.length) {
    const what = r.external.map((x) => `${x.name.replace(/\.exe$/i, '')}${x.ports?.length ? ` :${x.ports.join(', :')}` : ''}`).join(', ');
    toast(`Stopped ${what}`, { kind: 'ok', title: `${p.name} stopped`, detail: 'Started outside FlintBench: its terminal stays open.' });
  } else if (r && !r.stopped?.length) {
    toast(`${p.name}: nothing was running`, { kind: 'info' });
  }
  return r;
}

/** Open the project and show one of its dock tabs (a terminal, or 'tx:<session>' for a conversation). */
function showTab(p, tabId) {
  navigate(projectPath(p.id));
  setTimeout(() => window.dispatchEvent(new CustomEvent('flintbench:show-tab', { detail: { projectId: p.id, tabId } })), 0);
}

/** VS Code on the project: to the front if open, opened otherwise. */
async function focusEditor(p) {
  const r = await attempt(() => api.post(projectUrl(p.id, '/editor/focus')), { failure: 'Could not reach VS Code' });
  if (r?.action === 'focused') toast(r.focused ? 'VS Code brought to the front' : 'VS Code found, but Windows kept the focus where it was', { kind: r.focused ? 'ok' : 'warn' });
  else if (r) toast(`Opening ${p.name} in VS Code`, { kind: 'info' });
}

/** A live agent session to the front: its window outside FlintBench, or its tab inside. */
async function focusSession(p, s) {
  const r = await attempt(() => api.post(`/api/agent-sessions/${encodeURIComponent(s.id)}/focus`), { failure: `Could not reach ${s.agentName}` });
  if (!r) return;
  if (r.action === 'terminal') showTab(p, r.terminalId);
  else if (r.action === 'focused') toast(r.focused ? `${s.agentName} brought to the front${r.app ? ` (${r.app.replace(/\.exe$/i, '')})` : ''}` : `${s.agentName} found, but Windows kept the focus where it was`, { kind: r.focused ? 'ok' : 'warn' });
  else if (['claude', 'codex', 'antigravity'].includes(s.agent) && s.agentSessionId) showTab(p, `tx:${s.id}`);
  else toast(`No window found for ${s.agentName}`, { kind: 'warn' });
}

async function startHere(p, tool) {
  navigate(projectPath(p.id));
  const r = await attempt(() => api.post(projectUrl(p.id, `/agents/${tool.id}/start`), { mode: 'new' }), { failure: `Could not start ${tool.name}` });
  if (r?.terminal) {
    store.setTerminal(r.terminal);
    setTimeout(() => window.dispatchEvent(new CustomEvent('flintbench:show-tab', { detail: { projectId: p.id, tabId: r.terminal.id } })), 0);
  }
}

/** The tools at work on a project: VS Code and every live agent session, each one click to the front. */
function toolItems(p) {
  const vs = (p.editors ?? []).find((e) => e.id === 'vscode');
  const active = p.agents?.active ?? [];
  const tools = (store.state.agents.tools ?? []).filter((t) => t.installed && t.launchable && t.enabled);
  return [
    // VS Code open on the project: bring that window forward; otherwise your editors, default first
    vs ? { label: 'Bring VS Code to the front', iconNode: agentMark('vscode', 14), run: () => focusEditor(p) } : null,
    ...editorItems(p.id, { disabled: !p.exists, skip: vs ? ['code'] : [] }),
    ...active.map((s) => ({ label: `Bring ${s.agentName} to the front`, iconNode: agentMark(s.agent, 14), run: () => focusSession(p, s) })),
    // a conversation open in a window outside FlintBench can move into a tab here
    ...active.filter((s) => s.source === 'external' && !s.terminalId && s.movable).map((s) => ({
      label: s.moving === 'in' ? `Cancel moving ${s.agentName}` : `Move ${s.agentName} into FlintBench`,
      icon: 'resume',
      run: async () => {
        const terminal = await moveHere(s);
        if (terminal) showTab(p, terminal.id);
      },
    })),
    ...tools.filter((t) => !active.some((s) => s.agent === t.id)).map((t) => ({ label: `Start ${t.name} here`, iconNode: agentMark(t.id, 14), disabled: !p.exists, run: () => startHere(p, t) })),
  ];
}

/** The right-click menu of a project, wherever a project is listed. */
export function projectMenuItems(p) {
  return [
    ...toolItems(p),
    '-',
    { label: 'Open', icon: 'chevron', hint: 'Enter', run: () => navigate(projectPath(p.id)) },
    { label: 'Resume', icon: 'resume', hint: 'R', disabled: !p.exists, run: () => resumeProject(p) },
    p.running
      ? { label: 'Stop', icon: 'stop', run: () => stopProject(p) }
      : { label: 'Start', icon: 'play', disabled: !p.exists || !canStart(p), run: () => startProject(p) },
    '-',
    { label: 'Files', icon: 'folder', run: () => navigate(projectPath(p.id, 'files')) },
    { label: 'Open in File Explorer', icon: 'folder', disabled: !p.exists, run: () => attempt(() => api.post(projectUrl(p.id, '/reveal'))) },
    { label: 'Copy path', icon: 'file', run: () => copyText(p.path, toast) },
    '-',
    { label: 'Remove from FlintBench', icon: 'trash', danger: true, run: () => removeProject(p) },
  ];
}

/** Opens the project with its terminals restored (the project view performs the resume). */
/** The one Resume (lib/resume.js), then the project with its terminal panel open. */
export async function resumeProject(p) {
  const r = await resumeWork(p.id);
  if (!r) return;
  navigate(projectPath(p.id, 'workspace'));
  if (r.agentTerminal) setTimeout(() => window.dispatchEvent(new CustomEvent('flintbench:show-tab', { detail: { projectId: p.id, tabId: r.agentTerminal.id } })), 0);
}

function changesText(g) {
  if (!g?.isRepo) return { text: 'no git', cls: 'faint' };
  const branch = g.detached ? 'detached' : g.branch;
  return { text: g.changed ? `${branch} · ${plural(g.changed, 'change')}` : `${branch} · clean`, cls: g.changed ? 'change-text' : 'dim' };
}

const LIVE_WINDOW = 10 * 60_000;

/** A project is active while an agent works on it, a service runs, or its files changed in the last 10 minutes. */
function isLive(p, now = Date.now()) {
  return p.exists && Boolean(p.agents?.active?.length || p.editors?.length || p.running || now - (p.activity?.lastFileChangeAt ?? 0) < LIVE_WINDOW);
}

/** What is running for a project: "localhost:3000", "web, api", "2 containers"… or null. */
function runningText(p) {
  if (!p.running) return null;
  const port = p.runtime?.ports?.[0];
  const services = (p.runtime?.services ?? []).filter((x) => x.status === 'running').map((x) => x.name);
  const containers = p.docker?.running ?? 0;
  const parts = [services.length ? services.join(', ') : null, containers ? plural(containers, 'container') : null].filter(Boolean);
  return [parts.join(' · ') || (port ? null : 'process'), port ? `localhost:${port}` : null].filter(Boolean).join(' · ');
}

/**
 * The live signal, in the style of the tool at work: Claude Code's spark (the glyphs it cycles
 * while it thinks), a dot flipping full and empty for Codex (quick, then slow), the braille spinner of Google's CLIs for Antigravity
 * and Gemini, a blinking text cursor for files edited by hand or in an editor. A grey dot at rest.
 * Frame sequences are stacked glyphs, each shown for its tenth of the cycle (CSS).
 */
const FRAMES = {
  claude: { glyphs: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'], cycle: 2 }, // 200 ms a glyph
  // a full and an empty dot, quick then slow: four 200 ms flips, then 600 ms on and 600 ms off
  codex: { glyphs: ['●', '○', '●', '○', '●', '●', '●', '○', '○', '○'], cycle: 2 },
  // 8-dot cells: one dot missing goes round, the ink keeps its place (6-dot frames jump up and down)
  braille: { glyphs: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷', '⣾', '⣽'], cycle: 1 },
};
const SIGNAL_OF = { claude: 'claude', codex: 'codex', antigravity: 'braille', gemini: 'braille', edit: 'caret' };

function liveSignal(kind) {
  if (kind === 'idle') return h('span.live-signal.is-idle', { 'aria-hidden': 'true' }, '·');
  const look = SIGNAL_OF[kind] ?? 'claude';
  const frames = FRAMES[look];
  if (frames) {
    return h(`span.live-signal.is-frames.is-${look}`, { 'aria-hidden': 'true' },
      frames.glyphs.map((g, i) => h('span', { style: { animationDuration: `${frames.cycle}s`, animationDelay: `${((i * frames.cycle) / 10 - frames.cycle).toFixed(2)}s` } }, g)));
  }
  return h(`span.live-signal.is-${look}`, { 'aria-hidden': 'true' }, '▍');
}

function liveModel(p, now) {
  const agents = p.agents?.active ?? [];
  const editors = p.editors ?? [];
  const tools = [...new Set(agents.map((s) => s.agent)), ...editors.map((e) => e.id)];
  const names = [...new Set(agents.map((s) => s.agentName)), ...editors.map((e) => e.name)];
  const since = Math.min(...agents.map((s) => s.startedAt), ...editors.map((e) => e.since ?? Infinity));
  const changing = now - (p.activity?.lastFileChangeAt ?? 0) < LIVE_WINDOW;
  const moving = projectMoving(p, now);
  const service = runningText(p);
  const g = p.git;
  const what = names.length
    ? `${names.join(' + ')}${Number.isFinite(since) ? ` · ${duration(now - since)}` : ''}${moving ? '' : ' · idle'}`
    : changing ? `${moving ? 'Files changing' : 'Files changed'} · ${ago(p.activity.lastFileChangeAt)}` : `Running · ${service}`;
  // which tool's signal: the agent answering, else files changing by hand or in an editor
  const answering = agents.find((s) => agentWorking(s, now));
  const signal = !moving ? 'idle' : answering ? answering.agent : 'edit';
  return {
    name: p.name,
    tools,
    signal,
    tone: agents[0] ? agents[0].agent : editors[0] ? editors[0].id : changing ? '' : 'running',
    working: Boolean(names.length || changing),
    // the bars move while an agent answers or files change; they rest while the tools wait
    idle: Boolean(names.length || changing) && !moving,
    what,
    service: names.length || changing ? service : null,
    meta: changesText(g).text,
  };
}

function liveCard(p, m, isNew) {
  const card = h(`a.live-card${m.tone ? `.is-${m.tone}` : ''}${m.idle ? '.is-idle' : m.working ? '.is-moving' : ''}${isNew ? '.is-new' : ''}`, { href: projectPath(p.id), 'aria-label': `${p.name}: ${m.idle ? 'open, idle' : 'active'}, ${m.what}${m.service ? `, running ${m.service}` : ''}. Right-click for VS Code and agent sessions.` },
    h('div.live-top', m.tools.length ? toolMarks(m.tools, 18) : icon(m.working ? 'activity' : 'play', 15), h('strong.ellipsis', p.name), h('span.spacer'), m.working ? liveSignal(m.signal) : null),
    h('div.live-what', m.what),
    m.service ? h('div.live-svc', statusDot('ok', 'Service running'), h('span.ellipsis', `Running · ${m.service}`)) : null,
    h('div.live-meta.mono', m.meta));
  contextMenu(card, () => projectMenuItems(store.project(p.id) ?? p), { label: `${p.name} tools` });
  return card;
}

/**
 * "Active": the projects being worked on or running right now. Cards are patched in place —
 * an unchanged card keeps its element, so its bars and colours never restart on updates.
 */
function liveStrip() {
  const grid = h('div.live-grid');
  const el = h('section.indev', { 'aria-label': 'Projects active now', hidden: true }, grid);
  let cards = new Map(); // id -> { sig, card }
  return {
    el,
    update(all) {
      const now = Date.now();
      const live = all.filter((p) => isLive(p, now)).sort((a, b) => (b.agents?.active?.length ?? 0) - (a.agents?.active?.length ?? 0)
        || Number(Boolean(b.running)) - Number(Boolean(a.running))
        || (b.activity?.lastFileChangeAt ?? 0) - (a.activity?.lastFileChangeAt ?? 0));
      el.hidden = !live.length;
      const next = new Map();
      live.slice(0, 6).forEach((p, i) => {
        const m = liveModel(p, now);
        const sig = JSON.stringify({ ...m, what: '' }); // the timer text alone is patched, not rebuilt
        const old = cards.get(p.id);
        const card = old?.sig === sig ? old.card : liveCard(p, m, !old);
        if (old && old.card !== card) old.card.replaceWith(card);
        const what = card.querySelector('.live-what');
        if (what.textContent !== m.what) what.textContent = m.what;
        if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] ?? null);
        next.set(p.id, { sig, card });
      });
      for (const [id, { card }] of cards) if (!next.has(id)) card.remove();
      cards = next;
    },
  };
}

function projectRow(p) {
  const now = nowState(p);
  const changes = changesText(p.git);
  const row = h(`article.prow${isLive(p) ? '.is-live' : ''}`, {
    tabindex: 0,
    dataset: { id: p.id },
    'aria-label': `${p.name}: ${now.text}`,
    onclick: () => navigate(projectPath(p.id)),
    onkeydown: (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter') navigate(projectPath(p.id));
      else if (e.key === 'r') resumeProject(p);
    },
  },
  h('div.cell.c-name',
    h('div.name', h('span.ellipsis', p.name)),
    h('div.meta', (p.stack ?? []).slice(0, 3).map((x) => h('span.tag', x)))),
  h('div.cell.c-now', h('div.line', now.marks?.length ? toolMarks(now.marks, 16) : statusDot(now.dot, now.text), h(`span.ellipsis.${now.cls}`, now.text))),
  h('div.cell.c-git', h('div.line', icon('branch', 13), h(`span.ellipsis.mono.${changes.cls}`, changes.text))),
  h('div.cell.c-time', h('div.line.dim', { title: p.activity?.lastActivityAt ? new Date(p.activity.lastActivityAt).toLocaleString() : 'No activity recorded yet' }, ago(p.activity?.lastActivityAt))),
  h('div.actions',
    p.running
      ? actionButton('Stop', () => stopProject(p), { cls: 'btn sm', title: `Stop ${p.name}` })
      : actionButton('Start', () => startProject(p), { cls: 'btn sm', title: canStart(p) ? `Start ${p.name}` : 'Nothing to start yet — define a service in the project', disabled: !p.exists || !canStart(p) }),
    actionButton('Resume', () => resumeProject(p), { cls: 'btn sm', title: 'Reopen the last agent conversation, start the services that were running and restore your terminals (r)', disabled: !p.exists }),
    h('span.prow-go', { 'aria-hidden': 'true' }, icon('chevron', 14))));
  contextMenu(row, () => projectMenuItems(p), { label: `${p.name} actions` });
  return row;
}

/**
 * Project Memory on Home: projects you stepped away from, most recent first, each
 * with its clue for picking it up again. Opening one shows its "Welcome back" briefing.
 */
function resumeStrip(all) {
  const now = Date.now();
  const away = all
    // a conversation cut off by a shutdown is listed right away, however recent
    // a conversation that just ended has its own notice above: not listed twice
    .filter((p) => !closedNotice(p, now))
    .filter((p) => p.exists && !isLive(p, now) && p.activity?.lastActivityAt && (now - p.activity.lastActivityAt >= AWAY_MS || p.agents?.cutOff))
    .sort((a, b) => b.activity.lastActivityAt - a.activity.lastActivityAt)
    .slice(0, 4);
  if (!away.length) return null;
  const clue = (p) => {
    const last = p.agents?.last;
    const cut = p.agents?.cutOff;
    if (cut) return [agentMark(cut.agent, 14), h('span.warn-text', `${cut.agentName} interrupted`)];
    if (last) return [agentMark(last.agent, 14), `Last with ${last.agentName}${last.task ? ` · ${last.task}` : ''}`];
    if (p.git?.lastCommit) return [icon('commit', 13), `“${p.git.lastCommit.subject}”`];
    return [icon('activity', 13), 'Files changed'];
  };
  return h('section.resume-strip', { 'aria-label': 'Pick up where you left off' },
    h('div.resume-title', h('span.label', 'Pick up where you left off')),
    h('div.resume-grid', away.map((p) => h('a.resume-card', { href: projectPath(p.id) },
      h('div.resume-top', h('strong.ellipsis', p.name), h('span.resume-away', ago(p.activity.lastActivityAt))),
      h('div.resume-clue', clue(p)),
      !p.git?.isRepo ? h('div.resume-open.faint', 'No git')
        : p.git.changed ? h('div.resume-open.change-text', `${plural(p.git.changed, 'file')} not committed`) : h('div.resume-open.faint', 'Everything committed')))));
}

/**
 * Agent conversations that just ended — cut off, closed mid-answer, or simply closed —
 * each with one click back into the same conversation. Shown while recent; dismissable.
 */
function closedStrip(all, onChange) {
  const now = Date.now();
  const items = all.map((p) => ({ p, n: closedNotice(p, now) })).filter((x) => x.n).sort((a, b) => b.n.endedAt - a.n.endedAt).slice(0, 4);
  if (!items.length) return null;
  const reopen = async (p, n) => {
    const r = await reopenConversation(p.id, n);
    if (r?.terminal) showTab(p, r.terminal.id);
  };
  return h('section.closed-strip', { 'aria-label': 'Conversations that just ended' },
    items.map(({ p, n }) => h(`div.agent-closed.is-${n.kind}`,
      h('span.agent-closed-ic', { 'aria-hidden': 'true' }, icon(n.kind === 'interrupted' ? 'st-warn' : 'st-info', 16)),
      h('div.agent-closed-text',
        h('strong', h('a', { href: projectPath(p.id) }, p.name), ' · ', n.title),
        h('span', agentMark(n.agent, 13), n.detail)),
      h('div.agent-closed-actions',
        actionButton(n.reopenLabel, () => reopen(p, n), { cls: `btn sm${n.kind === 'interrupted' ? ' primary' : ''}`, iconName: 'resume' }),
        h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Dismiss: ${p.name}, ${n.title}`, onclick: () => { dismissClosed(p, n); onChange(); } }, 'Dismiss')))));
}

/**
 * Projects whose folder is gone (profile Test): renamed or moved — found again by the server, to
 * confirm — or not found, to locate. Listed first: until then the project cannot be worked on.
 */
function movedStrip(all) {
  const missing = all.filter((p) => !p.exists).sort((a, b) => Number(Boolean(b.relocation)) - Number(Boolean(a.relocation)));
  if (!missing.length) return null;
  return h('section.closed-strip', { 'aria-label': 'Projects whose folder moved' },
    missing.map((p) => {
      const t = relocationText(p);
      return h('div.agent-closed.is-interrupted',
        h('span.agent-closed-ic', { 'aria-hidden': 'true' }, icon('folder', 16)),
        h('div.agent-closed-text',
          h('strong', h('a', { href: projectPath(p.id) }, t.title)),
          h('span', t.detail)),
        h('div.agent-closed-actions', relocationActions(p)));
    }));
}

// Folders hidden from the Home inbox with "Ignore": still detected, still listed in Projects (this browser)
const HIDDEN_CANDIDATES = 'home.hiddenCandidates';
const candidateKey = (path) => path.replace(/[\\/]+$/, '').toLowerCase();

/**
 * New projects detected. Ignore only takes one off this inbox (it stays in Projects › Detected,
 * not added); Skip in scans is the separate, lasting choice: FlintBench stops looking at the folder.
 */
/** The detected folders the Home inbox shows: the ones not hidden with Ignore (the rail badge counts these). */
export function visibleCandidates(all = store.state.candidates) {
  const hidden = new Set(prefs.get(HIDDEN_CANDIDATES, []));
  return all.filter((c) => !hidden.has(candidateKey(c.path)));
}

function candidateInbox(all) {
  const hidden = new Set(prefs.get(HIDDEN_CANDIDATES, []));
  const candidates = visibleCandidates(all);
  if (!candidates.length) return null;
  const add = (paths) => attempt(() => api.post('/api/candidates/add', { paths }), { success: `Added ${plural(paths.length, 'project')}`, failure: 'Could not add project' });
  const hide = (path) => {
    prefs.set(HIDDEN_CANDIDATES, [...hidden, candidateKey(path)].slice(-500));
    notify('candidates'); // the inbox and the rail badge both follow
  };
  const skip = async (paths) => {
    const r = await attempt(() => api.post('/api/candidates/ignore', { paths }), { failure: 'Could not skip the folder in scans' });
    if (r) store.set('ignored', r.ignored);
  };
  return h('section.inbox', { 'aria-label': 'New projects detected' },
    h('div.inbox-head',
      h('span.inbox-badge', { 'aria-hidden': 'true' }, icon('plus', 16)),
      h('div.inbox-title',
        h('strong', candidates.length === 1 ? 'New project detected' : `${candidates.length} new projects detected`),
        h('span', 'Found in your project folders. Ignore hides one from here (it stays in Projects); Skip in scans stops FlintBench looking at that folder.')),
      h('span.spacer'),
      candidates.length > 1 ? actionButton(`Add all ${candidates.length}`, () => add(candidates.map((c) => c.path)), { cls: 'btn' }) : null),
    candidates.slice(0, 8).map((c) => h('div.inbox-row',
      h('span.inbox-icon', { 'aria-hidden': 'true' }, icon('folder', 17)),
      h('div', { style: { minWidth: 0 } },
        h('div.inbox-name', h('strong', c.name), c.stack.map((s) => h('span.tag', s))),
        h('div.path.ellipsis', { title: c.path }, c.path)),
      h('div.inbox-actions',
        h('button.btn.ghost', { type: 'button', title: 'Hide it from Home; it stays in Projects › Detected, not added', onclick: () => hide(c.path) }, 'Ignore'),
        actionButton('Skip in scans', () => skip([c.path]), { cls: 'btn ghost', title: 'Never offer this folder again (undo in Settings › Project directories)' }),
        actionButton('Add project', () => add([c.path]), { cls: 'btn primary' })))),
    candidates.length > 8 ? h('a.inbox-more', { href: '/projects' }, `${candidates.length - 8} more in Projects`) : null);
}

export function mount(container) {
  const filterKey = 'home.filter';
  const sortKey = 'home.sort';
  let filter = prefs.get(filterKey, 'all');
  let sort = prefs.get(sortKey, 'recent');
  let query = '';

  const telemetry = h('div.telemetry');
  const live = liveStrip();
  const resume = h('div');
  const closed = h('div');
  const moved = h('div');
  const inbox = h('div');
  const rows = h('div');
  const search = h('input.input', { type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects', 'data-search': true, spellcheck: false });
  const sortMenu = selectMenu({
    label: 'Sort projects by', prefix: 'Sort', width: '220px', value: sort,
    options: [{ value: 'recent', text: 'Recent activity' }, { value: 'status', text: 'Status' }, { value: 'name', text: 'Name' }],
    onChange: (v) => { sort = v; prefs.set(sortKey, sort); render(); },
  });
  const title = h('h1.greet');
  const summary = h('p.summary');

  const view = h('div.view', h('div.view-inner',
    h('header.page-head.home-head',
      h('div', title, summary),
      h('span.spacer'),
      actionButton('Scan', async () => { await attempt(() => api.post('/api/projects/scan'), { success: 'Scan complete' }); }, { cls: 'btn lg', iconName: 'refresh', title: 'Rescan project directories' }),
      h('a.btn.primary.lg', { href: '/projects' }, icon('plus', 16), 'Add project')),
    moved,
    closed,
    live.el,
    resume,
    telemetry,
    inbox,
    // what to show is chosen in the counters above (each one filters); here: search, then order
    h('div.toolbar', h('label.search', icon('search', 14), search, h('kbd', '/')), sortMenu.el),
    rows));
  container.append(view);
  let firstPaint = true;
  const previous = new Map(); // telemetry label -> last value, to flash real changes only

  function filtered() {
    let list = [...store.state.projects.values()];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((p) => `${p.name} ${p.path} ${p.stack?.join(' ')} ${p.git?.branch ?? ''}`.toLowerCase().includes(q));
    if (filter === 'running') list = list.filter((p) => p.running);
    if (filter === 'agents' && agentsInUse()) list = list.filter((p) => p.agents?.active?.length);
    if (filter === 'attention') list = list.filter((p) => p.needsAttention || !p.exists);
    if (filter === 'dirty') list = list.filter((p) => p.git?.changed);
    const rank = (p) => (p.agents?.active?.length ? 0 : p.running ? 1 : p.needsAttention ? 2 : 3);
    list.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'status') return rank(a) - rank(b) || (b.activity?.lastActivityAt ?? 0) - (a.activity?.lastActivityAt ?? 0);
      return (b.activity?.lastActivityAt ?? 0) - (a.activity?.lastActivityAt ?? 0) || a.name.localeCompare(b.name);
    });
    return list;
  }

  function setFilter(f) {
    filter = f;
    prefs.set(filterKey, f);
    render();
  }

  // the cards change with time too (files quiet for 2 minutes: idle; for 10: no longer active):
  // render again the moment the next of those thresholds is crossed, not at the next minute
  let edge = 0;
  function scheduleEdge(all) {
    clearTimeout(edge);
    const now = Date.now();
    const next = Math.min(...all.flatMap((p) => {
      const t = p.activity?.lastFileChangeAt ?? 0;
      return [t + FILES_MOVING_MS, t + LIVE_WINDOW].filter((x) => x > now);
    }));
    if (Number.isFinite(next) && next - now < 60_000) edge = setTimeout(render, next - now + 50);
  }

  function render() {
    const all = [...store.state.projects.values()];
    // the profile decides whether Home shows the live strip and the counters
    if (has('home.live')) live.update(all);
    else live.el.hidden = true;
    scheduleEdge(all);
    replace(resume, resumeStrip(all));
    replace(closed, closedStrip(all, render));
    replace(moved, movedStrip(all));
    const running = all.filter((p) => p.running).length;
    const attention = all.filter((p) => p.needsAttention || !p.exists).length;
    const agents = all.reduce((n, p) => n + (p.agents?.active?.length ?? 0), 0);
    const inEditor = all.filter((p) => p.editors?.length).length;
    const dirty = all.filter((p) => p.git?.changed).length;
    const roots = store.state.settings?.roots ?? [];
    const now = new Date();
    title.textContent = greeting(now, store.state.auth?.username);
    const parts = [
      running ? `${plural(running, 'project')} running` : null,
      agents && agentsInUse() ? `${plural(agents, 'agent')} at work` : null,
      inEditor ? `${plural(inEditor, 'project')} open in VS Code` : null,
      attention ? `${attention} need${attention === 1 ? 's' : ''} attention` : null,
      dirty ? `${dirty} with uncommitted changes` : null,
    ].filter(Boolean);
    summary.textContent = all.length ? (parts.length ? `${parts.join(' · ')}.` : 'All quiet: nothing running, nothing waiting.') : 'No projects yet.';

    const cell = (label, value, cls, f, unit) => {
      const changed = previous.has(label) && previous.get(label) !== value;
      previous.set(label, value);
      return h(`button.tcell${cls ? `.${cls}` : ''}${changed ? '.flash' : ''}`, { type: 'button', onclick: () => setFilter(filter === f ? 'all' : f), 'aria-pressed': String(filter === f), title: `Show ${label.toLowerCase()}` },
        h('span.label', label), h('span.value', String(value), unit ? h('small', unit) : null));
    };
    telemetry.hidden = !has('home.counters');
    replace(telemetry,
      cell('Projects', all.length, '', 'all'),
      cell('Running', running, running ? 'is-ok' : '', 'running'),
      cell('Need attention', attention, attention ? 'is-warn' : '', 'attention'),
      agentsInUse() ? cell('Agents active', agents, agents ? 'is-agent' : '', 'agents') : null,
      cell('Uncommitted', dirty, '', 'dirty'));

    replace(inbox, candidateInbox(store.state.candidates));

    if (!roots.length && !all.length) {
      replace(rows, h('div.empty-state',
        h('h3', 'Point FlintBench at your code'),
        h('p', 'Add the folders where your projects live (for example C:\\Dev or ~/Projects). FlintBench scans them for Git repositories and project files, and keeps watching for new ones.'),
        addRootForm()));
      return;
    }
    const list = filtered();
    const focusedId = document.activeElement?.closest?.('.prow')?.dataset.id;
    if (!list.length) {
      replace(rows, h('div.empty-state', h('h3', all.length ? 'No projects match' : 'No projects added yet'), h('p', all.length ? 'Change the filter or search.' : 'Add detected projects above, or add one by path in Projects.')));
      return;
    }
    replace(rows, h(`div.prows${firstPaint ? '.enter' : ''}`, { role: 'list', 'aria-label': 'Projects' },
      h('div.prows-head', { 'aria-hidden': 'true' }, h('span.label', 'Project'), h('span.label.c-now', 'Now'), h('span.label.c-git', 'Branch'), h('span.label.c-time', 'Last activity'), h('span.actions-pad')),
      list.map((p, i) => {
        const row = projectRow(p);
        row.setAttribute('role', 'listitem');
        row.style.setProperty('--i', String(Math.min(i, 7)));
        return row;
      })));
    firstPaint = false;
    if (focusedId) rows.querySelector(`.prow[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }

  rows.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key) || !e.target.classList.contains('prow')) return;
    e.preventDefault();
    const all = [...rows.querySelectorAll('.prow')];
    const idx = all.indexOf(e.target);
    const next = all[(e.key === 'ArrowDown' || e.key === 'j') ? Math.min(all.length - 1, idx + 1) : Math.max(0, idx - 1)];
    next?.focus();
  });
  search.addEventListener('input', () => { query = search.value; render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows.querySelector('.prow')?.focus();
    } else if (e.key === 'Escape') {
      search.value = '';
      query = '';
      render();
    }
  });

  const unsub = subscribe(['projects', 'candidates', 'settings', 'agents'], render);
  const tick = setInterval(render, 60_000);
  render();
  return {
    destroy() {
      unsub();
      clearInterval(tick);
      clearTimeout(edge);
    },
  };
}
