import { h, icon, replace } from './dom.js';
import { play } from './sound.js';
import { plural } from './format.js';

/* ---------------- toasts ---------------- */

const MAX_TOASTS = 4;

export function toast(message, { kind = 'info', detail, timeout = 3800, iconNode, title, onClick, sound = true } = {}) {
  const box = document.getElementById('toasts');
  const glyph = { ok: 'st-ok', err: 'st-err', warn: 'st-warn', info: 'st-info' }[kind] ?? 'st-info';
  const el = h(`div.toast.${kind}${onClick ? '.is-action' : ''}`, { role: kind === 'err' || kind === 'warn' ? 'alert' : 'status' },
    h('span.toast-icon', { 'aria-hidden': 'true' }, iconNode ?? icon(glyph, 20)),
    h('div.toast-body', title ? h('div.toast-title', title) : null, h('div.toast-msg', message), detail ? h('pre', detail) : null),
    h('button.toast-x', { type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss' }, icon('x', 13)));
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 160);
  };
  el.addEventListener('click', (e) => {
    if (onClick && !e.target.closest('.toast-x')) onClick();
    dismiss();
  });
  el.dismissToast = dismiss;
  // at most MAX_TOASTS on screen: the oldest leaves as the new one arrives
  const shown = [...box.children].filter((t) => !t.classList.contains('is-out'));
  for (const old of shown.slice(0, Math.max(0, shown.length - (MAX_TOASTS - 1)))) old.dismissToast?.();
  box.append(el);
  if (sound && kind === 'ok') play('success');
  else if (sound && kind === 'err') play('error');
  setTimeout(dismiss, kind === 'err' ? timeout * 2 : timeout);
}

export async function attempt(fn, { success, failure = 'Action failed' } = {}) {
  try {
    const result = await fn();
    if (success) toast(typeof success === 'function' ? success(result) : success, { kind: 'ok' });
    return result;
  } catch (error) {
    toast(failure, { kind: 'err', detail: error.message });
    return undefined;
  }
}

/* ---------------- dialogs (native <dialog>: focus trap + Esc) ---------------- */

export function dialog(build, { cls = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = h(`dialog.modal${cls ? `.${cls}` : ''}`);
    let closing = false;
    // the dialog eases out before it is removed (the answer is not held back by the animation)
    const done = (value) => {
      if (closing) return;
      closing = true;
      resolve(value);
      dlg.classList.add('is-closing');
      setTimeout(() => { dlg.close(); dlg.remove(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140);
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.append(build(done));
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[autofocus]')?.focus();
  });
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return dialog((done) => h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); done(true); } },
    h('h2', title),
    body ? h('p.dim', body) : null,
    h('div.actions',
      h('button.btn', { type: 'button', onclick: () => done(false) }, 'Cancel'),
      h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'submit', autofocus: true }, confirm))));
}

/**
 * A question with more than one way forward. `choices`: [{ value, label, primary?, danger? }], shown
 * after Cancel in the given order; resolves with the chosen value, or null when cancelled.
 */
export function choiceDialog({ title, body, choices }) {
  return dialog((done) => h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); done(choices.find((c) => c.primary)?.value ?? null); } },
    h('h2', title),
    body ? h('p.dim', body) : null,
    h('div.actions',
      h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancel'),
      choices.map((c) => h(`button.btn${c.danger ? '.danger' : c.primary ? '.primary' : ''}`, c.primary
        ? { type: 'submit', autofocus: true }
        : { type: 'button', onclick: () => done(c.value) }, c.label)))));
}

export function promptDialog({ title, label, value = '', placeholder = '', confirm = 'Save', mono = false, hint }) {
  return dialog((done) => {
    const input = h(`input.input${mono ? '.mono' : ''}`, { value, placeholder, autofocus: true, spellcheck: false });
    return h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); done(input.value.trim() || null); } },
      h('h2', title),
      h('label.field', h('span', label), input, hint ? h('span.hint', hint) : null),
      h('div.actions',
        h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button.btn.primary', { type: 'submit' }, confirm)));
  });
}

/* ---------------- shared project vocabulary ---------------- */

/**
 * What is happening in this project right now, in one line of plain language.
 * Priority: missing → agent at work → running → needs attention → idle.
 */
export const FILES_MOVING_MS = 2 * 60_000; // files changed in the last 2 minutes: work in progress

/**
 * The agent is answering right now — decided by the server on evidence (Claude Code's registry,
 * Codex's turn record, Antigravity's transcript writes). An agent just opened, or waiting, is idle.
 */
export function agentWorking(s) {
  return s.busy === true;
}

/** Something is being done on the project right now: an agent answering, or files changing. */
export function projectMoving(p, now = Date.now()) {
  return (p.agents?.active ?? []).some((s) => agentWorking(s, now)) || now - (p.activity?.lastFileChangeAt ?? 0) < FILES_MOVING_MS;
}

export function nowState(p) {
  if (!p.exists) return { dot: 'err', cls: 'error-text', text: 'Folder missing' };
  const agent = p.agents?.active?.[0];
  const editors = p.editors ?? [];
  // every tool at work on the project: its agents (one mark each), then its editors
  const marks = [...new Set([...(p.agents?.active ?? []).map((s) => s.agent), ...editors.map((e) => e.id)])];
  if (!agent && editors.length) return { dot: 'agent live', marks, cls: 'agent-text', text: `Open in ${editors.map((e) => e.name).join(', ')}` };
  if (agent) {
    // open but waiting for you is not "at work"
    const working = p.agents.active.find((s) => agentWorking(s));
    const shown = working ?? agent;
    return { dot: 'agent live', marks, agent: shown.agent, cls: 'agent-text', text: `${shown.agentName} ${working ? 'at work' : 'open · idle'}${p.agents.active.length > 1 ? ` +${p.agents.active.length - 1}` : ''}` };
  }
  if (p.running) {
    const port = p.runtime?.ports?.[0];
    const services = (p.runtime?.services ?? []).filter((x) => x.status === 'running').length;
    const containers = p.docker?.running ?? 0;
    const what = port ? `localhost:${port}` : services ? plural(services, 'service') : containers ? plural(containers, 'container') : 'process';
    return { dot: 'ok live', cls: 'ok-text', text: `Running · ${what}`, port };
  }
  const issue = (p.attention ?? []).find((x) => x.severity !== 'info');
  if (issue) return { dot: issue.severity === 'error' ? 'err' : 'warn', cls: issue.severity === 'error' ? 'error-text' : 'warn-text', text: issue.label ?? 'Needs attention' };
  return { dot: 'off', cls: 'dim', text: 'Idle' };
}

export function projectStatus(p) {
  if (!p.exists) return { cls: 'err', rail: 'rail-err', label: 'Missing', dot: 'err' };
  if (p.agents?.active?.length) return { cls: 'agent', rail: 'rail-agent', label: p.running ? 'Running' : 'Agent active', dot: 'agent live' };
  if (p.editors?.length) return { cls: 'agent', rail: 'rail-agent', label: p.running ? 'Running' : `Open in ${p.editors[0].name}`, dot: 'agent live' };
  if (p.running) return { cls: 'ok', rail: 'rail-ok', label: 'Running', dot: 'ok live' };
  if (p.attention?.some((a) => a.severity === 'error')) return { cls: 'err', rail: 'rail-err', label: 'Stopped', dot: 'off' };
  if (p.needsAttention) return { cls: 'warn', rail: 'rail-warn', label: 'Stopped', dot: 'off' };
  return { cls: '', rail: 'rail-idle', label: 'Stopped', dot: 'off' };
}

export function gitLine(git) {
  if (!git) return 'git …';
  if (!git.isRepo) return 'no git';
  if (git.conflicts) return `${git.conflicts} conflicts`;
  if (!git.changed) return 'clean';
  const parts = [];
  const modified = git.changed - git.untracked;
  if (modified) parts.push(`${modified} modified`);
  if (git.untracked) parts.push(`${git.untracked} untracked`);
  return parts.join(', ');
}

export function severityChip(a) {
  return h(`span.chip.${a.severity === 'error' ? 'err' : a.severity === 'warn' ? 'warn' : ''}`, a.label);
}

export function statusDot(cls, label) {
  return h(`span.dot.${cls.split(' ').join('.')}`, { role: 'img', 'aria-label': label, title: label });
}

/* ---------------- minimal, safe markdown (DOM-built, no HTML passthrough) ---------------- */

function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(h('code', tok.slice(1, -1)));
    else if (tok.startsWith('**')) out.push(h('strong', tok.slice(2, -2)));
    else {
      const label = /^\[([^\]]+)\]/.exec(tok)[1];
      const href = /\(([^)]+)\)$/.exec(tok)[1];
      out.push(/^https?:\/\//.test(href) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label) : h('span', label));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src) {
  const root = h('div.md');
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let list = null;
  const closeList = () => { list = null; };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      root.append(h('pre', h('code', code.join('\n'))));
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      root.append(h(`h${heading[1].length}`, inline(heading[2])));
    } else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) {
        list = h(ordered ? 'ol' : 'ul');
        root.append(list);
      }
      list.append(h('li', inline(line.replace(/^\s*([-*+]|\d+\.)\s+/, ''))));
    } else if (/^>\s?/.test(line)) {
      closeList();
      root.append(h('blockquote', inline(line.replace(/^>\s?/, ''))));
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      root.append(h('hr'));
    } else if (line.trim()) {
      closeList();
      const para = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|```|\s*[-*+]\s|\s*\d+\.\s|>)/.test(lines[i + 1])) para.push(lines[++i]);
      root.append(h('p', inline(para.join(' '))));
    } else {
      closeList();
    }
    i += 1;
  }
  return root;
}

/* ---------------- command palette ---------------- */

export function openPalette(items, { placeholder = 'Jump to project or run a command…' } = {}) {
  if (document.querySelector('.overlay')) return;
  const prevFocus = document.activeElement;
  const input = h('input.input', { placeholder, 'aria-label': placeholder, role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', spellcheck: false });
  const list = h('ul', { id: 'palette-list', role: 'listbox' });
  let selected = 0;
  let shown = items;
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div.palette', { role: 'dialog', 'aria-label': 'Command palette' }, input, list));

  function close() {
    overlay.remove();
    prevFocus?.focus?.();
  }

  function score(item, q) {
    const text = `${item.label} ${item.keywords ?? ''}`.toLowerCase();
    if (!q) return 1;
    if (text.startsWith(q)) return 3;
    if (text.includes(q)) return 2;
    let pos = 0;
    for (const ch of q) {
      pos = text.indexOf(ch, pos);
      if (pos < 0) return 0;
      pos += 1;
    }
    return 1;
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    shown = items.map((it) => [it, score(it, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([it]) => it).slice(0, 40);
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    replace(list, shown.length ? shown.map((it, idx) => h('li', {
      role: 'option',
      id: `pal-${idx}`,
      'aria-selected': String(idx === selected),
      onmousemove: () => { if (selected !== idx) { selected = idx; render(); } },
      onclick: () => run(it),
    }, icon(it.icon ?? 'chevron', 14), h('span.ellipsis', it.label), it.hint ? h('span.hint', it.hint) : null)) : h('li.faint', 'No matches'));
    input.setAttribute('aria-activedescendant', `pal-${selected}`);
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  function run(it) {
    close();
    it.run();
  }

  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { selected = Math.min(shown.length - 1, selected + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { selected = Math.max(0, selected - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (shown[selected]) run(shown[selected]); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  document.body.append(overlay);
  render();
  input.focus();
}
