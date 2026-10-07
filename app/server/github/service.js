import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from '../host/paths.js';

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REPO_FIELDS = '{name, full_name, owner: .owner.login, private, fork, archived, description, homepage, language, stars: .stargazers_count, forks: .forks_count, open_issues: .open_issues_count, pushed_at, updated_at, created_at, default_branch, html_url, clone_url, ssh_url, admin: (.permissions.admin // false)}';
const CACHE_MS = 2 * 60_000;

// commands FlintBench may open in a terminal window for the owner: fixed lines, never built from input
const TERMINAL = {
  install: { title: 'Install GitHub CLI', file: 'winget', args: ['install', '--id', 'GitHub.cli', '-e', '--source', 'winget'] },
  login: { title: 'Sign in to GitHub', file: 'gh', args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'] },
  'delete-scope': { title: 'Allow deleting repositories', file: 'gh', args: ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'delete_repo'] },
};

function repoRef(owner, name) {
  if (!NAME.test(String(owner)) || !NAME.test(String(name)) || owner === '.' || owner === '..' || name === '.' || name === '..') throw httpError(400, 'Not a repository name');
  return `${owner}/${name}`;
}

/**
 * GitHub, through the GitHub CLI (gh) the owner signed in to: FlintBench never sees a password or
 * token, gh keeps it. Lists every repository the account can reach (own, collaborator, its
 * organisations) and manages them: create, edit, visibility, archive, delete, clone to this PC.
 */
export class GitHubService {
  constructor({ host, projects, git, log = console }) {
    this.host = host;
    this.projects = projects;
    this.git = git;
    this.log = log;
    this.cache = null; // { at, repos }
  }

  async #gh(args, { input, timeout = 30_000 } = {}) {
    if (!this.host.exec.which('gh')) throw httpError(409, 'GitHub CLI is not installed');
    const r = await this.host.exec.run('gh', args, { input, timeout, env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
    if (r.code !== 0) {
      const text = (r.stderr || r.stdout).trim();
      const http = /\(HTTP (\d{3})\)/.exec(text);
      const message = text.split('\n').map((l) => l.replace(/^gh: /, '').trim()).filter(Boolean).slice(-2).join(' · ') || 'GitHub CLI failed';
      throw Object.assign(new Error(message), { status: http && Number(http[1]) < 500 ? 409 : 502, expose: true, githubStatus: http ? Number(http[1]) : null, text });
    }
    return r.stdout;
  }

  /** gh api with a JSON body on stdin; parsed result (null for an empty answer). */
  async #api(method, endpoint, body) {
    const args = ['api', '-X', method, endpoint, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) args.push('--input', '-');
    const out = await this.#gh(args, { input: body === undefined ? undefined : JSON.stringify(body) });
    return out.trim() ? JSON.parse(out) : null;
  }

  /** Installed, signed in, as whom, and with which permissions (scopes). */
  async status() {
    this.host.exec.clearWhichCache();
    // installed while FlintBench runs: its folder is only in the PATH saved in the registry
    if (!this.host.exec.which('gh')) await this.host.exec.refreshPath();
    if (!this.host.exec.which('gh')) return { installed: false, authenticated: false, user: null, scopes: [] };
    const auth = await this.host.exec.run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 15_000, env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
    if (auth.code !== 0) return { installed: true, authenticated: false, user: null, scopes: [] };
    const scopesLine = /Token scopes:\s*(.*)/.exec(`${auth.stdout}\n${auth.stderr}`)?.[1] ?? '';
    const scopes = [...scopesLine.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const me = await this.#gh(['api', 'user', '--jq', '{login, name, avatar_url, html_url}']).then((t) => JSON.parse(t)).catch(() => null);
    return { installed: true, authenticated: true, user: me, scopes };
  }

  /** Every repository the account reaches, most recently pushed first (cached for two minutes). */
  async repos({ refresh = false } = {}) {
    if (this.cache && !refresh && Date.now() - this.cache.at < CACHE_MS) return { repos: this.cache.repos, fetchedAt: this.cache.at };
    const out = await this.#gh(['api', '--paginate', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', '--jq', `.[] | ${REPO_FIELDS}`], { timeout: 120_000 });
    const repos = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    this.cache = { at: Date.now(), repos };
    return { repos, fetchedAt: this.cache.at };
  }

  #forget(fullName, replacement) {
    if (!this.cache) return;
    const i = this.cache.repos.findIndex((r) => r.full_name.toLowerCase() === fullName.toLowerCase());
    if (i === -1 && replacement) this.cache.repos.unshift(replacement);
    else if (i !== -1 && replacement) this.cache.repos[i] = replacement;
    else if (i !== -1) this.cache.repos.splice(i, 1);
  }

  /** One repository with what is open on it: pull requests, issues, recent commits, branches. */
  async detail(owner, name) {
    const ref = repoRef(owner, name);
    const list = async (endpoint, jq) => {
      const out = await this.#gh(['api', endpoint, '--jq', jq]).catch((e) => (e.githubStatus === 409 ? '' : Promise.reject(e))); // 409: empty repository
      return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    };
    const [repo, pulls, issues, commits, branches] = await Promise.all([
      this.#gh(['api', `repos/${ref}`, '--jq', REPO_FIELDS]).then((t) => JSON.parse(t)),
      list(`repos/${ref}/pulls?state=open&per_page=30`, '.[] | {number, title, user: .user.login, draft, created_at, updated_at, html_url, head: .head.ref, base: .base.ref}'),
      list(`repos/${ref}/issues?state=open&per_page=30`, '.[] | select(.pull_request | not) | {number, title, user: .user.login, comments, created_at, updated_at, html_url, labels: [.labels[].name]}'),
      list(`repos/${ref}/commits?per_page=12`, '.[] | {sha, message: .commit.message, author: (.author.login // .commit.author.name), at: .commit.author.date, html_url}'),
      list(`repos/${ref}/branches?per_page=50`, '.[] | {name, protected}'),
    ]);
    this.#forget(ref, repo);
    for (const c of commits) c.message = String(c.message ?? '').split('\n')[0]; // the subject line
    return { repo, pulls, issues, commits, branches };
  }

  /** A new repository on the account: optional README, .gitignore template and license. */
  async create(body = {}) {
    const name = String(body.name ?? '').trim();
    if (!NAME.test(name) || name === '.' || name === '..') throw httpError(400, 'Repository names use letters, digits, . _ and -');
    const payload = {
      name,
      description: String(body.description ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 350),
      private: body.private !== false,
      auto_init: Boolean(body.readme || body.gitignore || body.license),
    };
    if (body.gitignore && /^[A-Za-z0-9+.-]{1,40}$/.test(body.gitignore)) payload.gitignore_template = body.gitignore;
    if (body.license && /^[a-z0-9.-]{1,40}$/.test(body.license)) payload.license_template = body.license;
    const repo = await this.#api('POST', 'user/repos', payload);
    const summary = await this.#gh(['api', `repos/${repo.full_name}`, '--jq', REPO_FIELDS]).then((t) => JSON.parse(t)).catch(() => null);
    if (summary) this.#forget(summary.full_name, summary);
    return summary ?? repo;
  }

  /**
   * Name, description, website, visibility, archived. A rename also points the origin of every
   * local copy known to FlintBench at the new address (GitHub redirects the old one, for a while).
   */
  async update(owner, name, body = {}) {
    const ref = repoRef(owner, name);
    const patch = {};
    if (typeof body.name === 'string') {
      const next = body.name.trim();
      if (!NAME.test(next) || next === '.' || next === '..') throw httpError(400, 'Repository names use letters, digits, . _ and -');
      if (next !== name) patch.name = next;
    }
    if (typeof body.description === 'string') patch.description = body.description.replace(/[\r\n]+/g, ' ').trim().slice(0, 350);
    if (typeof body.homepage === 'string') patch.homepage = body.homepage.trim().slice(0, 300);
    if (typeof body.private === 'boolean') patch.private = body.private;
    if (typeof body.archived === 'boolean') patch.archived = body.archived;
    if (!Object.keys(patch).length) throw httpError(400, 'Nothing to change');
    await this.#api('PATCH', `repos/${ref}`, patch);
    const now = await this.#gh(['api', `repos/${owner}/${patch.name ?? name}`, '--jq', REPO_FIELDS]).then((t) => JSON.parse(t));
    if (patch.name) {
      this.#forget(ref, null);
      await this.#repointLocalCopies(ref, now);
    }
    this.#forget(now.full_name, now);
    return now;
  }

  async #repointLocalCopies(oldRef, repo) {
    const oldWeb = `https://github.com/${oldRef}`.toLowerCase();
    for (const p of this.projects.live.values()) {
      if (p.git?.webUrl?.toLowerCase() !== oldWeb) continue;
      try {
        const current = await this.host.git.remoteUrl(p.path, 'origin');
        const next = current?.startsWith('git@') || current?.startsWith('ssh://') ? repo.ssh_url : repo.clone_url;
        await this.host.git.setRemoteUrl(p.path, 'origin', next);
        await this.git.refresh(p.id, { full: true });
      } catch (error) {
        this.log.warn(`[github] could not update origin of ${p.name}: ${error.message}`);
      }
    }
  }

  /** Delete for good. The name must be typed back; gh needs the delete_repo permission. */
  async remove(owner, name, confirm) {
    const ref = repoRef(owner, name);
    if (String(confirm ?? '') !== ref && String(confirm ?? '') !== name) throw httpError(400, 'Type the repository name to confirm');
    try {
      await this.#api('DELETE', `repos/${ref}`);
    } catch (error) {
      if (error.githubStatus === 403 || /delete_repo/.test(error.text ?? '')) {
        throw Object.assign(new Error('GitHub CLI is not allowed to delete repositories yet'), { status: 403, expose: true, reason: 'needs_delete_scope' });
      }
      throw error;
    }
    this.#forget(ref, null);
    return { deleted: ref };
  }

  /** Clone into <parent>/<name> and add it to FlintBench as a project. */
  async clone(owner, name, parent) {
    const ref = repoRef(owner, name);
    const dir = this.host.paths.normalizePath(String(parent ?? ''));
    if (!dir || !(await this.host.paths.isDirectory(dir))) throw httpError(400, 'Choose an existing folder to clone into');
    const dest = path.join(dir, name);
    if (await fs.stat(dest).then(() => true, () => false)) throw httpError(409, `${dest} already exists`);
    await this.#gh(['repo', 'clone', ref, dest], { timeout: 5 * 60_000 }); // within the HTTP request timeout
    return this.projects.add(dest, { source: 'manual' });
  }

  /** gh install, sign-in or a new permission happen in a terminal window the owner answers. */
  openTerminal(action) {
    const t = TERMINAL[action];
    if (!t) throw httpError(400, 'Unknown action');
    const file = this.host.exec.which(t.file);
    if (!file) throw httpError(409, t.file === 'gh' ? 'GitHub CLI is not installed' : `${t.file} is not available on this computer`);
    const cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
    const wt = this.host.exec.which('wt');
    if (wt) this.host.exec.launchDetached(wt, ['-w', 'new', 'new-tab', '-d', cwd, '--title', t.title, '--', file, ...t.args], { hide: false });
    else this.host.exec.launchInConsoleWindow(file, t.args, { cwd, title: t.title });
    return { opened: t.title };
  }
}
