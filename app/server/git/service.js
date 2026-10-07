import fs from 'node:fs/promises';
import path from 'node:path';
import { assertRelativeRepoPath } from '../host/paths.js';

const TEXT_LIMIT = 512 * 1024;

/** A small text file's content, or null when it is binary, too large or unreadable. */
export async function readText(file) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > TEXT_LIMIT) return null;
    const buf = await fs.readFile(file);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// starter .gitignore files offered when a repository is created from the dashboard
const GITIGNORE = {
  node: ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/', '.env', '.env.*', '!.env.example', '*.log', '.DS_Store', 'Thumbs.db', ''].join('\n'),
  python: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '.env', 'dist/', 'build/', '*.egg-info/', '.pytest_cache/', '.mypy_cache/', '.DS_Store', 'Thumbs.db', ''].join('\n'),
  basic: ['.env', '*.log', '.DS_Store', 'Thumbs.db', ''].join('\n'),
};

/**
 * A .gitignore built from the dashboard's file tree: an optional starter template, then each
 * chosen file or folder anchored to the repository root (`/name` or `/folder/`), with gitignore's
 * pattern characters escaped so a name is matched literally. Null when nothing was chosen.
 */
export function customGitignore({ base, paths } = {}) {
  const lines = [];
  for (const item of Array.isArray(paths) ? paths.slice(0, 500) : []) {
    const rel = String(item?.path ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    const parts = rel.split('/');
    if (!rel || /[\r\n]/.test(rel) || parts.some((p) => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(rel) || rel === '.git' || rel.startsWith('.git/')) {
      throw Object.assign(new Error(`Cannot ignore "${rel || item?.path}"`), { status: 400, expose: true });
    }
    const escaped = rel.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ ');
    lines.push(`/${escaped}${item.dir ? '/' : ''}`);
  }
  const template = GITIGNORE[base] ?? '';
  if (!lines.length) return template || null;
  return `${template}${template ? '\n' : ''}# Chosen in FlintBench\n${[...new Set(lines)].join('\n')}\n`;
}

/**
 * Git domain: keeps live git state for every project in sync with the working tree,
 * whoever changes it (FlintBench, VS Code, GitHub Desktop, an agent...).
 */
export class GitService {
  constructor({ projects, host, bus, log = console }) {
    this.projects = projects;
    this.host = host;
    this.bus = bus;
    this.log = log;
    this.inflight = new Map(); // id -> { running: Promise, again: bool, full: bool }
    this.timers = new Map();
    this.known = new Map(); // id -> { headSha, branch, commits:Set<sha> }
    this.details = new Map(); // id -> { commits, branches }
    this.acting = new Set(); // ids with a git action from FlintBench in flight: its events say so
  }

  init() {
    this.projects.on('added', (s) => this.refresh(s.id, { full: true }));
    this.projects.on('removed', (id) => {
      this.known.delete(id);
      this.details.delete(id);
    });
    this.projects.on('file', ({ projectId, kind }) => {
      this.schedule(projectId, kind === 'file' ? 400 : 150, kind !== 'file');
    });
    for (const s of this.projects.live.values()) this.refresh(s.id, { full: true });
    // reconciliation fallback (missed watcher events, Linux deep files)
    this.reconcileTimer = setInterval(() => {
      let i = 0;
      for (const id of this.projects.live.keys()) setTimeout(() => this.refresh(id), (i++ % 20) * 250);
    }, 60_000);
    this.reconcileTimer.unref();
  }

  stop() {
    clearInterval(this.reconcileTimer);
    for (const t of this.timers.values()) clearTimeout(t);
  }

  schedule(id, delay, full) {
    const existing = this.timers.get(id);
    if (existing) {
      clearTimeout(existing.timer);
      full = full || existing.full;
    }
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.refresh(id, { full });
    }, delay);
    this.timers.set(id, { timer, full });
  }

  async refresh(id, { full = false } = {}) {
    const slot = this.inflight.get(id);
    if (slot) {
      slot.again = true;
      slot.full = slot.full || full;
      return slot.running;
    }
    const entry = { again: false, full };
    entry.running = (async () => {
      try {
        await this.#refresh(id, full);
        while (entry.again) {
          const nextFull = entry.full;
          entry.again = false;
          entry.full = false;
          await this.#refresh(id, nextFull);
        }
      } finally {
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, entry);
    return entry.running;
  }

  async #refresh(id, full) {
    if (!this.projects.has(id)) return;
    const project = this.projects.get(id);
    if (!project.exists) return;
    const cwd = project.path;
    try {
      if (!project.git?.isRepo) {
        const isRepo = await this.host.git.isRepo(cwd);
        if (!isRepo) {
          this.projects.patch(id, 'git', { isRepo: false, updatedAt: Date.now() });
          return;
        }
        full = true;
      }
      const status = await this.host.git.status(cwd);
      const prev = this.known.get(id);
      const headChanged = !prev || prev.headSha !== status.headSha || prev.branch !== status.branch;
      let commits = this.details.get(id)?.commits ?? [];
      if (full || headChanged) {
        commits = await this.host.git.log(cwd, { limit: 15 });
        const branches = await this.host.git.branches(cwd).catch(() => []);
        const webUrl = await this.host.git.webUrl(cwd).catch(() => null);
        const userEmail = await this.host.git.userEmail(cwd).catch(() => null);
        this.details.set(id, { commits, branches, webUrl, userEmail });
      }
      if (prev && headChanged) this.#emitHeadEvents(id, prev, status, commits);
      else if (prev) this.#emitPush(id, prev, status, commits);
      this.known.set(id, {
        headSha: status.headSha,
        branch: status.branch,
        upstream: status.upstream,
        ahead: status.ahead,
        commits: new Set(commits.map((c) => c.sha)),
      });

      const last = commits[0] ?? null;
      const summary = {
        isRepo: true,
        branch: status.branch,
        detached: status.detached,
        headSha: status.headSha,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        staged: status.staged,
        unstaged: status.unstaged,
        untracked: status.untracked,
        conflicts: status.conflicts,
        changed: status.files.length,
        lastCommit: last ? { sha: last.sha, short: last.short, subject: last.subject, author: last.author, at: last.at } : null,
        webUrl: this.details.get(id)?.webUrl ?? null, // the repository's page, for commit links
        updatedAt: Date.now(),
      };
      const before = project.git;
      project.gitFiles = status.files;
      this.projects.patch(id, 'git', summary);
      // "you worked here" only for your own commits: a cloned or pulled history is not your work
      const email = this.details.get(id)?.userEmail?.toLowerCase();
      const own = email ? commits.find((c) => c.authorEmail?.toLowerCase() === email) : last;
      if (own) this.projects.touchActivity(id, 'lastCommitAt', own.at);
      if (before?.isRepo && (before.changed !== summary.changed || before.staged !== summary.staged || before.ahead !== summary.ahead || before.behind !== summary.behind)) {
        this.bus.emit('git.status_changed', id, { changed: summary.changed, staged: summary.staged, ahead: summary.ahead, behind: summary.behind });
      }
    } catch (error) {
      this.projects.patch(id, 'git', { ...(project.git ?? {}), isRepo: project.git?.isRepo ?? false, error: error.message, updatedAt: Date.now() });
    }
  }

  #emitHeadEvents(id, prev, status, commits) {
    if (prev.branch !== status.branch) {
      this.bus.emit('git.branch_changed', id, { from: prev.branch, to: status.branch, detached: status.detached });
    }
    // commits that appeared on the current branch since the last observation
    const fresh = [];
    for (const c of commits) {
      if (prev.commits.has(c.sha)) break;
      fresh.push(c);
    }
    if (prev.branch === status.branch && fresh.length && fresh.length < commits.length) {
      for (const c of fresh.reverse()) {
        // only commits authored recently count as "created" (rebases/pulls of old commits do not)
        if (Date.now() - c.at < 30 * 60_000) {
          this.bus.emit('git.commit_created', id, { sha: c.sha, short: c.short, subject: c.subject, author: c.author, commitAt: c.at, source: this.#source(id) });
        }
      }
    }
  }

  /**
   * A push, seen from the working tree: HEAD stayed put while the commits waiting for the remote
   * went down (or a branch got its upstream with nothing left to send). Whoever pushed.
   */
  #emitPush(id, prev, status, commits) {
    if (!status.upstream || prev.headSha !== status.headSha) return;
    const sameUpstream = prev.upstream === status.upstream;
    const published = !prev.upstream && status.ahead === 0 && Boolean(status.headSha);
    if (!published && !(sameUpstream && status.ahead < prev.ahead)) return;
    const head = commits[0];
    this.bus.emit('git.pushed', id, {
      upstream: status.upstream,
      count: published ? null : prev.ahead - status.ahead, // null: a new branch, its count is not known
      published,
      sha: head?.sha ?? status.headSha,
      short: head?.short ?? status.headSha?.slice(0, 7),
      subject: head?.subject ?? '',
      source: this.#source(id),
    });
  }

  #source(id) {
    return this.acting.has(id) ? 'flintbench' : 'external';
  }

  detail(id) {
    const project = this.projects.get(id);
    const d = this.details.get(id) ?? { commits: [], branches: [] };
    return { summary: project.git, files: project.gitFiles, commits: d.commits, branches: d.branches };
  }

  async #act(id, fn) {
    const project = this.projects.get(id);
    if (!project.git?.isRepo) throw Object.assign(new Error('Not a git repository'), { status: 400, expose: true });
    this.acting.add(id);
    try {
      const result = await fn(project.path, project);
      await this.refresh(id, { full: true });
      return result;
    } finally {
      this.acting.delete(id);
    }
  }

  /**
   * Turn a folder into a repository from the dashboard: git init with the chosen branch and identity,
   * an optional starter .gitignore (never overwriting one), an optional first commit, and optionally
   * a new repository on the user's GitHub account (GitHub CLI) that becomes origin.
   */
  async initRepo(id, opts = {}) {
    const project = this.projects.get(id);
    if (project.git?.isRepo || await this.host.git.isRepo(project.path)) throw Object.assign(new Error('Already a Git repository'), { status: 409, expose: true });
    const branch = String(opts.branch || 'main').trim();
    await this.host.git.assertBranchName(project.path, branch);
    const userName = typeof opts.userName === 'string' ? opts.userName.trim().slice(0, 100) : '';
    const userEmail = typeof opts.userEmail === 'string' ? opts.userEmail.trim().slice(0, 200) : '';
    if (userEmail && !/^[^\s@]+@[^\s@]+$/.test(userEmail)) throw Object.assign(new Error('That email address does not look right'), { status: 400, expose: true });
    const github = opts.github && typeof opts.github === 'object' ? {
      name: String(opts.github.name ?? '').trim(),
      visibility: opts.github.visibility === 'public' ? 'public' : 'private',
      description: String(opts.github.description ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300),
    } : null;
    if (github && !/^[A-Za-z0-9._-]{1,100}$/.test(github.name)) throw Object.assign(new Error('Repository names use letters, digits, . _ and -'), { status: 400, expose: true });
    if (github && !opts.commit) throw Object.assign(new Error('Publishing to GitHub needs the initial commit'), { status: 400, expose: true });

    const template = opts.gitignore === 'custom' ? customGitignore(opts.gitignoreCustom) : GITIGNORE[opts.gitignore]; // refused paths stop here, before git init
    await this.host.git.initRepo(project.path, { branch, userName, userEmail });
    if (template) {
      const file = path.join(project.path, '.gitignore');
      await fs.writeFile(file, template, { flag: 'wx' }).catch(() => {}); // never overwrite an existing one
    }
    const committed = opts.commit ? await this.host.git.commitAll(project.path, String(opts.message || 'Initial commit').slice(0, 500)) : false;
    const remote = github ? await this.host.git.githubCreate(project.path, github) : null;
    await this.refresh(id, { full: true });
    return { ...this.detail(id), committed, remote };
  }

  stage(id, files) { return this.#act(id, (cwd) => this.host.git.stage(cwd, files)); }
  unstage(id, files) { return this.#act(id, (cwd, p) => this.host.git.unstage(cwd, files, { hasHead: Boolean(p.git.headSha) })); }
  commit(id, message) { return this.#act(id, (cwd) => this.host.git.commit(cwd, message)); }
  pull(id) { return this.#act(id, (cwd) => this.host.git.pull(cwd)); }
  push(id) {
    return this.#act(id, (cwd, p) => this.host.git.push(cwd, { setUpstream: !p.git.upstream, branch: p.git.branch }));
  }
  fetch(id) { return this.#act(id, (cwd) => this.host.git.fetch(cwd)); }
  createBranch(id, name, checkout = true) { return this.#act(id, (cwd) => this.host.git.createBranch(cwd, name, { checkout })); }
  switchBranch(id, name) { return this.#act(id, (cwd) => this.host.git.switchBranch(cwd, name)); }
  diff(id, file, staged) { return this.host.git.diff(this.projects.get(id).path, file, { staged }); }

  /**
   * One file's changes as a unified diff: in one commit (`sha`), or not committed yet (against
   * HEAD). An untracked file has no diff in git: its whole content is shown as added.
   */
  async fileDiff(id, file, sha = null) {
    const project = this.projects.get(id);
    if (!project.git?.isRepo) throw Object.assign(new Error('Not a git repository'), { status: 400, expose: true });
    if (sha) return this.host.git.diffInCommit(project.path, sha, file);
    const diff = await this.host.git.diffHead(project.path, file);
    if (diff.trim()) return diff;
    const untracked = (project.gitFiles ?? []).some((f) => f.untracked && f.path === file);
    if (!untracked) return '';
    const text = await readText(path.join(project.path, assertRelativeRepoPath(file)));
    if (text === null) return 'Binary file, or too large to show.';
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return [`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
  }

  commitsBetween(id, since, until) {
    const project = this.projects.get(id);
    if (!project.git?.isRepo) return Promise.resolve([]);
    return this.host.git.log(project.path, { limit: 200, since, until });
  }
}
