import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Read-only access to the *metadata* of local agent session files.
 * Contents of conversations are not read for detection; for Codex only the first line's
 * `cwd` field is extracted (the tool records its own working directory there).
 * Transcript content is read only by the opt-in live transcript (Settings › Agents).
 */

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export const CLAUDE_RUNNING_DIR = path.join(os.homedir(), '.claude', 'sessions');
export const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
// agent home folders: written to when a CLI starts (logs, state), before any session file exists
// Antigravity CLI: one folder per conversation; its own readable transcript sits in
// brain/<conversation id>/.system_generated/logs/transcript.jsonl
export const ANTIGRAVITY_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
const agyTranscriptOf = (id) => path.join(ANTIGRAVITY_BRAIN_DIR, id, '.system_generated', 'logs', 'transcript.jsonl');

export async function findAntigravityTranscript(conversationId) {
  if (!SESSION_ID.test(conversationId)) return null;
  const file = agyTranscriptOf(conversationId);
  return (await statSafe(file))?.isFile() ? file : null;
}

/** The Antigravity conversation most recently written since `since` (ms), or null. */
export async function latestAntigravityConversation(since) {
  let best = null;
  for (const dir of await readdirSafe(ANTIGRAVITY_BRAIN_DIR)) {
    if (!dir.isDirectory() || !SESSION_ID.test(dir.name)) continue;
    const st = await statSafe(agyTranscriptOf(dir.name));
    if (!st || st.mtimeMs < since) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { id: dir.name, mtimeMs: st.mtimeMs };
  }
  return best;
}

export const AGENT_HOMES = [path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.gemini'), path.join(os.homedir(), '.antigravity')];

/** Claude Code names a project's transcript directory after its cwd with every non-alphanumeric replaced by '-'. */
export function encodeClaudeProjectDir(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The Claude Code transcript of this folder last written inside [from, to] (+2 min of slack):
 * for sessions started by FlintBench, whose Claude session id is not recorded.
 */
export async function claudeTranscriptNear(projectPath, from, to = Date.now()) {
  const dir = path.join(CLAUDE_PROJECTS_DIR, encodeClaudeProjectDir(projectPath));
  let best = null;
  for (const entry of await readdirSafe(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry.name);
    const st = await statSafe(file);
    if (!st || st.mtimeMs < from - 60_000 || st.mtimeMs > to + 120_000) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
  }
  return best?.file ?? null;
}

async function statSafe(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readdirSafe(p) {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function listClaudeSessions({ since }) {
  const sessions = [];
  for (const dir of await readdirSafe(CLAUDE_PROJECTS_DIR)) {
    if (!dir.isDirectory()) continue;
    const full = path.join(CLAUDE_PROJECTS_DIR, dir.name);
    for (const entry of await readdirSafe(full)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(full, entry.name);
      const st = await statSafe(file);
      if (!st || st.mtimeMs < since) continue;
      sessions.push({
        agent: 'claude',
        key: `claude:${entry.name.replace(/\.jsonl$/, '')}`,
        file,
        projectDirKey: dir.name.toLowerCase(),
        cwd: null,
        startedAt: Math.round(st.birthtimeMs || st.ctimeMs),
        lastActivityAt: Math.round(st.mtimeMs),
      });
    }
  }
  return sessions;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readJsonSafe(file) {
  // the file can be caught mid-write; one short retry before giving up
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 60));
    }
  }
  return null;
}

/**
 * Open Claude Code processes. Claude Code keeps `~/.claude/sessions/<pid>.json` for as long as
 * a process runs: it is written at startup (before any transcript exists) and removed on exit.
 * Only identity fields are kept: pid, session id, working directory and timestamps.
 * `available` is false when this Claude Code version does not keep the registry.
 */
export async function listClaudeRunning() {
  const st = await statSafe(CLAUDE_RUNNING_DIR);
  if (!st?.isDirectory()) return { available: false, running: [] };
  const running = [];
  for (const entry of await readdirSafe(CLAUDE_RUNNING_DIR)) {
    const m = /^(\d+)\.json$/.exec(entry.name);
    if (!entry.isFile() || !m) continue;
    const pid = Number(m[1]);
    if (!isAlive(pid)) continue;
    const raw = await readJsonSafe(path.join(CLAUDE_RUNNING_DIR, entry.name));
    if (!raw || typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string') {
      running.push({ agent: 'claude', pid, unreadable: true });
      continue;
    }
    const startedAt = Number(raw.startedAt) || null;
    // Windows: the process creation time (FILETIME, 100 ns since 1601) Claude Code recorded for
    // itself; a different process later given the same pid started after it
    let procStartAt = null;
    if (String(raw.pidDomain ?? '').startsWith('win32') && /^\d{15,20}$/.test(String(raw.procStart ?? ''))) {
      procStartAt = Number(BigInt(raw.procStart) / 10000n) - 11_644_473_600_000;
    }
    running.push({
      agent: 'claude',
      pid,
      key: `claude:${raw.sessionId}`,
      cwd: raw.cwd,
      startedAt,
      procStartAt,
      lastActivityAt: Number(raw.updatedAt) || startedAt,
      status: raw.status === 'busy' || raw.status === 'idle' ? raw.status : null, // busy while working on a turn
    });
  }
  return { available: true, running };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transcript file of one Claude Code session (only when the user enabled live transcripts). */
export async function findClaudeTranscript(sessionId) {
  if (!SESSION_ID.test(sessionId)) return null;
  for (const dir of await readdirSafe(CLAUDE_PROJECTS_DIR)) {
    if (!dir.isDirectory()) continue;
    const file = path.join(CLAUDE_PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if ((await statSafe(file))?.isFile()) return file;
  }
  return null;
}

const codexFileCache = new Map();

/** Session file of one Codex session ("rollout-…" name, from its key), newest days searched first. */
export async function findCodexTranscript(name) {
  if (!/^rollout-[\w.-]+$/.test(name)) return null;
  const cached = codexFileCache.get(name);
  if (cached && (await statSafe(cached))?.isFile()) return cached;
  const desc = (entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  for (const year of desc(await readdirSafe(CODEX_SESSIONS_DIR))) {
    for (const month of desc(await readdirSafe(path.join(CODEX_SESSIONS_DIR, year)))) {
      for (const day of desc(await readdirSafe(path.join(CODEX_SESSIONS_DIR, year, month)))) {
        const file = path.join(CODEX_SESSIONS_DIR, year, month, day, `${name}.jsonl`);
        if ((await statSafe(file))?.isFile()) {
          codexFileCache.set(name, file);
          return file;
        }
      }
    }
  }
  return null;
}

/**
 * Complete lines appended to a JSONL file after `offset`. A torn last line is left for the
 * next read. The first read of a large file starts `maxBytes` from the end.
 * Returns { lines, offset, reset } — reset when the file shrank (rewritten) and was read from the start.
 */
export async function readJsonlFrom(file, offset, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const st = await statSafe(file);
  if (!st) return null;
  const reset = st.size < offset;
  let start = reset ? 0 : offset;
  let skipFirst = false;
  if (st.size - start > maxBytes) {
    start = st.size - maxBytes;
    skipFirst = true;
  }
  if (st.size === start) return { lines: [], offset: start, reset };
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(st.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset: start, reset };
    const lines = buffer.subarray(0, end).toString('utf8').split('\n');
    return { lines: skipFirst ? lines.slice(1) : lines, offset: start + end + 1, reset };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Complete JSON lines from the last `bytes` of a JSONL file, newest last. */
async function tailJsonl(file, bytes = 256 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn line */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

/** Claude Code: the text of its last reply in a session (for a task-finished notification). */
export async function claudeLastReply(sessionId) {
  const file = await findClaudeTranscript(sessionId);
  if (!file) return null;
  const lines = await tailJsonl(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.type !== 'assistant' || l.isSidechain || !Array.isArray(l.message?.content)) continue;
    const text = l.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) return text;
  }
  return null;
}

/** Codex: its latest completed turn ({ turnId, message }) in a session file. */
/**
 * The last finished Codex turn, and whether a newer one is under way (`busy`: a task_started after
 * the last end of a turn — task_complete, or turn_aborted when it was interrupted; null when the
 * tail read shows neither).
 */
export async function codexLastTurn(file) {
  const lines = await tailJsonl(file);
  let done = null;
  let started = -1;
  let ended = -1;
  for (let i = lines.length - 1; i >= 0 && (done === null || started < 0); i--) {
    const p = lines[i].payload;
    if (lines[i].type !== 'event_msg') continue;
    if ((p?.type === 'task_complete' || p?.type === 'turn_aborted') && ended < 0) ended = i;
    if (p?.type === 'task_complete' && done === null) done = { turnId: p.turn_id ?? lines[i].timestamp, message: p.last_agent_message ?? null };
    else if (p?.type === 'task_started' && started < 0) started = i;
  }
  const busy = started < 0 && ended < 0 ? null : started > ended;
  return { turnId: done?.turnId ?? null, message: done?.message ?? null, busy };
}

const codexCwdCache = new Map();

async function readCodexCwd(file) {
  if (codexCwdCache.has(file)) return codexCwdCache.get(file);
  let cwd = null;
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
    if (m) cwd = JSON.parse(m[1]);
  } catch {
    cwd = null;
  } finally {
    await handle?.close();
  }
  codexCwdCache.set(file, cwd);
  return cwd;
}

export async function listCodexSessions({ since }) {
  const sessions = [];
  const sinceDate = new Date(since);
  sinceDate.setHours(0, 0, 0, 0);
  for (const year of await readdirSafe(CODEX_SESSIONS_DIR)) {
    if (!year.isDirectory() || Number(year.name) < sinceDate.getFullYear()) continue;
    const yearDir = path.join(CODEX_SESSIONS_DIR, year.name);
    for (const month of await readdirSafe(yearDir)) {
      if (!month.isDirectory()) continue;
      const monthDir = path.join(yearDir, month.name);
      for (const day of await readdirSafe(monthDir)) {
        if (!day.isDirectory()) continue;
        const dayDate = new Date(Number(year.name), Number(month.name) - 1, Number(day.name));
        // a session started earlier can still be written today; keep a 2-day margin
        if (dayDate.getTime() < sinceDate.getTime() - 2 * 86_400_000) continue;
        const dayDir = path.join(monthDir, day.name);
        for (const entry of await readdirSafe(dayDir)) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const file = path.join(dayDir, entry.name);
          const st = await statSafe(file);
          if (!st || st.mtimeMs < since) continue;
          sessions.push({
            agent: 'codex',
            key: `codex:${entry.name.replace(/\.jsonl$/, '')}`,
            file,
            projectDirKey: null,
            cwd: await readCodexCwd(file),
            startedAt: Math.round(st.birthtimeMs || st.ctimeMs),
            lastActivityAt: Math.round(st.mtimeMs),
          });
        }
      }
    }
  }
  return sessions;
}

export function createAgentFiles() {
  return {
    claudeDir: CLAUDE_PROJECTS_DIR,
    claudeRunningDir: CLAUDE_RUNNING_DIR,
    antigravityBrainDir: ANTIGRAVITY_BRAIN_DIR,
    codexDir: CODEX_SESSIONS_DIR,
    agentHomes: AGENT_HOMES,
    encodeClaudeProjectDir,
    listClaudeRunning,
    findClaudeTranscript,
    findCodexTranscript,
    findAntigravityTranscript,
    latestAntigravityConversation,
    claudeLastReply,
    codexLastTurn,
    readJsonlFrom,
    claudeTranscriptNear,
    async list({ since, agents = ['claude', 'codex'] }) {
      const lists = await Promise.all([
        agents.includes('claude') ? listClaudeSessions({ since }) : [],
        agents.includes('codex') ? listCodexSessions({ since }) : [],
      ]);
      return lists.flat();
    },
  };
}
