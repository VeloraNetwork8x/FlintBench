import { Terminal } from '/vendor/xterm/xterm.mjs';
import { FitAddon } from '/vendor/xterm/addon-fit.mjs';
import { WebglAddon } from '/vendor/xterm/addon-webgl.mjs';
import { h, icon, replace } from '../lib/dom.js';
import { store, subscribe, prefs } from '../lib/store.js';
import { api, projectUrl } from '../lib/api.js';
import { attachPty, detachPty, send } from '../lib/ws.js';
import { attempt, confirmDialog, promptDialog, toast } from '../lib/ui.js';
import { moveToTerminal } from '../views/project/agent-panel.js';
import { clock } from '../lib/format.js';
import { agentMark } from '../lib/agent-icons.js';
import { contextMenu, openMenu } from '../lib/menu.js';
import { transcriptView, refreshTranscript, disposeTranscript, disposeAllTranscripts, onTranscriptResumed } from './transcript.js';

// xterm instances outlive views: switching tabs or projects keeps scrollback and state.
const instances = new Map(); // terminalId -> { term, fit, el, opened, exitNoted }

/**
 * The terminal on screen draws with WebGL (the GPU): agents' interfaces redraw many times a second
 * and the DOM renderer made typing lag. One at a time: a page gets few WebGL contexts and a hidden
 * terminal has nothing to draw. Without WebGL, or after a lost context, xterm draws with the DOM.
 */
let webglOn = null; // { inst, addon }

function dropWebgl() {
  const on = webglOn;
  webglOn = null;
  try { on?.addon.dispose(); } catch { /* already gone with its terminal */ }
}

function useWebgl(inst) {
  if (webglOn?.inst === inst) return;
  dropWebgl();
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => { if (webglOn?.addon === addon) dropWebgl(); });
    inst.term.loadAddon(addon);
    webglOn = { inst, addon };
  } catch { /* no WebGL here: the DOM renderer stays */ }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function xtermTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  // a contemporary, softly saturated palette tuned to the app surfaces (not the classic console colours)
  return light ? {
    background: cssVar('--surface'),
    foreground: '#24262b',
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--surface'),
    selectionBackground: 'rgba(47,95,208,0.20)',
    black: '#24262b', brightBlack: '#6e727c',
    red: '#c8414f', brightRed: '#dc5a67',
    green: '#2f8a4b', brightGreen: '#3a9f59',
    yellow: '#a6700c', brightYellow: '#bd8414',
    blue: '#3563d4', brightBlue: '#4b77e3',
    magenta: '#7a55d6', brightMagenta: '#8d6ae3',
    cyan: '#1b8597', brightCyan: '#2499ac',
    white: '#c9cbd1', brightWhite: '#ffffff',
  } : {
    background: cssVar('--surface'),
    foreground: '#e3e5ea',
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--surface'),
    selectionBackground: 'rgba(143,180,255,0.24)',
    black: '#2b2e35', brightBlack: '#6b7080',
    red: '#ff7b86', brightRed: '#ff9aa2',
    green: '#7ad29a', brightGreen: '#97e2b2',
    yellow: '#f0c674', brightYellow: '#f7d792',
    blue: '#8fb4ff', brightBlue: '#adc8ff',
    magenta: '#c7a6ff', brightMagenta: '#d8c0ff',
    cyan: '#76d3e0', brightCyan: '#9be3ec',
    white: '#cfd2d9', brightWhite: '#f5f6f8',
  };
}

// bundled: Geist Mono for text, the Nerd Font symbols for prompt icons (oh-my-posh, starship)
const BUNDLED_FONTS = ['Geist Mono', 'Symbols Nerd Font Mono', 'Cascadia Code', 'Consolas'];

/** The owner's own terminal font first (Windows Terminal / VS Code), the bundled ones behind it. */
function terminalFontFamily() {
  const host = store.state.terminalFont?.families ?? [];
  const families = [...host, ...BUNDLED_FONTS.filter((f) => !host.includes(f))];
  return `${families.map((f) => `"${f}"`).join(', ')}, monospace`;
}

/** A path as a terminal drop types it: quoted only when the shell would split or mangle it. */
function quotePath(p) {
  return /[\s"'`$&()<>|;,^%!]/.test(p) ? `"${p}"` : p;
}

/** Local paths behind file:// URIs (what editors such as VS Code put on a drag), else none. */
function droppedPaths(dt) {
  const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).map((u) => u.trim()).filter((u) => /^file:\/\//i.test(u));
  return uris.map((u) => {
    const url = new URL(u);
    const p = decodeURIComponent(url.pathname);
    // file:///C:/x → C:\x on Windows; file://server/share → \\server\share
    if (store.state.platform !== 'win32') return p;
    if (url.host) return `\\\\${url.host}${p.replace(/\//g, '\\')}`;
    return p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
  });
}

/**
 * Files dropped or pasted onto a terminal, typed into it as paths (as a native terminal does on a
 * drop, so an agent such as Claude Code picks them up). The browser never says where a file lives:
 * the server finds the real file on this machine from its name, size and time. Only one it cannot
 * find (a pasted screenshot) is copied into the project's FlintBench data, and the copy's path typed.
 */
async function attachFiles(id, term, files) {
  const located = await api.post(`/api/terminals/${id}/locate`, {
    files: files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified })),
  }).then((r) => r.paths, () => []);
  const missing = files.filter((_, i) => !located[i]);
  if (missing.reduce((n, f) => n + f.size, 0) > 8 * 1024 * 1024) toast(`Copying ${missing.length === 1 ? missing[0].name : `${missing.length} files`}…`);
  const paths = [];
  for (const [i, file] of files.entries()) {
    if (located[i]) {
      paths.push(located[i]);
      continue;
    }
    try {
      const r = await api.post(`/api/terminals/${id}/attachments?name=${encodeURIComponent(file.name || 'file')}`, file);
      paths.push(r.path);
    } catch (error) {
      toast(`Could not attach ${file.name || 'the file'}`, { kind: 'err', detail: error.message });
    }
  }
  // a pasted picture has no place of its own; a dropped file that was not found is worth saying
  const copied = missing.filter((f) => !(f.type.startsWith('image/') && Date.now() - f.lastModified < 10_000));
  if (copied.length) toast(`${copied.length === 1 ? `${copied[0].name} was` : `${copied.length} files were`} not found on disk: a copy is attached`, { kind: 'warn' });
  if (paths.length) term.paste(`${paths.map(quotePath).join(' ')} `);
  term.focus();
}

function wireDrops(id, term, el) {
  const accepts = (dt) => dt && [...dt.types].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain');
  let depth = 0;
  const leave = () => { depth = 0; el.classList.remove('drop-target'); };
  el.addEventListener('dragenter', (e) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    el.classList.add('drop-target');
  });
  el.addEventListener('dragover', (e) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => { if (--depth <= 0) leave(); });
  el.addEventListener('drop', (e) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    leave();
    const dt = e.dataTransfer;
    const local = droppedPaths(dt);
    if (local.length) {
      term.paste(`${local.map(quotePath).join(' ')} `);
      term.focus();
      return;
    }
    const files = [...dt.files];
    if (files.length) return attachFiles(id, term, files);
    const text = dt.getData('text/plain');
    if (text) {
      term.paste(text);
      term.focus();
    }
  });
  // a picture on the clipboard (a screenshot) pasted with Ctrl+V: attached like a dropped file
  el.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    e.stopPropagation();
    attachFiles(id, term, files);
  }, true);
}

function instance(id) {
  let inst = instances.get(id);
  if (inst) return inst;
  const term = new Terminal({
    fontFamily: terminalFontFamily(),
    fontSize: 13,
    lineHeight: 1.35,
    fontWeight: '400',
    fontWeightBold: '600',
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    cursorInactiveStyle: 'none',
    drawBoldTextInBrightColors: false,
    scrollback: 5000,
    theme: xtermTheme(),
    allowProposedApi: false,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    // app shortcuts pass through the terminal
    if ((e.ctrlKey || e.metaKey) && (e.key === '`' || (e.shiftKey && ['p', 'l'].includes(k)))) return false;
    if (e.altKey && /^[1-5]$/.test(e.key)) return false;
    // copy with a selection, paste via the browser
    if ((e.ctrlKey || e.metaKey) && k === 'c' && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'v') return false;
    // Ctrl+Enter / Shift+Enter: a new line in the message, not "send" (a line feed, as Ctrl+J:
    // Claude Code and Codex take it as a line break; plain Enter still sends)
    if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey) && !e.altKey && !e.metaKey) {
      e.preventDefault();
      send({ t: 'pty.in', id, d: '\n' });
      return false;
    }
    return true;
  });
  term.onData((d) => send({ t: 'pty.in', id, d }));
  // web links (and bare localhost:port from dev servers): underlined on hover, open on click / Ctrl+click
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const links = [];
      const re = /\bhttps?:\/\/[^\s"'<>`]+|\b(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/[^\s"'<>`]*)?/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const raw = m[0].replace(/[.,;:!?)\]}]+$/, '');
        const url = /^https?:/i.test(raw) ? raw : `http://${raw}`;
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + raw.length, y } },
          text: url,
          activate: () => window.open(url, '_blank', 'noopener,noreferrer'),
        });
      }
      callback(links.length ? links : undefined);
    },
  });
  const el = h('div.dock-term');
  wireDrops(id, term, el);
  inst = { term, fit, el, opened: false, exitNoted: false };
  instances.set(id, inst);
  attachPty(id, {
    out: (d) => term.write(d),
    replay: (d) => {
      term.reset();
      term.write(d);
      inst.exitNoted = false;
      noteExit(id);
    },
  });
  return inst;
}

function noteExit(id) {
  const inst = instances.get(id);
  const t = store.state.terminals.get(id);
  if (!inst || !t?.exited || inst.exitNoted) return;
  inst.exitNoted = true;
  inst.term.write(t.stoppedByUser ? '\r\n\x1b[2m[stopped]\x1b[0m\r\n' : `\r\n\x1b[2m[process exited with code ${t.exitCode}]\x1b[0m\r\n`);
}

function disposeTerminal(id) {
  const inst = instances.get(id);
  if (!inst) return;
  detachPty(id);
  if (webglOn?.inst === inst) dropWebgl();
  inst.term.dispose();
  inst.el.remove();
  instances.delete(id);
}

export function disposeAllTerminals() {
  for (const id of [...instances.keys()]) disposeTerminal(id);
  disposeAllTranscripts();
  transcriptsSeen.clear();
  transcriptsClosed.clear();
}

const KIND_ICON = { shell: 'terminal', service: 'play', agent: 'agent', transcript: 'eye' };
const selectedByProject = new Map();
// external Claude Code sessions shown as read-only conversation tabs
const transcriptsSeen = new Map(); // projectId -> Map(sessionId -> session); ended ones stay until closed
const transcriptsClosed = new Map(); // projectId -> Set(sessionId) closed by the user while live

/**
 * Terminal dock for one project. Real PTYs (server side), xterm.js here.
 */
export function createDock(projectId) {
  // an empty dock only takes space: start reduced to its bar until there is something to show
  let collapsed = prefs.get('dock.collapsed', false) || (!store.projectTerminals(projectId).length && !(store.state.projects.get(projectId)?.agents?.active ?? []).some((s) => s.source === 'external' && s.agentSessionId && !s.terminalId));
  let maximized = false;
  let height = prefs.get('dock.h', Math.max(280, Math.round(window.innerHeight * 0.4)));
  const tabs = h('div.dock-tabs', { role: 'tablist', 'aria-label': 'Terminals' });
  const body = h('div.dock-body');
  const toggleBtn = h('button.btn.sm.icon.ghost', { type: 'button', title: 'Toggle terminal (Ctrl+`)', onclick: () => toggle() });
  const maxBtn = h('button.btn.sm.icon.ghost', { type: 'button', title: 'Maximize terminal', onclick: () => { maximized = !maximized; layout(); fitActive(); } }, icon('maximize', 13));
  const resizer = h('div.dock-resizer', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize terminal', tabindex: 0 });
  const el = h('section.dock', { 'aria-label': 'Terminal' },
    resizer,
    h('div.dock-bar',
      h('span.label', { style: { margin: '0 8px 0 4px' } }, 'Terminal'),
      tabs,
      h('button.btn.sm.icon.ghost', { type: 'button', title: 'New terminal or agent', 'aria-haspopup': 'menu', onclick: (e) => openNewMenu(e.currentTarget) }, icon('plus', 14)),
      h('button.btn.sm.ghost', { type: 'button', title: 'Run a command in a new tab', onclick: () => runCommand() }, icon('play', 11), 'Run…'),
      h('span.spacer'),
      maxBtn,
      toggleBtn),
    body);
  // the resizer must sit above the bar inside the grid
  el.style.gridTemplateRows = 'auto auto minmax(0, 1fr)';

  function list() {
    return store.projectTerminals(projectId);
  }

  /** Conversation tabs: live external Claude Code sessions, plus ended ones not closed yet. */
  function transcriptTabs() {
    if (!transcriptsSeen.has(projectId)) transcriptsSeen.set(projectId, new Map());
    if (!transcriptsClosed.has(projectId)) transcriptsClosed.set(projectId, new Set());
    const seen = transcriptsSeen.get(projectId);
    const closed = transcriptsClosed.get(projectId);
    const sessions = store.state.projects.get(projectId)?.agents?.active ?? [];
    // a session running inside one of our terminals is already visible in that tab: never a second one
    for (const s of sessions) {
      if (s.terminalId && seen.has(s.id)) {
        seen.delete(s.id);
        disposeTranscript(s.id);
      }
    }
    const active = sessions.filter((s) => s.source === 'external' && ['claude', 'codex', 'antigravity'].includes(s.agent) && s.agentSessionId && !s.terminalId);
    const activeIds = new Set(active.map((s) => s.id));
    for (const id of [...closed]) if (!activeIds.has(id)) closed.delete(id);
    for (const s of active) if (!closed.has(s.id)) seen.set(s.id, s);
    for (const [id, s] of seen) {
      if (!activeIds.has(id) && s.live !== false) seen.set(id, { ...s, live: false, endedAt: s.endedAt ?? Date.now() });
    }
    return [...seen.values()].map((s) => ({ id: `tx:${s.id}`, kind: 'transcript', name: `${s.agentName} · ${clock(s.startedAt)}`, session: s, exited: s.live === false }));
  }

  function allTabs() {
    return [...list(), ...transcriptTabs()];
  }

  function tabsSignature(all, current) {
    return all.map((t) => `${t.id}:${t.name}:${t.exited}:${t.exitCode}`).join('|') + `>${current?.id}`;
  }

  function selected() {
    const all = allTabs();
    const id = selectedByProject.get(projectId);
    // after a close, fall back to the last real terminal before any conversation tab
    return all.find((t) => t.id === id) ?? list().at(-1) ?? all.at(-1) ?? null;
  }

  function layout() {
    el.classList.toggle('collapsed', collapsed);
    el.classList.toggle('maximized', maximized && !collapsed);
    el.style.setProperty('--dock-h', `${height}px`);
    replace(toggleBtn, icon(collapsed ? 'up' : 'down', 14));
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  let tabsKey = '';
  function renderTabs() {
    const all = allTabs();
    const current = selected();
    tabsKey = tabsSignature(all, current);
    replace(tabs, all.map((t) => {
      const conversation = t.kind === 'transcript';
      const close = h('span.x', { role: 'button', tabindex: -1, 'aria-label': `Close ${t.name}`, title: t.exited ? 'Remove' : 'Close' }, icon('x', 11));
      close.addEventListener('click', (e) => { e.stopPropagation(); if (conversation) closeTranscript(t); else closeTerminal(t); });
      const tab = h(`button.dock-tab${t.exited ? '.exited' : ''}`, {
        type: 'button',
        role: 'tab',
        'aria-selected': String(current?.id === t.id),
        title: conversation
          ? `${t.name} — conversation, read-only${t.exited ? ' (ended)' : ''}`
          : `${t.name} — ${t.command}${t.exited ? (t.stoppedByUser ? ' (stopped)' : ` (exited ${t.exitCode})`) : ''}`,
        onclick: () => show(t.id),
        ondblclick: conversation ? undefined : () => rename(t),
      }, conversation ? agentMark(t.session.agent, 14) : t.kind === 'agent' && t.meta?.agentId ? agentMark(t.meta.agentId, 14) : icon(KIND_ICON[t.kind] ?? 'terminal', 12), h('span', t.name), !conversation && t.exited && t.exitCode && !t.stoppedByUser ? h('span.error-text.num', String(t.exitCode)) : null, close);
      if (t.kind === 'agent' || conversation) tab.style.color = current?.id === t.id ? '' : 'var(--agent)';
      contextMenu(tab, () => [
        { label: 'Show', icon: 'chevron', run: () => show(t.id) },
        conversation ? null : { label: 'Rename', icon: 'editor', run: () => rename(t) },
        { label: maximized ? 'Restore size' : 'Maximize', icon: 'maximize', run: () => { show(t.id, { focus: false }); maximized = !maximized; layout(); fitActive(); } },
        movableIn(t) ? { label: movableIn(t).moving === 'out' ? 'Cancel transfer' : 'Transfer to terminal', icon: 'external', run: () => moveToTerminal(t.id, movableIn(t)) } : null,
        '-',
        { label: conversation ? 'Close conversation' : t.exited ? 'Remove' : 'Close', icon: 'x', danger: !conversation && !t.exited, run: () => (conversation ? closeTranscript(t) : closeTerminal(t)) },
      ], { label: `${t.name} tab` });
      return tab;
    }));
  }

  let shownId = null;
  function renderBody() {
    const t = selected();
    shownId = t?.id ?? null;
    for (const child of [...body.children]) child.remove();
    if (t?.kind === 'transcript') {
      const view = transcriptView(t.session);
      body.append(view.el);
      view.shown();
      return;
    }
    if (!t) {
      body.append(h('div.dock-empty', h('div.stack', { style: { justifyItems: 'center' } },
        h('span', 'No terminal open for this project.'),
        h('button.btn.sm', { type: 'button', onclick: () => newTerminal() }, icon('plus', 13), 'New terminal'))));
      return;
    }
    const inst = instance(t.id);
    body.append(inst.el);
    if (!inst.opened) {
      inst.term.open(inst.el);
      inst.opened = true;
    }
    useWebgl(inst);
    noteExit(t.id);
    requestAnimationFrame(fitActive);
  }

  let fitTimer = 0;
  function fitActive() {
    const t = selected();
    const inst = t && instances.get(t.id);
    if (!inst?.opened || collapsed || !inst.el.isConnected) return;
    try {
      inst.fit.fit();
    } catch {
      return;
    }
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => send({ t: 'pty.resize', id: t.id, cols: inst.term.cols, rows: inst.term.rows }), 60);
  }

  function show(id, { focus = true } = {}) {
    selectedByProject.set(projectId, id);
    if (collapsed) {
      collapsed = false;
      prefs.set('dock.collapsed', false);
      layout();
    }
    renderTabs();
    renderBody();
    if (focus) requestAnimationFrame(() => instances.get(id)?.term.focus());
  }

  async function newTerminal(command, name) {
    const t = await attempt(() => api.post(projectUrl(projectId, '/terminals'), { name: name ?? `Terminal ${list().filter((x) => x.kind === 'shell').length + 1}`, command }), { failure: 'Could not open terminal' });
    if (t) {
      store.setTerminal(t);
      show(t.id);
    }
  }

  async function runCommand() {
    const cmd = await promptDialog({ title: 'Run command', label: 'Command (runs in the project folder, tab stays open)', placeholder: 'npm run dev', mono: true, confirm: 'Run' });
    if (cmd) newTerminal(cmd, cmd.split(/\s+/).slice(0, 3).join(' ').slice(0, 24));
  }

  /** "+": a plain terminal, a one-off command, or one of the installed agents started in this folder. */
  function openNewMenu(anchor) {
    const tools = (store.state.agents.tools ?? []).filter((t) => t.installed && t.launchable && t.enabled);
    openMenu([
      { label: 'New terminal', icon: 'terminal', run: () => newTerminal() },
      { label: 'Run command…', icon: 'play', run: () => runCommand() },
      tools.length ? '-' : null,
      ...tools.map((t) => ({
        label: `Start ${t.name}`,
        iconNode: agentMark(t.id, 14),
        run: async () => {
          const r = await attempt(() => api.post(projectUrl(projectId, `/agents/${t.id}/start`), { mode: 'new' }), { failure: `Could not start ${t.name}` });
          if (r?.terminal) store.setTerminal(r.terminal);
        },
      })),
    ], { anchor, label: 'New terminal or agent' });
  }

  async function rename(t) {
    const name = await promptDialog({ title: 'Rename tab', label: 'Name', value: t.name });
    if (name) {
      const next = await attempt(() => api.patch(`/api/terminals/${t.id}`, { name }));
      if (next) store.setTerminal(next);
    }
  }

  /**
   * The agent session running in this tab (launched here, or typed into a shell tab) when its
   * conversation can continue in a terminal window.
   */
  function movableIn(t) {
    if (t.kind === 'transcript' || t.exited) return null;
    const s = (store.state.projects.get(projectId)?.agents?.active ?? []).find((x) => x.terminalId === t.id);
    return s?.movable ? s : null;
  }

  function closeTranscript(t) {
    const id = t.session.id;
    transcriptsSeen.get(projectId)?.delete(id);
    if (t.session.live !== false) transcriptsClosed.get(projectId)?.add(id);
    disposeTranscript(id);
    if (selectedByProject.get(projectId) === t.id) selectedByProject.delete(projectId);
    renderTabs();
    renderBody();
  }

  async function closeTerminal(t) {
    if (!t.exited && t.kind !== 'shell') {
      const ok = await confirmDialog({ title: `Stop ${t.name}?`, body: t.kind === 'agent' ? 'The agent process will be terminated. Its session is kept in the journal.' : 'The service process tree will be terminated.', confirm: 'Stop', danger: true });
      if (!ok) return;
    }
    // the tab goes away at once; the process tree is stopped server side after removal
    disposeTerminal(t.id);
    store.removeTerminal(t.id);
    await attempt(() => api.del(`/api/terminals/${t.id}`), { failure: 'Could not close terminal' });
  }

  function toggle(force) {
    collapsed = typeof force === 'boolean' ? !force : !collapsed;
    prefs.set('dock.collapsed', collapsed);
    layout();
    if (!collapsed) {
      renderBody();
      const t = selected();
      if (t) requestAnimationFrame(() => instances.get(t.id)?.term.focus());
    }
  }

  // drag to resize
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const move = (ev) => {
      height = Math.max(120, Math.min(window.innerHeight - 160, startH + (startY - ev.clientY)));
      collapsed = false;
      maximized = false;
      layout();
    };
    const up = () => {
      resizer.classList.remove('dragging');
      resizer.removeEventListener('pointermove', move);
      prefs.set('dock.h', height);
      fitActive();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up, { once: true });
  });
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    height = Math.max(120, Math.min(window.innerHeight - 160, height + (e.key === 'ArrowUp' ? 24 : -24)));
    prefs.set('dock.h', height);
    layout();
    fitActive();
  });

  const ro = new ResizeObserver(() => fitActive());
  ro.observe(body);
  let known = new Set(list().map((t) => t.id));
  const unsub = subscribe('terminals', () => {
    const all = list();
    // a terminal created elsewhere for this project (service, agent, resume) becomes visible
    const fresh = all.filter((t) => !known.has(t.id));
    known = new Set(all.map((t) => t.id));
    for (const id of [...instances.keys()]) {
      if (!store.state.terminals.has(id)) disposeTerminal(id);
    }
    if (fresh.length && fresh.at(-1).kind !== 'service') {
      show(fresh.at(-1).id, { focus: fresh.at(-1).kind === 'agent' });
      return;
    }
    renderTabs();
    const t = selected();
    if (t) noteExit(t.id);
    if (t?.id !== shownId || (t && t.kind !== 'transcript' && !body.contains(instances.get(t.id)?.el))) renderBody();
  });
  // external sessions appear, end or resume with project state
  // "bring to the front" from Home: open the dock on the requested tab
  const onShowTab = (e) => {
    if (e.detail?.projectId !== projectId) return;
    const t = allTabs().find((x) => x.id === e.detail.tabId);
    if (t) show(t.id);
  };
  window.addEventListener('flintbench:show-tab', onShowTab);
  const offResumed = onTranscriptResumed((sessionId) => {
    const t = transcriptTabs().find((x) => x.session.id === sessionId);
    if (t) closeTranscript(t);
  });
  const unsubProjects = subscribe('projects', () => {
    const t = selected();
    const all = allTabs();
    // every open conversation follows its session (live → ended, pending "Resume here")
    for (const x of all) if (x.kind === 'transcript') refreshTranscript(x.session);
    if (tabsSignature(all, t) !== tabsKey) renderTabs();
    if (t?.id !== shownId) renderBody();
  });
  const unsubTheme = subscribe('settings', () => {
    requestAnimationFrame(() => instances.forEach((inst) => { inst.term.options.theme = xtermTheme(); }));
  });

  layout();
  renderTabs();
  renderBody();

  return {
    el,
    show,
    toggle,
    newTerminal,
    focus() {
      const t = selected();
      if (t) instances.get(t.id)?.term.focus();
    },
    open() { toggle(true); },
    destroy() {
      ro.disconnect();
      unsub();
      unsubProjects();
      offResumed();
      window.removeEventListener('flintbench:show-tab', onShowTab);
      unsubTheme();
      for (const child of [...body.children]) child.remove();
    },
  };
}
