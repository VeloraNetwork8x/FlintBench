/**
 * Work sessions: the project's activity grouped into periods of work, by simple deterministic
 * rules — no AI, no guessing.
 *
 * - Work is what changes the project or is done on it: file changes (10-minute buckets), commits,
 *   agent sessions (from start to their last recorded activity), services started from FlintBench,
 *   task updates and branch switches.
 * - Activity keeps a session open; a gap longer than GAP_MS closes it. The next piece of work
 *   opens a new one.
 * - Context that does not prove work is attached to the sessions it overlaps but never opens or
 *   extends one: an editor window left open (VS Code), dev processes started outside FlintBench,
 *   containers. A VS Code window open all night is not a night of work.
 *
 * Everything reported is an observed fact (time spans, counts, commit subjects, which tools were
 * present). Nothing says who changed a file.
 */

export const GAP_MS = 30 * 60_000;
const FILE_BUCKET_MS = 10 * 60_000;
// an agent session observed only at its start and last activity: beyond this, the time between
// is not counted as one continuous span (a conversation can be resumed days later)
const MAX_AGENT_SPAN_MS = 3 * 60 * 60_000;

const WORK_EVENTS = new Set(['work.updated', 'git.branch_changed']);
const CONTEXT_EVENTS = new Set(['process.started', 'docker.container_started']);

/**
 * @param {object} input
 * @param {object[]} input.events       activity log records, any order
 * @param {object[]} input.agentSessions agent journal records of this project
 * @param {object[]} input.commits      git log entries { sha, short, subject, at }
 * @param {object[]} [input.editorsNow] editors open on the project right now ({ name, since })
 * @param {number}   [input.now]
 * @returns {object[]} sessions, most recent first
 */
export function buildWorkSessions({ events = [], agentSessions = [], commits = [], editorsNow = [], now = Date.now(), gapMs = GAP_MS }) {
  const pulses = [];
  const context = [];
  const editorSpans = [];
  const openEditors = new Map(); // name -> since

  const sorted = [...events].sort((a, b) => a.at - b.at);
  for (const e of sorted) {
    if (e.type === 'file.activity') {
      const start = e.data.bucketStart;
      pulses.push({ start, end: Math.max(start, Math.min(start + FILE_BUCKET_MS, e.at)), kind: 'files', files: e.data.files ?? 0, edits: e.data.events ?? 0, paths: Array.isArray(e.data.paths) ? e.data.paths : null });
    } else if (e.type === 'process.started' && e.data?.managed && e.data.service) {
      pulses.push({ start: e.at, end: e.at, kind: 'service', name: e.data.service });
    } else if (WORK_EVENTS.has(e.type)) {
      pulses.push({ start: e.at, end: e.at, kind: e.type === 'git.branch_changed' ? 'branch' : 'task', branch: e.data?.branch ?? e.data?.to ?? null });
    } else if (CONTEXT_EVENTS.has(e.type)) {
      context.push({ at: e.at, kind: e.type === 'process.started' ? 'process' : 'container', name: e.data?.name ?? e.data?.service ?? '' });
    } else if (e.type === 'editor.opened') {
      openEditors.set(e.data?.name ?? 'Editor', e.data?.since ?? e.at);
    } else if (e.type === 'editor.closed') {
      const name = e.data?.name ?? 'Editor';
      editorSpans.push({ name, start: openEditors.get(name) ?? e.data?.since ?? e.at, end: e.at });
      openEditors.delete(name);
    }
  }
  for (const [name, since] of openEditors) editorSpans.push({ name, start: since, end: now });
  for (const ed of editorsNow) {
    if (!editorSpans.some((s) => s.name === ed.name && s.end >= now)) editorSpans.push({ name: ed.name, start: ed.since ?? now, end: now });
  }

  for (const c of commits) pulses.push({ start: c.at, end: c.at, kind: 'commit', commit: c });
  for (const s of agentSessions) {
    if (!s.startedAt) continue;
    // from start to the last sign of activity: an idle agent window does not extend the session
    const last = Math.min(Math.max(s.startedAt, s.lastActivityAt ?? s.endedAt ?? s.startedAt), s.endedAt ?? Infinity);
    if (last - s.startedAt <= MAX_AGENT_SPAN_MS) {
      pulses.push({ start: s.startedAt, end: last, kind: 'agent', session: s });
    } else {
      // a conversation reopened days later: only its two ends are observed, not the time between
      pulses.push({ start: s.startedAt, end: s.startedAt, kind: 'agent', session: s });
      pulses.push({ start: last, end: last, kind: 'agent', session: s });
    }
  }
  if (!pulses.length) return [];

  pulses.sort((a, b) => a.start - b.start);
  const groups = [];
  let cur = null;
  for (const p of pulses) {
    if (cur && p.start <= cur.end + gapMs) {
      cur.end = Math.max(cur.end, p.end);
      cur.pulses.push(p);
    } else {
      cur = { start: p.start, end: p.end, pulses: [p] };
      groups.push(cur);
    }
  }

  return groups.map((g) => summarize(g, { context, editorSpans, now, gapMs })).reverse();
}

function summarize(g, { context, editorSpans, now, gapMs }) {
  const files = g.pulses.filter((p) => p.kind === 'files');
  const pathCounts = new Map();
  let exactFiles = files.length > 0;
  for (const f of files) {
    if (!f.paths || f.paths.length < f.files) exactFiles = false;
    for (const p of f.paths ?? []) pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
  }
  const topPaths = [...pathCounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => p);

  const commits = g.pulses.filter((p) => p.kind === 'commit').map((p) => p.commit).sort((a, b) => a.at - b.at)
    .map((c) => ({ short: c.short, subject: c.subject, at: c.at }));

  const agents = new Map();
  for (const p of g.pulses.filter((x) => x.kind === 'agent')) {
    const s = p.session;
    const key = s.agentName ?? s.agent;
    const a = agents.get(key) ?? { agent: s.agent, name: key, ms: 0, sessions: 0, tasks: [], ids: new Set() };
    a.ms += Math.max(0, p.end - p.start);
    if (!a.ids.has(s.id)) { a.ids.add(s.id); a.sessions += 1; }
    if (s.task && !a.tasks.includes(s.task)) a.tasks.push(s.task);
    agents.set(key, a);
  }

  const editors = [...new Set(editorSpans.filter((e) => e.start <= g.end && e.end >= g.start).map((e) => e.name))];
  const services = [...new Set(g.pulses.filter((p) => p.kind === 'service').map((p) => p.name))];
  const branches = [...new Set(g.pulses.filter((p) => p.kind === 'branch' && p.branch).map((p) => p.branch))];
  const near = (t) => t >= g.start - 5 * 60_000 && t <= g.end + 5 * 60_000;
  const outside = context.filter((c) => near(c.at));

  // In progress: an agent of this session is still open, or work was seen in the last few minutes
  // and the session did not end with an agent being closed. The gap only decides whether later
  // work joins this session; closing the agent and walking away is not "still working".
  const agentSessions = g.pulses.filter((p) => p.kind === 'agent').map((p) => p.session);
  const agentOpen = agentSessions.some((s) => s.live === true);
  const lastAgentEnd = Math.max(0, ...agentSessions.map((s) => s.endedAt ?? 0));
  const closedAtEnd = lastAgentEnd > 0 && lastAgentEnd >= g.end - FILE_BUCKET_MS;
  const live = agentOpen || (now - g.end < Math.min(gapMs, FILE_BUCKET_MS) && !closedAtEnd);

  return {
    id: `ws-${g.start}`,
    startedAt: g.start,
    endedAt: g.end,
    durationMs: g.end - g.start,
    live,
    files: exactFiles ? pathCounts.size : files.reduce((n, f) => Math.max(n, f.files), 0),
    filesExact: exactFiles,
    fileEdits: files.reduce((n, f) => n + f.edits, 0),
    topPaths,
    commits,
    agents: [...agents.values()].map(({ ids, ...a }) => a),
    editors,
    tools: [...editors, ...agents.keys()],
    services,
    branches,
    processes: outside.filter((c) => c.kind === 'process').length,
    containers: outside.filter((c) => c.kind === 'container').length,
  };
}
