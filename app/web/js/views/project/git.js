import { h, icon, replace, actionButton } from '../../lib/dom.js';
import { selectField } from '../../lib/select-menu.js';
import { api, projectUrl } from '../../lib/api.js';
import { ago, plural } from '../../lib/format.js';
import { attempt, promptDialog, toast } from '../../lib/ui.js';
import { openMenu } from '../../lib/menu.js';
import { fileBadge } from '../../lib/file-icons.js';
import { commitLink } from '../../lib/git-links.js';
import { store } from '../../lib/store.js';
import { IGNORE_TEMPLATES, chooseIgnored } from './ignore-picker.js';

const STATE = {
  M: ['Modified', 'M'], A: ['Added', 'A'], D: ['Deleted', 'D'], R: ['Renamed', 'R'], C: ['Conflict', 'C'], U: ['Untracked', 'U'], T: ['Type changed', 'M'],
};

function stateOf(f) {
  if (f.conflict) return STATE.C;
  if (f.untracked) return STATE.U;
  const code = f.x !== '.' && f.x !== ' ' ? f.x : f.y;
  return STATE[code] ?? STATE.M;
}

/**
 * Source control as three numbered steps — choose files, describe, push — with the branch and
 * its sync state above. A checkbox per file is "git add": ticked files go into the next commit.
 */
export function render(ctx) {
  const syncBar = h('div.git-sync');
  const steps = h('div.git-steps');
  const side = h('div.git-side');
  const message = h('textarea.textarea', { rows: 3, placeholder: 'What did you change? e.g. "Fix login redirect"', 'aria-label': 'Commit message' });
  const el = h('div.p-center-inner.git', syncBar, h('div.git-grid', steps, side));
  let detail = null;
  let selected = null; // file path whose diff is shown
  let timer = 0;

  async function load() {
    detail = await api.get(projectUrl(ctx.projectId, '/git')).catch(() => null);
    draw();
  }

  async function act(path, body, success) {
    const r = await attempt(() => api.post(projectUrl(ctx.projectId, `/git/${path}`), body), { success, failure: 'Git command failed' });
    if (r?.files) {
      detail = r;
      draw();
    }
    return r;
  }

  async function showDiff(file) {
    selected = file.path;
    draw();
    if (file.untracked) {
      replace(side, diffPanel(file, h('p.ov-empty', 'New file, not tracked yet. Tick it to include it in the next commit.')));
      return;
    }
    const staged = file.staged && !file.unstaged;
    const r = await api.get(projectUrl(ctx.projectId, `/git/diff?path=${encodeURIComponent(file.path)}${staged ? '&staged=1' : ''}`)).catch((e) => ({ diff: `error: ${e.message}` }));
    if (selected !== file.path) return;
    const lines = (r.diff || '(no textual changes)').split('\n').map((line) => {
      const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta'
        : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
      return h(cls ? `div.${cls}` : 'div', line || ' ');
    });
    replace(side, diffPanel(file, h('pre.diff', lines)));
  }

  function diffPanel(file, body) {
    return h('section.ov-block',
      h('header.ov-head', fileBadge(file.path), h('code.ellipsis', file.path), h('span.spacer'),
        h('button.btn.sm.icon.ghost', { type: 'button', title: 'Close diff', onclick: () => { selected = null; draw(); } }, icon('x', 13))),
      body);
  }

  async function commit({ andPush = false } = {}) {
    if (!message.value.trim()) {
      message.focus();
      message.classList.add('needs-input');
      setTimeout(() => message.classList.remove('needs-input'), 900);
      return;
    }
    const r = await act('commit', { message: message.value }, andPush ? null : 'Committed');
    if (!r) return;
    message.value = '';
    if (andPush) await act('push', {}, 'Committed and pushed');
  }
  message.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  });
  message.addEventListener('input', () => drawCommitButtons());

  const commitButtons = h('div.row.wrap');
  function drawCommitButtons() {
    const staged = (detail?.files ?? []).filter((f) => f.staged).length;
    const why = !staged ? 'Tick at least one file in step 1' : !message.value.trim() ? 'Write a message first' : '';
    replace(commitButtons,
      actionButton(staged ? `Commit ${plural(staged, 'file')}` : 'Commit', () => commit(), { cls: 'btn primary', iconName: 'check', disabled: Boolean(why), title: why || 'git commit (Ctrl+Enter)' }),
      actionButton('Commit & Push', () => commit({ andPush: true }), { cls: 'btn', disabled: Boolean(why), title: why || 'Commit, then push to the remote' }),
      why ? h('span.faint.small', why) : null);
  }

  function branchMenu(anchor) {
    const s = detail.summary;
    openMenu([
      ...detail.branches.map((b) => ({ label: b.name, icon: b.current ? 'check' : 'branch', disabled: b.current, run: () => act('switch', { name: b.name }, `Switched to ${b.name}`) })),
      '-',
      { label: 'New branch…', icon: 'plus', run: async () => {
        const name = await promptDialog({ title: 'Create branch', label: `Branch name (from ${s.branch ?? 'HEAD'}, switches to it)`, placeholder: 'feature/…', mono: true, confirm: 'Create' });
        if (name) await act('branch', { name, checkout: true }, `Created ${name}`);
      } },
    ], { anchor, label: 'Branches' });
  }

  /**
   * Not a repository yet: create one from here, asking what git would ask (branch, identity),
   * plus a starter .gitignore, the first commit and, optionally, a new repo on the user's GitHub.
   */
  async function drawInit(p) {
    replace(steps, h('p.ov-empty.git-init', 'Reading your Git settings…'));
    const d = await api.get('/api/git/defaults').catch(() => ({ github: { installed: false } }));
    const field = (label, input, hint) => h('label.field', h('span', label), input, hint ? h('span.hint', hint) : null);
    const branch = h('input.input.mono', { value: d.defaultBranch || 'main', spellcheck: false });
    const userName = h('input.input', { value: d.userName ?? '', placeholder: 'Your name' });
    const userEmail = h('input.input', { value: d.userEmail ?? '', placeholder: 'you@example.com', type: 'email' });
    const stack = (p.stack ?? []).join(' ').toLowerCase();
    const preset = /python|django|flask/.test(stack) ? 'python' : /node|react|next|vite|discord|typescript|tailwind/.test(stack) || !stack ? 'node' : 'basic';
    const ignore = selectField({
      label: '.gitignore',
      value: preset,
      options: [...IGNORE_TEMPLATES.slice(0, 3), { value: '', text: 'None' }, { value: 'custom', text: 'Custom…' }],
    });
    // Custom: files and folders picked in the project's tree, on top of a template
    let custom = { base: preset, paths: [] };
    let previous = preset;
    const customNote = h('span.hint');
    const showCustom = () => {
      const n = custom.paths.length;
      const base = IGNORE_TEMPLATES.find((t) => t.value === custom.base && t.value);
      replace(customNote, ignore.value !== 'custom' ? 'Never overwrites an existing one' : [
        `${n ? plural(n, 'item') : 'Nothing'} chosen${base ? ` + ${base.text.split(' ')[0]}` : ''} · `,
        h('button.link-btn', { type: 'button', onclick: editCustom }, 'Edit'),
      ]);
    };
    async function editCustom() {
      const picked = await chooseIgnored(ctx.projectId, custom);
      if (picked) custom = picked;
      else if (!custom.paths.length && ignore.value === 'custom') ignore.value = previous; // cancelled before choosing anything
      showCustom();
    }
    ignore.addEventListener('change', () => {
      if (ignore.value === 'custom') editCustom();
      else { previous = ignore.value; showCustom(); }
    });
    showCustom();
    const commit = h('input', { type: 'checkbox', checked: true });
    const message = h('input.input', { value: 'Initial commit' });
    const publish = h('input', { type: 'checkbox', checked: Boolean(d.github?.authenticated) });
    const repoName = h('input.input.mono', { value: p.name.replace(/[^A-Za-z0-9._-]+/g, '-'), spellcheck: false });
    const visibility = selectField({ label: 'Visibility', value: 'private', options: [{ value: 'private', text: 'Private' }, { value: 'public', text: 'Public' }] });
    const description = h('input.input', { placeholder: 'Optional description' });
    const gh = d.github ?? {};
    const ghBox = h('div.git-gh',
      !gh.installed
        ? [h('p.dim', 'Publishing uses the GitHub CLI (gh), which is not installed on this machine.'),
          h('div.row.wrap', h('button.btn.sm', { type: 'button', onclick: () => ctx.dock.newTerminal('winget install --id GitHub.cli -e --source winget', 'Install GitHub CLI') }, icon('terminal', 12), 'Install GitHub CLI'),
            h('button.btn.sm.ghost', { type: 'button', onclick: () => drawInit(p) }, icon('refresh', 12), 'Check again'))]
        : !gh.authenticated
          ? [h('p.dim', 'GitHub CLI is installed. Sign in once and FlintBench can create repositories on your account.'),
            h('div.row.wrap', h('button.btn.sm', { type: 'button', onclick: () => ctx.dock.newTerminal('gh auth login', 'Sign in to GitHub') }, icon('terminal', 12), 'Sign in to GitHub'),
              h('button.btn.sm.ghost', { type: 'button', onclick: () => drawInit(p) }, icon('refresh', 12), 'Check again'))]
          : [h('p.dim', `Signed in to GitHub as ${gh.user ?? 'you'}.`),
            h('div.git-init-grid', field('Repository name', repoName), field('Visibility', visibility)),
            field('Description', description)]);
    const create = actionButton('Create repository', async () => {
      const body = {
        branch: branch.value.trim(), userName: userName.value.trim(), userEmail: userEmail.value.trim(),
        gitignore: ignore.value || null, gitignoreCustom: ignore.value === 'custom' ? custom : undefined, commit: commit.checked, message: message.value.trim() || 'Initial commit',
        github: publish.checked && gh.authenticated ? { name: repoName.value.trim(), visibility: visibility.value, description: description.value.trim() } : null,
      };
      const r = await attempt(() => api.post(projectUrl(ctx.projectId, '/git/init'), body), { failure: 'Could not create the repository' });
      if (!r) return;
      toast(r.remote ? `Repository created and published: ${r.remote}` : r.committed ? 'Repository created with its first commit' : 'Repository created', { kind: 'ok' });
      detail = r;
      draw();
    }, { cls: 'btn primary', iconName: 'check' });
    publish.addEventListener('change', () => { if (publish.checked) commit.checked = true; });
    commit.addEventListener('change', () => { if (!commit.checked) publish.checked = false; });
    replace(steps, h('section.git-step.git-init',
      h('header', h('span.git-num', icon('branch', 12)), h('h3', 'Create a Git repository'), h('span.spacer'), h('span.faint.small', p.path)),
      h('div.git-step-body',
        h('p.dim', 'This folder is not tracked yet. These are the settings git would ask for; they are prefilled from your global Git configuration.'),
        h('div.git-init-grid', field('Default branch', branch), h('label.field', h('span', '.gitignore'), ignore, customNote)),
        h('div.git-init-grid', field('Name', userName, 'Author of the commits in this repository'), field('Email', userEmail)),
        h('label.check', commit, 'Create the first commit with every file'),
        field('Commit message', message),
        h('label.check', publish, gh.authenticated ? 'Also create the repository on my GitHub account and push' : 'Publish to GitHub (sign-in needed, see below)'),
        ghBox,
        h('div.row', create))));
    if (!gh.authenticated) publish.disabled = true;
  }

  function draw() {
    const p = ctx.project();
    // the init response already says it is a repository: do not wait for the next live update
    if (!p?.git?.isRepo && !detail?.summary?.isRepo) {
      replace(syncBar);
      side.replaceChildren();
      if (!steps.querySelector('.git-init')) drawInit(p);
      return;
    }
    if (!detail) {
      replace(steps, h('p.ov-empty', 'Reading repository…'));
      return;
    }
    const files = detail.files ?? [];
    const s = detail.summary ?? p.git;
    const staged = files.filter((f) => f.staged);
    const focusMsg = document.activeElement === message;

    // sync bar: where we are, what is waiting to go up or come down
    replace(syncBar,
      h('button.git-branch', { type: 'button', title: 'Switch or create a branch', 'aria-haspopup': 'menu', onclick: (e) => branchMenu(e.currentTarget) },
        icon('branch', 14), h('strong.mono', s.detached ? 'detached HEAD' : s.branch), icon('down', 12)),
      h('span.git-track', s.upstream
        ? [h('span', { class: s.ahead ? 'accent-text' : '' }, `↑ ${s.ahead} to push`), h('span', { class: s.behind ? 'warn-text' : '' }, `↓ ${s.behind} to pull`), h('span.faint.mono', s.upstream)]
        : h('span.faint', 'Not published yet')),
      h('span.spacer'),
      actionButton('Fetch', () => act('fetch', {}, 'Fetched'), { cls: 'btn sm ghost', iconName: 'refresh', title: 'Check the remote for new commits' }),
      actionButton(s.behind ? `Pull ${s.behind}` : 'Pull', () => act('pull', {}, 'Pulled'), { cls: 'btn sm', iconName: 'down', title: 'git pull --ff-only' }));

    // step 1: choose files (git add)
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all files' });
    all.checked = files.length > 0 && staged.length === files.length;
    all.indeterminate = staged.length > 0 && staged.length < files.length;
    all.addEventListener('change', () => (all.checked
      ? act('stage', { paths: files.filter((f) => !f.staged || f.unstaged).map((f) => f.path) })
      : act('unstage', { paths: staged.map((f) => f.path) })));
    const rows = files.map((f) => {
      const [label, letter] = stateOf(f);
      const box = h('input', { type: 'checkbox', 'aria-label': `Include ${f.path} in the commit` });
      box.checked = f.staged && !f.unstaged;
      box.indeterminate = f.staged && f.unstaged;
      box.addEventListener('change', () => act(box.checked ? 'stage' : 'unstage', { paths: [f.path] }));
      return h(`li.git-file${selected === f.path ? '.is-active' : ''}`,
        h('label.git-check', box),
        fileBadge(f.path),
        h('button.git-name', { type: 'button', title: `Show the changes in ${f.path}`, onclick: () => showDiff(f) }, h('bdi', f.path)),
        h(`span.git-state.st-${letter}`, { title: label }, label));
    });

    // step 3: push
    const ahead = s.ahead ?? 0;
    const pushStep = !s.upstream
      ? [h('p.dim', 'This branch is not on the remote yet.'), actionButton('Publish branch', () => act('push', {}, 'Branch published'), { cls: 'btn primary', iconName: 'up' })]
      : ahead
        ? [h('p.dim', `${plural(ahead, 'commit')} ready to send to ${s.upstream}.`), actionButton(`Push ${plural(ahead, 'commit')}`, () => act('push', {}, 'Pushed'), { cls: 'btn primary', iconName: 'up' })]
        : [h('p.faint', 'Nothing to push: the remote is up to date.')];

    replace(steps,
      h('section.git-step',
        h('header', h('span.git-num', '1'), h('h3', 'Choose files'), h('span.faint.small', files.length ? `${staged.length} of ${files.length} selected` : ''), h('span.spacer'),
          files.length ? h('label.check.small', all, 'Select all') : null),
        files.length ? h('ul.git-files', rows) : h('p.ov-empty', 'No changes: the working tree is clean.')),
      h('section.git-step',
        h('header', h('span.git-num', '2'), h('h3', 'Describe the change'), h('span.spacer'), h('span.faint.small', 'Ctrl+Enter commits')),
        h('div.git-step-body', message, commitButtons)),
      h('section.git-step',
        h('header', h('span.git-num', '3'), h('h3', 'Push')),
        h('div.git-step-body', pushStep)));
    drawCommitButtons();
    if (focusMsg) message.focus();

    if (!selected) {
      replace(side, h('section.ov-block',
        h('header.ov-head', h('h3', 'Recent commits'), h('span.spacer'),
          actionButton('', async () => { detail = await attempt(() => api.post(projectUrl(ctx.projectId, '/git/refresh'))) ?? detail; draw(); }, { cls: 'btn sm icon ghost', iconName: 'refresh', title: 'Refresh' })),
        detail.commits.length ? h('ul.commits', detail.commits.map((c) => h('li',
          commitLink(store.project(ctx.projectId)?.git?.webUrl, c.sha, c.short, 'span.sha'),
          h('span.ellipsis', { title: `${c.subject}\n${c.author}` }, c.subject),
          h('span.faint.small', ago(c.at))))) : h('p.ov-empty', 'No commits yet.')));
    }
  }

  draw();
  load();
  return {
    el,
    update() {
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    },
    destroy() { clearTimeout(timer); },
  };
}
