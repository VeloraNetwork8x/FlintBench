import { store, prefs, notify } from './store.js';

/**
 * Projects open as tabs: every project visited stays here, with the section it was left on, so the
 * header can offer a one-click switch back to it (Alt+[ / Alt+] cycle). Kept per browser, in the
 * order they were opened; the oldest visit drops out past MAX.
 */

const KEY = 'openProjects';
const MAX = 8;

let list = (() => {
  const saved = prefs.get(KEY, []);
  return Array.isArray(saved) ? saved.filter((x) => x && typeof x.id === 'string').slice(0, MAX) : [];
})();

function save() {
  prefs.set(KEY, list);
  notify('openProjects');
}

/** The open projects that still exist, in tab order: [{ id, tab, at }]. */
export function openProjects() {
  return list.filter((x) => store.project(x.id));
}

/** A project shown on `tab`: opened as a tab if it was not, its section remembered. */
export function touchProject(id, tab) {
  const i = list.findIndex((x) => x.id === id);
  if (i !== -1 && list[i].tab === tab) {
    list[i].at = Date.now();
    prefs.set(KEY, list);
    return;
  }
  if (i !== -1) list[i] = { id, tab, at: Date.now() };
  else list.push({ id, tab, at: Date.now() });
  while (list.length > MAX) {
    const oldest = list.reduce((a, b) => (b.at < a.at ? b : a));
    list = list.filter((x) => x !== oldest);
  }
  save();
}

export function closeProject(id) {
  list = list.filter((x) => x.id !== id);
  save();
}
