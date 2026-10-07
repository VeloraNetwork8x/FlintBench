// History router. Routes: / /projects /agents /activity /github /settings /p/:id/:tab?

const listeners = new Set();

export function parse(pathname = location.pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  // no tab in the address: the project opens on the tab its profile chooses (resolveTab)
  if (parts[0] === 'p' && parts[1]) return { name: 'project', id: parts[1], tab: parts[2] ?? null };
  const name = parts[0] ?? 'home';
  return { name: ['projects', 'agents', 'activity', 'github', 'settings'].includes(name) ? name : 'home' };
}

export function current() {
  return parse();
}

// One page may hold the user back (unsaved Settings): it answers true to let navigation happen.
let leaveGuard = null;
export function setLeaveGuard(fn) {
  leaveGuard = fn;
  return () => { if (leaveGuard === fn) leaveGuard = null; };
}

export async function navigate(path, { replace = false } = {}) {
  if (path === location.pathname) return;
  if (leaveGuard && !(await leaveGuard())) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  shown = location.pathname;
  listeners.forEach((fn) => fn(parse()));
}

export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const projectPath = (id, tab) => `/p/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`;

let shown = location.pathname;
window.addEventListener('popstate', async () => {
  if (leaveGuard && location.pathname !== shown) {
    const target = location.pathname;
    history.pushState(null, '', shown); // stay until the guard answers
    if (!(await leaveGuard())) return;
    history.replaceState(null, '', target);
  }
  shown = location.pathname;
  listeners.forEach((fn) => fn(parse()));
});

// Same-origin links navigate without reloading.
document.addEventListener('click', (event) => {
  const a = event.target.closest('a[href]');
  if (!a || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || a.target) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.preventDefault();
  navigate(url.pathname);
});
