import fs from 'node:fs';
import path from 'node:path';

const RECURSIVE_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin';

export const IGNORED_DIRS = new Set([
  'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vercel',
  'dist', 'build', 'out', 'coverage', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.gradle', '.idea', '.vs', '.terraform', '.angular', 'graphify-out',
]);

const GIT_INTERESTING = /^(HEAD|index|packed-refs|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|refs\/.+)$/;
const NOISE_FILE = /(\.swp|\.swx|~|\.tmp|\.lock|\.DS_Store|Thumbs\.db)$/i;

/** Classifies a watcher path relative to the project root: 'git' | 'file' | null (ignored). */
export function classifyProjectPath(rel) {
  if (!rel) return 'unknown';
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts[0] === '.git') {
    const inner = parts.slice(1).join('/');
    if (!inner || inner.endsWith('.lock')) return null;
    return GIT_INTERESTING.test(inner) ? 'git' : null;
  }
  if (parts.some((p) => IGNORED_DIRS.has(p))) return null;
  if (NOISE_FILE.test(parts.at(-1))) return null;
  return 'file';
}

const FRESH_WRITE_MS = 2 * 60_000;

/**
 * A watcher event is not proof of an edit: Windows also reports last-access and attribute
 * updates (antivirus, indexer, sync clients, editors reading files after boot) and parent-folder
 * touches, as 'change' and as 'rename'. Only a file written or created moments ago counts (a
 * copied file keeps its old mtime but has a fresh creation time); a vanished file counts as removed.
 */
async function contentChanged(file, eventType) {
  try {
    const st = await fs.promises.stat(file);
    // a folder created or renamed changes the tree (the Files view listens); a folder 'change' does not
    if (st.isDirectory()) return eventType === 'rename' && Date.now() - Math.max(st.mtimeMs, st.birthtimeMs || 0) < FRESH_WRITE_MS;
    return Date.now() - Math.max(st.mtimeMs, st.birthtimeMs || 0) < FRESH_WRITE_MS;
  } catch {
    return true;
  }
}

/**
 * Watches one project directory. Calls onEvent({ kind: 'git'|'file'|'unknown', path }).
 * Recursive natively on Windows/macOS; on Linux watches the root and git refs and relies
 * on periodic reconciliation for deep files.
 */
export function watchProject(root, onEvent, { log = console } = {}) {
  const watchers = [];
  let closed = false;
  let retry = null;

  const add = (dir, recursive, prefix = '') => {
    try {
      const watcher = fs.watch(dir, { recursive, persistent: false }, (eventType, filename) => {
        const rel = filename ? path.join(prefix, filename.toString()) : '';
        const kind = classifyProjectPath(rel);
        if (!kind) return;
        const event = { kind, path: rel.replaceAll('\\', '/'), eventType };
        if (kind !== 'file') return onEvent(event);
        contentChanged(path.join(dir, filename.toString()), eventType).then((real) => { if (real && !closed) onEvent(event); });
      });
      watcher.on('error', (error) => {
        log.warn(`[watch] ${dir}: ${error.message}`);
        restart();
      });
      watchers.push(watcher);
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn(`[watch] cannot watch ${dir}: ${error.message}`);
    }
  };

  const start = () => {
    if (RECURSIVE_SUPPORTED) {
      add(root, true);
    } else {
      add(root, false);
      add(path.join(root, '.git'), false, '.git');
      add(path.join(root, '.git', 'refs', 'heads'), false, '.git/refs/heads');
    }
  };

  const closeAll = () => {
    for (const w of watchers.splice(0)) {
      try { w.close(); } catch { /* ignore */ }
    }
  };

  const restart = () => {
    if (closed || retry) return;
    closeAll();
    retry = setTimeout(() => {
      retry = null;
      if (!closed) {
        start();
        onEvent({ kind: 'unknown', path: '' });
      }
    }, 5000);
    retry.unref?.();
  };

  start();
  return {
    close() {
      closed = true;
      clearTimeout(retry);
      closeAll();
    },
  };
}

/**
 * Watches a project root (e.g. C:\Dev) for new folders / indicator files up to `depth`.
 * Calls onChange() (debounced by the caller).
 */
export function watchRoot(root, depth, onChange, { log = console } = {}) {
  const watchers = [];
  const add = (dir, recursive) => {
    try {
      const watcher = fs.watch(dir, { recursive, persistent: false }, (eventType, filename) => {
        if (!filename) return onChange();
        const parts = filename.toString().split(/[\\/]+/);
        if (parts.length > depth + 1) return undefined;
        if (parts.some((p) => IGNORED_DIRS.has(p))) return undefined;
        return onChange();
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch (error) {
      log.warn(`[watch] cannot watch root ${dir}: ${error.message}`);
    }
  };
  if (RECURSIVE_SUPPORTED) {
    add(root, true);
  } else {
    add(root, false);
  }
  return {
    close() {
      for (const w of watchers.splice(0)) {
        try { w.close(); } catch { /* ignore */ }
      }
    },
  };
}

/** Watches a directory tree used by an external tool (agent session files). */
export function watchTree(dir, onChange) {
  try {
    const watcher = fs.watch(dir, { recursive: RECURSIVE_SUPPORTED, persistent: false }, (eventType, filename) => {
      onChange(filename ? filename.toString() : '');
    });
    watcher.on('error', () => {});
    return { close: () => watcher.close() };
  } catch {
    return { close() {} };
  }
}

/** Watches one file for writes. Callers keep a slow poll as a fallback (events can be missed). */
export function watchFile(file, onChange) {
  try {
    const watcher = fs.watch(file, { persistent: false }, () => onChange());
    watcher.on('error', () => {});
    return { close: () => watcher.close() };
  } catch {
    return { close() {} };
  }
}
