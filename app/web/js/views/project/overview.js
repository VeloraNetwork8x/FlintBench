import { h, icon, replace, actionButton } from '../../lib/dom.js';
import { selectField } from '../../lib/select-menu.js';
import { api, projectUrl } from '../../lib/api.js';
import { store, prefs } from '../../lib/store.js';
import { ago, when, duration, plural, clock } from '../../lib/format.js';
import { has } from '../../lib/feature.js';
import { attempt, severityChip, statusDot, nowState } from '../../lib/ui.js';
import { describeEvent } from '../../lib/events.js';
import { launchAgent, closedNotice, dismissClosed, reopenConversation } from './agent-panel.js';
import { commitLink } from '../../lib/git-links.js';
import { briefingCard, shouldBrief } from './briefing.js';
import { agentMark, toolMarks } from '../../lib/agent-icons.js';
import { createFileChanges } from './file-changes.js';
import { relocationText, relocationActions } from '../../lib/relocation.js';

/**
 * The project at a glance, in reading order:
 *   1. anything that needs attention (only when there is something);
 *   2. three facts — what is happening now, the branch and its changes, when it was last worked on;
 *   3. the work itself (changes, recent activity) next to what is running (services, agent, notes).
 * Every block links to the section that manages it; nothing is shown twice.
 */
const NOTE_TYPES = [['note', 'Note'], ['decision', 'Decision'], ['goal', 'Goal'], ['constraint', 'Constraint'], ['state', 'State']];
const NOTE_LABEL = Object.fromEntries(NOTE_TYPES);
const NOTE_HINTS = {
  note: 'Where you left off, next step, things to remember…',
  decision: 'What was decided, and why…',
  goal: 'What this project, or this stretch of work, should achieve…',
  constraint: 'A limit to respect: a version, a deadline, a rule…',
  state: 'Where things stand right now…',
};
// stacks that serve web pages: their projects always have a Preview (Offline when nothing serves them)
const WEB_STACK = new Set(['Next.js', 'Nuxt', 'SvelteKit', 'Svelte', 'Vue', 'React', 'Angular', 'Astro', 'Solid', 'Vite', 'Express', 'Fastify', 'NestJS', 'Hono', 'Django', 'FastAPI', 'Flask', 'PHP', 'Static site']);
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity CLI', gemini: 'Gemini CLI' };

/** One log line, built from parts: an icon tone, the subject in bold, a mono token, a quiet tail. */
function entry(e, web) {
  const d = e.data ?? {};
  const svc = d.service ?? d.name;
  switch (e.type) {
    case 'git.commit_created': return { icon: 'commit', tone: 'accent', parts: [commitLink(web, d.sha, d.short, 'code.tl-token'), h('span.tl-main', d.subject)] };
    case 'git.pushed': return { icon: 'up', tone: 'accent', parts: [h('span.tl-main', d.published ? 'Published branch' : `Pushed ${plural(d.count ?? 1, 'commit')}`), h('code.tl-token', d.upstream)] };
    case 'git.branch_changed': return { icon: 'branch', tone: 'accent', parts: [h('span.tl-main', 'Switched branch'), h('code.tl-token', d.from ?? '—'), '→', h('code.tl-token', d.to ?? 'detached')] };
    case 'agent.started': return { agent: d.agent, tone: 'agent', parts: [h('span.tl-main', `${AGENT_NAMES[d.agent] ?? d.agent} started`), d.mode === 'resume' ? h('span.tl-tail', 'resumed') : null, d.source === 'external' ? h('span.tl-tail', 'outside FlintBench') : null] };
    case 'agent.stopped': return { agent: d.agent, tone: 'muted', parts: [h('span.tl-main', `${AGENT_NAMES[d.agent] ?? d.agent} ended`), d.durationMs ? h('span.tl-tail', `after ${duration(d.durationMs)}`) : null] };
    case 'agent.moved': return { agent: d.agent, tone: 'agent', parts: [h('span.tl-main', `${AGENT_NAMES[d.agent] ?? d.agent} moved`), h('span.tl-tail', d.direction === 'in' ? 'into FlintBench' : `to ${d.app ?? 'a terminal window'}`)] };
    case 'process.started': return { icon: 'play', tone: 'ok', parts: [h('span.tl-main', `${svc} started`), d.ports?.length ? h('code.tl-token', `:${d.ports.join(', :')}`) : null, d.managed ? null : h('span.tl-tail', 'external')] };
    case 'process.stopped': return { icon: 'stop', tone: d.exitCode ? 'err' : 'off', parts: [h('span.tl-main', `${svc} stopped`), d.exitCode ? h('code.tl-token', `exit ${d.exitCode}`) : null] };
    case 'docker.container_started': return { icon: 'box', tone: 'ok', parts: [h('span.tl-main', `Container ${svc} started`)] };
    case 'docker.container_stopped': return { icon: 'box', tone: 'off', parts: [h('span.tl-main', `Container ${svc} stopped`), d.status ? h('span.tl-tail', d.status) : null] };
    case 'work.updated': return { icon: 'work', tone: 'warn', parts: [h('span.tl-main', d.title), h('span.tl-tail', `→ ${String(d.status).replace('_', ' ')}`)] };
    default: return { icon: 'activity', tone: 'muted', parts: [h('span.tl-main', describeEvent(e))] };
  }
}

function dayLabel(ts) {
  const day = new Date(ts).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return 'Today';
  if (day === today - 86_400_000) return 'Yesterday';
  return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Recent activity as a timeline grouped by day: time, a marker per kind of event, the event itself. */
function timeline(events, { limit = 10, open = false, onToggle, web = null } = {}) {
  const list = h('ol.tl');
  // the expanded state outlives re-renders (live updates must not fold the list back)
  let shown = open ? events.length : Math.min(limit, events.length);
  const more = h('button.btn.sm.ghost.tl-more', { type: 'button' });
  const draw = () => {
    let day = null;
    replace(list, events.slice(0, shown).map((e) => {
      const x = entry(e, web);
      const label = dayLabel(e.at);
      const head = label !== day ? h('li.tl-day', label) : null;
      day = label;
      return [head, h(`li.tl-item.is-${x.tone}`, { title: new Date(e.at).toLocaleString() },
        h('time.tl-time', { dateTime: new Date(e.at).toISOString() }, clock(e.at)),
        h('span.tl-mark', { 'aria-hidden': 'true' }, x.agent ? agentMark(x.agent, 13) : icon(x.icon, 12)),
        h('span.tl-body', x.parts),
        h('span.tl-ago', ago(e.at)))];
    }));
    more.hidden = events.length <= limit;
    more.textContent = shown < events.length ? `Show ${events.length - shown} more` : 'Show less';
  };
  more.addEventListener('click', () => { shown = shown < events.length ? events.length : limit; onToggle?.(shown > limit); draw(); });
  draw();
  return h('div.tl-wrap', list, more);
}

export function render(ctx) {
  // three parts: the facts, a live preview (kept across redraws so it never reloads by itself), the blocks
  const top = h('div.ov-part');
  const previewSlot = h('aside.ov-aside', { 'aria-label': 'Preview' });
  const rest = h('div.ov-part');
  const el = h('div.p-center-inner.ov', top, previewSlot, rest);
  let previewUrl = null;
  let previewTimer = 0;
  let preview = null; // the preview on show: { offline, setOffline(), reload(), start() }
  let previewShot = null; // object URL of its last good picture, kept to show while offline
  // Notes: each one says what it is about, picked with a button when it is written
  const draftKey = `notes.draft.${ctx.projectId}`;
  let noteType = 'note';
  let notes = [];
  let notesLoaded = false;
  const typeTabs = h('div.tabs.note-types', { role: 'group', 'aria-label': 'Type of note' });
  const noteInput = h('textarea.textarea.note-input', { rows: 3, 'aria-label': 'New note', value: prefs.get(draftKey, '') });
  const notesState = h('span.faint.small');
  const notesList = h('ul.note-list', { 'aria-label': 'Project notes' });
  const addBtn = actionButton('Add', () => addNote(), { cls: 'btn sm primary', title: 'Add the note (Ctrl+Enter)' });
  const notesEl = h('div.notes', typeTabs, noteInput, h('div.note-actions', h('span.faint.small', 'Ctrl+Enter to add'), h('span.spacer'), addBtn), notesList);
  let data = null;
  let timer = 0;
  let recentOpen = false; // "Show more" on Recent activity stays open across live updates
  // Files changed (profile Test): kept across redraws, like the notes
  const fileChanges = createFileChanges(ctx);

  function renderTypes() {
    replace(typeTabs, NOTE_TYPES.map(([id, label]) => h('button', {
      type: 'button', 'aria-pressed': String(noteType === id),
      onclick: () => { noteType = id; renderTypes(); noteInput.focus(); },
    }, label)));
    noteInput.placeholder = NOTE_HINTS[noteType];
  }

  function renderNotes() {
    notesState.textContent = notes.length ? plural(notes.length, 'note') : '';
    replace(notesList, notes.length
      ? notes.map((n) => h('li.note',
        h(`span.note-type.is-${n.type}`, NOTE_LABEL[n.type] ?? 'Note'),
        h('p.note-text', n.text),
        h('span.note-when.faint', { title: when(n.at) }, ago(n.at)),
        h('button.btn.sm.icon.ghost.note-x', { type: 'button', 'aria-label': `Delete ${NOTE_LABEL[n.type] ?? 'note'}: ${n.text.slice(0, 40)}`, title: 'Delete', onclick: () => removeNote(n) }, icon('x', 11))))
      : h('li.ov-empty', 'Pick what the note is about, write it, Add. Decisions, goals and constraints stay here between sessions.'));
  }

  async function loadNotes() {
    const r = await api.get(projectUrl(ctx.projectId, '/notes')).catch(() => null);
    if (!r) return;
    notes = r.entries ?? [];
    notesLoaded = true;
    renderNotes();
  }

  async function addNote() {
    const text = noteInput.value.trim();
    if (!text) { noteInput.focus(); return; }
    const r = await attempt(() => api.post(projectUrl(ctx.projectId, '/notes'), { type: noteType, text }), { failure: 'Note not saved' });
    if (!r) return;
    notes = r.entries;
    noteInput.value = '';
    prefs.set(draftKey, '');
    renderNotes();
  }

  async function removeNote(n) {
    const r = await attempt(() => api.del(projectUrl(ctx.projectId, `/notes/${encodeURIComponent(n.id)}`)), { failure: 'Note not deleted' });
    if (!r) return;
    notes = r.entries;
    renderNotes();
  }

  // what is being written survives leaving the page; only Add makes it a note
  noteInput.addEventListener('input', () => prefs.set(draftKey, noteInput.value));
  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); }
  });
  renderTypes();
  renderNotes();

  async function load() {
    data = await api.get(projectUrl(ctx.projectId, '/resume')).catch(() => null);
    if (has('overview.files')) fileChanges.load();
    if (data && !notesLoaded) await loadNotes();
    draw();
  }

  const link = (tab, text) => h('a.more', { href: '#', onclick: (e) => { e.preventDefault(); ctx.go(tab); } }, text, ' →');
  const block = (title, action, ...body) => h('section.ov-block', h('header.ov-head', h('h3', title), h('span.spacer'), action), ...body);

  function fact(label, value, sub, cls = '') {
    return h('div.ov-fact', h('span.label', label), h(`div.ov-value${cls}`, value), sub ? h('div.ov-sub', sub) : null);
  }

  function changesBlock(g) {
    if (!g) return block('Changes', null, h('p.ov-empty', 'Not a git repository.'));
    const files = g.files ?? [];
    return block(g.changed ? `Changes · ${g.changed}` : 'Changes', link('git', 'Open Git'),
      files.length
        ? h('ul.files', files.slice(0, 10).map((f) => {
          const st = f.x === '?' ? 'U' : (f.x === '.' ? f.y : f.x);
          return h('li', h(`span.st.${st}`, st), h('span.ellipsis', f.path));
        }), g.changed > Math.min(files.length, 10) ? h('li.faint', `+${g.changed - Math.min(files.length, 10)} more`) : null)
        : h('p.ov-empty', 'Working tree clean.'),
      g.lastCommit ? h('p.ov-foot', 'Last commit ', commitLink(ctx.project()?.git?.webUrl, g.lastCommit.sha, g.lastCommit.short, 'span.mono'), ` “${g.lastCommit.subject}” · ${ago(g.lastCommit.at)}`) : null);
  }

  function runningBlock() {
    const services = data.services ?? [];
    return block('Services', link('services', 'Manage'),
      services.length
        ? h('ul.ov-list', services.map((s) => h('li',
          statusDot(s.status === 'running' ? 'ok live' : s.status === 'failed' ? 'err' : 'off', s.status),
          h('span.ellipsis', s.name),
          h('span.spacer'),
          s.url && s.status === 'running' ? h('a.mono.small', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url.replace(/^https?:\/\//, '')) : h(`span.small.${s.status === 'running' ? 'ok-text' : 'faint'}`, s.status))))
        : h('p.ov-empty', 'Nothing defined yet. ', link('services', 'Add a service')));
  }

  function agentBlock(p) {
    const active = p.agents?.active ?? [];
    const last = data.lastAgent;
    const tools = (store.state.agents.tools ?? []).filter((t) => t.installed && t.launchable && t.enabled);
    let body;
    if (active.length) {
      body = h('ul.ov-list', active.map((s) => h('li',
        agentMark(s.agent, 18),
        h('span', h('strong', s.agentName), h('span.faint', ` · ${s.source === 'flintbench' ? 'in FlintBench' : s.terminalId ? 'in a terminal tab' : 'outside FlintBench'} · ${duration(Date.now() - s.startedAt)}`)))));
    } else {
      // a conversation closed or cut off moments ago is stated plainly, with one click to reopen it
      const notice = closedNotice(p);
      const resume = notice ? null : data.briefing?.resume;
      const reopen = resume && tools.some((t) => t.id === resume.agent) ? reopenButton(p, resume) : null;
      body = h('div.ov-agent',
        notice ? closedBox(p, notice)
          : h('p.ov-empty', last ? `Last: ${last.agentName} · ${when(last.startedAt)}${last.endedAt ? ` · ${duration(last.endedAt - last.startedAt)}` : ''}` : 'No sessions yet.'),
        tools.length || reopen ? h('div.row.wrap', reopen, tools.map((t) => { const b = actionButton(`Start ${t.name}`, () => launchAgent(ctx.projectId, t.id, 'new'), { cls: 'btn sm', disabled: !p.exists }); b.prepend(agentMark(t.id, 14)); return b; })) : null);
    }
    return block('Agent', link('agents', 'Sessions'), body);
  }

  async function reopen(c) {
    const r = await reopenConversation(ctx.projectId, c);
    if (r?.terminal) ctx.dock.open();
  }

  /** Reopens the last agent conversation (the exact one when its id is known) in a terminal tab. */
  function reopenButton(p, resume) {
    const label = resume.resumeOf ? `Reopen ${resume.agentName} conversation` : `Continue ${resume.agentName}`;
    const b = actionButton(label, () => reopen(resume), { cls: 'btn sm primary', disabled: !p.exists, title: resume.resumeOf ? `Continue the last ${resume.agentName} conversation, with its full history, in a terminal tab` : `Reopen the most recent ${resume.agentName} conversation in this folder` });
    b.prepend(agentMark(resume.agent, 14));
    return b;
  }

  /** The conversation just closed or cut off: what happened, when, and the way back into it. */
  function closedBox(p, n) {
    return h(`div.agent-closed.is-${n.kind}`,
      h('span.agent-closed-ic', { 'aria-hidden': 'true' }, icon(n.kind === 'interrupted' ? 'st-warn' : 'st-info', 16)),
      h('div.agent-closed-text', h('strong', n.title), h('span', n.detail)),
      h('div.agent-closed-actions',
        actionButton(n.reopenLabel, () => reopen(n), { cls: `btn sm${n.kind === 'interrupted' ? ' primary' : ''}`, iconName: 'resume', disabled: !p.exists }),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => { dismissClosed(p, n); draw(); } }, 'Dismiss')));
  }

  /** Web pages this project is serving right now: its running services with a URL, then any listening port. */
  function webTargets(p) {
    const urls = (data?.services ?? []).filter((s) => s.status === 'running' && s.url).map((s) => ({ url: s.url, label: s.url.replace(/^https?:\/\//, '').replace(/\/$/, '') }));
    for (const port of p.runtime?.ports ?? []) {
      const url = `http://localhost:${port}`;
      if (!urls.some((u) => u.url.replace(/\/$/, '') === url)) urls.push({ url, label: `localhost:${port}` });
    }
    return urls;
  }

  /** A project that is a web app has a Preview even when nothing serves it right now. */
  function isWebApp(p, targets) {
    if (!has('overview.preview')) return false;
    return targets.length > 0 || (p.stack ?? []).some((s) => WEB_STACK.has(s)) || (p.indicators ?? []).includes('index.html');
  }

  /**
   * A small picture of the page the project is serving, on the right. Rendered by the server with a
   * headless browser (pages often forbid being framed), refreshed every 30 s and on demand. Always
   * there for a web app: when nothing serves it, it says Offline over the last picture kept.
   */
  function drawPreview(p) {
    const targets = webTargets(p);
    const target = targets.find((t) => t.url === previewUrl) ?? targets[0];
    if (!has('overview.preview')) {
      clearInterval(previewTimer);
      preview = null;
      previewSlot.replaceChildren();
      return;
    }
    if (!target) {
      clearInterval(previewTimer);
      // the page stopped being served: keep its picture, marked offline, and stop capturing
      if (preview && previewSlot.firstChild) {
        preview.setOffline();
        return;
      }
      if (!isWebApp(p, targets)) {
        previewUrl = null;
        preview = null;
        previewSlot.replaceChildren();
        return;
      }
      buildPreview(p, null, targets);
      return;
    }
    if (preview && preview.url === target.url && previewSlot.firstChild) {
      if (preview.offline) preview.start(); // served again: capture it now
      return; // same page: keep the picture
    }
    buildPreview(p, target, targets);
  }

  /** The Preview block, for a page being served (target) or for none (offline from the start). */
  function buildPreview(p, target, targets) {
    previewUrl = target?.url ?? null;
    const label = target?.label ?? 'The dev server';
    const src = (step, fresh) => projectUrl(ctx.projectId, `/preview?url=${encodeURIComponent(target.url)}&step=${step}${fresh ? `&fresh=${Date.now()}` : ''}`);
    const state = h('div.preview-state', 'Capturing the page…');
    const img = h('img.preview-img', { alt: `Preview of ${label}`, title: target ? `Open ${target.label}` : '' });
    const box = h(`${target ? 'a' : 'div'}.preview-box.is-loading`, target ? { href: target.url, target: '_blank', rel: 'noopener noreferrer' } : {}, img, state);
    img.addEventListener('load', () => { box.classList.remove('is-loading', 'is-error'); });
    const show = (blob) => {
      const url = URL.createObjectURL(blob);
      if (previewShot) URL.revokeObjectURL(previewShot);
      previewShot = url;
      img.src = url;
    };
    let lastAt = null;
    let lastTried = false;
    let lastUrl = null; // the page the kept picture shows
    let loading = false;
    const current = {
      url: target?.url ?? null,
      offline: false,
      /** Offline: the picture on show stays (in grey); without one, the last picture kept for the project. */
      async setOffline() {
        current.offline = true;
        clearInterval(previewTimer);
        box.classList.remove('is-loading', 'is-error');
        box.classList.add('is-offline');
        const say = () => replace(state, h('span.preview-off', h('span.preview-off-tag', 'Offline'),
          target ? `${target.label} is not running` : lastUrl ? `${lastUrl} is not running` : 'No dev server running',
          lastAt ? h('span.preview-off-at', `Last picture ${ago(lastAt)}`) : null));
        say();
        // the overview redraws often: the kept picture is asked for once
        if (img.getAttribute('src') || lastTried) return;
        lastTried = true;
        const res = await fetch(projectUrl(ctx.projectId, '/preview/last'), { credentials: 'same-origin' }).catch(() => null);
        if (!res?.ok || !current.offline) return;
        lastAt = Number(res.headers.get('X-Preview-At')) || null;
        lastUrl = decodeURI(res.headers.get('X-Preview-Url') ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '') || null;
        show(await res.blob());
        say();
      },
      /**
       * A visit takes three pictures a few seconds apart: shown one after another when asked
       * (a loader is replaced by the page), only the last one on the quiet 30 s refresh.
       */
      async reload(fresh, { steps = [1, 2, 3] } = {}) {
        if (loading || !target) return;
        loading = true;
        if (!img.getAttribute('src') || current.offline) box.classList.add('is-loading');
        state.textContent = 'Capturing the page…';
        try {
          for (const [i, step] of steps.entries()) {
            // fetched rather than set as <img src>: a stopped server answers 503 "offline", not a broken image
            const res = await fetch(src(step, fresh && i === 0), { credentials: 'same-origin' });
            if (res.status === 503) { await current.setOffline(); return; }
            if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
            current.offline = false;
            lastAt = Date.now();
            box.classList.remove('is-offline');
            show(await res.blob());
          }
        } catch {
          box.classList.remove('is-loading');
          box.classList.add('is-error');
          state.textContent = `Could not capture ${label}`;
        } finally {
          loading = false;
        }
      },
      start() {
        current.reload(true);
        clearInterval(previewTimer);
        previewTimer = setInterval(() => { if (document.visibilityState === 'visible' && !current.offline) current.reload(true, { steps: [3] }); }, 30_000);
      },
    };
    preview = current;
    if (target) {
      current.reload(false);
      clearInterval(previewTimer);
      previewTimer = setInterval(() => { if (document.visibilityState === 'visible' && !current.offline) current.reload(true, { steps: [3] }); }, 30_000);
    } else {
      current.setOffline();
    }
    replace(previewSlot, block('Preview',
      target ? h('span.row',
        h('button.btn.sm.icon.ghost', { type: 'button', title: 'Capture again', onclick: () => current.reload(true) }, icon('refresh', 13)),
        h('a.btn.sm.icon.ghost', { href: target.url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${target.label}` }, icon('external', 13))) : null,
      box,
      targets.length > 1
        ? (() => {
          const pick = selectField({ label: 'Page to preview', size: 'sm', cls: 'preview-pick', value: target.url, options: targets.map((t) => ({ value: t.url, text: t.label })) });
          pick.addEventListener('change', () => { previewUrl = pick.value; preview = null; previewSlot.replaceChildren(); drawPreview(p); });
          return pick;
        })()
        : h('div.preview-url.mono', target ? target.label : 'Start its dev server to see the page')));
  }

  function draw() {
    const p = ctx.project();
    if (!p) return;
    if (!data) {
      replace(top, h('p.ov-empty', 'Reading project state…'));
      return;
    }
    const g = data.git;
    const now = nowState(p);
    const attention = (data.attention ?? []).filter((a) => a.severity !== 'info');
    drawPreview(p);
    replace(top,
      // Project Memory: after an absence, where you left off and one button to get going again
      !p.exists ? missingBanner(p) : null,
      shouldBrief(ctx.projectId, data) ? briefingCard(ctx, data, { onDone: draw }) : null,
      attention.length ? h('div.ov-attention', { role: 'status' }, h('span.label', 'Needs attention'), h('div.row.wrap', attention.map(severityChip))) : null,
      h('div.ov-facts',
        fact('Now', h('span.row', now.marks?.length ? toolMarks(now.marks, 18) : statusDot(now.dot, now.text), h(`span.ellipsis.${now.cls}`, now.text)), data.currentWork ? ['Task: ', link('work', data.currentWork.title)] : null),
        fact('Branch', g ? (g.detached ? 'detached HEAD' : g.branch) : 'no git', g ? (g.changed ? h('span.change-text', `${plural(g.changed, 'uncommitted change')}`) : 'clean') : null, '.mono'),
        fact('Last worked', data.lastWorkedAt ? ago(data.lastWorkedAt) : 'never', data.lastWorkedAt ? `${when(data.lastWorkedAt)}${data.lastWorkedSource ? ` · ${data.lastWorkedSource}` : ''}` : null)));
    replace(rest,
      // Notes keep their own size; the other blocks follow their content
      h(`div.ov-grid${recentOpen ? '.is-expanded' : ''}`,
        h('div.ov-col',
          changesBlock(g),
          block('Recent activity', data.recent.length ? h('span.faint.small', plural(data.recent.length, 'event')) : null, data.recent.length
            ? timeline(data.recent, { open: recentOpen, onToggle: (v) => setExpanded(v), web: ctx.project()?.git?.webUrl ?? null })
            : h('p.ov-empty', 'Commits, branch switches, agent sessions and services will appear here.')),
          has('overview.files') ? block('Files changed', fileChanges.meta, fileChanges.el) : null),
        h('div.ov-col',
          runningBlock(),
          has('overview.agent') ? agentBlock(p) : null,
          notesBlock())));
  }

  /**
   * The folder is gone (profile Test): renamed or moved (the server found it again), or not found.
   * Nothing changes until the owner confirms; see lib/relocation.js.
   */
  function missingBanner(p) {
    const t = relocationText(p);
    return h('section.ov-moved', { role: 'status' },
      h('div.ov-moved-text',
        h('strong', t.title),
        h('p', 'Was at ', h('code', p.path)),
        h(p.relocation ? 'p' : 'p.faint', t.detail),
        h('p.faint', 'History, notes and sessions stay with the project.')),
      h('div.row.wrap', relocationActions(p)));
  }

  /** Notes keep one size: the list scrolls inside instead of growing the panel. */
  function notesBlock() {
    const b = block('Notes', notesState, notesEl);
    b.classList.add('ov-notes');
    return b;
  }

  function setExpanded(open) {
    recentOpen = open;
    rest.querySelector('.ov-grid')?.classList.toggle('is-expanded', open);
  }

  draw();
  load();
  return {
    el,
    update() {
      clearTimeout(timer);
      timer = setTimeout(load, 1200);
    },
    destroy() {
      clearTimeout(timer);
      clearInterval(previewTimer);
      if (previewShot) URL.revokeObjectURL(previewShot);
      fileChanges.destroy();
    },
  };
}
