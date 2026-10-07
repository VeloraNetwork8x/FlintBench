import { h, icon, actionButton } from '../../lib/dom.js';
import { prefs } from '../../lib/store.js';
import { duration, clock, when, plural } from '../../lib/format.js';
import { agentMark } from '../../lib/agent-icons.js';
import { resumeSteps, stepsText, resumeWork } from '../../lib/resume.js';
import { sessionFacts } from './sessions.js';

/**
 * Project Memory / Resume — "I open a project I have not touched for days: tell me where I left
 * off and get me going again." Shown at the top of the overview after an absence, or right away
 * when the last conversation was cut off.
 * Everything comes from local facts, never written by a model: what was done in the last work
 * session (files, lines, commits, tests, what an agent did), git,
 * services that were on when work stopped, the open task and the last note.
 */

const NOTE_LABEL = { note: 'note', decision: 'decision', goal: 'goal', constraint: 'constraint', state: 'state' };
export const AWAY_MS = 60 * 60_000; // an hour away is a return worth a briefing
const dismissKey = (id) => `briefing.${id}`;
export function shouldBrief(projectId, data) {
  const b = data?.briefing;
  if (!b) return false;
  if (b.lastSession?.live) return false; // still working: nothing to come back to
  // a conversation cut off (computer shut down, FlintBench closed, stopped mid-turn) is worth a
  // briefing right away, however short the absence
  const cutOff = b.interrupted;
  if (!cutOff && (b.awayMs === null || b.awayMs < AWAY_MS)) return false;
  return prefs.get(dismissKey(projectId), null) !== data.lastWorkedAt;
}

function awayText(ms) {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return `${days} days`;
  if (days === 1) return 'a day';
  return duration(ms);
}


/** The last work session in one line — when, how long, with what, how much changed. */
function lastSessionLine(ctx, w, g) {
  const range = `${when(w.startedAt)} → ${clock(w.endedAt)}`;
  return h('div.brief-session',
    h('span.brief-ic', icon('timer', 14)),
    h('div',
      h('strong', 'Last work session'), ' ', h('span.mono', range),
      h('span.brief-session-facts', sessionFacts(w), g?.branch ? ` · on ${g.branch}` : '')),
    h('button.btn.sm.ghost', { type: 'button', onclick: () => ctx.go('sessions') }, 'All sessions'));
}

const and = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const lines = (added, removed) => [h('span.ln-add', `+${added}`), ' ', h('span.ln-del', `−${removed}`)];
const ROOT = '(project root)';

/**
 * What was done in the last work session, said in a few lines from observed facts only (profile
 * Test): what changed and where, what was committed or left uncommitted, what was run, and what
 * an agent did when there was one. The same for work done by hand, in an editor or with an agent;
 * no model writes it.
 */
function sessionSummary(s, agent) {
  const rows = [];
  if (s.files) {
    const where = s.areas.length ? `in ${and(s.areas.map((a) => (a.name === ROOT ? 'the project root' : a.name)))}` : null;
    const what = s.kinds.length ? `mostly ${and(s.kinds.map((k) => k.name))}` : null;
    rows.push([icon('file', 14),
      [`Changed ${s.filesExact ? plural(s.files, 'file') : `${s.files}+ files`}`, s.added !== null ? [' · ', h('span.brief-lines', lines(s.added, s.removed)), ' lines'] : null],
      [what, where].filter(Boolean).join(', ')]);
  }
  if (s.commits.length) {
    rows.push([icon('commit', 14), `Committed ${s.commits.length === 1 ? 'once' : `${s.commits.length} times`}`,
      s.commits.slice(-3).reverse().map((c) => `“${c.subject}”`).join(' · ')]);
  }
  if (s.uncommitted) rows.push([icon('file', 14), s.uncommitted === s.files ? 'None of it committed yet' : `${s.uncommitted} of these files not committed yet`, 'still in the working tree']);
  else if (s.uncommitted === 0 && s.files && s.commits.length) rows.push([icon('check', 14), 'Everything from it is committed', null]);
  if (s.test) rows.push([icon(s.test.ok ? 'check' : 'x', 14), s.test.ok ? 'Tests passed' : `Tests failed (exit ${s.test.exitCode})`, s.test.service]);
  if (s.services.length) rows.push([icon('play', 14), `Started ${and(s.services)}`, null]);
  if (s.branches.length) rows.push([icon('branch', 14), `Switched to ${s.branches.at(-1)}`, s.branches.length > 1 ? `via ${s.branches.slice(0, -1).join(' → ')}` : null]);
  const a = s.agent;
  if (a && (a.requests || a.files || a.commands)) {
    const did = [a.requests ? plural(a.requests, 'request') : null, a.files ? `edited ${plural(a.files, 'file')}` : null, a.commands ? `ran ${plural(a.commands, 'command')}` : null].filter(Boolean);
    rows.push([agent ? agentMark(agent, 14) : icon('context', 14), `${a.name ?? 'The agent'}: ${did.join(', ')}`, a.unfinished ? 'it stopped in the middle of a request' : a.lastCommand ? h('code.brief-cmd', a.lastCommand) : null]);
  }
  if (!rows.length) return h('p.brief-none', 'Nothing changed in the files, no commits and no commands recorded in that session.');
  return h('ul.brief-summary', rows.map(([ic, title, detail]) => h('li', h('span.brief-ic', ic), h('div', h('strong', title), detail ? (typeof detail === 'string' ? h('span', detail) : detail) : null))));
}

export function briefingCard(ctx, data, { onDone }) {
  const p = ctx.project();
  const b = data.briefing;
  const g = data.git;
  const last = b.lastSession;

  const dismiss = () => {
    prefs.set(dismissKey(ctx.projectId), data.lastWorkedAt);
    onDone();
  };

  // the plan is written under the button: no second question
  async function resumeAll() {
    const r = await resumeWork(ctx.projectId, { data, ask: false });
    if (!r) return;
    ctx.dock.open();
    if (r.agentTerminal) ctx.dock.show(r.agentTerminal.id);
    dismiss();
  }

  // what is still open, most actionable first
  const open = [];
  const files = g?.files ?? [];
  if (g?.changed) {
    const names = files.slice(0, 3).map((f) => f.path.split('/').pop()).join(', ');
    open.push([icon('file', 14), `${plural(g.changed, 'file')} not committed`, names + (g.changed > 3 ? ` +${g.changed - 3}` : '')]);
  }
  if (g?.ahead) open.push([icon('up', 14), `${plural(g.ahead, 'commit')} not pushed`, g.branch ? `on ${g.branch}` : '']);
  for (const s of b.wasRunning) open.push([icon('play', 14), `${s.name} was running`, 'stopped when you left']);
  if (data.currentWork) open.push([icon('work', 14), 'Task in progress', data.currentWork.title]);
  for (const n of data.notes?.entries?.slice(0, 2) ?? []) open.push([icon('context', 14), `Your ${NOTE_LABEL[n.type] ?? 'note'}`, n.text.split('\n').find((l) => l.trim())?.slice(0, 120) ?? '']);
  if (!open.length && g?.lastCommit) open.push([icon('commit', 14), 'Everything committed', `last: “${g.lastCommit.subject}”`]);

  const lower = (t) => t.replace(/^(Today|Yesterday)/, (w) => w.toLowerCase());
  const lastLine = last
    // how long its window was open, not how long it worked: the work session line says that
    ? `Last worked ${lower(when(last.endedAt ?? last.startedAt))} · ${last.agentName}${last.endedAt ? ` open for ${duration(last.endedAt - last.startedAt)}` : ''}`
    : `Last worked ${lower(when(data.lastWorkedAt))}${data.lastWorkedSource ? ` · ${data.lastWorkedSource}` : ''}`;

  const steps = resumeSteps(b, p);
  const cutOff = b.interrupted && last;
  const cutOffTitle = cutOff ? (b.digest?.unfinished
    ? `${last.agentName} stopped in the middle of your work`
    : `${last.agentName} was still open when the computer or FlintBench stopped`) : '';
  return h('section.brief', { 'aria-label': 'Where you left off' },
    h('header.brief-head',
      h('div',
        h('span.brief-kicker', cutOff ? 'Interrupted' : 'Welcome back'),
        h('h2', cutOff ? cutOffTitle : `You were away ${awayText(b.awayMs)}`),
        h('p.brief-sub', cutOff ? `Stopped ${lower(when(last.endedAt ?? last.startedAt))}${b.resume?.resumeOf ? ` · the same ${b.resume.agentName} conversation can be reopened` : ''}` : lastLine)),
      h('button.btn.sm.ghost', { type: 'button', onclick: dismiss, title: 'Hide until you work here again' }, 'Dismiss')),
    (b.workSession ?? data.lastWorkSession) ? lastSessionLine(ctx, b.workSession ?? data.lastWorkSession, g) : null,
    h('div.brief-body',
      h('div.brief-where',
        h('div.label', 'What you did'),
        b.summary ? sessionSummary(b.summary, last?.agent) : h('p.brief-none', 'No work recorded for that session: only time spent with the project open.')),
      h('div.brief-open',
        h('div.label', 'Still open'),
        open.length ? h('ul', open.map(([ic, title, detail]) => h('li', h('span.brief-ic', ic), h('div', h('strong', title), detail ? h('span', detail) : null)))) : h('p.brief-none', 'Nothing left half-done.'))),
    h('footer.brief-foot',
      actionButton('Resume where you left off', resumeAll, { cls: 'btn primary', iconName: 'resume', disabled: !p?.exists }),
      h('span.brief-plan', `Will ${stepsText(steps)}.`)));
}
