import { run, which, refreshPath } from './exec.js';
import { assertRelativeRepoPath, httpError } from './paths.js';

const BASE = ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'color.ui=false'];
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const SEP = '\x1f';
const REC = '\x1e';

async function git(cwd, args, { timeout = 20_000, input, allowFail = false } = {}) {
  const result = await run('git', [...BASE, ...args], { cwd, timeout, env: ENV, input });
  if (result.code !== 0 && !allowFail) {
    const message = (result.stderr || result.stdout).trim().split('\n').slice(-4).join('\n') || `git ${args[0]} failed`;
    throw Object.assign(new Error(message), { status: 409, expose: true, gitCode: result.code });
  }
  return result;
}

export function parseStatusV2(raw) {
  const status = {
    headSha: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0,
    files: [], staged: 0, unstaged: 0, untracked: 0, conflicts: 0,
  };
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.headSha = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        status.detached = value === '(detached)';
        status.branch = status.detached ? null : value;
      } else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value);
        if (m) { status.ahead = Number(m[1]); status.behind = Number(m[2]); }
      }
      continue;
    }
    const type = line[0];
    if (type === '?') {
      status.files.push({ path: line.slice(2), x: '?', y: '?', staged: false, unstaged: true, untracked: true });
      status.untracked += 1;
    } else if (type === '1' || type === '2') {
      const parts = line.split(' ');
      const xy = parts[1];
      const fieldCount = type === '1' ? 8 : 9;
      const filePath = parts.slice(fieldCount).join(' ');
      const file = { path: filePath, x: xy[0], y: xy[1], staged: xy[0] !== '.', unstaged: xy[1] !== '.', untracked: false };
      if (type === '2') {
        file.from = tokens[i + 1];
        i += 1;
      }
      if (file.staged) status.staged += 1;
      if (file.unstaged) status.unstaged += 1;
      status.files.push(file);
    } else if (type === 'u') {
      const parts = line.split(' ');
      status.files.push({ path: parts.slice(10).join(' '), x: 'U', y: 'U', staged: false, unstaged: true, conflict: true });
      status.conflicts += 1;
    }
  }
  return status;
}

/** `git diff --numstat` lines: "added<TAB>removed<TAB>path"; "-" for binary files. */
export function parseNumstat(raw) {
  const files = [];
  for (const line of raw.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trimEnd());
    if (!m) continue;
    files.push({ path: m[3], added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
  }
  return files;
}

export function createGitCli() {
  return {
    available() {
      return Boolean(which('git'));
    },

    async version() {
      const r = await run('git', ['--version'], { timeout: 5000 }).catch(() => null);
      return r?.code === 0 ? r.stdout.trim().replace(/^git version /, '') : null;
    },

    async isRepo(cwd) {
      const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFail: true, timeout: 8000 }).catch(() => null);
      return r?.code === 0 && r.stdout.trim() === 'true';
    },

    async status(cwd) {
      const r = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z']);
      return parseStatusV2(r.stdout);
    },

    async log(cwd, { limit = 20, since, until, all = false, author } = {}) {
      const args = ['log', `-n${limit}`, `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%at${SEP}%D${SEP}%ae${REC}`];
      if (since) args.push(`--since=${Math.floor(since / 1000)}`);
      if (until) args.push(`--until=${Math.floor(until / 1000)}`);
      if (author) args.push(`--author=${author}`, '--fixed-strings');
      if (all) args.push('--all');
      const r = await git(cwd, args, { allowFail: true });
      if (r.code !== 0) return []; // empty repository
      return r.stdout.split(REC).map((rec) => rec.trim()).filter(Boolean).map((rec) => {
        const [sha, short, subject, author, at, refs, authorEmail] = rec.split(SEP);
        return { sha, short, subject, author, at: Number(at) * 1000, refs, authorEmail };
      });
    },

    /** The identity commits are made with in this repository (local config, else global), or null. */
    async userEmail(cwd) {
      const r = await git(cwd, ['config', '--get', 'user.email'], { allowFail: true, timeout: 5000 }).catch(() => null);
      return r?.code === 0 ? r.stdout.trim() || null : null;
    },

    /** The repository's first commits (no parents): the same history wherever the folder is moved. */
    async rootCommits(cwd) {
      const r = await git(cwd, ['rev-list', '--max-parents=0', 'HEAD'], { allowFail: true, timeout: 10_000 }).catch(() => null);
      return r?.code === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5) : [];
    },

    async commitCountSince(cwd, since) {
      const r = await git(cwd, ['rev-list', '--count', `--since=${Math.floor(since / 1000)}`, 'HEAD'], { allowFail: true });
      return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
    },

    /** Web address of the "origin" remote (https://host/owner/repo), or null for local-only repos. */
    async webUrl(cwd) {
      const r = await git(cwd, ['config', '--get', 'remote.origin.url'], { allowFail: true, timeout: 5000 }).catch(() => null);
      const raw = r?.code === 0 ? r.stdout.trim() : '';
      if (!raw) return null;
      const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(raw);
      if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
      const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(raw);
      return http ? `https://${http[1]}/${http[2]}` : null;
    },

    async branches(cwd) {
      const r = await git(cwd, ['for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${SEP}%(HEAD)${SEP}%(committerdate:unix)${SEP}%(upstream:short)`, 'refs/heads']);
      return r.stdout.split('\n').filter(Boolean).map((line) => {
        const [name, head, at, upstream] = line.split(SEP);
        return { name, current: head === '*', at: Number(at) * 1000, upstream: upstream || null };
      });
    },

    async diff(cwd, file, { staged = false } = {}) {
      const rel = assertRelativeRepoPath(file);
      const args = ['diff', '--no-ext-diff', '--no-color'];
      if (staged) args.push('--cached');
      args.push('--', rel);
      const r = await git(cwd, args, { allowFail: true, timeout: 10_000 });
      return r.stdout.slice(0, 200_000);
    },

    /**
     * Lines added and removed per file in the working tree against HEAD (staged and not).
     * Binary files have added/removed null. Untracked files are not included (see untracked()).
     */
    async workingNumstat(cwd) {
      const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
      const args = head.code === 0 ? ['diff', '--numstat', '--no-renames', 'HEAD'] : ['diff', '--numstat', '--no-renames', '--cached'];
      const r = await git(cwd, args, { allowFail: true, timeout: 15_000 });
      return r.code === 0 ? parseNumstat(r.stdout) : [];
    },

    /** Untracked files that are not ignored, relative to the repository root. */
    async untracked(cwd) {
      const r = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true, timeout: 15_000 });
      return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [];
    },

    /**
     * Commits in a time window with the lines each one added and removed per file.
     * @returns {{ sha, short, subject, at, files: { path, added, removed }[] }[]} most recent first
     */
    async commitStats(cwd, { since, until, limit = 200, author } = {}) {
      const args = ['log', `-n${limit}`, '--no-renames', '--numstat', `--format=${REC}%H${SEP}%h${SEP}%s${SEP}%at`];
      if (since) args.push(`--since=${Math.floor(since / 1000)}`);
      if (until) args.push(`--until=${Math.floor(until / 1000)}`);
      if (author) args.push(`--author=${author}`, '--fixed-strings');
      const r = await git(cwd, args, { allowFail: true, timeout: 20_000 });
      if (r.code !== 0) return [];
      return r.stdout.split(REC).filter((x) => x.trim()).map((rec) => {
        const [head, ...rest] = rec.split('\n');
        const [sha, short, subject, at] = head.split(SEP);
        return { sha, short, subject, at: Number(at) * 1000, files: parseNumstat(rest.join('\n')) };
      });
    },

    /** One file's diff against HEAD (staged and not together). */
    async diffHead(cwd, file) {
      const rel = assertRelativeRepoPath(file);
      const r = await git(cwd, ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', rel], { allowFail: true, timeout: 10_000 });
      return r.stdout.slice(0, 200_000);
    },

    /** A file's committed content (HEAD), or null when it is not committed. */
    async showHead(cwd, file) {
      const rel = assertRelativeRepoPath(file);
      const r = await git(cwd, ['show', `HEAD:${rel}`], { allowFail: true, timeout: 8000 });
      return r.code === 0 ? r.stdout : null;
    },

    /** One file's changes in one commit. */
    async diffInCommit(cwd, sha, file) {
      const rel = assertRelativeRepoPath(file);
      if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw httpError(400, 'Invalid commit');
      const r = await git(cwd, ['show', '--no-ext-diff', '--no-color', '--format=', sha, '--', rel], { allowFail: true, timeout: 10_000 });
      return r.stdout.slice(0, 200_000);
    },

    async stage(cwd, files) {
      const rels = files.map(assertRelativeRepoPath);
      if (!rels.length) return;
      await git(cwd, ['add', '-A', '--', ...rels]);
    },

    async unstage(cwd, files, { hasHead = true } = {}) {
      const rels = files.map(assertRelativeRepoPath);
      if (!rels.length) return;
      if (hasHead) await git(cwd, ['restore', '--staged', '--', ...rels]);
      else await git(cwd, ['rm', '--cached', '-r', '-q', '--', ...rels]);
    },

    async commit(cwd, message) {
      if (typeof message !== 'string' || !message.trim()) throw httpError(400, 'Commit message is required');
      if (message.length > 10_000) throw httpError(400, 'Commit message is too long');
      const r = await git(cwd, ['commit', '-F', '-'], { input: message, timeout: 60_000 });
      return r.stdout.trim();
    },

    async pull(cwd) {
      const r = await git(cwd, ['pull', '--ff-only'], { timeout: 120_000 });
      return (r.stdout + r.stderr).trim();
    },

    async push(cwd, { setUpstream = false, branch } = {}) {
      const args = setUpstream && branch ? ['push', '-u', 'origin', branch] : ['push'];
      const r = await git(cwd, args, { timeout: 120_000 });
      return (r.stdout + r.stderr).trim();
    },

    async fetch(cwd) {
      await git(cwd, ['fetch', '--quiet'], { timeout: 60_000, allowFail: true });
    },

    /** The URL a remote fetches from, or null. */
    async remoteUrl(cwd, remote = 'origin') {
      const r = await git(cwd, ['remote', 'get-url', remote], { allowFail: true, timeout: 5000 });
      return r.code === 0 ? r.stdout.trim() : null;
    },

    async setRemoteUrl(cwd, remote, url) {
      if (typeof url !== 'string' || !/^(https:\/\/|git@|ssh:\/\/)/.test(url)) throw httpError(400, 'Invalid remote URL');
      await git(cwd, ['remote', 'set-url', remote, url]);
    },

    /** git init with the settings git would ask for: default branch and the identity for this repo. */
    async initRepo(cwd, { branch, userName, userEmail }) {
      await git(cwd, ['init', '-b', branch]);
      if (userName) await git(cwd, ['config', 'user.name', userName]);
      if (userEmail) await git(cwd, ['config', 'user.email', userEmail]);
    },

    /** Stage everything (respecting .gitignore) and commit; false when there was nothing to commit. */
    async commitAll(cwd, message) {
      await git(cwd, ['add', '-A']);
      const staged = await git(cwd, ['diff', '--cached', '--quiet'], { allowFail: true });
      if (staged.code === 0) return false;
      await git(cwd, ['commit', '-m', message], { timeout: 60_000 });
      return true;
    },

    /** The global identity and default branch git would use, to prefill the init form. */
    async globalDefaults() {
      const read = async (key) => (await git(process.cwd(), ['config', '--global', '--get', key], { allowFail: true })).stdout.trim() || null;
      return { userName: await read('user.name'), userEmail: await read('user.email'), defaultBranch: await read('init.defaultBranch') };
    },

    /** GitHub CLI: installed, signed in, and as whom. */
    async githubStatus() {
      if (!which('gh')) await refreshPath(); // installed while FlintBench runs
      if (!which('gh')) return { installed: false, authenticated: false, user: null };
      const auth = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 15_000 }).catch(() => ({ code: 1 }));
      if (auth.code !== 0) return { installed: true, authenticated: false, user: null };
      const me = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15_000 }).catch(() => ({ code: 1, stdout: '' }));
      return { installed: true, authenticated: true, user: me.code === 0 ? me.stdout.trim() : null };
    },

    /** Create the repository on the user's GitHub account, add it as origin and push. */
    async githubCreate(cwd, { name, visibility, description }) {
      const args = ['repo', 'create', name, visibility === 'public' ? '--public' : '--private', '--source', '.', '--remote', 'origin', '--push'];
      if (description) args.push('--description', description);
      const r = await run('gh', args, { cwd, timeout: 180_000, env: { GH_PROMPT_DISABLED: '1' } });
      if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || 'gh repo create failed'), { status: 409, expose: true });
      return (r.stdout.match(/https:\/\/github\.com\/\S+/) ?? [null])[0];
    },

    async assertBranchName(cwd, name) {
      if (typeof name !== 'string' || !name || name.startsWith('-') || name.length > 200) throw httpError(400, 'Invalid branch name');
      const r = await git(cwd, ['check-ref-format', '--branch', name], { allowFail: true });
      if (r.code !== 0) throw httpError(400, 'Invalid branch name');
    },

    async createBranch(cwd, name, { checkout = true } = {}) {
      await this.assertBranchName(cwd, name);
      if (checkout) await git(cwd, ['switch', '-c', name]);
      else await git(cwd, ['branch', name]);
    },

    async switchBranch(cwd, name) {
      await this.assertBranchName(cwd, name);
      await git(cwd, ['switch', name]);
    },

    async checkIgnored(cwd, files) {
      if (!files.length) return new Set();
      const r = await git(cwd, ['check-ignore', '--stdin', '-z'], { input: files.join('\0'), allowFail: true });
      return new Set(r.stdout.split('\0').filter(Boolean));
    },

    async countMarkers(cwd, pattern = 'TODO|FIXME') {
      const r = await git(cwd, ['grep', '-I', '-c', '-E', `\\b(${pattern})\\b`, '--', '.', ':(exclude)*.min.js', ':(exclude)*.lock', ':(exclude)package-lock.json'], { allowFail: true, timeout: 15_000 });
      if (r.code !== 0) return 0;
      return r.stdout.split('\n').filter(Boolean).reduce((sum, line) => sum + (Number(line.split(':').at(-1)) || 0), 0);
    },
  };
}
