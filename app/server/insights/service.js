import fs from 'node:fs/promises';
import path from 'node:path';
import { claudeItems, codexItems, antigravityItems } from '../agents/transcript.js';
import { isRealSession } from '../agents/service.js';
import { buildWorkSessions, GAP_MS } from './work-sessions.js';
import { digestTranscript } from './session-digest.js';
import { gitFileChanges, sessionSummary } from './file-changes.js';
import { notesView } from '../work/service.js';

const DAY = 86_400_000;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Deterministic insights built only from local facts: attention indicators,
 * the "Where was I?" resume snapshot, and secondary analytics. No AI summaries.
 */
// how long a project's summary and files changed stay valid (see #memo)
const MEMO_MS = 15_000;

export class InsightsService {
  constructor({ projects, host, storage, git, work, agents, history = null, log = console }) {
    this.projects = projects;
    this.host = host;
    this.storage = storage;
    this.git = git;
    this.work = work;
    this.agents = agents;
    this.history = history;
    this.log = log;
    this.todos = new Map();
    this.analyticsCache = new Map();
    this.memo = new Map(); // key -> { at, promise }
  }

  /**
   * The overview's reads (git log, the activity log, the last agent transcript) cost a few hundred
   * ms on a quiet machine and seconds while agents run git too; switching between projects asked
   * for them every time. A result is kept MEMO_MS, and one already being computed is shared.
   */
  #memo(key, compute) {
    const hit = this.memo.get(key);
    if (hit && Date.now() - hit.at < MEMO_MS) return hit.promise;
    const promise = compute();
    this.memo.set(key, { at: Date.now(), promise });
    promise.catch(() => { if (this.memo.get(key)?.promise === promise) this.memo.delete(key); });
    return promise;
  }

  init() {
    this.projects.on('state', (s) => this.#updateAttention(s.id));
    this.projects.on('added', (s) => setTimeout(() => this.#countTodos(s.id), 5000));
    let i = 0;
    for (const id of this.projects.live.keys()) setTimeout(() => this.#countTodos(id), 8000 + (i++) * 400);
    this.todoTimer = setInterval(() => {
      let j = 0;
      for (const id of this.projects.live.keys()) setTimeout(() => this.#countTodos(id), (j++) * 400);
    }, 15 * 60_000);
    this.todoTimer.unref();
  }

  stop() {
    clearInterval(this.todoTimer);
  }

  async #countTodos(id) {
    if (!this.projects.has(id)) return;
    const p = this.projects.get(id);
    if (!p.exists || !p.git?.isRepo) return;
    const count = await this.host.git.countMarkers(p.path).catch(() => null);
    if (count !== null) {
      this.todos.set(id, count);
      this.#updateAttention(id);
    }
  }

  attentionFor(s) {
    const items = [];
    if (!s.exists) items.push({ kind: 'missing', severity: 'error', label: 'Folder not found' });
    const g = s.git;
    if (g?.isRepo) {
      if (g.conflicts) items.push({ kind: 'conflicts', severity: 'error', label: `${g.conflicts} merge conflict${g.conflicts > 1 ? 's' : ''}` });
      if (g.behind) items.push({ kind: 'behind', severity: 'warn', label: `${g.behind} behind ${g.upstream ?? 'upstream'}` });
      if (g.ahead) items.push({ kind: 'ahead', severity: 'info', label: `${g.ahead} unpushed commit${g.ahead > 1 ? 's' : ''}` });
      if (g.changed) items.push({ kind: 'dirty', severity: 'info', label: `${g.changed} uncommitted file${g.changed > 1 ? 's' : ''}` });
      if (g.detached) items.push({ kind: 'detached', severity: 'warn', label: 'Detached HEAD' });
      if (g.error) items.push({ kind: 'git-error', severity: 'warn', label: 'Git status failed' });
    }
    const test = s.runtime?.lastTestRun;
    if (test && test.exitCode !== 0) items.push({ kind: 'tests', severity: 'error', label: `Last test run failed (${test.service}, exit ${test.exitCode})` });
    for (const svc of s.runtime?.services ?? []) {
      if (svc.status === 'failed' && svc.kind !== 'test') items.push({ kind: 'service', severity: 'warn', label: `${svc.name} exited with code ${svc.exitCode}` });
    }
    for (const c of s.docker?.containers ?? []) {
      if (c.health === 'unhealthy') items.push({ kind: 'container', severity: 'error', label: `${c.service ?? c.name} unhealthy` });
    }
    if (s.work?.blocked) items.push({ kind: 'blocked', severity: 'warn', label: `${s.work.blocked} blocked work item${s.work.blocked > 1 ? 's' : ''}` });
    const todos = this.todos.get(s.id);
    if (todos) items.push({ kind: 'todo', severity: 'info', label: `${todos} TODO/FIXME` });
    return items;
  }

  #updateAttention(id) {
    if (!this.projects.has(id)) return;
    const s = this.projects.get(id);
    const next = this.attentionFor(s);
    if (JSON.stringify(next) !== JSON.stringify(s.attention)) this.projects.patch(id, 'attention', next);
  }

  /**
   * An agent session's transcript, read from the agent's own file on this machine, as unified
   * items, each time a briefing is computed; nothing of it is stored. Only when "Last conversation
   * in Welcome back" is on (Settings > Agents; settings saved before it existed count as on).
   */
  async #transcriptItems(session, projectPath) {
    if (this.agents.settings?.get().agents.resumeExchange === false) return null;
    const files = this.host.agentFiles;
    const sid = session.agentSessionId ?? '';
    let file = null;
    let parse = null;
    if (session.agent === 'claude') {
      file = (sid && await files.findClaudeTranscript(sid)) || await files.claudeTranscriptNear(projectPath, session.startedAt, session.endedAt ?? Date.now());
      parse = (raw) => claudeItems(raw);
    } else if (session.agent === 'codex' && sid.startsWith('rollout-')) {
      file = await files.findCodexTranscript(sid);
      const state = { items: false };
      parse = (raw) => codexItems(raw, state);
    } else if (session.agent === 'antigravity' && !sid.startsWith('proc:')) {
      file = await files.findAntigravityTranscript(sid);
      const state = { pending: [] };
      parse = (raw) => antigravityItems(raw, state);
    }
    if (!file) return null;
    const chunk = await files.readJsonlFrom(file, 0);
    const items = [];
    for (const line of chunk?.lines ?? []) {
      if (!line.trim()) continue;
      try { items.push(...parse(JSON.parse(line))); } catch { /* torn line */ }
    }
    return items;
  }

  /**
   * The agent session a returning owner cares about: the most recent one with real work in it
   * (a minute or more, files changed, or cut off), not a one-second "hi" opened afterwards.
   * A session still running wins: there is nothing to come back to.
   */
  async #lastWorkingSession(projectId) {
    const recent = await this.agents.journal({ projectId, limit: 12 }).catch(() => []);
    if (!recent.length) return null;
    if (recent[0].live) return recent[0];
    return recent.find(isRealSession) ?? recent[0];
  }

  /** Paths changed in the project between two moments (file-activity buckets that recorded them). */
  #changedPaths(events, from, to) {
    const paths = new Set();
    let unknown = 0;
    for (const e of events) {
      if (e.type !== 'file.activity' || e.data.bucketStart < from - 10 * 60_000 || e.data.bucketStart > to) continue;
      if (Array.isArray(e.data.paths)) for (const p of e.data.paths) paths.add(p);
      if (!Array.isArray(e.data.paths) || e.data.paths.length < (e.data.files ?? 0)) unknown += 1;
    }
    return { paths, complete: unknown === 0 };
  }

  /**
   * "Welcome back": what a returning owner needs to restart - how long they were away, the last
   * agent session with what happened in it (requests, files its tools edited, commands, whether it
   * was cut off), files changed outside the agent, the services that were on when work stopped, and
   * how to pick the conversation up again. Deterministic, from local files only.
   */
  async #briefing(s, events, recentWork = []) {
    const lastSession = await this.#lastWorkingSession(s.id);
    const items = lastSession && !lastSession.live ? await this.#transcriptItems(lastSession, s.path).catch(() => null) : null;
    const digest = items ? digestTranscript(items, { projectPath: s.path, from: lastSession.startedAt, to: lastSession.endedAt ?? lastSession.lastActivityAt ?? Date.now() }) : null;
    // services whose last recorded event is "started" but that are not running now: they were on
    // when work stopped (machine shut down, FlintBench closed) and can be brought back
    const lastByService = new Map();
    for (const e of events) {
      if ((e.type === 'process.started' || e.type === 'process.stopped') && e.data?.managed && e.data.service) lastByService.set(e.data.service, e.type);
    }
    const wasRunning = s.runtime.services
      .filter((x) => x.status !== 'running' && lastByService.get(x.name) === 'process.started')
      .map((x) => ({ id: x.id, name: x.name }));
    let resume = null;
    if (lastSession && !lastSession.live && ['claude', 'codex', 'antigravity'].includes(lastSession.agent)) {
      // the exact conversation only when Claude's own session id is known (not a process key)
      const exact = Boolean(this.agents.agentSessionOf(lastSession.id));
      resume = { agent: lastSession.agent, agentName: lastSession.agentName, resumeOf: exact ? lastSession.id : null };
    }
    // files changed during the last stretch of work that the agent's own tools did not write
    let outside = null;
    // the stretch of work the agent session belongs to (the latest one when there is no agent)
    const agentEnd = lastSession ? (lastSession.endedAt ?? lastSession.lastActivityAt ?? lastSession.startedAt) : null;
    const span = (lastSession
      ? recentWork.find((w) => w.startedAt <= agentEnd && w.endedAt >= lastSession.startedAt)
      : recentWork[0]) ?? null;
    if (span && !span.live) {
      const { paths, complete } = this.#changedPaths(events, span.startedAt, span.endedAt);
      const byAgent = new Set((digest?.agentFiles ?? []).map((f) => f.path));
      const files = [...paths].filter((p) => !byAgent.has(p));
      outside = { files: files.slice(0, 12), count: files.length, complete, editors: span.editors };
    }
    const interrupted = Boolean(lastSession && !lastSession.live && (lastSession.endReason || digest?.unfinished));
    const summary = span && !span.live ? await this.#sessionSummary(s, span, events, { digest, agentName: lastSession?.agentName ?? null, latest: span === recentWork[0] }).catch(() => null) : null;
    return {
      awayMs: s.activity.lastActivityAt ? Date.now() - s.activity.lastActivityAt : null,
      lastSession: lastSession ? {
        id: lastSession.id, agent: lastSession.agent, agentName: lastSession.agentName, source: lastSession.source,
        startedAt: lastSession.startedAt, endedAt: lastSession.endedAt ?? null, live: Boolean(lastSession.live), task: lastSession.task ?? null,
        endReason: lastSession.endReason ?? null, commits: lastSession.commits ?? [],
      } : null,
      digest: digest ? {
        requests: digest.requests, prompts: digest.prompts, agentFiles: digest.agentFiles.slice(0, 12), agentFileCount: digest.agentFiles.length,
        commands: digest.commands, lastCommands: digest.lastCommands, unfinished: digest.unfinished,
      } : null,
      // cut off: still open when the computer or FlintBench stopped, or stopped in the middle of a turn
      interrupted,
      outside,
      // the work session that agent session belongs to (profile Test shows it in the briefing)
      workSession: span,
      // what was done in it, from facts only, with or without an agent (profile Test)
      summary,
      wasRunning,
      resume,
    };
  }

  /**
   * The facts of one work session put together (file-changes.js): the files the watcher saw change,
   * the session's own commits with their line counts and, when it is the latest session, what is
   * still not committed in those files.
   */
  async #sessionSummary(s, span, events, { digest, agentName, latest }) {
    const { paths } = this.#changedPaths(events, span.startedAt, span.endedAt);
    let commits = [];
    let working = null;
    if (s.git?.isRepo && s.exists) {
      const own = new Set((span.commits ?? []).map((c) => c.short));
      if (own.size) {
        const stats = await this.host.git.commitStats(s.path, { since: span.startedAt - 60_000, until: span.endedAt + 60_000 }).catch(() => []);
        commits = stats.filter((c) => own.has(c.short));
      }
      if (latest) working = await this.host.git.workingNumstat(s.path).catch(() => null);
    }
    const testRun = s.runtime?.lastTestRun ?? null;
    return sessionSummary({ span, paths, commits, working, digest, agentName, testRun });
  }

  /**
   * Files changed in the last `days` days, most recent first. FlintBench's own file history
   * (history/service.js) says how each file changed while it watched — lines added and removed,
   * with or without git. Git, when the project has it, adds what is not committed and the commits
   * of the window (made while FlintBench was not running, too). Files seen changing before the
   * history existed are listed without line counts.
   */
  fileChanges(id, { days = 7 } = {}) {
    this.projects.get(id); // unknown project: 404 now, not a cached failure
    return this.#memo(`${id}:files:${days}`, () => this.#fileChanges(id, { days }));
  }

  async #fileChanges(id, { days = 7 } = {}) {
    const s = this.projects.get(id);
    const since = Date.now() - Math.min(90, Math.max(1, Number(days) || 7)) * DAY;
    const observed = this.history && s.exists ? await this.history.files(id, { since }).catch(() => null) : null;
    const git = s.exists && s.git?.isRepo ? await gitFileChanges(this.host.git, s.path, { since, limit: 500 }).catch(() => null) : null;
    const rows = new Map();
    for (const f of observed?.files ?? []) rows.set(f.path, { ...f, uncommitted: null, commits: [] });
    for (const g of git?.files ?? []) {
      const r = rows.get(g.path) ?? {
        path: g.path, at: g.at, saves: 0, added: g.binary ? null : g.added, removed: g.binary ? null : g.removed,
        status: g.binary ? 'binary' : g.uncommitted?.untracked ? 'new' : 'edited',
      };
      r.uncommitted = g.uncommitted;
      r.commits = g.commits;
      r.at = Math.max(r.at, g.at);
      rows.set(g.path, r);
    }
    // before the history existed: the paths the watcher recorded, without line counts
    const data = await this.storage.project(id);
    const earlier = new Map();
    for (const e of await data.activity.read({ since })) {
      if (e.type !== 'file.activity') continue;
      for (const p of e.data.paths ?? []) if (!rows.has(p)) earlier.set(p, Math.max(earlier.get(p) ?? 0, e.data.bucketStart));
    }
    // only files that still exist: editors' and tools' temporary files come and go
    for (const [p, at] of earlier) {
      if (!s.exists || !(await fs.stat(path.join(s.path, p)).then((x) => x.isFile(), () => false))) continue;
      rows.set(p, { path: p, at, saves: 0, added: null, removed: null, status: 'edited', earlier: true, uncommitted: null, commits: [] });
    }
    const files = [...rows.values()].sort((a, b) => b.at - a.at);
    let added = 0;
    let removed = 0;
    for (const f of files) { added += f.added ?? 0; removed += f.removed ?? 0; }
    return { git: Boolean(git), trackedSince: observed?.since ?? null, complete: observed?.complete ?? false, since, files: files.slice(0, 120), total: files.length, added, removed };
  }

  /**
   * Work sessions of one project over the last `days` days (see work-sessions.js), most recent
   * first. Commits count only when made with this repository's own identity (git user.email), so a
   * pull of other people's history does not invent sessions.
   */
  async workSessions(id, { days = 30, from, to = Date.now() } = {}) {
    const s = this.projects.get(id);
    const since = from ?? Date.now() - Math.min(180, Math.max(1, Number(days) || 30)) * DAY;
    // a session already running at `since` starts earlier: read a gap's worth more
    const readFrom = since - GAP_MS;
    const data = await this.storage.project(id);
    const [events, agentSessions, commits] = await Promise.all([
      data.activity.read({ since: readFrom }),
      data.sessions.read({ since: readFrom }),
      this.#ownCommits(s, readFrom, to),
    ]);
    const editorsNow = (s.editors ?? []).map((e) => ({ name: e.name, since: e.since }));
    // the stored records lag behind: sessions open right now come from the live state
    const live = new Map((s.agents?.active ?? []).map((a) => [a.id, a]));
    const sessions = [...agentSessions.filter((r) => !live.has(r.id)), ...live.values()];
    return buildWorkSessions({ events, agentSessions: sessions, commits, editorsNow })
      .filter((w) => w.endedAt >= since && w.startedAt <= to);
  }

  async #ownCommits(s, since, until) {
    if (!s.git?.isRepo || !s.exists) return [];
    const email = await this.host.git.userEmail(s.path).catch(() => null);
    if (!email) return [];
    return this.host.git.log(s.path, { limit: 2000, since, until, all: true, author: email }).catch(() => []);
  }

  /** "Where was I?" — assembled deterministically from local state. */
  resume(id) {
    this.projects.get(id);
    return this.#memo(`${id}:resume`, () => this.#resume(id));
  }

  async #resume(id) {
    const s = this.projects.get(id);
    const data = await this.storage.project(id);
    const events = await data.activity.read({ limit: 400 });
    const meaningful = events.filter((e) => ['git.commit_created', 'git.branch_changed', 'agent.started', 'agent.stopped', 'work.updated', 'process.started', 'process.stopped', 'docker.container_started', 'docker.container_stopped'].includes(e.type));
    const a = s.activity;
    const sources = [
      ['file change', a.lastFileChangeAt],
      ['commit', a.lastCommitAt],
      ['agent session', a.lastAgentAt],
    ].filter(([, t]) => t);
    sources.sort((x, y) => y[1] - x[1]);
    const lastFileBucket = [...events].reverse().find((e) => e.type === 'file.activity');
    const notes = data.notes.get();
    const recentWork = await this.workSessions(id, { days: 60 }).catch(() => []);
    const lastWorkSession = recentWork[0] ?? null;
    return {
      id: s.id,
      name: s.name,
      path: s.path,
      lastWorkedAt: a.lastActivityAt,
      lastWorkedSource: sources[0]?.[0] ?? null,
      lastOpenedAt: a.lastOpenedAt,
      lastFileActivity: lastFileBucket ? { at: lastFileBucket.data.bucketStart, files: lastFileBucket.data.files } : null,
      git: s.git?.isRepo ? {
        branch: s.git.branch,
        detached: s.git.detached,
        changed: s.git.changed,
        staged: s.git.staged,
        untracked: s.git.untracked,
        ahead: s.git.ahead,
        behind: s.git.behind,
        lastCommit: s.git.lastCommit,
        files: (s.gitFiles ?? []).slice(0, 8).map((f) => ({ path: f.path, x: f.x, y: f.y })),
      } : null,
      currentWork: s.work?.inProgress ?? null,
      lastAgent: s.agents.active[0] ? { ...s.agents.active[0], live: true } : s.agents.last,
      services: [
        ...s.runtime.services.map((x) => ({ name: x.name, status: x.status, kind: 'service', url: x.url })),
        ...s.docker.containers.map((c) => ({ name: c.service ?? c.name, status: c.state === 'running' ? 'running' : 'stopped', kind: 'container' })),
        ...s.runtime.processes.map((p) => ({ name: `${p.name} (external)`, status: 'running', kind: 'process', url: p.ports[0] ? `http://localhost:${p.ports[0]}` : null })),
      ],
      notes: notesView(notes).entries.length ? { entries: notesView(notes).entries.slice(0, 5).map((e) => ({ ...e, text: e.text.slice(0, 600) })), updatedAt: notes.updatedAt } : null,
      recent: meaningful.slice(-30).reverse(),
      briefing: await this.#briefing(s, events, recentWork),
      // the most recent work session (profile Test shows it in the briefing)
      lastWorkSession,
      attention: s.attention,
    };
  }

  /**
   * Activity over a period, bucketed for charts.
   *   { year }            1 January → 31 December of that year (up to now), by day: the calendar
   *   { from, to }        any window (ms), e.g. "the last 6 hours" or "the last 2 years"
   *   { days }            the last N days (compatibility)
   * bucket: minute | 5min | 15min | hour | day | week | month, chosen from the window length unless
   * given so that a chart has at most ~100 bars.
   * Counted per bucket: observed work time (the work sessions' spans, split across the buckets they
   * cross), commits (git log, every branch), agent sessions started (journal), work items
   * completed, and projects with any activity (files changed, commits, sessions).
   */
  async analytics(opts = {}) {
    if (typeof opts !== 'object' || opts === null) opts = { days: opts };
    const now = Date.now();
    let from;
    let to = now;
    if (opts.year) {
      const y = Math.trunc(Number(opts.year));
      if (!(y >= 2000 && y <= new Date().getFullYear())) throw Object.assign(new Error('Unknown year'), { status: 400, expose: true });
      from = new Date(y, 0, 1).getTime();
      to = Math.min(new Date(y + 1, 0, 1).getTime() - 1, now);
    } else if (opts.from) {
      from = Math.max(now - 10 * 365 * DAY, Number(opts.from));
      to = opts.to ? Math.min(now, Number(opts.to)) : now;
    } else {
      const days = Math.min(731, Math.max(1, Number(opts.days) || 7));
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      from = start.getTime() - (days - 1) * DAY;
    }
    if (!(from < to)) throw Object.assign(new Error('Empty period'), { status: 400, expose: true });
    const span = to - from;
    const HOUR = 3_600_000;
    const bucket = ['minute', '5min', '15min', 'hour', 'day', 'week', 'month'].includes(opts.bucket) ? opts.bucket
      : opts.year ? 'day'
        : span <= 1.5 * HOUR ? 'minute' : span <= 6 * HOUR ? '5min' : span <= 24 * HOUR ? '15min'
          : span <= 4 * DAY ? 'hour' : span <= 100 * DAY ? 'day' : span <= 2 * 365 * DAY ? 'week' : 'month';
    const minutes = { minute: 1, '5min': 5, '15min': 15, hour: 60 }[bucket];
    const cacheKey = `${bucket}:${Math.floor(from / 60_000)}:${Math.floor(to / 60_000)}`;
    const cached = this.analyticsCache.get(cacheKey);
    if (cached && now - cached.at < 60_000) return cached.value;

    const startOf = (ts) => {
      const d = new Date(ts);
      if (minutes) { d.setMinutes(Math.floor(d.getMinutes() / minutes) * minutes, 0, 0); return d.getTime(); }
      d.setHours(0, 0, 0, 0);
      if (bucket === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      if (bucket === 'month') d.setDate(1);
      return d.getTime();
    };
    const next = (ts) => {
      const d = new Date(ts);
      if (minutes) d.setMinutes(d.getMinutes() + minutes);
      else if (bucket === 'day') d.setDate(d.getDate() + 1);
      else if (bucket === 'week') d.setDate(d.getDate() + 7);
      else d.setMonth(d.getMonth() + 1);
      return d.getTime();
    };
    const series = new Map();
    for (let t = startOf(from); t <= to; t = next(t)) series.set(t, { start: t, date: dayKey(t), projects: new Set(), workMs: 0, commits: 0, sessions: 0, agentMinutes: 0, completed: 0 });
    const slot = (ts) => (ts >= from && ts <= to ? series.get(startOf(ts)) : undefined);

    const perProject = [];
    let commitsTotal = 0;
    let completedTotal = 0;
    const sessionsByAgent = {};
    let sessionsTotal = 0;
    let sessionMs = 0;
    let workMsTotal = 0;
    for (const s of this.projects.live.values()) {
      const data = await this.storage.project(s.id);
      const events = await data.activity.read({ since: from });
      let active = false;
      for (const e of events) {
        if (!['file.activity', 'git.commit_created', 'agent.started', 'work.updated', 'git.branch_changed'].includes(e.type)) continue;
        const d = slot(e.type === 'file.activity' ? e.data.bucketStart : e.at);
        if (d) { d.projects.add(s.id); active = true; }
      }
      let commits = 0;
      if (s.git?.isRepo && s.exists) {
        const log = await this.host.git.log(s.path, { limit: 5000, since: from, until: to, all: true }).catch(() => []);
        for (const c of log) {
          const d = slot(c.at);
          if (d) { d.commits += 1; d.projects.add(s.id); commits += 1; active = true; }
        }
      }
      commitsTotal += commits;
      const sessions = (await data.sessions.read({ since: from })).filter((r) => r.startedAt >= from && r.startedAt <= to);
      for (const r of sessions) {
        sessionsTotal += 1;
        sessionsByAgent[r.agentName ?? r.agent] = (sessionsByAgent[r.agentName ?? r.agent] ?? 0) + 1;
        const ms = Math.max(0, Math.min(r.endedAt ?? now, to) - r.startedAt);
        sessionMs += ms;
        const d = slot(r.startedAt);
        if (d) { d.sessions += 1; d.agentMinutes += Math.round(ms / 60_000); d.projects.add(s.id); }
        active = true;
      }
      // time in work sessions, clipped to the period
      const work = await this.workSessions(s.id, { from, to }).catch(() => []);
      const workMs = work.reduce((n, w) => n + Math.max(0, Math.min(w.endedAt, to) - Math.max(w.startedAt, from)), 0);
      workMsTotal += workMs;
      for (const w of work) {
        const end = Math.min(w.endedAt, to);
        for (let t = startOf(Math.max(w.startedAt, from)); t < end; t = next(t)) {
          const d = series.get(t);
          const part = Math.min(next(t), end) - Math.max(t, w.startedAt, from);
          if (d && part > 0) { d.workMs += part; d.projects.add(s.id); }
        }
      }
      const completed = data.work.get().items.filter((i) => i.completedAt && i.completedAt >= from && i.completedAt <= to);
      completedTotal += completed.length;
      for (const i of completed) {
        const d = slot(i.completedAt);
        if (d) d.completed += 1;
      }
      if (active || commits || sessions.length || workMs) {
        perProject.push({ id: s.id, name: s.name, commits, sessions: sessions.length, workSessions: work.length, workMs, completed: completed.length, lastActivityAt: s.activity.lastActivityAt });
      }
    }
    perProject.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    const value = {
      from,
      to,
      bucket,
      rangeDays: Math.max(1, Math.round(span / DAY)),
      since: from,
      activeProjects: perProject.length,
      commits: commitsTotal,
      sessions: sessionsTotal,
      sessionHours: Math.round((sessionMs / 3_600_000) * 10) / 10,
      workMs: workMsTotal,
      sessionsByAgent,
      completedWork: completedTotal,
      days: [...series.values()].map((d) => ({ ...d, projects: d.projects.size })),
      projects: perProject,
      recent: [...this.projects.live.values()]
        .filter((s) => s.activity.lastActivityAt)
        .sort((a, b) => b.activity.lastActivityAt - a.activity.lastActivityAt)
        .slice(0, 8)
        .map((s) => ({ id: s.id, name: s.name, lastActivityAt: s.activity.lastActivityAt })),
    };
    this.analyticsCache.set(cacheKey, { at: now, value });
    return value;
  }
}
