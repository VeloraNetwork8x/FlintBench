import { h, icon, replace, brandMark, actionButton } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store, prefs } from '../lib/store.js';
import { attempt } from '../lib/ui.js';
import { agentMark, hostLogo } from '../lib/agent-icons.js';
import { EDITORS } from '../lib/editors.js';
import { PRESETS, recommendProfile, customDefaults } from '../lib/profiles.js';
import { applySettingsLook } from '../lib/theme.js';
import { addRootForm } from './settings.js';
import { profileCards, customEditor } from './profile-editor.js';

const AGENTS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['antigravity', 'Antigravity CLI']];

const WHY = {
  experience: { new: 'you are just starting out', some: 'you have been coding for a few years', expert: 'you have been coding for many years' },
  ai: { none: 'you do not use AI agents', sometimes: 'you use AI agents now and then', mostly: 'agents do most of your work' },
};

/**
 * First run: a few questions, one per screen, then the profile they point to (or another one, or
 * Custom). Resolves once the answers are saved; the console opens after it. Runs only while
 * settings.setup.done is false (`npm run reset-setup` brings it back).
 */
export function runSetupWizard(root) {
  return new Promise((resolve) => {
    const settings = store.state.settings;
    const tools = store.state.integrations?.agents ?? store.state.agents?.tools ?? [];
    const editorsFound = new Map((store.state.integrations?.editors ?? []).map((e) => [e.command, e.installed]));
    const a = {
      experience: null,
      ai: null,
      agents: AGENTS.map(([id]) => id).filter((id) => tools.find((t) => t.id === id)?.installed),
      editors: EDITORS.filter((e) => editorsFound.get(e.command)).slice(0, 1).map((e) => e.command),
      defaultEditor: null,
      github: null,
      docker: settings.docker?.enabled !== false,
      notifications: 'all',
      sounds: true,
      profile: null,
      custom: null,
    };
    a.defaultEditor = a.editors[0] ?? null;

    const steps = [
      { id: 'welcome', title: 'Set FlintBench up for the way you work', lead: 'A few quick questions. Your answers pick a profile: which sections, tabs and details the console shows, and how it looks. You can switch profile at any time in Settings.', body: welcome, next: 'Start' },
      { id: 'experience', title: 'How long have you been building software?', lead: 'The more experience, the more detail the console shows.', body: experience, valid: () => a.experience },
      { id: 'ai', title: 'Do you build with AI coding agents?', lead: 'FlintBench starts, follows and resumes them in your projects. They keep their own login and plan.', body: ai, valid: () => a.ai && (a.ai === 'none' || a.agents.length) },
      { id: 'editors', title: 'Which editors do you use?', lead: 'FlintBench opens projects and files in them. One click opens the default one; the others are in the menus.', body: editors, valid: () => a.editors.length && a.defaultEditor },
      { id: 'github', title: 'Do you use GitHub?', lead: 'With GitHub connected, FlintBench lists and manages your repositories and publishes new ones.', body: github, valid: () => a.github },
      { id: 'prefs', title: 'A few preferences', lead: 'Kept in Settings, whatever the profile.', body: preferences },
      { id: 'folders', title: 'Where do your projects live?', lead: 'FlintBench scans these folders for projects and keeps watching them. Only read, never changed. You can add folders later too.', body: folders, next: () => ((store.state.settings?.roots ?? []).length ? 'Next' : 'Skip for now') },
      { id: 'result', title: 'Your profile', lead: null, body: result, next: 'Open FlintBench' },
    ];
    let index = 0;
    let poll = 0;

    const progress = h('div.wiz-progress', { role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': steps.length });
    const counter = h('span.wiz-count');
    const title = h('h1.wiz-title', { tabIndex: -1 });
    const lead = h('p.wiz-lead');
    const body = h('div.wiz-body');
    const back = h('button.btn.ghost', { type: 'button', onclick: () => go(index - 1) }, 'Back');
    const next = h('button.btn.primary', { type: 'submit' });
    const error = h('p.field-error', { role: 'alert' });
    const form = h('form.wiz-card', { novalidate: true, 'aria-labelledby': 'wiz-title' },
      h('header.wiz-head', h('span.brand-mark', brandMark()), h('span.wiz-brand', 'FlintBench setup'), h('span.spacer'), counter),
      progress,
      h('div.wiz-step', title, lead, body),
      error,
      h('footer.wiz-foot', back, h('span.spacer'), next));
    title.id = 'wiz-title';
    replace(root, h('main.auth.wiz', form));

    form.addEventListener('submit', (e) => {
      // the folder form inside a step submits too (Enter adds the folder): that is not "Next"
      if (e.target !== form) return;
      e.preventDefault();
      if (steps[index].valid && !steps[index].valid()) return;
      if (index === steps.length - 1) finish();
      else go(index + 1);
    });

    function refresh() {
      const step = steps[index];
      const ok = !step.valid || Boolean(step.valid());
      next.disabled = !ok;
      const label = typeof step.next === 'function' ? step.next() : step.next ?? 'Next';
      replace(next, label, index < steps.length - 1 ? icon('chevron', 14) : null);
    }

    function go(i) {
      clearInterval(poll);
      poll = 0;
      index = Math.max(0, Math.min(steps.length - 1, i));
      const step = steps[index];
      error.textContent = '';
      counter.textContent = `${index + 1} of ${steps.length}`;
      progress.setAttribute('aria-valuenow', String(index + 1));
      progress.style.setProperty('--wiz-p', String((index + 1) / steps.length));
      title.textContent = step.title;
      lead.textContent = step.lead ?? '';
      lead.hidden = !step.lead;
      back.hidden = index === 0;
      body.classList.remove('is-in');
      replace(body, step.body());
      void body.offsetWidth; // restart the entrance
      body.classList.add('is-in');
      refresh();
      title.focus({ preventScroll: true });
    }

    /* ---------- the questions ---------- */

    function options(name, list, value, set, { cls = '' } = {}) {
      return h(`div.wiz-options${cls}`, { role: 'radiogroup', 'aria-labelledby': 'wiz-title' }, list.map(([id, label, hint, mark]) =>
        h(`label.wiz-option${value === id ? '.is-on' : ''}`,
          h('input', { type: 'radio', name, value: id, checked: value === id, onchange: () => { set(id); for (const o of body.querySelectorAll(`input[name="${name}"]`)) o.closest('.wiz-option').classList.toggle('is-on', o.checked); refresh(); } }),
          mark ?? null,
          h('span.wiz-option-text', h('span.wiz-option-label', label), hint ? h('span.wiz-option-hint', hint) : null))));
    }

    function welcome() {
      return h('ul.wiz-points',
        h('li', icon('folder', 16), h('span', h('strong', 'Your projects'), ' — found in your folders, with their state at a glance.')),
        h('li', icon('agent', 16), h('span', h('strong', 'Your tools'), ' — editors, AI agents and GitHub, one click away.')),
        h('li', icon('overview', 16), h('span', h('strong', 'Your way'), ' — as simple or as detailed as you like.')));
    }

    function experience() {
      return options('experience', [
        ['new', 'Just starting out', 'Show me only what I need.'],
        ['some', 'A few years', 'The everyday tools, without the low-level details.'],
        ['expert', 'Many years', 'Every detail, as much as fits on screen.'],
      ], a.experience, (v) => { a.experience = v; });
    }

    function ai() {
      const which = h('div');
      const drawWhich = () => {
        if (!a.ai || a.ai === 'none') { replace(which); return; }
        replace(which, h('fieldset.wiz-sub', h('legend', 'Which ones?'),
          h('div.wiz-checks', AGENTS.map(([id, name]) => {
            const found = tools.find((t) => t.id === id)?.installed;
            return h(`label.wiz-check${a.agents.includes(id) ? '.is-on' : ''}`,
              h('input', { type: 'checkbox', checked: a.agents.includes(id), onchange: (e) => { a.agents = e.target.checked ? [...a.agents, id] : a.agents.filter((x) => x !== id); e.target.closest('.wiz-check').classList.toggle('is-on', e.target.checked); refresh(); } }),
              agentMark(id, 18), h('span', name), h(`span.wiz-badge${found ? '.is-found' : ''}`, found ? 'Installed' : 'Not found'));
          }))));
      };
      drawWhich();
      return h('div.stack',
        options('ai', [
          ['none', 'No', 'No agent buttons or sections anywhere.'],
          ['sometimes', 'Sometimes', 'Agents are there when I want them.'],
          ['mostly', 'Most of my work', 'Agents first: projects open on their agents.'],
        ], a.ai, (v) => { a.ai = v; drawWhich(); }),
        which);
    }

    function editors() {
      const list = h('div.wiz-editors');
      const draw = () => replace(list, EDITORS.map((e) => {
        const on = a.editors.includes(e.command);
        const found = editorsFound.get(e.command);
        const isDefault = a.defaultEditor === e.command;
        return h(`div.wiz-editor${on ? '.is-on' : ''}`,
          h('label.wiz-editor-pick',
            h('input', { type: 'checkbox', checked: on, onchange: (ev) => {
              a.editors = ev.target.checked ? [...a.editors, e.command] : a.editors.filter((c) => c !== e.command);
              if (!a.editors.includes(a.defaultEditor)) a.defaultEditor = a.editors[0] ?? null;
              if (ev.target.checked && !a.defaultEditor) a.defaultEditor = e.command;
              draw();
              refresh();
            } }),
            h('span.wiz-editor-text', h('span.wiz-editor-name', e.name), h(`span.wiz-badge${found ? '.is-found' : ''}`, found ? 'Installed' : 'Not found'))),
          on ? h('button.wiz-default', { type: 'button', 'aria-pressed': String(isDefault), title: isDefault ? 'Opens on a click' : 'Make it the one a click opens', onclick: () => { a.defaultEditor = e.command; draw(); refresh(); } },
            isDefault ? 'Default' : 'Make default') : null);
      }));
      draw();
      return list;
    }

    function github() {
      const status = h('div.wiz-sub');
      const drawStatus = async () => {
        if (a.github !== 'yes') { replace(status); clearInterval(poll); poll = 0; return; }
        replace(status, h('p.faint', 'Checking GitHub CLI…'));
        const s = await api.get('/api/github/status').catch(() => null);
        if (steps[index].id !== 'github' || a.github !== 'yes') return;
        const ready = s?.authenticated;
        replace(status, h('div.wiz-gh',
          hostLogo('https://github.com', 22),
          h('div.wiz-gh-text',
            h('strong', ready ? `Connected as @${s.user?.login ?? 'you'}` : s?.installed ? 'Sign in to GitHub' : 'Install GitHub CLI'),
            h('span.faint', ready ? 'Your repositories will be in the GitHub section.'
              : s?.installed ? 'Confirm the code in your browser, in the window that opens. This page notices by itself.'
                : 'FlintBench reaches GitHub through the official GitHub CLI, which keeps your sign-in. This page notices the install by itself.')),
          ready ? h('span.chip.ok', 'Ready') : actionButton(s?.installed ? 'Sign in' : 'Install', () => attempt(() => api.post('/api/github/terminal', { action: s?.installed ? 'login' : 'install' })), { cls: 'btn sm primary', iconName: 'terminal' })));
        clearInterval(poll);
        poll = ready ? 0 : setInterval(async () => {
          const n = await api.get('/api/github/status').catch(() => null);
          if (n && (n.installed !== s?.installed || n.authenticated !== s?.authenticated)) drawStatus();
        }, 4000);
      };
      drawStatus();
      return h('div.stack',
        options('github', [
          ['yes', 'Yes', 'Set it up now; you can also finish later.'],
          ['no', 'No', 'No GitHub section. Git still works as usual.'],
        ], a.github, (v) => { a.github = v; drawStatus(); }),
        status,
        h('p.faint.small', 'Setting it up now is optional: Next works either way.'));
    }

    function preferences() {
      return h('div.stack.wiz-prefs',
        h('fieldset.wiz-sub', h('legend', 'Do you run projects in Docker?'),
          options('docker', [['yes', 'Yes', 'Containers start and stop with their project.'], ['no', 'No', 'No Docker status or controls.']], a.docker ? 'yes' : 'no', (v) => { a.docker = v === 'yes'; }, { cls: '.is-row' })),
        h('fieldset.wiz-sub', h('legend', 'Notifications'),
          options('notifications', [
            ['all', 'Everything', 'Agents finishing, services starting, commits and pushes.'],
            ['important', 'Only what matters', 'Agents finishing and pushes.'],
            ['quiet', 'Quiet', 'Only the outcome of what you do yourself.'],
          ], a.notifications, (v) => { a.notifications = v; }, { cls: '.is-row' })),
        h('label.check', h('input', { type: 'checkbox', checked: a.sounds, onchange: (e) => { a.sounds = e.target.checked; } }), 'Sounds and the spoken greeting'));
    }

    function folders() {
      const list = h('ul.list.panel.roots');
      const draw = () => {
        const roots = store.state.settings?.roots ?? [];
        replace(list, roots.length ? roots.map((r) => h('li', icon('folder', 14), h('span.ellipsis', r))) : h('li.faint', 'No folders yet.'));
        refresh();
      };
      draw();
      const off = setInterval(() => { if (steps[index].id !== 'folders') clearInterval(off); else draw(); }, 600);
      return h('div.stack', list, addRootForm());
    }

    function result() {
      const rec = recommendProfile({ experience: a.experience, ai: a.ai });
      a.profile ??= rec;
      const reasons = [WHY.experience[a.experience], WHY.ai[a.ai]].filter(Boolean);
      const editorBox = h('div');
      const preview = () => applySettingsLook({ ...store.state.settings, profile: a.profile, customProfile: a.custom });
      const drawEditor = () => {
        if (a.profile !== 'custom') { replace(editorBox); return; }
        a.custom ??= customDefaults(rec);
        replace(editorBox, h('div.wiz-custom', customEditor(a.custom, (c) => { a.custom = c; preview(); }, { agentsInUse: a.ai !== 'none' })));
      };
      const cards = profileCards({ value: a.profile, recommended: rec, onPick: (id) => {
        a.profile = id;
        for (const c of cards.querySelectorAll('.pf-card')) c.classList.toggle('is-on', c.dataset.id === id);
        drawEditor();
        preview();
      } });
      drawEditor();
      preview();
      return h('div.stack',
        h('p.wiz-why', 'We recommend ', h('strong', PRESETS[rec].name), ` because ${reasons.join(' and ')}. Pick another, or Custom to choose every feature yourself.`),
        cards,
        editorBox,
        h('p.faint.small', 'Later, the profile is how you change the console: Settings › Profile.'));
    }

    async function finish() {
      next.disabled = true;
      const agentsOn = a.ai === 'none' ? [] : a.agents;
      const patch = {
        profile: a.profile,
        ...(a.profile === 'custom' ? { customProfile: a.custom ?? customDefaults(recommendProfile({ experience: a.experience, ai: a.ai })) } : {}),
        agents: { use: a.ai, ...Object.fromEntries(AGENTS.map(([id]) => [id, { enabled: agentsOn.includes(id) }])) },
        editor: { command: a.defaultEditor || 'code', others: a.editors.filter((c) => c !== a.defaultEditor) },
        docker: { enabled: a.docker },
        notifications: { level: a.notifications },
        setup: { done: true, answers: { experience: a.experience, ai: a.ai, agents: agentsOn, editors: a.editors, github: a.github, docker: a.docker, notifications: a.notifications, profile: a.profile } },
      };
      try {
        store.set('settings', await api.patch('/api/settings', patch));
        prefs.set('sound.enabled', a.sounds);
        prefs.set('voice.enabled', a.sounds);
        clearInterval(poll);
        resolve();
      } catch (err) {
        error.textContent = err.message;
        next.disabled = false;
      }
    }

    go(0);
  });
}
