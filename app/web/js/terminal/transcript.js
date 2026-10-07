import { h, icon } from '../lib/dom.js';
import { store, subscribe } from '../lib/store.js';
import { api, projectUrl } from '../lib/api.js';
import { attachTranscript, detachTranscript } from '../lib/ws.js';
import { attempt, confirmDialog, renderMarkdown, statusDot } from '../lib/ui.js';
import { clock } from '../lib/format.js';
import { moveHere } from '../views/project/agent-panel.js';

// Views outlive tab switches like xterm instances: scroll position and items are kept.
const views = new Map(); // FlintBench session id -> view
const resumedListeners = new Set();

/** Called with the FlintBench session id once "Resume here" moved a conversation into a PTY. */
export function onTranscriptResumed(fn) {
  resumedListeners.add(fn);
  return () => resumedListeners.delete(fn);
}
const MAX_NODES = 800;
const SHELL_PREVIEW = 3; // lines Claude Code shows before "… +N lines"
const DIFF_PREVIEW = 40;
const WRITE_PREVIEW = 10;

/**
 * Read-only, live view of an external Claude Code conversation, drawn the way Claude Code
 * draws it in its own terminal (> prompts, ⏺ entries, ⎿ results, numbered diffs) from the
 * structured data it records in its transcript. Input stays in the terminal where it runs.
 */
export function transcriptView(session) {
  let view = views.get(session.id);
  if (!view) {
    view = createView(session);
    views.set(session.id, view);
  }
  view.update(session);
  return view;
}

/** Keep an existing view in step with its session (live → ended) without creating one. */
export function refreshTranscript(session) {
  views.get(session.id)?.update(session);
}

export function disposeTranscript(id) {
  views.get(id)?.destroy();
  views.delete(id);
}

export function disposeAllTranscripts() {
  for (const id of [...views.keys()]) disposeTranscript(id);
}

/* ---------------- Claude Code rendering ---------------- */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function elapsed(ms) {
  const s = Math.round(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh) return `${hh}h ${mm}m ${ss}s`;
  return mm ? `${mm}m ${ss}s` : `${ss}s`;
}

function relative(file, root) {
  if (!file) return '';
  if (!root) return file;
  const norm = (p) => p.replaceAll('\\', '/');
  const f = norm(file);
  const r = norm(root).replace(/\/$/, '');
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : file;
}

const firstLine = (text, max = 160) => {
  const line = String(text ?? '').split('\n')[0];
  return line.length > max || String(text ?? '').includes('\n') ? `${line.slice(0, max)}…` : line;
};

/** Tool header as Claude Code prints it: Name(args). */
function toolHeader(item, root) {
  const i = item.input ?? {};
  const name = item.name;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return [`${mcp[1]} - ${mcp[2]} (MCP)`, item.summary || null];
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return [name, i.command ?? ''];
    case 'Read':
      return ['Read', relative(i.file_path, root)];
    case 'Edit':
    case 'MultiEdit':
      return ['Update', relative(i.file_path, root)];
    case 'Write':
      return ['Write', relative(i.file_path, root)];
    case 'NotebookEdit':
      return ['Edit Notebook', relative(i.notebook_path, root)];
    case 'Grep':
    case 'Glob':
      return ['Search', `pattern: "${i.pattern ?? ''}"${i.path ? `, path: "${relative(i.path, root)}"` : ''}`];
    case 'WebFetch':
      return ['Fetch', i.url ?? ''];
    case 'WebSearch':
      return ['Web Search', `"${i.query ?? ''}"`];
    case 'Task':
    case 'Agent':
      return [name, i.description ?? ''];
    case 'TodoWrite':
      return ['Update Todos', null];
    case 'Skill':
      return ['Skill', i.skill ?? ''];
    default:
      return [name, item.summary || null];
  }
}

function moreLine(n) {
  return h('div.cc-dim', `… +${n} ${n === 1 ? 'line' : 'lines'} (click to expand)`);
}

function textLines(text, limit, cls = '') {
  const lines = String(text).replace(/\s+$/, '').split('\n');
  const shown = limit ? lines.slice(0, limit) : lines;
  const nodes = [h(`div.cc-pre${cls}`, shown.join('\n'))];
  if (limit && lines.length > limit) nodes.push(moreLine(lines.length - limit));
  return nodes;
}

function diffRows(hunks, limit) {
  const rows = [];
  let total = 0;
  hunks.forEach((hunk, index) => {
    if (index > 0) rows.push(h('div.cc-dl.cc-gap', h('span.cc-ln', '⋮'), h('span'), h('span')));
    let oldN = hunk.oldStart;
    let newN = hunk.newStart;
    for (const line of hunk.lines) {
      total += 1;
      const sign = line[0];
      let n;
      if (sign === '-') n = oldN++;
      else if (sign === '+') n = newN++;
      else {
        n = newN++;
        oldN++;
      }
      if (limit && total > limit) continue;
      const cls = sign === '+' ? '.cc-add' : sign === '-' ? '.cc-del' : '';
      rows.push(h(`div.cc-dl${cls}`, h('span.cc-ln', String(n)), h('span.cc-sign', sign === '+' || sign === '-' ? sign : ' '), h('span.cc-code', line.slice(1))));
    }
  });
  const nodes = [h('div.cc-diff', rows)];
  if (limit && total > limit) nodes.push(moreLine(total - limit));
  return nodes;
}

/** The ⎿ block under a tool header: what Claude Code prints for this tool's result. */
function toolOutput(entry, root) {
  const { item, result, expanded } = entry;
  if (item.name === 'TodoWrite' && item.input?.todos) {
    return item.input.todos.map((t) => h(`div.cc-todo.is-${t.status}`, `${t.status === 'completed' ? '☒' : t.status === 'in_progress' ? '◼' : '☐'} ${t.content}`));
  }
  if (!result) return [h('div.cc-dim', item.name === 'Bash' || item.name === 'PowerShell' ? 'Running…' : 'Waiting…')];
  const d = result.data;
  if (result.isError && d?.kind !== 'shell') {
    const text = result.text || 'Error';
    return textLines(/^error/i.test(text) ? text : `Error: ${text}`, expanded ? 0 : SHELL_PREVIEW, '.cc-err');
  }
  if (d?.kind === 'patch' && d.type === 'create' && d.content) {
    const path = relative(d.filePath, root);
    const limit = expanded ? 0 : WRITE_PREVIEW;
    const head = limit ? d.content.head.slice(0, limit) : d.content.head;
    const rows = head.map((line, i) => h('div.cc-dl', h('span.cc-ln', String(i + 1)), h('span.cc-sign', ' '), h('span.cc-code', line)));
    const rest = d.content.lines - head.length;
    return [h('div', 'Wrote ', h('strong', String(d.content.lines)), ' lines to ', h('strong', path)), h('div.cc-diff', rows), rest > 0 ? moreLine(rest) : null];
  }
  if (d?.kind === 'patch') {
    const path = relative(d.filePath, root);
    const parts = [d.added ? plural(d.added, 'addition', 'additions') : null, d.removed ? plural(d.removed, 'removal', 'removals') : null].filter(Boolean);
    return [
      h('div', 'Updated ', h('strong', path), parts.length ? ` with ${parts.join(' and ')}` : ''),
      ...diffRows(d.hunks, expanded ? 0 : DIFF_PREVIEW),
      d.truncated && expanded ? h('div.cc-dim', '(diff truncated)') : null,
    ];
  }
  if (d?.kind === 'read') return [h('div', 'Read ', h('strong', String(d.numLines)), ` ${d.numLines === 1 ? 'line' : 'lines'}`)];
  if (d?.kind === 'search') {
    return [d.mode === 'content' && d.numLines !== null
      ? h('div', 'Found ', h('strong', String(d.numLines)), ` ${d.numLines === 1 ? 'line' : 'lines'}`)
      : h('div', 'Found ', h('strong', String(d.numFiles)), ` ${d.numFiles === 1 ? 'file' : 'files'}`)];
  }
  if (d?.kind === 'shell') {
    const limit = expanded ? 0 : SHELL_PREVIEW;
    const nodes = [];
    if (d.stdout.trim()) nodes.push(...textLines(d.stdout, limit));
    if (d.stderr.trim()) nodes.push(...textLines(d.stderr, limit, '.cc-err'));
    if (d.interrupted) nodes.push(h('div.cc-err', 'Interrupted by user'));
    return nodes.length ? nodes : [h('div.cc-dim', '(No content)')];
  }
  return result.text ? textLines(result.text, expanded ? 0 : SHELL_PREVIEW) : [h('div.cc-dim', '(No content)')];
}

/* ---------------- view ---------------- */

function createView(initial) {
  let session = initial;
  let stick = true;
  let disabled = false;
  let resumeWhenClosed = false;
  const tools = new Map(); // tool_use id -> entry
  const projectRoot = () => store.state.projects.get(session.projectId)?.path ?? null;

  const live = h('span.tx-live');
  const since = h('span.faint.num');
  const waiting = h('span.agent-text', { hidden: true }, 'Resumes here when it closes in the other terminal');
  const resumeBtn = h('button.btn.sm', { type: 'button', title: 'Continue this conversation in a FlintBench terminal', onclick: () => resume() }, icon('resume', 13), 'Resume here');
  const list = h('div.cc', { role: 'log', 'aria-label': `${session.agentName} conversation` });
  const scroller = h('div.tx-scroll', list);
  const jump = h('button.btn.sm.tx-jump', { type: 'button', hidden: true, onclick: () => toEnd() }, icon('down', 12), 'New messages');
  const el = h('div.tx',
    h('div.tx-head',
      live,
      h('strong', session.agentName),
      h('span.chip.agent', 'external'),
      h('span.faint.ellipsis', 'Read-only — reply in the terminal where it runs'),
      h('span.spacer'),
      waiting,
      since,
      session.agent === 'claude' || session.movable ? resumeBtn : null),
    h('div.tx-body', scroller, jump));

  scroller.addEventListener('scroll', () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    if (stick) jump.hidden = true;
  });

  function toEnd() {
    scroller.scrollTop = scroller.scrollHeight;
    stick = true;
    jump.hidden = true;
  }

  function toolEntry(item) {
    const entry = { item, result: null, expanded: false };
    const [name, args] = toolHeader(item, projectRoot());
    const bullet = h('span.cc-bullet.is-pending', { 'aria-hidden': 'true' }, '⏺');
    const argsEl = args === null ? null : h('span', '(', h('span.cc-args', ''), ')');
    const head = h('button.cc-tool-head', { type: 'button', 'aria-expanded': 'false', title: 'Show full output' }, h('strong', name), argsEl);
    const body = h('div.cc-out-body');
    entry.el = h('div.cc-entry', bullet, h('div.cc-main', head, h('div.cc-out', h('span.cc-elbow', { 'aria-hidden': 'true' }, '⎿'), body)));
    entry.render = () => {
      if (argsEl) argsEl.querySelector('.cc-args').textContent = entry.expanded ? args : firstLine(args);
      body.replaceChildren(...toolOutput(entry, projectRoot()).filter(Boolean));
      bullet.className = `cc-bullet ${!entry.result && item.name !== 'TodoWrite' ? 'is-pending' : entry.result?.isError ? 'is-error' : 'is-ok'}`;
    };
    head.addEventListener('click', () => {
      entry.expanded = !entry.expanded;
      head.setAttribute('aria-expanded', String(entry.expanded));
      entry.render();
    });
    entry.render();
    tools.set(item.toolId, entry);
    return entry.el;
  }

  function node(item) {
    switch (item.kind) {
      case 'user':
      case 'command':
        return h('div.cc-prompt', h('span.cc-caret', { 'aria-hidden': 'true' }, '>'), h('div.cc-pre', item.text));
      case 'assistant':
        return h('div.cc-entry', h('span.cc-bullet.is-text', { 'aria-hidden': 'true' }, '⏺'), h('div.cc-main', renderMarkdown(item.text)));
      case 'tool':
        return toolEntry(item);
      case 'result': {
        const entry = tools.get(item.toolId);
        if (entry) {
          entry.result = item;
          entry.render();
        }
        return null;
      }
      case 'turn':
        return item.durationMs ? h('div.cc-turn', `✻ Worked for ${elapsed(item.durationMs)}`) : null;
      default:
        return null;
    }
  }

  function append(items) {
    const nodes = items.map(node).filter(Boolean);
    list.append(...nodes);
    while (list.childElementCount > MAX_NODES) list.firstElementChild.remove();
    if (stick) requestAnimationFrame(toEnd);
    else if (nodes.length) jump.hidden = false;
  }

  function notice(...children) {
    list.replaceChildren(h('div.tx-notice', ...children));
  }

  async function enable() {
    const s = await attempt(() => api.patch('/api/settings', { agents: { readTranscripts: true } }), { failure: 'Could not enable live transcript' });
    if (s) store.set('settings', s);
  }

  async function launchResume() {
    resumeWhenClosed = false;
    waiting.hidden = true;
    const r = await attempt(() => api.post(projectUrl(session.projectId, `/agents/${session.agent}/start`), { resumeOf: session.id }), { failure: 'Could not resume the session' });
    if (r?.terminal) {
      store.setTerminal(r.terminal);
      // the conversation now lives in that terminal tab: one tab per session, never two
      resumedListeners.forEach((fn) => fn(session.id));
    }
  }

  /** An open conversation moves here at once (closed in the other window), or when its answer ends. */
  const movesHere = () => session.live !== false && session.movable;

  async function resume() {
    if (session.live === false) return launchResume();
    if (movesHere()) {
      const terminal = await moveHere(session);
      if (terminal) resumedListeners.forEach((fn) => fn(session.id));
      return undefined;
    }
    if (resumeWhenClosed) {
      resumeWhenClosed = false;
      waiting.hidden = true;
      return undefined;
    }
    const ok = await confirmDialog({
      title: 'Resume this conversation here?',
      body: 'It is still open in another terminal, and two Claude Code processes on one conversation would drift apart. Type /exit there: FlintBench continues it here, with its full history, as soon as it closes.',
      confirm: 'Resume when closed',
    });
    if (!ok) return undefined;
    resumeWhenClosed = true;
    waiting.hidden = false;
    return undefined;
  }

  function onMessage(msg) {
    if (msg.disabled) {
      disabled = true;
      notice(
        h('strong', 'Live transcript is off'),
        h('span.dim', 'FlintBench reads conversation content only when you allow it. Nothing is stored; turn it off any time in Settings › Agents.'),
        h('button.btn.sm.primary', { type: 'button', onclick: enable }, icon('eye', 13), 'Show conversation'));
      return;
    }
    if (msg.error) {
      notice(h('span.dim', msg.error));
      return;
    }
    disabled = false;
    if (msg.reset) {
      list.replaceChildren();
      tools.clear();
      stick = true;
    }
    append(msg.items ?? []);
    if (msg.reset && !list.childElementCount) notice(h('span.dim', 'No messages yet. The conversation appears here with the first prompt.'));
  }

  attachTranscript(initial.id, onMessage);
  // turning the setting on elsewhere (Settings view, another tab) re-attaches
  const unsub = subscribe('settings', () => {
    if (disabled && store.state.settings?.agents?.readTranscripts) {
      detachTranscript(initial.id);
      attachTranscript(initial.id, onMessage);
    }
  });

  return {
    el,
    update(next) {
      const wasLive = session.live !== false;
      session = next;
      const isLive = next.live !== false;
      live.replaceChildren(statusDot(isLive ? 'agent live' : 'off', isLive ? (next.busy ? 'Answering' : 'Active') : 'Ended'));
      since.textContent = isLive ? `since ${clock(next.startedAt)}` : `ended ${clock(next.endedAt)}`;
      resumeBtn.disabled = false;
      if (movesHere()) {
        const pending = next.moving === 'in';
        resumeBtn.lastChild.textContent = pending ? 'Cancel move' : 'Move here';
        resumeBtn.title = pending ? 'Keep it in the other window' : 'Close it in the other window and continue it in a FlintBench terminal tab';
        waiting.textContent = 'Moves here when the answer ends';
        waiting.hidden = !pending;
      } else {
        resumeBtn.lastChild.textContent = 'Resume here';
        waiting.textContent = 'Resumes here when it closes in the other terminal';
        if (!resumeWhenClosed) waiting.hidden = true;
      }
      if (wasLive && !isLive && resumeWhenClosed) launchResume();
    },
    shown() {
      if (stick) requestAnimationFrame(toEnd);
    },
    destroy() {
      unsub();
      detachTranscript(initial.id);
      el.remove();
    },
  };
}
