import { h, icon, replace, actionButton } from '../lib/dom.js';
import { store, subscribe } from '../lib/store.js';
import { api, projectUrl } from '../lib/api.js';
import { navigate, projectPath } from '../lib/router.js';
import { ago, plural } from '../lib/format.js';
import { attempt, confirmDialog, dialog, gitLine, toast } from '../lib/ui.js';
import { contextMenu, copyText, openMenu } from '../lib/menu.js';
import { editorItems } from '../lib/editor-menu.js';
import { selectField } from '../lib/select-menu.js';
import { browse } from '../lib/picker.js';

// GitHub's own colours for the most common languages (the dot next to the language name)
const LANG = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572a5', HTML: '#e34c26', CSS: '#663399', Java: '#b07219',
  'C#': '#178600', 'C++': '#f34b7d', C: '#555555', Go: '#00add8', Rust: '#dea584', PHP: '#4f5d95', Ruby: '#701516',
  Shell: '#89e051', PowerShell: '#012456', Kotlin: '#a97bff', Swift: '#f05138', Dart: '#00b4ab', Vue: '#41b883',
  Svelte: '#ff3e00', SCSS: '#c6538c', Lua: '#000080', Jupyter: '#da5b0b', 'Jupyter Notebook': '#da5b0b',
};
const SHOW = [
  { value: 'all', text: 'All repositories' },
  { value: 'linked', text: 'In FlintBench' },
  { value: 'remote', text: 'Not on this PC' },
  { value: 'private', text: 'Private' },
  { value: 'public', text: 'Public' },
  { value: 'fork', text: 'Forks' },
  { value: 'archived', text: 'Archived' },
];
const SORT = [
  { value: 'pushed', text: 'Recently pushed' },
  { value: 'name', text: 'Name' },
  { value: 'stars', text: 'Stars' },
];
const GITIGNORES = ['Node', 'Python', 'Go', 'Rust', 'Java', 'VisualStudio', 'Unity'];
const LICENSES = [{ value: 'mit', text: 'MIT' }, { value: 'apache-2.0', text: 'Apache 2.0' }, { value: 'gpl-3.0', text: 'GPL 3.0' }, { value: 'unlicense', text: 'The Unlicense' }];

const repoUrl = (r, suffix = '') => `/api/github/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}${suffix}`;

/** The FlintBench project whose origin is this repository, if there is one. */
export function projectOf(repo) {
  const url = repo.html_url.toLowerCase();
  return [...store.state.projects.values()].find((p) => p.git?.webUrl?.toLowerCase() === url) ?? null;
}

function openTerminal(action) {
  return attempt(() => api.post('/api/github/terminal', { action }), { success: (r) => `${r.opened}: continue in the window that opened` });
}

/** Clone into a folder chosen in the system dialog, add it as a project and open its Git tab. */
async function cloneRepo(repo) {
  const parent = await browse({ kind: 'folder', title: `Clone ${repo.name} into…` });
  if (!parent) return null;
  const p = await attempt(() => api.post(repoUrl(repo, '/clone'), { parent }), { failure: `Could not clone ${repo.name}` });
  if (!p) return null;
  toast(`${repo.name} cloned and added to FlintBench`, { kind: 'ok', detail: p.path });
  navigate(projectPath(p.id, 'git'));
  return p;
}

function field(label, input, hint) {
  return h('label.field', h('span', label), input, hint ? h('span.hint', hint) : null);
}

/** New repository on the account: name, description, visibility, optional README / .gitignore / license. */
function newRepoDialog() {
  return dialog((done) => {
    const name = h('input.input.mono', { placeholder: 'my-project', autofocus: true, spellcheck: false, required: true, pattern: '[A-Za-z0-9._-]{1,100}' });
    const description = h('input.input', { placeholder: 'Optional' });
    const visibility = selectField({ label: 'Visibility', value: 'private', options: [{ value: 'private', text: 'Private' }, { value: 'public', text: 'Public' }] });
    const readme = h('input', { type: 'checkbox', checked: true });
    const gitignore = selectField({ label: '.gitignore', value: '', options: [{ value: '', text: 'None' }, ...GITIGNORES.map((g) => ({ value: g, text: g }))] });
    const license = selectField({ label: 'License', value: '', options: [{ value: '', text: 'None' }, ...LICENSES] });
    const error = h('p.field-error', { role: 'alert' });
    return h('form.gh-form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        done(await api.post('/api/github/repos', { name: name.value.trim(), description: description.value.trim(), private: visibility.value === 'private', readme: readme.checked, gitignore: gitignore.value || null, license: license.value || null }));
      } catch (err) {
        error.textContent = err.message;
      }
    } },
    h('h2', 'New repository'),
    h('div.gh-grid', field('Name', name, 'Letters, digits, . _ and -'), field('Visibility', visibility)),
    field('Description', description),
    h('label.check', readme, 'Start with a README'),
    h('div.gh-grid', field('.gitignore', gitignore), field('License', license)),
    error,
    h('div.actions',
      h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancel'),
      h('button.btn.primary', { type: 'submit' }, 'Create repository')));
  }, { cls: 'is-gh' });
}

/** Name, description, website, visibility. */
function editDialog(repo) {
  return dialog((done) => {
    const name = h('input.input.mono', { value: repo.name, spellcheck: false, required: true, pattern: '[A-Za-z0-9._-]{1,100}' });
    const description = h('input.input', { value: repo.description ?? '', placeholder: 'Optional', autofocus: true });
    const homepage = h('input.input', { value: repo.homepage ?? '', placeholder: 'https://…', type: 'url' });
    const visibility = selectField({ label: 'Visibility', value: repo.private ? 'private' : 'public', options: [{ value: 'private', text: 'Private' }, { value: 'public', text: 'Public' }] });
    const error = h('p.field-error', { role: 'alert' });
    return h('form.gh-form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      const goingPublic = repo.private && visibility.value === 'public';
      if (goingPublic && !(await confirmDialog({ title: `Make ${repo.name} public?`, body: 'Everyone will be able to see its code and its whole history.', confirm: 'Make public', danger: true }))) return;
      try {
        done(await api.patch(repoUrl(repo), { name: name.value.trim(), description: description.value, homepage: homepage.value, private: visibility.value === 'private' }));
      } catch (err) {
        error.textContent = err.message;
      }
    } },
    h('h2', `Edit ${repo.full_name}`),
    h('div.gh-grid', field('Name', name, 'Renaming updates the origin of the copies FlintBench knows'), field('Visibility', visibility)),
    field('Description', description),
    field('Website', homepage),
    error,
    h('div.actions',
      h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancel'),
      h('button.btn.primary', { type: 'submit' }, 'Save')));
  }, { cls: 'is-gh' });
}

/** Delete for good: the full name typed back, a red button. */
async function deleteRepo(repo) {
  const ok = await dialog((done) => {
    const input = h('input.input.mono', { autofocus: true, spellcheck: false, autocomplete: 'off', 'aria-label': `Type ${repo.full_name} to confirm` });
    const submit = h('button.btn.danger-solid', { type: 'submit', disabled: true }, 'Delete repository');
    input.addEventListener('input', () => { submit.disabled = input.value.trim() !== repo.full_name; });
    return h('form.rm', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); if (!submit.disabled) done(input.value.trim()); } },
      h('h2', 'Delete ', h('span.rm-name', repo.full_name), '?'),
      h('p.rm-lead', 'The repository is deleted on GitHub ', h('strong', 'for good'), ': code, issues, pull requests and releases. Copies on this PC stay as they are.'),
      field(`Type ${repo.full_name} to confirm`, input),
      h('div.actions',
        h('button.btn.ghost', { type: 'button', onclick: () => done(null) }, 'Cancel'),
        submit));
  }, { cls: 'is-remove' });
  if (!ok) return false;
  try {
    await api.del(repoUrl(repo), { confirm: ok });
    toast(`${repo.full_name} deleted`, { kind: 'ok' });
    return true;
  } catch (error) {
    if (error.reason === 'needs_delete_scope') {
      toast('Click to allow it: a window asks GitHub for the permission, then try again.', {
        kind: 'warn', title: 'GitHub CLI cannot delete repositories yet', timeout: 15_000, onClick: () => openTerminal('delete-scope'),
      });
    } else {
      toast('Could not delete the repository', { kind: 'err', detail: error.message });
    }
    return false;
  }
}

/** Everything about one repository: what is open on it, and what can be done with it. */
function repoDialog(start, { onChanged }) {
  let repo = start;
  let detail = null;
  let tab = 'pulls';
  return dialog((done) => {
    const head = h('div.gh-d-head');
    const tabs = h('div.gh-tabs', { role: 'tablist' });
    const body = h('div.gh-d-body', h('p.panel-empty', 'Reading from GitHub…'));
    const changed = (next) => { repo = next; onChanged?.(); drawHead(); };

    function drawHead() {
      const p = projectOf(repo);
      replace(head,
        h('div.gh-d-title', h('h2', repo.full_name), badges(repo)),
        repo.description ? h('p.dim', repo.description) : null,
        h('div.row.wrap.gh-d-actions',
          p ? actionButton(`Open ${p.name}`, () => { done(null); navigate(projectPath(p.id, 'git')); }, { cls: 'btn primary sm', iconName: 'branch' })
            : actionButton('Clone to this PC', async () => { if (await cloneRepo(repo)) done(null); }, { cls: 'btn primary sm', iconName: 'download' }),
          h('a.btn.sm', { href: repo.html_url, target: '_blank', rel: 'noopener' }, icon('external', 13), 'Open on GitHub'),
          actionButton('Edit', async () => { const r = await editDialog(repo); if (r) changed(r); }, { cls: 'btn sm', iconName: 'pencil' }),
          actionButton('', (e) => repoMenu(repo, e.currentTarget, { onChanged: changed, onDeleted: () => { onChanged?.(); done(null); } }), { cls: 'btn sm icon ghost', iconName: 'dots', title: 'More actions' }),
          h('span.spacer'),
          h('span.faint.small', `Pushed ${ago(Date.parse(repo.pushed_at))}`)));
    }

    function drawTabs() {
      const count = (k) => (detail ? detail[k].length : null);
      const tabsDef = [['pulls', 'Pull requests'], ['issues', 'Issues'], ['commits', 'Commits'], ['branches', 'Branches']];
      replace(tabs, tabsDef.map(([k, label]) => h('button.gh-tab', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawTabs(); drawBody(); } },
        label, count(k) !== null ? h('span.gh-tab-n', String(count(k))) : null)));
    }

    function drawBody() {
      if (!detail) return;
      // each item opens on GitHub; right click: open, copy its link (and its number, hash or name)
      const link = (url, copy, ...parts) => {
        const a = h('a.gh-item', { href: url, target: '_blank', rel: 'noopener' }, ...parts);
        contextMenu(a, () => [
          { label: 'Open on GitHub', icon: 'external', run: () => window.open(url, '_blank', 'noopener') },
          { label: 'Copy link', icon: 'external', run: () => copyText(url, toast) },
          copy ? { label: copy.label, icon: 'file', run: () => copyText(copy.text, toast) } : null,
        ], { label: 'Item actions' });
        return a;
      };
      const list = {
        pulls: () => detail.pulls.map((p) => link(p.html_url, { label: 'Copy number', text: `#${p.number}` }, h('span.gh-item-n', `#${p.number}`), h('span.gh-item-t', p.title), p.draft ? h('span.chip', 'Draft') : null,
          h('span.faint.small', `${p.head} → ${p.base} · ${p.user} · ${ago(Date.parse(p.updated_at))}`))),
        issues: () => detail.issues.map((i) => link(i.html_url, { label: 'Copy number', text: `#${i.number}` }, h('span.gh-item-n', `#${i.number}`), h('span.gh-item-t', i.title), ...i.labels.slice(0, 3).map((l) => h('span.chip', l)),
          h('span.faint.small', `${i.user}${i.comments ? ` · ${plural(i.comments, 'comment')}` : ''} · ${ago(Date.parse(i.updated_at))}`))),
        commits: () => detail.commits.map((c) => link(c.html_url, { label: 'Copy commit hash', text: c.sha }, h('code.gh-item-n', c.sha.slice(0, 7)), h('span.gh-item-t', c.message), h('span.faint.small', `${c.author ?? ''} · ${ago(Date.parse(c.at))}`))),
        branches: () => detail.branches.map((b) => link(`${repo.html_url}/tree/${encodeURIComponent(b.name)}`, { label: 'Copy branch name', text: b.name }, icon('branch', 13), h('span.gh-item-t.mono', b.name),
          b.name === repo.default_branch ? h('span.chip.accent', 'default') : null, b.protected ? h('span.chip', 'protected') : null)),
      }[tab]();
      const empty = { pulls: 'No open pull requests.', issues: 'No open issues.', commits: 'No commits yet.', branches: 'No branches yet.' }[tab];
      replace(body, list.length ? h('div.gh-items', list) : h('p.panel-empty', empty));
    }

    drawHead();
    drawTabs();
    api.get(repoUrl(repo)).then((d) => { detail = d; repo = d.repo; drawHead(); drawTabs(); drawBody(); })
      .catch((e) => replace(body, h('p.panel-empty', `Could not read the repository: ${e.message}`)));
    return h('div.gh-detail', head, tabs, body,
      h('div.actions', h('button.btn', { type: 'button', onclick: () => done(null) }, 'Close')));
  }, { cls: 'is-gh-repo' });
}

function badges(repo) {
  return h('span.gh-badges',
    h(`span.chip${repo.private ? '' : '.ok'}`, repo.private ? 'Private' : 'Public'),
    repo.fork ? h('span.chip', 'Fork') : null,
    repo.archived ? h('span.chip.warn', 'Archived') : null);
}

/**
 * What can be done with a repository: the ⋯ button and the right-click menu share it. A repository
 * that is a FlintBench project also offers its local copy (Git tab, project, VS Code, Explorer).
 */
function repoMenuItems(repo, { onChanged, onDeleted, onDetails }) {
  const set = async (patch, success) => {
    const r = await attempt(() => api.patch(repoUrl(repo), patch), { success });
    if (r) onChanged(r);
  };
  const p = projectOf(repo);
  const local = p ? [
    { label: 'Open Git tab', icon: 'branch', run: () => navigate(projectPath(p.id, 'git')) },
    { label: `Open ${p.name}`, icon: 'overview', run: () => navigate(projectPath(p.id)) },
    ...editorItems(p.id),
    { label: 'Show in File Explorer', icon: 'folder', run: () => attempt(() => api.post(projectUrl(p.id, '/reveal'))) },
  ] : [{ label: 'Clone to this PC…', icon: 'download', run: () => cloneRepo(repo) }];
  return [
    ...local,
    onDetails ? { label: 'Details', icon: 'eye', run: onDetails } : null,
    { label: 'Open on GitHub', icon: 'external', run: () => window.open(repo.html_url, '_blank', 'noopener') },
    '-',
    { label: 'Copy clone URL', icon: 'file', run: () => copyText(repo.clone_url, toast) },
    { label: 'Copy GitHub link', icon: 'external', run: () => copyText(repo.html_url, toast) },
    p ? { label: 'Copy local path', icon: 'folder', run: () => copyText(p.path, toast) } : null,
    '-',
    { label: 'Edit details…', icon: 'pencil', disabled: !repo.admin, run: async () => { const r = await editDialog(repo); if (r) onChanged(r); } },
    repo.private
      ? { label: 'Make public…', icon: 'eye', disabled: !repo.admin, run: async () => { if (await confirmDialog({ title: `Make ${repo.name} public?`, body: 'Everyone will be able to see its code and its whole history.', confirm: 'Make public', danger: true })) set({ private: false }, `${repo.name} is now public`); } }
      : { label: 'Make private', icon: 'lock', disabled: !repo.admin, run: () => set({ private: true }, `${repo.name} is now private`) },
    repo.archived
      ? { label: 'Unarchive', icon: 'box', disabled: !repo.admin, run: () => set({ archived: false }, `${repo.name} unarchived`) }
      : { label: 'Archive…', icon: 'box', disabled: !repo.admin, run: async () => { if (await confirmDialog({ title: `Archive ${repo.name}?`, body: 'It becomes read-only on GitHub: no pushes, issues or pull requests until it is unarchived.', confirm: 'Archive' })) set({ archived: true }, `${repo.name} archived`); } },
    '-',
    { label: 'Delete…', icon: 'trash', danger: true, disabled: !repo.admin, run: async () => { if (await deleteRepo(repo)) onDeleted(); } },
  ];
}

function repoMenu(repo, anchor, handlers) {
  openMenu(repoMenuItems(repo, handlers), { anchor, label: `${repo.full_name} actions` });
}

export function mount(container) {
  const inner = h('div.view-inner.gh');
  container.append(h('div.view', inner));
  let status = null;
  let repos = null;
  let fetchedAt = 0;
  let loadError = null;
  const search = h('input.input', { type: 'search', placeholder: 'Filter repositories', 'aria-label': 'Filter repositories', 'data-search': true });
  const show = selectField({ label: 'Show', value: 'all', options: SHOW, size: 'sm' });
  const sort = selectField({ label: 'Sort', value: 'pushed', options: SORT, size: 'sm' });
  const headSub = h('p.sub');
  const headActions = h('div.row');
  const content = h('div');
  for (const c of [search, show, sort]) c.addEventListener(c === search ? 'input' : 'change', () => drawList());

  replace(inner,
    h('header.page-head', h('div', h('h1', 'GitHub'), headSub), h('span.spacer'), headActions),
    content);

  async function load({ refresh = false } = {}) {
    loadError = null;
    if (!status || refresh) status = await api.get('/api/github/status').catch((e) => ({ error: e.message }));
    if (status?.authenticated) {
      try {
        const r = await api.get(`/api/github/repos${refresh ? '?refresh=1' : ''}`);
        repos = r.repos;
        fetchedAt = r.fetchedAt;
      } catch (e) {
        loadError = e.message;
      }
    }
    draw();
  }

  const reload = () => load({ refresh: true });

  // waiting for gh to be installed or signed in (in a window FlintBench opened): look again by itself
  let poll = 0;
  let checking = false;
  async function recheck() {
    if (checking || document.hidden) return;
    checking = true;
    const next = await api.get('/api/github/status').catch(() => null);
    checking = false;
    if (!next || !poll || (next.installed === status?.installed && next.authenticated === status?.authenticated)) return;
    status = next;
    if (next.authenticated) load();
    else draw();
  }
  function watchSetup(on) {
    if (on && !poll) poll = setInterval(recheck, 4000);
    else if (!on && poll) { clearInterval(poll); poll = 0; }
  }
  const onFocus = () => { if (poll) recheck(); };
  window.addEventListener('focus', onFocus);

  function draw() {
    if (!status) {
      replace(headSub, 'Checking GitHub CLI…');
      replace(content, h('p.panel-empty', 'Checking GitHub CLI…'));
      return;
    }
    watchSetup(!status.installed || !status.authenticated);
    if (!status.installed || !status.authenticated) {
      replace(headSub, 'Your repositories on GitHub, managed from here.');
      replace(headActions);
      const installed = status.installed;
      replace(content, h('div.empty-state.gh-setup',
        h('h3', installed ? 'Sign in to GitHub' : 'GitHub CLI is not installed'),
        h('p', installed
          ? 'Sign in once in the window that opens (GitHub asks you to confirm in the browser). FlintBench then lists every repository of your account.'
          : 'FlintBench reaches GitHub through the official GitHub CLI (gh). It keeps your sign-in: FlintBench never sees your password or token.'),
        h('div.row.wrap',
          actionButton(installed ? 'Sign in to GitHub' : 'Install GitHub CLI', () => openTerminal(installed ? 'login' : 'install'), { cls: 'btn primary', iconName: 'terminal' }),
          actionButton('Check again', reload, { cls: 'btn', iconName: 'refresh' })),
        h('p.faint.small', installed ? 'This page notices the sign-in by itself.' : 'This page notices the installation by itself.')));
      return;
    }
    const me = status.user?.login;
    replace(headSub, me ? `Signed in as @${me} through GitHub CLI${repos ? ` · ${plural(repos.length, 'repository', 'repositories')}` : ''}` : 'Signed in through GitHub CLI');
    replace(headActions,
      actionButton('Refresh', reload, { cls: 'btn', iconName: 'refresh', title: fetchedAt ? `Read ${ago(fetchedAt)}` : undefined }),
      actionButton('New repository', async () => {
        const r = await newRepoDialog();
        if (!r) return;
        toast(`${r.full_name} created`, { kind: 'ok' });
        repos = [r, ...(repos ?? []).filter((x) => x.full_name !== r.full_name)];
        drawList();
        repoDialog(r, { onChanged: reload });
      }, { cls: 'btn primary', iconName: 'plus' }));
    if (loadError) {
      replace(content, h('div.empty-state', h('h3', 'Could not read your repositories'), h('p', loadError), actionButton('Try again', reload, { cls: 'btn', iconName: 'refresh' })));
      return;
    }
    if (!repos) {
      replace(content, h('p.panel-empty', 'Reading your repositories…'));
      return;
    }
    replace(content, h('div.toolbar', search, show, sort, h('span.spacer'), h('span.faint.small.gh-count')), h('div.gh-list-wrap'));
    drawList();
  }

  function drawList() {
    const wrap = content.querySelector('.gh-list-wrap');
    if (!wrap || !repos) return;
    const q = search.value.trim().toLowerCase();
    const keep = {
      all: () => true, linked: (r) => projectOf(r), remote: (r) => !projectOf(r), private: (r) => r.private, public: (r) => !r.private, fork: (r) => r.fork, archived: (r) => r.archived,
    }[show.value];
    const list = repos
      .filter((r) => keep(r) && (!q || `${r.full_name} ${r.description ?? ''} ${r.language ?? ''}`.toLowerCase().includes(q)))
      .sort(sort.value === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : sort.value === 'stars' ? (a, b) => b.stars - a.stars || Date.parse(b.pushed_at) - Date.parse(a.pushed_at)
          : (a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at));
    const count = content.querySelector('.gh-count');
    if (count) count.textContent = list.length === repos.length ? plural(repos.length, 'repository', 'repositories') : `${list.length} of ${repos.length}`;
    if (!repos.length) {
      replace(wrap, h('div.empty-state', h('h3', 'No repositories yet'), h('p', 'Create one with New repository, or publish a project from its Git tab.')));
      return;
    }
    replace(wrap, list.length ? h('div.gh-list', { role: 'list' }, list.map(row)) : h('p.panel-empty', 'No repository matches.'));
  }

  function row(repo) {
    const p = projectOf(repo);
    const me = status.user?.login;
    const open = () => (p ? navigate(projectPath(p.id, 'git')) : repoDialog(repo, { onChanged: reload }));
    const changed = (next) => { repos = repos.map((r) => (r.full_name === repo.full_name ? next : r)); drawList(); };
    const deleted = () => { repos = repos.filter((r) => r.full_name !== repo.full_name); drawList(); };
    const details = () => repoDialog(repo, { onChanged: reload });
    const el = h('div.gh-row', {
      role: 'listitem',
      tabIndex: 0,
      title: p ? `Open ${p.name}'s Git tab` : 'Details',
      onclick: (e) => { if (!e.target.closest('button, a')) open(); },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } },
    },
    h('div.gh-main',
      h('div.gh-name', repo.owner !== me ? h('span.faint', `${repo.owner}/`) : null, h('strong', repo.name), badges(repo)),
      repo.description ? h('div.gh-desc', repo.description) : null),
    h('div.gh-meta',
      repo.language ? h('span.gh-lang', h('span.gh-lang-dot', { style: { background: LANG[repo.language] ?? 'var(--text-3)' } }), repo.language) : null,
      repo.stars ? h('span', { title: 'Stars' }, `★ ${repo.stars}`) : null,
      repo.open_issues ? h('span', { title: 'Open issues and pull requests' }, `${repo.open_issues} open`) : null),
    h('div.gh-local', p
      ? [h('span.chip.accent', 'In FlintBench'), h('span.gh-local-git', `${p.git?.branch ?? ''}${p.git?.ahead ? ` ↑${p.git.ahead}` : ''}${p.git?.behind ? ` ↓${p.git.behind}` : ''} · ${gitLine(p.git)}`)]
      : h('span.faint', 'Not on this PC')),
    h('div.gh-time.faint', ago(Date.parse(repo.pushed_at))),
    h('div.gh-actions',
      p ? null : actionButton('Clone', () => cloneRepo(repo), { cls: 'btn sm', iconName: 'download', title: 'Clone to this PC and add it to FlintBench' }),
      actionButton('', (e) => repoMenu(repo, e.currentTarget, { onChanged: changed, onDeleted: deleted }), { cls: 'btn sm icon ghost', iconName: 'dots', title: `${repo.name} actions` }),
      h('span.prow-go', { 'aria-hidden': 'true' }, icon('chevron', 14))));
    // right click: the ⋯ menu, plus Details for a repository whose click opens its project
    contextMenu(el, () => repoMenuItems(repo, { onChanged: changed, onDeleted: deleted, onDetails: p ? details : null }), { label: `${repo.name} actions` });
    return el;
  }

  const unsub = subscribe('projects', () => drawList());
  draw();
  load();
  return {
    destroy() {
      unsub();
      watchSetup(false);
      window.removeEventListener('focus', onFocus);
    },
  };
}
