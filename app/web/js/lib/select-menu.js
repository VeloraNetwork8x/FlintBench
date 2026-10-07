import { h, icon } from './dom.js';

/**
 * A styled single-choice dropdown (the native <select> popup cannot be styled).
 * Trigger: label + current value + caret. List: options with a tick on the chosen one; it opens
 * upward when there is no room below. Keyboard: ↑/↓ move, Enter/Space choose, Home/End jump,
 * Esc or Tab close, typing a letter jumps to the next option starting with it.
 *
 * @param {{ label: string, options: { value: string, text: string }[], value: string,
 *           onChange: (value: string) => void, prefix?: string, width?: string }} opts
 */
export function selectMenu({ label, options, value, onChange, prefix, width }) {
  let current = options.some((o) => o.value === value) ? value : options[0]?.value;
  const listId = `smenu-${Math.random().toString(36).slice(2, 8)}`;
  const valueText = h('span.smenu-value');
  const trigger = h('button.smenu-btn', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': label },
    prefix ? h('span.smenu-prefix', prefix) : null, valueText, h('span.smenu-caret', { 'aria-hidden': 'true' }, icon('down', 14)));
  const list = h('ul.smenu-list', { id: listId, role: 'listbox', 'aria-label': label, tabIndex: -1, hidden: true });
  const el = h('div.smenu', { style: width ? { width } : undefined }, trigger, list);

  const items = () => [...list.children];
  function draw() {
    valueText.textContent = options.find((o) => o.value === current)?.text ?? '';
    list.replaceChildren(...options.map((o) => h('li.smenu-opt', {
      role: 'option', id: `${listId}-${o.value || 'all'}`, 'aria-selected': String(o.value === current), dataset: { value: o.value },
      onclick: () => choose(o.value),
    }, h('span.smenu-tick', { 'aria-hidden': 'true' }, icon('check', 13)), h('span.ellipsis', o.text))));
  }
  function highlight(li) {
    for (const x of items()) x.classList.toggle('is-active', x === li);
    if (li) {
      list.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  }
  function open() {
    if (!list.hidden) return;
    list.hidden = false;
    // room below? otherwise open upward
    const r = trigger.getBoundingClientRect();
    const needed = Math.min(list.scrollHeight, 280) + 8;
    el.classList.toggle('is-up', window.innerHeight - r.bottom < needed && r.top > needed);
    trigger.setAttribute('aria-expanded', 'true');
    highlight(items().find((li) => li.dataset.value === current) ?? items()[0]);
    list.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside, true);
  }
  function close(refocus = true) {
    if (list.hidden) return;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) trigger.focus({ preventScroll: true });
  }
  function outside(e) { if (!el.contains(e.target)) close(false); }
  function choose(v) {
    close();
    if (v === current) return;
    current = v;
    draw();
    onChange(v);
  }

  trigger.addEventListener('click', () => (list.hidden ? open() : close()));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
  });
  list.addEventListener('keydown', (e) => {
    const all = items();
    const at = all.findIndex((li) => li.classList.contains('is-active'));
    const move = (i) => highlight(all[Math.max(0, Math.min(all.length - 1, i))]);
    if (e.key === 'ArrowDown') { e.preventDefault(); move(at + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(all.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (all[at]) choose(all[at].dataset.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const next = [...all.slice(at + 1), ...all.slice(0, at + 1)].find((li) => li.textContent.trim().toLowerCase().startsWith(k));
      if (next) highlight(next);
    }
  });
  // inside a <label> a click on the list would also "activate" the label, i.e. click the trigger and reopen it
  list.addEventListener('click', (e) => e.preventDefault());
  list.addEventListener('pointermove', (e) => { const li = e.target.closest('.smenu-opt'); if (li && !li.classList.contains('is-active')) highlight(li); });

  draw();
  return {
    el,
    get value() { return current; },
    set(v, { silent = true } = {}) { if (!options.some((o) => o.value === v)) return; current = v; draw(); if (!silent) onChange(v); },
  };
}

/**
 * selectMenu as a drop-in for a native <select>: the element has a `value` (read and set) and
 * fires a bubbling `change` event when the user picks an option.
 * `size: 'sm'` matches the small controls (`.btn.sm`).
 */
export function selectField({ label, options, value, width, size, cls }) {
  let field;
  const menu = selectMenu({ label, options, value, width, onChange: () => field.dispatchEvent(new Event('change', { bubbles: true })) });
  field = menu.el;
  if (size === 'sm') field.classList.add('is-sm');
  if (cls) field.classList.add(...cls.split(' '));
  Object.defineProperty(field, 'value', { get: () => menu.value, set: (v) => menu.set(v) });
  return field;
}
