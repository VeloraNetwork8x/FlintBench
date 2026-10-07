import { h, replace, actionButton } from '../../lib/dom.js';
import { store, subscribe, prefs } from '../../lib/store.js';
import { api, projectUrl } from '../../lib/api.js';
import { ago, clock, duration, when } from '../../lib/format.js';
import { attempt, statusDot, toast, choiceDialog } from '../../lib/ui.js';
import { evidenceText, filesText } from '../agents.js';
import { agentMark } from '../../lib/agent-icons.js';

export async function launchAgent(projectId, agentId, mode, task) {
  const r = await attempt(() => api.post(projectUrl(projectId, `/agents/${agentId}/start`), { mode, task: task || undefined }), { failure: 'Could not start agent' });
  if (r) store.setTerminal(r.terminal);
  return r;
}

/**
 * The conversation closed last on a project (p.agents.closed), worth a notice while it is recent:
 * one cut off or closed mid-answer for a day, one closed normally for two hours. Dismissed per session.
 */
const CLOSED_NOTICE_MS = { interrupted: 24 * 3_600_000, closed: 2 * 3_600_000 };
const dismissedKey = (projectId) => `agents.closed-dismissed.${projectId}`;

export function closedNotice(p, now = Date.now()) {
  const c = p?.agents?.closed;
  if (!c || p.agents.active?.length || !p.exists) return null;
  const kind = c.endReason ? 'interrupted' : 'closed';
  if (now - c.endedAt > CLOSED_NOTICE_MS[kind]) return null;
  if (prefs.get(dismissedKey(p.id), null) === c.id) return null;
  const at = clock(c.endedAt);
  const text = c.endReason === 'mid-turn'
    ? { title: `${c.agentName} was interrupted mid-answer`, detail: `Closed at ${at} while it was still working` }
    : c.endReason
      ? { title: `${c.agentName} was cut off`, detail: `Still open at ${at} when the computer or FlintBench stopped` }
      : { title: `${c.agentName} conversation closed`, detail: `Closed at ${at} · ${ago(c.endedAt)}` };
  return { ...c, kind, ...text, reopenLabel: c.resumeOf ? 'Reopen conversation' : `Continue ${c.agentName}` };
}

export function dismissClosed(p, notice) {
  prefs.set(dismissedKey(p.id), notice.id);
}

/** Reopens the closed conversation (the exact one when its id is known) in a terminal tab of the project. */
export async function reopenConversation(projectId, c) {
  const body = c.resumeOf ? { resumeOf: c.resumeOf } : { mode: 'resume' };
  const r = await attempt(() => api.post(projectUrl(projectId, `/agents/${c.agent}/start`), body), { failure: `Could not reopen ${c.agentName}` });
  if (r?.terminal) store.setTerminal(r.terminal);
  return r;
}

/** The two ways forward when the agent is writing an answer, or the single one when it is not. */
function moveChoices(s, nowLabel) {
  return s.busy
    ? [{ value: 'now', label: `${nowLabel} now` }, { value: 'idle', label: 'When it finishes', primary: true }]
    : [{ value: 'now', label: nowLabel, primary: true }];
}

/**
 * The conversation in a FlintBench tab continues in a Windows Terminal window (or the
 * pending transfer is cancelled). The completed move is announced by the server's event.
 */
export async function moveToTerminal(terminalId, s) {
  if (s.moving === 'out') {
    const r = await attempt(() => api.post(`/api/terminals/${encodeURIComponent(terminalId)}/transfer/cancel`), { failure: 'Could not cancel the transfer' });
    if (r?.cancelled) toast('Transfer cancelled', { kind: 'info' });
    return r;
  }
  const when = await choiceDialog({
    title: `Transfer ${s.agentName} to a terminal window?`,
    body: s.busy
      ? `${s.agentName} is writing an answer. It can move as soon as it finishes, or now: the answer in progress stops.`
      : `${s.agentName} stops in this tab and the same conversation, with its full history, continues in a new Windows Terminal window.`,
    choices: moveChoices(s, 'Transfer'),
  });
  if (!when) return null;
  const r = await attempt(() => api.post(`/api/terminals/${encodeURIComponent(terminalId)}/transfer`, { when }), { failure: 'Could not transfer the conversation' });
  if (r?.pending) toast(`${s.agentName} moves to a terminal window when it finishes`, { kind: 'info' });
  return r;
}

/**
 * A conversation open in a window outside FlintBench is closed there and reopened in a
 * terminal tab here (or the pending move is cancelled). Resolves with the new terminal when it moved.
 */
export async function moveHere(s) {
  if (s.moving === 'in') {
    const r = await attempt(() => api.post(`/api/agent-sessions/${encodeURIComponent(s.id)}/move/cancel`), { failure: 'Could not cancel the move' });
    if (r?.cancelled) toast('Move cancelled', { kind: 'info' });
    return null;
  }
  const when = await choiceDialog({
    title: `Move ${s.agentName} into FlintBench?`,
    body: s.busy
      ? `${s.agentName} is writing an answer in another window. It can move as soon as it finishes, or now: the answer in progress stops.`
      : `FlintBench closes ${s.agentName} in the other window and reopens the same conversation, with its full history, in a terminal tab here.`,
    choices: moveChoices(s, 'Move'),
  });
  if (!when) return null;
  const r = await attempt(() => api.post(`/api/agent-sessions/${encodeURIComponent(s.id)}/move-here`, { when }), { failure: `Could not move ${s.agentName}` });
  if (r?.pending) toast(`${s.agentName} moves here when it finishes`, { kind: 'info' });
  if (r?.terminal) store.setTerminal(r.terminal);
  return r?.terminal ?? null;
}

function activity(s) {
  const since = Date.now() - (s.lastActivityAt ?? s.startedAt);
  if (s.source === 'external') return `session file updated ${ago(s.lastActivityAt)}`;
  return since < 20_000 ? 'working · output streaming' : `idle ${duration(since)} · waiting or thinking`;
}

/** Right panel: launch agents in this project, see the live session, recent journal. */
export function createAgentPanel(ctx) {
  const el = h('div.agent-panel');
  const task = h('input.input', { placeholder: 'Task (optional)', 'aria-label': 'Task for the agent session (optional)', maxLength: 200 });
  let recent = [];

  async function loadRecent() {
    recent = (await api.get(`/api/agents/journal?project=${encodeURIComponent(ctx.projectId)}&limit=6`).catch(() => [])) ?? [];
    render();
  }

  function render() {
    const p = ctx.project();
    if (!p) return;
    const tools = store.state.agents.tools ?? [];
    const active = p.agents?.active ?? [];
    const focusInTask = document.activeElement === task;

    replace(el,
      h('div.agent-section',
        h('div.row', { style: { marginBottom: '8px' } }, h('span.label', 'AI agent'), h('span.spacer'), h('span.faint', { style: { fontSize: '11px' } }, 'uses your local login')),
        tools.map((t) => h('div.agent-tool',
          h('div', { style: { minWidth: 0 } },
            h('div.row', agentMark(t.id, 18), h('strong', t.name)),
            h('div.faint.ellipsis', { style: { fontSize: '11px' } }, t.installed ? (t.launchable ? (t.version ?? 'installed') : 'detected · launch not supported yet') : 'not detected')),
          t.installed && t.launchable && t.enabled
            ? h('div.row', { style: { gap: '4px' } },
              actionButton('New', () => launchAgent(ctx.projectId, t.id, 'new', task.value.trim()).then((r) => { if (r) task.value = ''; }), { cls: 'btn sm', title: `Start ${t.name} in ${p.name}`, disabled: !p.exists }),
              actionButton('Continue', () => launchAgent(ctx.projectId, t.id, 'resume', task.value.trim()), { cls: 'btn sm ghost', title: `Reopen the most recent ${t.name} conversation in this folder`, disabled: !p.exists }))
            : null)),
        h('div', { style: { marginTop: '8px' } }, task),
        h('p.evidence', { style: { marginTop: '6px' } }, 'The task is stored in the journal exactly as typed. It is not sent anywhere.')),

      h('div.agent-section',
        h('div.label', { style: { marginBottom: '8px' } }, active.length ? 'Live session' : 'No live session'),
        active.length ? active.map((s) => h(`div.agent-session.is-${s.agent}`,
          h('div.row', agentMark(s.agent, 20), h('strong', s.agentName), statusDot('agent live', 'Active'), h('span.spacer'), h('span.chip.agent', s.source === 'flintbench' ? 'FlintBench' : s.terminalId ? 'terminal' : 'external')),
          h('div.dim', { style: { fontSize: '12px' } }, activity(s)),
          h('dl.kv',
            h('dt', 'Started'), h('dd.num', `${clock(s.startedAt)} · ${duration(Date.now() - s.startedAt)}`),
            h('dt', 'Files'), h('dd', { title: 'Files changed in this project while the session was active. Not attributed to the agent.' }, filesText(s)),
            h('dt', 'Commits'), h('dd', s.commits?.length ? s.commits.map((c) => h('div.ellipsis', h('span.mono.dim', c.short), ' ', c.subject)) : h('span.faint', 'none during session')),
            s.task ? [h('dt', 'Task'), h('dd', s.task)] : null),
          h('p.evidence', evidenceText(s)),
          s.source === 'flintbench' ? h('div.row',
            h('button.btn.sm', { type: 'button', onclick: () => ctx.dock.show(s.terminalId) }, 'Show terminal'),
            actionButton('Stop', () => attempt(() => api.post(`/api/agent-sessions/${s.id}/stop`)), { cls: 'btn sm danger' })) : null))
          : h('p.faint', { style: { fontSize: '12px' } }, 'Launch an agent above. It runs in a terminal tab in this project folder.')),

      h('div.agent-section', { style: { borderBottom: 0 } },
        h('div.label', { style: { marginBottom: '6px' } }, 'Recent sessions'),
        recent.filter((r) => !r.live).length ? h('ul.list', recent.filter((r) => !r.live).slice(0, 5).map((r) => h('li', { style: { padding: '6px 0' } },
          h('div.row', agentMark(r.agent, 14), h('strong', { style: { fontSize: '12px' } }, r.agentName), h('span.faint', { style: { fontSize: '11px' } }, when(r.startedAt)), h('span.spacer'), h('span.num.dim', { style: { fontSize: '11px' } }, duration(r.durationMs))),
          h('div.faint', { style: { fontSize: '11px' } }, `${filesText(r)} · ${r.commits?.length ?? 0} commits${r.task ? ` · ${r.task}` : ''}`)))) : h('p.faint', { style: { fontSize: '12px' } }, 'None recorded yet.')));
    if (focusInTask) task.focus();
  }

  const unsub = subscribe([`project:${ctx.projectId}`, 'agents'], render);
  const unsubEv = subscribe('event', () => {
    const e = store.state.lastEvent;
    if (e?.projectId === ctx.projectId && e.type.startsWith('agent.')) loadRecent();
  });
  const tick = setInterval(render, 15_000);
  render();
  loadRecent();
  return {
    el,
    destroy() {
      unsub();
      unsubEv();
      clearInterval(tick);
    },
  };
}
