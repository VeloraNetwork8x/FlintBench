import crypto from 'node:crypto';
import { httpError } from '../host/paths.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { AntigravityAdapter } from './antigravity.js';

const ACTIVE_WINDOW = 10 * 60_000; // a session file written in the last 10 min = active
const BACKFILL = 30 * 86_400_000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const AGY_ANSWERING_MS = 30_000; // Antigravity counts as answering while its transcript was written this recently
const MOVE_GRACE_MS = 60_000; // a session stopped to be moved ends as "moved" when it goes within this time

/** The latest real session and how to reopen it: the exact conversation when the agent can name it. */
function closedOf(records, conversationIdOf) {
  const top = records.filter(isRealSession).sort((a, b) => b.endedAt - a.endedAt)[0];
  if (!top || top.transferredAt) return null; // it continues in another window
  const exact = Boolean(conversationIdOf(top.agent, top.agentSessionId));
  return { id: top.id, agent: top.agent, agentName: top.agentName, startedAt: top.startedAt, endedAt: top.endedAt, endReason: top.endReason ?? null, resumeOf: exact ? top.id : null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A session with real work in it: a minute or more, files changed, or cut off. */
export const isRealSession = (r) => Boolean(r.endReason) || (r.filesChanged ?? 0) > 0 || ((r.endedAt ?? r.lastActivityAt ?? r.startedAt) - r.startedAt) >= 60_000;

function cutOffOf(records) {
  const top = records.filter(isRealSession).sort((a, b) => b.endedAt - a.endedAt)[0];
  return top?.endReason ? { agent: top.agent, agentName: top.agentName, endedAt: top.endedAt, endReason: top.endReason } : null;
}

/**
 * Agents domain: detection, launch through adapters, the AI Coding Journal,
 * and honest detection of sessions started outside FlintBench.
 *
 * Attribution vocabulary used everywhere:
 *  - evidence 'pty'           launched by FlintBench in this project's directory
 *  - evidence 'session-file'  the agent's own session file names this project's directory
 *  - filesChanged             files changed WHILE the session was active (not "by the agent")
 *  - commits                  commits created DURING the session window
 */
export class AgentService {
  constructor({ projects, host, terminals, settings, storage, bus, git, runtime, log = console }) {
    this.projects = projects;
    this.host = host;
    this.terminals = terminals;
    this.settings = settings;
    this.storage = storage;
    this.bus = bus;
    this.git = git;
    this.runtime = runtime;
    this.log = log;
    const deps = { host, terminals, settings };
    this.adapters = new Map([new ClaudeCodeAdapter(deps), new CodexAdapter(deps), new AntigravityAdapter(deps)].map((a) => [a.id, a]));
    this.sessions = new Map(); // live sessions (managed + external active)
    for (const a of this.adapters.values()) a.sessions = this.sessions;
    this.persisted = new Map(); // id -> last persisted record (recent window)
    this.processes = [];
    this.unattributed = [];
    this.watchers = [];
    this.absorbedKeys = new Set(); // session files merged into the live session of their running process
    this.openAtStart = new Set(); // outside sessions recorded as open when FlintBench last stopped
    this.turnState = new Map(); // claude: registry key -> busy|idle ; codex: session file key -> last turn id
    this.codexBusy = new Map(); // codex session file key -> a turn is under way
    this.agentInTerminal = new Map(); // FlintBench terminal id -> { agent, convKey, pid } of the agent running in it
    this.movedKeys = new Map(); // conversation key -> when it was stopped to be moved: its end is not a close
    this.pendingMoves = new Map(); // conversation key -> { direction: 'out'|'in', terminalId?, sessionId?, projectId } run when its turn ends
    this.closingForMove = new Set(); // session ids being closed to be moved into FlintBench
    this.busyTouched = new Set(); // projects whose agents started or finished a turn since the last publish
    this.agyWrites = new Map(); // antigravity:<conversation> -> last write of its transcript
    this.busyShown = new Map(); // session id -> the "answering" state last published
  }

  async init() {
    if (this.settings.get().agents.detection) await this.detect();
    this.host.pty.on('exit', (t) => {
      if (t.kind === 'agent' && t.meta?.sessionId) this.#endManaged(t.meta.sessionId, t.exitCode).catch((e) => this.log.warn(`[agents] ${e.message}`));
      // Claude Code typed into this terminal may have just ended with it
      if (t.kind !== 'agent') this.#scheduleExternalScan(1000);
    });
    this.host.pty.on('data', (terminalId) => {
      for (const s of this.sessions.values()) {
        if (s.terminalId === terminalId) s.lastActivityAt = Date.now();
      }
    });
    this.projects.on('file', ({ projectId, kind, path }) => {
      if (kind !== 'file') return;
      for (const s of this.sessions.values()) {
        if (s.projectId === projectId && !s.endedAt && s.files.size < 5000) s.files.add(path);
      }
    });
    this.bus.on('git.commit_created', (event) => {
      for (const s of this.sessions.values()) {
        if (s.projectId === event.projectId && !s.endedAt) s.commits.push({ short: event.data.short, subject: event.data.subject });
      }
    });
    this.runtime.onAgentProcesses((list) => {
      // an agent process appeared or exited (also catches crashes that leave the registry behind)
      // pid + working folder: a process that appears, exits or gets attributed means sessions may change;
      // the first snapshot counts too (agents already open when FlintBench starts)
      const signature = list.map((p) => `${p.pid}@${p.cwd ?? ''}`).sort().join(',');
      const changed = signature !== this.processSignature;
      // a scan waited for this snapshot to tell our terminals from external processes
      if (changed || this.awaitingSnapshot) this.#scheduleExternalScan(300);
      this.awaitingSnapshot = false;
      this.processSignature = signature;
      this.processes = list;
    });
    this.projects.on('added', (s) => {
      this.publish(s.id).catch(() => {});
      // a newly added project may already have history in the agents' own session files
      if (this.initialized && this.settings.get().agents.readSessionFiles) {
        clearTimeout(this.backfillTimer);
        this.backfillTimer = setTimeout(() => this.scanExternal(Date.now() - BACKFILL).catch(() => {}), 500);
      }
    });

    await this.#loadPersisted();
    this.initialized = true;
    for (const id of this.projects.live.keys()) await this.publish(id);
    this.#startExternalWatch();
    this.settings.on('changed', (s, patch) => {
      if (patch.agents) {
        this.#startExternalWatch();
        if (s.agents.detection) this.detect().catch(() => {});
      }
    });
    this.publishTimer = setInterval(() => {
      for (const s of this.sessions.values()) if (s.source === 'flintbench') this.publish(s.projectId).catch(() => {});
    }, 20_000);
    this.publishTimer.unref();
  }

  stop() {
    clearInterval(this.scanTimer);
    clearInterval(this.publishTimer);
    for (const w of this.watchers.splice(0)) w.close();
  }

  async detect() {
    this.host.exec.clearWhichCache();
    await Promise.all([...this.adapters.values()].map((a) => a.detect().catch(() => null)));
    return this.tools();
  }

  tools() {
    return [...this.adapters.values()].map((a) => ({ id: a.id, name: a.name, ...a.getStatus() }));
  }

  adapter(id) {
    const a = this.adapters.get(id);
    if (!a) throw httpError(404, 'Unknown agent');
    return a;
  }

  /* ---------------- managed sessions ---------------- */

  async launch(projectId, agentId, { mode = 'new', task, resumeOf } = {}) {
    const project = this.projects.get(projectId);
    const adapter = this.adapter(agentId);
    const sessionId = crypto.randomUUID();
    const opts = { sessionId };
    if (resumeOf) {
      // reopen that exact conversation in a FlintBench terminal
      const target = this.agentSessionOf(resumeOf);
      if (!target || target.projectId !== projectId || target.agent !== agentId) throw httpError(404, 'Session not found');
      if (target.live && !this.closingForMove.has(resumeOf)) throw httpError(409, 'This conversation is still open in another window. Move it here, or exit it there first.');
      opts.agentSessionId = target.agentSessionId;
      mode = 'resume';
    }
    const agentSessionId = opts.agentSessionId ?? null;
    const terminal = mode === 'resume' ? adapter.resume(project, opts) : adapter.start(project, opts);
    const cleanTask = typeof task === 'string' && task.trim() ? task.trim().slice(0, 200) : null;
    const session = {
      id: sessionId,
      agent: adapter.id,
      agentName: adapter.name,
      projectId,
      source: 'flintbench',
      evidence: 'pty',
      mode,
      task: cleanTask, // only what the user typed; never inferred
      agentSessionId, // the conversation it reopened (Resume): the same conversation, live again
      resumeOf: resumeOf ?? null,
      startedAt: Date.now(),
      endedAt: null,
      lastActivityAt: Date.now(),
      terminalId: terminal.id,
      exitCode: null,
      files: new Set(),
      commits: [],
    };
    this.sessions.set(sessionId, session);
    await this.#persist(session);
    this.bus.emit('agent.started', projectId, { sessionId, agent: adapter.id, mode, task: cleanTask, source: 'flintbench' });
    await this.publish(projectId);
    return { session: this.#public(session), terminal };
  }

  async stopSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.source !== 'flintbench') throw httpError(404, 'Session not found or not managed by FlintBench');
    this.adapter(s.agent).stop(s);
  }

  sendInput(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (!s || s.source !== 'flintbench') throw httpError(404, 'Session not found');
    return this.adapter(s.agent).sendInput(s, String(data));
  }

  async #endManaged(sessionId, exitCode) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.endedAt = Date.now();
    s.exitCode = exitCode;
    const key = this.#convKeyOf(s);
    if (s.transferredAt) this.#forgetTurn(key);
    else if (this.#endedMidTurn(key)) s.endReason = 'mid-turn';
    this.pendingMoves.delete(key);
    this.sessions.delete(sessionId);
    await this.#finalizeFiles(s);
    await this.#persist(s);
    this.bus.emit('agent.stopped', s.projectId, { sessionId, agent: s.agent, exitCode, durationMs: s.endedAt - s.startedAt, source: 'flintbench' });
    await this.publish(s.projectId);
  }

  /** Drop files git ignores (build output, caches) from the observed set. */
  async #finalizeFiles(s) {
    if (!this.projects.has(s.projectId)) return;
    const project = this.projects.get(s.projectId);
    const files = [...s.files];
    if (project.git?.isRepo && files.length) {
      const ignored = await this.host.git.checkIgnored(project.path, files).catch(() => new Set());
      s.filesChangedCount = files.filter((f) => !ignored.has(f)).length;
    } else {
      s.filesChangedCount = files.length;
    }
  }

  #record(s) {
    return {
      id: s.id,
      agent: s.agent,
      agentName: s.agentName,
      projectId: s.projectId,
      source: s.source,
      evidence: s.evidence,
      mode: s.mode ?? null,
      agentSessionId: s.agentSessionId ?? null, // the agent's own session id (external sessions, resumed ones)
      resumeOf: s.resumeOf ?? null,
      transferredAt: s.transferredAt ?? null, // moved to a system terminal window: it continues there
      task: s.task ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      lastActivityAt: s.lastActivityAt,
      durationMs: s.endedAt ? s.endedAt - s.startedAt : null,
      filesChanged: s.filesChangedCount ?? (s.observed ? s.files.size : null),
      filesObserved: Boolean(s.observed || s.source === 'flintbench'),
      commits: s.commits.slice(0, 50),
      exitCode: s.exitCode ?? null,
      // 'interrupted': still open when FlintBench (or the computer) stopped and gone when it came
      // back; 'flintbench-restart': a terminal FlintBench owned died with it
      endReason: s.endReason ?? null,
    };
  }

  #public(s) {
    const key = s.endedAt ? null : this.#convKeyOf(s);
    return {
      ...this.#record(s),
      terminalId: s.terminalId ?? null,
      filesChanged: s.endedAt ? this.#record(s).filesChanged : s.files.size,
      live: !s.endedAt,
      // answering right now: only on evidence (registry, turn record, transcript writes); else waiting
      busy: key ? this.#busy(key) === true : false,
      moving: key ? this.pendingMoves.get(key)?.direction ?? null : null, // a move waiting for the turn to end
      // its conversation can change window: reopened by id, and running where FlintBench can stop it
      movable: Boolean(key && this.#conversationOfKey(key) && this.adapters.get(s.agent)?.launchable && (s.terminalId || s.pid)),
    };
  }

  async #persist(s) {
    const record = this.#record(s);
    this.persisted.set(record.id, record);
    const data = await this.storage.project(s.projectId);
    await data.sessions.append(record);
  }

  async #loadPersisted() {
    const since = Date.now() - BACKFILL - 86_400_000;
    for (const id of this.projects.live.keys()) {
      const data = await this.storage.project(id);
      for (const r of await data.sessions.read({ since })) {
        // a managed session cannot survive a FlintBench restart (its PTY died with us)
        if (r.source === 'flintbench' && !r.endedAt) {
          r.endedAt = r.lastActivityAt ?? r.startedAt;
          r.durationMs = r.endedAt - r.startedAt;
          r.endReason = 'flintbench-restart';
          await data.sessions.append(r);
        }
        // an outside session still open when FlintBench stopped: the first scan tells whether it is
        // still running or was cut off with it (computer shut down)
        if (r.source === 'external' && !r.endedAt) this.openAtStart.add(r.id);
        this.persisted.set(r.id, r);
      }
    }
  }

  /* ---------------- external sessions ---------------- */

  #startExternalWatch() {
    for (const w of this.watchers.splice(0)) w.close();
    clearInterval(this.scanTimer);
    if (!this.settings.get().agents.readSessionFiles) return;
    this.watchers.push(this.host.watch.tree(this.host.agentFiles.claudeDir, () => this.#scheduleExternalScan(1500)));
    this.watchers.push(this.host.watch.tree(this.host.agentFiles.codexDir, () => this.#scheduleExternalScan(1500)));
    // Antigravity writing a conversation: it may be answering
    this.watchers.push(this.host.watch.tree(this.host.agentFiles.antigravityBrainDir, () => this.#scheduleExternalScan(1500)));
    // open/exit of a Claude Code process: react quickly
    this.watchers.push(this.host.watch.tree(this.host.agentFiles.claudeRunningDir, () => this.#scheduleExternalScan(300)));
    // Codex / Gemini keep no per-process registry: their home folder changing means a CLI may have
    // just started, so take a fresh process snapshot (at most every 5 s); its change triggers a rescan
    for (const dir of this.host.agentFiles.agentHomes) this.watchers.push(this.host.watch.file(dir, () => this.#refreshProcesses()));
    this.scanTimer = setInterval(() => this.scanExternal(Date.now() - 2 * 86_400_000).catch(() => {}), 60_000);
    this.scanTimer.unref();
    this.scanExternal(Date.now() - BACKFILL).catch((e) => this.log.warn(`[agents] external scan: ${e.message}`));
  }

  #refreshProcesses() {
    const wait = Math.max(0, (this.lastProcessRefresh ?? 0) + 5000 - Date.now());
    if (this.processRefreshTimer) return;
    this.processRefreshTimer = setTimeout(() => {
      this.processRefreshTimer = null;
      this.lastProcessRefresh = Date.now();
      this.runtime.monitor().catch(() => {});
    }, Math.max(wait, 400));
  }

  #scheduleExternalScan(delay) {
    if (!this.initialized || !this.settings.get().agents.readSessionFiles) return;
    // a sooner request replaces a later one; a later one never postpones a sooner one
    const due = Date.now() + delay;
    if (this.externalDue && this.externalDue <= due) return;
    clearTimeout(this.externalDebounce);
    this.externalDue = due;
    this.externalDebounce = setTimeout(() => {
      this.externalDue = 0;
      this.scanExternal(Date.now() - 2 * 86_400_000).catch(() => {});
    }, delay);
  }

  #matchProject(file) {
    let best = null;
    for (const p of this.projects.live.values()) {
      if (file.agent === 'claude' && !file.cwd) {
        if (this.host.agentFiles.encodeClaudeProjectDir(p.path).toLowerCase() === file.projectDirKey) return p.id;
      } else if (file.cwd && this.host.paths.isInside(p.path, file.cwd)) {
        if (!best || p.path.length > best.path.length) best = p;
      }
    }
    return best?.id ?? null;
  }

  /**
   * The live FlintBench terminal a process runs in (PTY root or an ancestor of it), from the
   * latest process snapshot. `known`: the snapshot already lists the process.
   */
  #terminalOf(pid) {
    const terminals = [...this.host.pty.terminals.values()].filter((t) => !t.exited && t.proc?.pid);
    const byRoot = new Map(terminals.map((t) => [t.proc.pid, t]));
    if (byRoot.has(pid)) return { terminal: byRoot.get(pid), known: true };
    const byPid = new Map(this.runtime.snapshot.processes.map((p) => [p.pid, p]));
    const known = byPid.has(pid);
    const visited = new Set();
    for (let p = byPid.get(pid); p && !visited.has(p.pid); p = byPid.get(p.ppid)) {
      visited.add(p.pid);
      if (byRoot.has(p.ppid)) return { terminal: byRoot.get(p.ppid), known };
    }
    return { terminal: null, known };
  }

  /** True when the session belongs to an agent FlintBench launched (it already has its own terminal tab). */
  #overlapsManaged(file, projectId) {
    // a running process is attributed exactly by #terminalOf; the time window is for session files only
    if (file.pid) return false;
    const candidates = [...this.persisted.values(), ...[...this.sessions.values()].map((s) => this.#record(s))];
    return candidates.some((r) => r.source === 'flintbench' && r.agent === file.agent && r.projectId === projectId
      && file.startedAt >= r.startedAt - 60_000 && file.startedAt <= (r.endedAt ?? Date.now()) + 60_000);
  }

  async scanExternal(since) {
    if (this.scanningExternal) {
      // remember the widest window requested while a scan is running
      this.pendingSince = Math.min(this.pendingSince ?? Infinity, since);
      return;
    }
    this.scanningExternal = true;
    const touched = new Set();
    try {
      const [files, claude] = await Promise.all([
        this.host.agentFiles.list({ since }),
        this.host.agentFiles.listClaudeRunning().catch(() => ({ available: false, running: [] })),
      ]);
      // a registry file left by a Claude Code that was killed (window closed) names a pid Windows may
      // since have given to another program: that program started after the one that wrote the file
      const procs = new Map(this.runtime.snapshot.processes.map((p) => [p.pid, p]));
      const snapshotAt = this.runtime.snapshot.at;
      claude.running = claude.running.filter((r) => {
        const p = procs.get(r.pid);
        const began = r.procStartAt ?? r.startedAt;
        if (!began || !procs.size) return true; // no snapshot (yet, or it failed): nothing to compare
        if (p) return !(p.startedAt && p.startedAt > began + 5000);
        // missing from a snapshot taken after it said it started: that pid is someone else's now;
        // a fresh snapshot (its arrival rescans) settles it either way
        if (snapshotAt && snapshotAt > began + 5000) {
          this.awaitingSnapshot = true;
          this.runtime.monitor().catch(() => {});
          return false;
        }
        return true;
      });
      const unattributed = [];
      const now = Date.now();
      const entries = new Map(files.map((f) => [f.key, f]));
      // an open Claude Code process is a live session from its first second, transcript or not
      for (const r of claude.running) {
        // registry file caught mid-write: keep what this pid already was
        const known = r.unreadable ? [...this.sessions.values()].find((s) => s.pid === r.pid) : null;
        if (r.unreadable && !known) continue;
        const key = known?.key ?? r.key;
        const f = entries.get(key);
        entries.set(key, {
          agent: 'claude',
          key,
          pid: r.pid,
          projectDirKey: f?.projectDirKey ?? null,
          cwd: known ? known.cwd : r.cwd,
          startedAt: known ? known.startedAt : (r.startedAt ?? f?.startedAt ?? now),
          lastActivityAt: Math.max(known?.lastActivityAt ?? 0, r.lastActivityAt ?? 0, f?.lastActivityAt ?? 0) || now,
        });
      }
      this.claudeCwdByPid = new Map(claude.running.filter((r) => r.cwd).map((r) => [r.pid, r.cwd]));
      await this.#detectTurns(claude.running, files).catch((e) => this.log.warn(`[agents] turns: ${e.message}`));
      // Same rule for every agent: an open process is a live session from its first second, in the
      // project of its working directory (Claude Code is covered above by its own registry).
      for (const p of this.processes) {
        if (!p.cwd || (p.agent === 'claude' && claude.available)) continue;
        const key = `${p.agent}:proc:${p.pid}:${p.startedAt ?? 0}`;
        // a process being open is not activity: its session files say when it last did something
        entries.set(key, { agent: p.agent, key, pid: p.pid, cwd: p.cwd, startedAt: p.startedAt ?? now, lastActivityAt: p.startedAt ?? now, fromProcess: true });
      }
      // Antigravity keeps no per-folder session file: its conversation is the transcript written
      // since its process started (the newest one, when several agy windows are open)
      for (const proc of [...entries.values()].filter((e) => e.fromProcess && e.agent === 'antigravity')) {
        const conv = await this.host.agentFiles.latestAntigravityConversation(proc.startedAt - 10_000).catch(() => null);
        if (conv) {
          proc.fileKey = `antigravity:${conv.id}`;
          proc.lastActivityAt = Math.max(proc.lastActivityAt, conv.mtimeMs);
          this.agyWrites.set(proc.fileKey, conv.mtimeMs);
        }
      }
      // a session file written by such a process (first message sent) is the same session, not a second one
      for (const proc of [...entries.values()].filter((e) => e.fromProcess)) {
        for (const f of [...entries.values()]) {
          if (f.fromProcess || f.pid || f.agent !== proc.agent || !f.cwd) continue;
          if (this.host.paths.pathKey(f.cwd) !== this.host.paths.pathKey(proc.cwd) || f.startedAt < proc.startedAt - 10_000) continue;
          entries.delete(f.key);
          this.absorbedKeys.add(f.key);
          proc.lastActivityAt = Math.max(proc.lastActivityAt, f.lastActivityAt);
          // the conversation lives in that file: the live view must read it, not the process key
          proc.fileKey = f.key;
        }
      }
      const seen = new Set();
      // every Codex process is known with its folder: the process list alone says which are open
      const codexSeen = Boolean(this.host.processes?.cwdSupported) && this.runtime.snapshot.at > 0
        && this.processes.filter((p) => p.agent === 'codex').every((p) => p.cwd);
      const agentInTerminal = new Map();
      const deferred = new Set(); // running, but waiting for a process snapshot to be attributed
      for (const f of entries.values()) {
        if (!f.fromProcess && this.absorbedKeys.has(f.key)) continue; // recorded by its process session
        // with the registry, a Claude Code session is live exactly while its process runs; Codex
        // likewise while its processes are seen with their folders (a running one absorbs its file);
        // otherwise (older versions, no process data) a recently written session file counts as live
        const byProcess = (f.agent === 'claude' && claude.available) || (f.agent === 'codex' && codexSeen);
        const active = Boolean(f.pid) || (now - f.lastActivityAt < ACTIVE_WINDOW && !byProcess);
        const projectId = this.#matchProject(f);
        if (!projectId) {
          if (active) unattributed.push({ agent: f.agent, lastActivityAt: f.lastActivityAt, cwd: f.cwd });
          continue;
        }
        const id = `ext-${crypto.createHash('sha1').update(f.key).digest('hex').slice(0, 16)}`;
        if (f.pid) {
          // Claude Code typed into a FlintBench terminal: that tab already shows it
          const { terminal, known } = this.#terminalOf(f.pid);
          if (!terminal && !known && this.runtime.snapshot.at < (f.startedAt ?? 0) + 5000) {
            // too new for the process snapshot: ask for a fresh one (its change triggers a rescan)
            const pending = [...this.sessions.values()].find((x) => x.key === f.key);
            if (pending) seen.add(pending.id);
            // its process is alive: never mark it cut off meanwhile (first scan after a restart)
            deferred.add(id);
            this.awaitingSnapshot = true;
            this.runtime.monitor().catch(() => {});
            continue;
          }
          if (terminal) {
            const convKey = f.fileKey ?? f.key;
            agentInTerminal.set(terminal.id, { agent: f.agent, convKey, pid: f.pid });
            // a session launched here learns its conversation id: it can be reopened or moved exactly
            const managed = terminal.kind === 'agent' ? [...this.sessions.values()].find((x) => x.terminalId === terminal.id && x.source === 'flintbench') : null;
            if (managed && !managed.agentSessionId && this.#conversationOfKey(convKey)) managed.agentSessionId = convKey.slice(convKey.indexOf(':') + 1);
          }
          if (terminal?.kind === 'agent') continue; // launched by FlintBench: its managed session covers it
          f.terminalId = terminal?.id ?? null;
        }
        if (this.#overlapsManaged(f, projectId)) continue;
        const agentName = this.adapters.get(f.agent)?.name ?? f.agent;
        let live = this.sessions.get(id);
        if (active) {
          seen.add(id);
          if (!live) {
            const prev = this.persisted.get(id);
            live = {
              id, key: f.key, agentSessionId: f.key.slice(f.key.indexOf(':') + 1), agent: f.agent, agentName, projectId, source: 'external', evidence: f.fromProcess ? 'process' : 'session-file',
              task: null, startedAt: f.startedAt, endedAt: null, lastActivityAt: f.lastActivityAt,
              files: new Set(), commits: prev?.commits ?? [], observed: true,
            };
            this.sessions.set(id, live);
            // a session resumed after it had ended is a new start too
            if (!prev || prev.endedAt) this.bus.emit('agent.started', projectId, { sessionId: id, agent: f.agent, source: 'external', evidence: 'session-file' });
          }
          live.lastActivityAt = f.lastActivityAt;
          if (f.fileKey) live.agentSessionId = f.fileKey.slice(f.fileKey.indexOf(':') + 1);
          live.convKey = f.fileKey ?? f.key;
          live.pid = f.pid ?? null;
          live.cwd = f.cwd ?? null;
          live.terminalId = f.terminalId ?? null;
          const prev = this.persisted.get(id);
          if (!prev || now - (prev.persistedAt ?? 0) > 5 * 60_000) {
            await this.#persist(live);
            this.persisted.get(id).persistedAt = now;
          }
          touched.add(projectId);
          continue;
        }
        // inactive: finalize once
        const prev = this.persisted.get(id);
        if (live) this.sessions.delete(id);
        if (prev?.endedAt && prev.endedAt >= f.lastActivityAt - 1000 && !live) continue;
        const ended = live ?? {
          id, agentSessionId: f.key.slice(f.key.indexOf(':') + 1), agent: f.agent, agentName, projectId, source: 'external', evidence: 'session-file',
          task: null, startedAt: f.startedAt, lastActivityAt: f.lastActivityAt, files: new Set(), observed: false,
        };
        // a process seen running has just exited; otherwise the last write is the best end we know
        ended.endedAt = live?.pid ? now : f.lastActivityAt;
        // moved to another window, or its process went away while the agent was answering
        const endKey = live?.convKey ?? f.fileKey ?? f.key;
        if (this.#takeMoved(endKey)) { ended.transferredAt = now; this.#forgetTurn(endKey); }
        else if (live?.pid && this.#endedMidTurn(endKey)) ended.endReason = 'mid-turn';
        // recorded as open, not running any more and never seen ending: FlintBench was down when it
        // stopped — the computer was shut down or restarted, or FlintBench was closed meanwhile
        if (!live && prev && !prev.endedAt) ended.endReason = 'interrupted';
        const commits = await this.git.commitsBetween(projectId, ended.startedAt, ended.endedAt).catch(() => []);
        ended.commits = commits.slice(0, 50).map((c) => ({ short: c.short, subject: c.subject }));
        if (live) await this.#finalizeFiles(ended);
        await this.#persist(ended);
        if (live) this.bus.emit('agent.stopped', projectId, { sessionId: id, agent: f.agent, source: 'external', durationMs: ended.endedAt - ended.startedAt });
        touched.add(projectId);
      }
      // first scan after a start: outside sessions recorded as open that are not running any more
      // stopped while FlintBench was down — cut off by a shutdown, or closed meanwhile
      for (const id of this.openAtStart) {
        if (deferred.has(id)) continue; // decided by the scan that follows the process snapshot
        this.openAtStart.delete(id);
        const r = this.persisted.get(id);
        if (this.sessions.has(id) || !r || r.endedAt) continue;
        const ended = { ...r, endedAt: r.lastActivityAt ?? r.startedAt, endReason: 'interrupted' };
        ended.durationMs = ended.endedAt - ended.startedAt;
        this.persisted.set(id, ended);
        await (await this.storage.project(r.projectId)).sessions.append(ended);
        touched.add(r.projectId);
      }
      // sessions whose process exited without a transcript, or whose files disappeared
      for (const s of [...this.sessions.values()]) {
        if (s.source !== 'external' || seen.has(s.id)) continue;
        this.sessions.delete(s.id);
        s.endedAt = s.pid ? now : s.lastActivityAt;
        const endKey = s.convKey ?? s.key;
        if (this.#takeMoved(endKey)) { s.transferredAt = now; this.#forgetTurn(endKey); }
        else if (s.pid && this.#endedMidTurn(endKey)) s.endReason = 'mid-turn';
        await this.#finalizeFiles(s);
        await this.#persist(s);
        this.bus.emit('agent.stopped', s.projectId, { sessionId: s.id, agent: s.agent, source: 'external', durationMs: s.endedAt - s.startedAt });
        touched.add(s.projectId);
      }
      this.agentInTerminal = agentInTerminal;
      this.unattributed = unattributed;
      // a turn started or ended: "answering" and pending moves are shown with the session
      for (const s of this.sessions.values()) {
        if (s.agent !== 'antigravity') continue;
        const answering = this.#busy(this.#convKeyOf(s) ?? '') === true;
        if (this.busyShown.get(s.id) !== answering) { this.busyShown.set(s.id, answering); touched.add(s.projectId); }
        if (answering) this.#scheduleExternalScan(AGY_ANSWERING_MS + 1000);
      }
      for (const id of this.busyTouched) touched.add(id);
      this.busyTouched.clear();
      for (const id of touched) await this.publish(id);
      this.#runPendingMoves().catch((e) => this.log.warn(`[agents] move: ${e.message}`));
    } finally {
      this.scanningExternal = false;
      if (this.pendingSince !== undefined) {
        const next = this.pendingSince;
        this.pendingSince = undefined;
        this.scanExternal(next).catch(() => {});
      }
    }
  }

  /* ---------------- read models ---------------- */

  async publish(projectId) {
    if (!this.projects.has(projectId)) return;
    const active = [...this.sessions.values()].filter((s) => s.projectId === projectId).map((s) => this.#public(s));
    const records = [...this.persisted.values()].filter((r) => r.projectId === projectId && r.endedAt);
    const last = records.sort((a, b) => b.endedAt - a.endedAt)[0] ?? null;
    const lastActivity = Math.max(0, ...active.map((s) => s.lastActivityAt ?? 0), last?.endedAt ?? 0);
    if (lastActivity) this.projects.touchActivity(projectId, 'lastAgentAt', lastActivity);
    this.projects.patch(projectId, 'agents', {
      active,
      last: last ? { agent: last.agent, agentName: last.agentName, startedAt: last.startedAt, endedAt: last.endedAt, source: last.source, task: last.task, endReason: last.endReason ?? null } : null,
      // the latest session with real work in it, when it was cut off (shutdown, FlintBench closed):
      // a one-second session opened afterwards does not hide it
      cutOff: active.length ? null : cutOffOf(records),
      // the conversation closed most recently, while nothing is open: Home and Overview offer to reopen it
      closed: active.length ? null : closedOf(records, (agent, id) => this.adapters.get(agent)?.conversationId(id) ?? null),
    });
  }

  /** The agent was answering when its process went away (Claude Code's registry, Codex's session file). Forgets the key. */
  #endedMidTurn(key) {
    if (!key) return false;
    // Antigravity records no turns: a recent write is not proof it was cut off mid-answer
    const busy = !key.startsWith('antigravity:') && this.#busy(key) === true;
    this.#forgetTurn(key);
    return busy;
  }

  #forgetTurn(key) {
    if (!key) return;
    if (key.startsWith('claude:')) this.turnState.delete(key);
    this.codexBusy.delete(key);
  }

  /**
   * true while the agent answers, false while it waits for input, null when it cannot be told.
   * Claude Code: its registry status. Codex: a turn started and not completed in its session file.
   * Antigravity: no turn record — its transcript written in the last 30 seconds.
   */
  #busy(key) {
    if (key.startsWith('claude:')) {
      const state = this.turnState.get(key);
      return state === 'busy' ? true : state === 'idle' ? false : null;
    }
    if (key.startsWith('antigravity:')) {
      const at = this.agyWrites.get(key);
      return at ? Date.now() - at < AGY_ANSWERING_MS : null;
    }
    return this.codexBusy.get(key) ?? null;
  }

  /** "agent:session id" of a live session's conversation: its own, or the one seen running in its tab. */
  #convKeyOf(s) {
    if (s.convKey) return s.convKey;
    if (s.agentSessionId) return `${s.agent}:${s.agentSessionId}`;
    return s.terminalId ? this.agentInTerminal.get(s.terminalId)?.convKey ?? null : null;
  }

  /** The id the agent's CLI reopens this conversation by, or null. */
  #conversationOfKey(key) {
    const i = key?.indexOf(':') ?? -1;
    if (i < 0) return null;
    return this.adapters.get(key.slice(0, i))?.conversationId(key.slice(i + 1)) ?? null;
  }

  /** True once when this conversation was stopped to be moved (recently): its end is a move. */
  #takeMoved(key) {
    const at = this.movedKeys.get(key);
    this.movedKeys.delete(key);
    return Boolean(at && Date.now() - at < MOVE_GRACE_MS);
  }

  /**
   * Bring a live session forward: one inside FlintBench answers with its terminal tab; one outside
   * focuses the window that hosts its process (Windows Terminal, VS Code, a console…).
   */
  async focusSession(id) {
    const s = this.sessions.get(id);
    if (!s) throw httpError(404, 'Session not found or no longer running');
    if (s.terminalId) return { action: 'terminal', terminalId: s.terminalId, projectId: s.projectId };
    if (!s.pid) return { action: 'none', reason: 'no-process', projectId: s.projectId };
    const r = await this.runtime.focusProcessWindow(s.pid);
    return { action: r.focused || r.title ? 'focused' : 'none', ...r, projectId: s.projectId };
  }

  /**
   * "Agent finished a task" notifications. Claude Code flips its registry status busy → idle at the
   * end of every turn; Codex appends a task_complete record. The preview is the agent's last reply,
   * read from its own session file only when Settings › Agents › Task previews is on.
   * Only transitions seen while FlintBench runs are announced, never history.
   */
  async #detectTurns(running, files) {
    const previews = this.settings.get().agents.taskPreviews !== false;
    const announce = (agent, cwd, summary, sessionKey) => {
      const projectId = this.#matchProject({ agent, cwd });
      if (!projectId) return;
      const clean = summary ? summary.replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 280) : null;
      this.bus.emit('agent.turn_completed', projectId, { agent, agentName: this.adapters.get(agent)?.name ?? agent, summary: clean, sessionKey });
    };
    for (const r of running) {
      if (r.unreadable || !r.status) continue;
      const before = this.turnState.get(r.key);
      this.turnState.set(r.key, r.status);
      if (before !== r.status) {
        const projectId = this.#matchProject({ agent: 'claude', cwd: r.cwd });
        if (projectId) this.busyTouched.add(projectId);
      }
      if (before === 'busy' && r.status === 'idle') {
        const summary = previews ? await this.host.agentFiles.claudeLastReply(r.key.slice(r.key.indexOf(':') + 1)).catch(() => null) : null;
        announce('claude', r.cwd, summary, r.key);
      }
    }
    for (const f of files) {
      if (f.agent !== 'codex' || !f.file || !f.cwd || Date.now() - f.lastActivityAt > 15 * 60_000) continue;
      const turn = await this.host.agentFiles.codexLastTurn(f.file).catch(() => null);
      if (!turn) continue;
      if (turn.busy !== null && this.codexBusy.get(f.key) !== turn.busy) {
        this.codexBusy.set(f.key, turn.busy);
        const projectId = this.#matchProject({ agent: 'codex', cwd: f.cwd });
        if (projectId) this.busyTouched.add(projectId);
      }
      if (!turn.turnId) continue;
      const known = this.turnState.has(f.key);
      const before = this.turnState.get(f.key);
      this.turnState.set(f.key, turn.turnId);
      if (known && before !== turn.turnId) announce('codex', f.cwd, previews ? turn.message : null, f.key);
    }
  }

  /** The agent's own session id behind a FlintBench session id, for external Claude Code sessions only. */
  /** An external session whose conversation can be followed live: Claude Code, Codex or Antigravity. */
  transcriptSessionOf(id) {
    const s = this.sessions.get(id) ?? this.persisted.get(id);
    if (!s || !['claude', 'codex', 'antigravity'].includes(s.agent) || s.source !== 'external' || !s.agentSessionId) return null;
    return { agent: s.agent, agentSessionId: s.agentSessionId, projectId: s.projectId, live: !s.endedAt };
  }

  /**
   * Moves the conversation running in a FlintBench terminal tab (Claude Code, Codex, Antigravity)
   * to a window of the system terminal: it stops here, then the same conversation continues there
   * by its id. Two processes never hold one conversation at once. `when: 'idle'` waits for the
   * agent to finish the answer it is writing.
   */
  async transferToSystemTerminal(terminalId, { when = 'now' } = {}) {
    if (!this.host.isWindows) throw httpError(501, 'Moving a session to a terminal window is available on Windows only');
    const t = this.host.pty.get(terminalId);
    if (!t || t.exited) throw httpError(404, 'Terminal not found or not running');
    const managed = t.kind === 'agent' && t.meta?.sessionId ? this.sessions.get(t.meta.sessionId) : null;
    const inTab = this.agentInTerminal.get(terminalId);
    const convKey = inTab?.convKey ?? (managed ? this.#convKeyOf(managed) : null);
    const agent = inTab?.agent ?? managed?.agent;
    if (!convKey || !this.#conversationOfKey(convKey)) throw httpError(409, 'No conversation to move in this tab yet: send the agent a first message');
    if (agent === 'claude' && !(await this.host.agentFiles.findClaudeTranscript(this.#conversationOfKey(convKey)))) throw httpError(409, 'Nothing to move yet: send a first message to Claude Code here');
    const adapter = this.adapter(agent);
    const agentSessionId = convKey.slice(convKey.indexOf(':') + 1);
    if (!adapter.resumeCommand(agentSessionId)) throw httpError(409, `${adapter.name} is not installed or not on PATH`);
    if (when === 'idle' && this.#busy(convKey) === true) {
      this.pendingMoves.set(convKey, { direction: 'out', terminalId, projectId: t.projectId, requestedAt: Date.now() });
      await this.publish(t.projectId);
      return { pending: true, agentName: adapter.name };
    }
    this.pendingMoves.delete(convKey);
    const project = this.projects.get(t.projectId);

    // stop it here first; its end is recorded as "moved", never as a close or an interruption
    this.movedKeys.set(convKey, Date.now());
    if (managed) managed.transferredAt = Date.now();
    const pid = t.kind === 'agent' ? t.pid : inTab?.pid;
    if (t.kind === 'agent') this.host.pty.stop(terminalId);
    else this.host.exec.killTree(pid); // the agent was typed into a shell tab: the shell stays
    for (let waited = 0; waited < 6000 && pid && isAlive(pid); waited += 200) await sleep(200);

    const app = this.#openWindow(adapter, project, agentSessionId);
    if (t.kind === 'agent') this.host.pty.remove(terminalId); // the conversation lives in the new window now
    this.bus.emit('agent.moved', project.id, { agent: adapter.id, agentName: adapter.name, direction: 'out', app });
    this.#scheduleExternalScan(1500);
    return { app, agentName: adapter.name };
  }

  /**
   * The opposite move: a conversation open in a window outside FlintBench is closed there and
   * reopened, with its history, in a FlintBench terminal tab. `when: 'idle'` waits for the answer
   * in progress to end.
   */
  async moveIntoFlintBench(sessionId, { when = 'now' } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s || s.source !== 'external' || s.endedAt) throw httpError(404, 'Session not found or no longer running');
    if (s.terminalId) throw httpError(409, 'This session already runs in a FlintBench terminal tab');
    if (!s.pid) throw httpError(409, 'Its process is not known: exit it there, then resume it here');
    const convKey = this.#convKeyOf(s);
    if (!this.#conversationOfKey(convKey)) throw httpError(409, 'This conversation cannot be reopened by its id');
    const adapter = this.adapter(s.agent);
    // checked before closing anything: a conversation is never closed there without opening here
    if (!adapter.launchable || !adapter.enabled() || !adapter.detection.installed) throw httpError(409, `${adapter.name} cannot be launched from FlintBench (Settings › Agents)`);
    if (!this.projects.get(s.projectId).exists) throw httpError(409, 'Project folder is missing');
    if (when === 'idle' && this.#busy(convKey) === true) {
      this.pendingMoves.set(convKey, { direction: 'in', sessionId, projectId: s.projectId, requestedAt: Date.now() });
      await this.publish(s.projectId);
      return { pending: true, agentName: adapter.name };
    }
    this.pendingMoves.delete(convKey);
    this.movedKeys.set(convKey, Date.now());
    this.host.exec.killTree(s.pid);
    for (let waited = 0; waited < 6000 && isAlive(s.pid); waited += 200) await sleep(200);
    if (isAlive(s.pid)) {
      this.movedKeys.delete(convKey);
      throw httpError(409, `${adapter.name} did not close in the other window`);
    }
    this.closingForMove.add(sessionId);
    try {
      const r = await this.launch(s.projectId, s.agent, { resumeOf: sessionId });
      this.bus.emit('agent.moved', s.projectId, { agent: adapter.id, agentName: adapter.name, direction: 'in' });
      this.#scheduleExternalScan(1000);
      return { ...r, agentName: adapter.name };
    } finally {
      this.closingForMove.delete(sessionId);
    }
  }

  /** Drops a move waiting for the end of a turn (the session's or its tab's). */
  async cancelMove({ sessionId, terminalId }) {
    for (const [key, m] of this.pendingMoves) {
      if ((sessionId && m.sessionId === sessionId) || (terminalId && m.terminalId === terminalId)) {
        this.pendingMoves.delete(key);
        await this.publish(m.projectId);
        return { cancelled: true };
      }
    }
    return { cancelled: false };
  }

  /** Runs the moves whose agent has finished its answer; drops the ones whose session is gone. */
  async #runPendingMoves() {
    for (const [key, m] of [...this.pendingMoves]) {
      if (this.#busy(key) === true) continue;
      this.pendingMoves.delete(key);
      const tab = m.direction === 'out' ? this.host.pty.get(m.terminalId) : null;
      const gone = m.direction === 'out' ? !tab || tab.exited : !this.sessions.get(m.sessionId);
      if (gone) {
        await this.publish(m.projectId);
        continue;
      }
      try {
        if (m.direction === 'out') await this.transferToSystemTerminal(m.terminalId);
        else await this.moveIntoFlintBench(m.sessionId);
      } catch (e) {
        this.log.warn(`[agents] pending move: ${e.message}`);
        await this.publish(m.projectId);
      }
    }
  }

  /** Opens the conversation in a new Windows Terminal window, else a console window. Returns the app's name. */
  #openWindow(adapter, project, agentSessionId) {
    const cmd = adapter.resumeCommand(agentSessionId);
    const title = `${adapter.name} · ${project.name}`;
    const wt = this.host.exec.which('wt');
    if (wt) {
      // `--` ends Windows Terminal's own options; an npm .cmd shim runs through cmd.exe
      const line = cmd.isShim ? [process.env.ComSpec || 'cmd.exe', '/d', '/c', cmd.file, ...cmd.args] : [cmd.file, ...cmd.args];
      this.host.exec.launchDetached(wt, ['-w', 'new', 'new-tab', '-d', project.path, '--title', title, '--', ...line], { hide: false });
      return 'Windows Terminal';
    }
    this.host.exec.launchInConsoleWindow(cmd.file, cmd.args, { cwd: project.path, title });
    return 'a console window';
  }

  /** A recorded session whose exact conversation its agent can reopen. */
  agentSessionOf(id) {
    const s = this.sessions.get(id) ?? this.persisted.get(id);
    if (!s || !this.adapters.get(s.agent)?.conversationId(s.agentSessionId)) return null;
    return { agent: s.agent, agentSessionId: s.agentSessionId, projectId: s.projectId, live: !s.endedAt };
  }

  overview() {
    const unmanagedProcesses = this.processes.filter((p) => !p.managed).map((p) => {
      // Windows does not expose another process's cwd; Claude Code's own registry does
      const cwd = p.cwd ?? this.claudeCwdByPid?.get(p.pid) ?? null;
      const project = cwd ? [...this.projects.live.values()].filter((s) => this.host.paths.isInside(s.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0] : null;
      return { agent: p.agent, pid: p.pid, projectId: project?.id ?? null, cwdKnown: Boolean(cwd) };
    });
    return {
      tools: this.tools(),
      active: [...this.sessions.values()].map((s) => this.#public(s)),
      processes: unmanagedProcesses,
      unattributed: this.unattributed,
      readSessionFiles: this.settings.get().agents.readSessionFiles,
    };
  }

  async journal({ projectId, limit = 100, since } = {}) {
    const ids = projectId ? [projectId] : [...this.projects.live.keys()];
    const all = [];
    for (const id of ids) {
      const data = await this.storage.project(id);
      all.push(...(await data.sessions.read({ since })));
    }
    const liveIds = new Set(this.sessions.keys());
    return all
      .map((r) => (liveIds.has(r.id) ? this.#public(this.sessions.get(r.id)) : r))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, limit);
  }
}
