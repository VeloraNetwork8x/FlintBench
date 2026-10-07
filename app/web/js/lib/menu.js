import { h, icon } from './dom.js';

// One floating menu at a time: right-click menus and button drop-downs share it.
let current = null;

/**
 * Opens a menu at a point ({ x, y }) or under an element ({ anchor }).
 * items: [{ label, icon?, iconNode?, hint?, danger?, disabled?, run }] or '-' for a separator.
 * Keyboard: ↑ ↓ Home End move, Enter/Space runs, Esc closes and gives focus back.
 */
export function openMenu(items, { x, y, anchor, label = 'Actions' } = {}) {
  closeMenu();
  const returnFocus = document.activeElement;
  const buttons = [];
  const list = h('div.menu', { role: 'menu', 'aria-label': label },
    items.filter(Boolean).map((item) => {
      if (item === '-') return h('div.menu-sep', { role: 'separator' });
      const btn = h(`button.menu-item${item.danger ? '.is-danger' : ''}`, {
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled,
        title: item.title,
        onclick: () => {
          closeMenu({ restore: false });
          item.run?.();
        },
      }, item.iconNode ?? (item.icon ? icon(item.icon, 14) : h('span.menu-noicon')), h('span.menu-label', item.label), item.hint ? h('span.menu-hint', item.hint) : null);
      if (!item.disabled) buttons.push(btn);
      return btn;
    }));
  document.body.append(list);

  // place, then flip away from the viewport edges
  const r = list.getBoundingClientRect();
  let left = x ?? 0;
  let top = y ?? 0;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = a.left;
    top = a.bottom + 4;
    if (top + r.height > innerHeight - 8) top = a.top - r.height - 4;
  } else if (top + r.height > innerHeight - 8) {
    top = Math.max(8, top - r.height);
  }
  if (left + r.width > innerWidth - 8) left = Math.max(8, innerWidth - r.width - 8);
  list.style.left = `${Math.round(left)}px`;
  list.style.top = `${Math.round(Math.max(8, top))}px`;

  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); buttons.at(-1)?.focus(); }
    else if (e.key === 'Tab') { e.preventDefault(); closeMenu(); }
  };
  const onPointer = (e) => { if (!list.contains(e.target)) closeMenu({ restore: false }); };
  const onScroll = (e) => { if (!list.contains(e.target)) closeMenu({ restore: false }); };
  const onBlur = () => closeMenu({ restore: false });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  current = {
    list,
    close(restore) {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      list.remove();
      if (restore && returnFocus?.isConnected) returnFocus.focus();
    },
  };
  buttons[0]?.focus({ preventScroll: true });
  return list;
}

export function closeMenu({ restore = true } = {}) {
  const menu = current;
  current = null;
  menu?.close(restore);
}

/**
 * Right-click (and the keyboard context-menu key / Shift+F10) on an element opens its menu.
 * build(event) returns the items, computed at open time so they reflect the current state.
 */
export function contextMenu(el, build, { label } = {}) {
  el.addEventListener('contextmenu', (e) => {
    const items = build(e);
    if (!items?.length) return;
    e.preventDefault();
    e.stopPropagation();
    const fromKeyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
    if (fromKeyboard) {
      const b = el.getBoundingClientRect();
      openMenu(items, { x: b.left + 16, y: b.top + Math.min(b.height, 28), label });
    } else {
      openMenu(items, { x: e.clientX, y: e.clientY, label });
    }
  });
}

/** Copies text and says so; falls back silently when the clipboard is unavailable. */
export async function copyText(text, toastFn) {
  try {
    await navigator.clipboard.writeText(text);
    toastFn?.('Copied to the clipboard', { kind: 'ok' });
  } catch {
    toastFn?.('Could not copy to the clipboard', { kind: 'err' });
  }
}
