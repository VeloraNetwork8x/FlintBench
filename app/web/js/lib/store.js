// Client state. Views subscribe to topics; updates are coalesced per animation frame.

const state = {
  auth: null,
  settings: null,
  projects: new Map(),
  candidates: [],
  ignored: [],
  agents: { tools: [], active: [], processes: [], unattributed: [] },
  integrations: null,
  terminals: new Map(),
  platform: '',
  dataDir: '',
  connected: false,
  lastEvent: null,
  lastScanAt: null,
  rootSuggestions: [],
};

const subs = new Map();
const pending = new Set();
let frame = 0;

export function subscribe(topics, fn) {
  const list = Array.isArray(topics) ? topics : [topics];
  for (const t of list) {
    if (!subs.has(t)) subs.set(t, new Set());
    subs.get(t).add(fn);
  }
  return () => list.forEach((t) => subs.get(t)?.delete(fn));
}

export function notify(topic) {
  pending.add(topic);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const fns = new Set();
    for (const t of pending) subs.get(t)?.forEach((fn) => fns.add(fn));
    const topics = new Set(pending);
    pending.clear();
    fns.forEach((fn) => {
      try {
        fn(topics);
      } catch (error) {
        console.error(error);
      }
    });
  });
}

export const store = {
  state,
  setBootstrap(b) {
    state.settings = b.settings;
    state.projects = new Map(b.projects.map((p) => [p.id, p]));
    state.candidates = b.candidates;
    state.ignored = b.ignored;
    state.agents = b.agents;
    state.integrations = b.integrations;
    state.terminals = new Map(b.terminals.map((t) => [t.id, t]));
    state.platform = b.platform;
    state.dataDir = b.dataDir;
    state.lastScanAt = b.lastScanAt;
    state.rootSuggestions = b.rootSuggestions ?? [];
    ['projects', 'candidates', 'agents', 'settings', 'terminals', 'integrations'].forEach(notify);
  },
  project(id) {
    return state.projects.get(id) ?? null;
  },
  setProject(p) {
    state.projects.set(p.id, p);
    notify('projects');
    notify(`project:${p.id}`);
  },
  removeProject(id) {
    state.projects.delete(id);
    notify('projects');
    notify(`project:${id}`);
  },
  setTerminal(t) {
    state.terminals.set(t.id, t);
    notify('terminals');
  },
  removeTerminal(id) {
    state.terminals.delete(id);
    notify('terminals');
  },
  projectTerminals(projectId) {
    return [...state.terminals.values()].filter((t) => t.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt);
  },
  set(key, value) {
    state[key] = value;
    notify(key);
  },
};

/** Persisted per-browser UI preferences (never state that matters). */
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`flintbench:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`flintbench:${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable: preference simply not remembered
    }
  },
};
