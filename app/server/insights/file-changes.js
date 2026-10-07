import fs from 'node:fs/promises';
import path from 'node:path';
import { readText } from '../git/service.js';

/**
 * Files touched in a project and how much each one changed, from git only: the working tree
 * against HEAD (what is not committed yet, untracked files counted as all added) and the commits of
 * a window. Without git there are no line counts: the caller falls back to the paths the file
 * watcher recorded.
 */

const UNTRACKED_LIMIT = 300;

const countLines = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);
const add = (a, b) => (a === null || b === null ? null : a + b);

/**
 * @param {object} git    host git cli
 * @param {string} cwd
 * @param {object} opts
 * @param {number} opts.since  commits from this moment on
 * @param {number} [opts.limit]
 * @returns {{ files: object[], total: number, added: number, removed: number }}
 */
export async function gitFileChanges(git, cwd, { since, limit = 80 }) {
  const [working, untracked, commits] = await Promise.all([
    git.workingNumstat(cwd),
    git.untracked(cwd),
    git.commitStats(cwd, { since }),
  ]);
  const rows = new Map();
  const row = (p) => {
    if (!rows.has(p)) rows.set(p, { path: p, at: 0, added: 0, removed: 0, binary: false, uncommitted: null, commits: [] });
    return rows.get(p);
  };
  for (const f of working) row(f.path).uncommitted = { added: f.added, removed: f.removed, untracked: false };
  for (const p of untracked.slice(0, UNTRACKED_LIMIT)) {
    const text = await readText(path.join(cwd, p));
    row(p).uncommitted = { added: text === null ? null : countLines(text), removed: text === null ? null : 0, untracked: true };
  }
  // not committed: when the file was last written (a deleted file: now)
  await Promise.all([...rows.values()].map(async (r) => {
    r.at = await fs.stat(path.join(cwd, r.path)).then((s) => s.mtimeMs, () => Date.now());
  }));
  for (const c of commits) {
    for (const f of c.files) {
      const r = row(f.path);
      r.commits.push({ sha: c.sha, short: c.short, subject: c.subject, at: c.at, added: f.added, removed: f.removed });
      r.at = Math.max(r.at, c.at);
    }
  }
  let added = 0;
  let removed = 0;
  for (const r of rows.values()) {
    for (const part of [r.uncommitted, ...r.commits].filter(Boolean)) {
      if (part.added === null) r.binary = true;
      r.added = add(r.added, part.added) ?? r.added;
      r.removed = add(r.removed, part.removed) ?? r.removed;
    }
    added += r.added;
    removed += r.removed;
  }
  const files = [...rows.values()].sort((a, b) => b.at - a.at);
  return { files: files.slice(0, limit), total: files.length, added, removed, untrackedCapped: untracked.length > UNTRACKED_LIMIT };
}

const KINDS = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
  css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS', html: 'HTML', htm: 'HTML', md: 'Markdown', mdx: 'Markdown',
  json: 'JSON', py: 'Python', ps1: 'PowerShell', sh: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', go: 'Go',
  rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', php: 'PHP', rb: 'Ruby', svg: 'SVG', vue: 'Vue', svelte: 'Svelte',
  sql: 'SQL', c: 'C', h: 'C', cpp: 'C++', swift: 'Swift', dart: 'Dart',
};

/** The most frequent values of a list, with how many times each appears. */
function top(values, n) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, files]) => ({ name, files }));
}

/**
 * What was done in one work session, from observed facts only, so it reads the same whether the
 * work was done by hand, in an editor or with an agent: how long and with which tools, the files
 * changed (how many, which kinds, in which folders, lines added and removed when git knows), the
 * commits, services started, branch switches, a test run, and what an agent did when there was one.
 *
 * @param {object} input
 * @param {object} input.span        the work session (work-sessions.js)
 * @param {Set<string>} input.paths  files the file watcher saw change in it
 * @param {object[]} input.commits   commitStats() of the session's own commits
 * @param {object[]|null} input.working  workingNumstat() when the session is the latest one
 * @param {object|null} input.digest the agent session's digest (session-digest.js)
 * @param {string|null} input.agentName
 * @param {object|null} input.testRun last test run { service, exitCode, at }
 */
export function sessionSummary({ span, paths, commits = [], working = null, digest = null, agentName = null, testRun = null }) {
  const all = new Set(paths);
  for (const f of digest?.agentFiles ?? []) all.add(f.path);
  for (const c of commits) for (const f of c.files) all.add(f.path);
  const list = [...all].filter((p) => !path.isAbsolute(p));

  // lines: what the session's commits changed, plus what is still not committed in its files
  let added = null;
  let removed = null;
  if (commits.length || working) {
    added = 0;
    removed = 0;
    const count = (f) => { added += f.added ?? 0; removed += f.removed ?? 0; };
    for (const c of commits) c.files.forEach(count);
    for (const f of working ?? []) if (all.has(f.path)) count(f);
  }
  const uncommitted = working ? working.filter((f) => all.has(f.path)).length : null;

  const ext = (p) => KINDS[path.posix.extname(p).slice(1).toLowerCase()] ?? null;
  const dir = (p) => (path.posix.dirname(p) === '.' ? '(project root)' : path.posix.dirname(p));
  const test = testRun && testRun.at >= span.startedAt - 60_000 && testRun.at <= span.endedAt + 10 * 60_000
    ? { service: testRun.service, ok: testRun.exitCode === 0, exitCode: testRun.exitCode } : null;

  return {
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs: span.durationMs,
    editors: span.editors ?? [],
    agents: (span.agents ?? []).map((a) => a.name),
    files: span.filesExact || !span.files ? list.length : Math.max(span.files, list.length),
    filesExact: Boolean(span.filesExact) || list.length >= (span.files ?? 0),
    kinds: top(list.map(ext).filter(Boolean), 3),
    areas: top(list.map(dir), 3),
    added,
    removed,
    uncommitted,
    commits: span.commits ?? [],
    services: span.services ?? [],
    branches: span.branches ?? [],
    test,
    agent: digest ? {
      name: agentName,
      requests: digest.requests,
      files: digest.agentFiles.length,
      commands: digest.commands,
      lastCommand: digest.lastCommands[0] ?? null,
      unfinished: digest.unfinished,
    } : null,
  };
}
