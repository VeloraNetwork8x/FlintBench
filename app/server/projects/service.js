import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectProject } from './detector.js';
import { IGNORED_DIRS } from '../host/fs-watch.js';
import { httpError } from '../host/paths.js';

// how often an existing project's fingerprint is read again (it only matters once it goes missing)
const FINGERPRINT_TTL = 6 * 60 * 60_000;

function slug(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

/**
 * Project registry + discovery + live state.
 * Live state is assembled from domain monitors (git, runtime, docker, agents) via patch().
 * Emits: 'state' (summary) on coalesced change, 'added' (project), 'removed' (id),
 *        'candidates' (list), 'file' ({projectId, kind, path}).
 */
export class ProjectService extends EventEmitter {
  constructor({ storage, host, bus, settings, dataDir = null, log = console }) {
    super();
    this.setMaxListeners(50);
    this.storage = storage;
    this.host = host;
    this.bus = bus;
    this.settings = settings;
    this.dataDir = dataDir;
    this.log = log;
    this.live = new Map(); // id -> live state
    this.watchers = new Map(); // id -> watcher
    this.rootWatchers = new Map(); // rootKey -> watcher
    this.candidates = new Map(); // pathKey -> candidate
    this.fpCache = new Map(); // pathKey -> { fp, at }: folders compared with a missing project
    this.pendingEmit = new Map();
    this.scanning = null;
    this.rescanTimer = null;
  }

  async init() {
    for (const p of this.storage.projects.list()) await this.#activate(p);
    this.settings.on('changed', (_s, patch) => {
      if (patch.roots || 'scanDepth' in patch) {
        this.#syncRootWatchers();
        this.scheduleRescan(200);
      }
    });
    this.#syncRootWatchers();
    await this.scan();
    this.reconcileTimer = setInterval(() => this.scan().catch(() => {}), 5 * 60_000);
    this.reconcileTimer.unref();
  }

  stop() {
    clearInterval(this.reconcileTimer);
    clearTimeout(this.rescanTimer);
    for (const w of this.watchers.values()) w.close();
    for (const w of this.rootWatchers.values()) w.close();
  }

  /* ---------------- registry ---------------- */

  list() {
    return [...this.live.values()].map((s) => this.summary(s.id));
  }

  get(id) {
    const s = this.live.get(id);
    if (!s) throw httpError(404, 'Project not found');
    return s;
  }

  has(id) {
    return this.live.has(id);
  }

  summary(id) {
    const s = this.live.get(id);
    if (!s) return null;
    const { gitFiles, fingerprint, relocationDismissed, ...rest } = s;
    return structuredClone(rest);
  }

  /** Domain monitors write their slice of live state here. */
  patch(id, key, value) {
    const s = this.live.get(id);
    if (!s) return;
    s[key] = value;
    this.#derive(s);
    this.#scheduleEmit(id);
  }

  touchActivity(id, field, at = Date.now()) {
    const s = this.live.get(id);
    if (!s) return;
    s.activity[field] = Math.max(s.activity[field] ?? 0, at);
    // opening a project in FlintBench is not development activity
    if (field !== 'lastOpenedAt') s.activity.lastActivityAt = Math.max(s.activity.lastActivityAt ?? 0, at);
    this.#scheduleEmit(id);
  }

  #derive(s) {
    const runningServices = s.runtime.services.filter((x) => x.status === 'running').length;
    const runningContainers = s.docker.containers.filter((c) => c.state === 'running').length;
    const externalWithPorts = s.runtime.processes.filter((p) => p.ports.length).length;
    s.running = runningServices + runningContainers + externalWithPorts > 0;
    s.status = !s.exists ? 'missing' : s.running ? 'running' : 'stopped';
    s.needsAttention = s.attention.some((a) => a.severity !== 'info');
  }

  // changes in a burst (agents writing files, a build) reach the page as one update per window
  #scheduleEmit(id) {
    if (this.pendingEmit.has(id)) return;
    this.pendingEmit.set(id, setTimeout(() => {
      this.pendingEmit.delete(id);
      const summary = this.summary(id);
      if (summary) this.emit('state', summary);
    }, 450));
  }

  async #activate(project) {
    const exists = await this.host.paths.isDirectory(project.path);
    const data = await this.storage.project(project.id);
    const lastEvents = await data.activity.read({ limit: 50 });
    const lastActivityAt = lastEvents
      // opening FlintBench or an editor window is not work on the project
      .filter((e) => !['project.opened', 'project.added', 'editor.opened', 'editor.closed'].includes(e.type))
      .reduce((m, e) => Math.max(m, e.type === 'file.activity' ? e.data.bucketStart : e.at), 0) || null;
    const lastOpened = [...lastEvents].reverse().find((e) => e.type === 'project.opened')?.at ?? null;
    const state = {
      ...project,
      exists,
      running: false,
      status: exists ? 'stopped' : 'missing',
      needsAttention: false,
      git: null,
      gitFiles: [],
      activity: { lastActivityAt, lastFileChangeAt: null, lastOpenedAt: lastOpened, lastCommitAt: null },
      runtime: { services: [], processes: [], ports: [] },
      docker: { containers: [], composeFiles: project.composeFiles ?? [] },
      agents: { active: [], last: null },
      editors: [], // editors with this project open (VS Code), from window titles
      terminals: 0,
      work: { inProgress: null, open: 0 },
      attention: [],
      relocation: null, // { path, name, reason } when a missing folder seems to have moved there
    };
    this.live.set(project.id, state);
    if (exists) {
      this.#watch(project);
      this.#refreshFingerprint(state).catch(() => {});
    }
    this.emit('added', state);
    this.#scheduleEmit(project.id);
  }

  #watch(project) {
    this.watchers.get(project.id)?.close();
    // FlintBench's own data folder may live inside a watched project (FlintBench itself): its writes
    // (activity logs, sessions, settings) are FlintBench bookkeeping, not development on the project
    const own = this.dataDir && this.host.paths.isInside(project.path, this.dataDir)
      ? path.relative(project.path, this.dataDir).split(path.sep).join('/')
      : null;
    const watcher = this.host.watch.project(project.path, (event) => {
      if (own && event.path && (event.path === own || event.path.startsWith(`${own}/`))) return;
      if (event.kind === 'file') {
        this.touchActivity(project.id, 'lastFileChangeAt');
        this.bus.emit('file.changed', project.id, { path: event.path });
      }
      this.emit('file', { projectId: project.id, ...event });
    }, { log: this.log });
    this.watchers.set(project.id, watcher);
  }

  async add(inputPath, { source = 'manual', failIfExists = false } = {}) {
    const dir = this.host.paths.normalizePath(inputPath);
    if (!(await this.host.paths.isDirectory(dir))) throw httpError(400, 'Folder does not exist');
    const key = this.host.paths.pathKey(dir);
    const existing = this.storage.projects.findByPath(key);
    if (existing) {
      if (failIfExists) throw httpError(409, `${existing.name} is already in FlintBench`);
      return this.summary(existing.id);
    }
    const detected = (await detectProject(dir)) ?? { name: path.basename(dir), stack: [], indicators: [], composeFiles: [] };
    const id = `${slug(detected.name)}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
    const project = {
      id,
      name: detected.name,
      path: dir,
      pathKey: key,
      stack: detected.stack,
      composeFiles: detected.composeFiles,
      source,
      addedAt: Date.now(),
    };
    await this.storage.projects.add(project);
    if (this.storage.projects.isIgnored(key)) await this.storage.projects.unignore(key);
    this.candidates.delete(key);
    this.emit('candidates', this.listCandidates());
    await this.#activate(project);
    this.bus.emit('project.added', id, { path: dir, source });
    return this.summary(id);
  }

  /** Removes FlintBench metadata only. The repository on disk is never touched. */
  async remove(id) {
    const s = this.get(id);
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.live.delete(id);
    await this.storage.projects.remove(id);
    await this.storage.removeProjectData(id);
    this.emit('removed', id);
    this.bus.emit('project.removed', id, { path: s.path });
    this.scheduleRescan(500);
  }

  async rename(id, name) {
    const n = String(name ?? '').trim();
    if (!n || n.length > 80) throw httpError(400, 'Name must be 1–80 characters');
    await this.storage.projects.update(id, { name: n });
    this.get(id).name = n;
    this.#scheduleEmit(id);
  }

  async refreshDetection(id) {
    const s = this.get(id);
    const detected = await detectProject(s.path);
    if (!detected) return;
    const patch = { stack: detected.stack, composeFiles: detected.composeFiles };
    await this.storage.projects.update(id, patch);
    Object.assign(s, patch);
    s.docker.composeFiles = detected.composeFiles;
    this.#scheduleEmit(id);
  }

  /* ---------------- discovery ---------------- */

  listCandidates() {
    return [...this.candidates.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  scheduleRescan(delay = 1500) {
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => this.scan().catch((e) => this.log.warn(`[discovery] ${e.message}`)), delay);
    this.rescanTimer.unref?.();
  }

  #syncRootWatchers() {
    const { roots, scanDepth } = this.settings.get();
    const keys = new Set(roots.map((r) => this.host.paths.pathKey(r)));
    for (const [key, w] of this.rootWatchers) {
      if (!keys.has(key)) {
        w.close();
        this.rootWatchers.delete(key);
      }
    }
    for (const root of roots) {
      const key = this.host.paths.pathKey(root);
      this.rootWatchers.get(key)?.close();
      this.rootWatchers.set(key, this.host.watch.root(root, scanDepth, () => this.scheduleRescan(), { log: this.log }));
    }
  }

  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.#scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async #scan() {
    const { roots, scanDepth, autoAddGitRepos } = this.settings.get();
    const found = new Map();
    for (const root of roots) {
      await this.#walk(root, 0, scanDepth, found);
    }
    // missing / restored registered projects
    for (const s of this.live.values()) {
      const exists = await this.host.paths.isDirectory(s.path);
      if (exists !== s.exists) {
        s.exists = exists;
        if (exists) {
          this.#watch(s);
          s.relocation = null;
        } else {
          this.watchers.get(s.id)?.close();
          this.watchers.delete(s.id);
        }
        this.#derive(s);
        this.#scheduleEmit(s.id);
      }
      if (exists && Date.now() - (s.fingerprint?.at ?? 0) > FINGERPRINT_TTL) await this.#refreshFingerprint(s).catch(() => {});
    }
    // a missing folder that turns up elsewhere (moved or renamed) is offered, never auto-added
    const relocating = await this.#findRelocations(found);
    const previous = this.candidates;
    const next = new Map();
    for (const [key, detected] of found) {
      if (this.storage.projects.findByPath(key) || this.storage.projects.isIgnored(key) || relocating.has(key)) continue;
      if (autoAddGitRepos && detected.hasGit) {
        await this.add(detected.path, { source: 'auto' }).catch((e) => this.log.warn(`[discovery] auto-add failed: ${e.message}`));
        continue;
      }
      const candidate = { ...detected, key, firstSeenAt: previous.get(key)?.firstSeenAt ?? Date.now() };
      next.set(key, candidate);
      if (!previous.has(key)) this.bus.emit('project.discovered', null, { path: detected.path, name: detected.name, stack: detected.stack });
    }
    this.candidates = next;
    this.lastScanAt = Date.now();
    this.emit('candidates', this.listCandidates());
    return this.listCandidates();
  }

  async #walk(dir, depth, maxDepth, found) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((e) => e.name);
    const detected = await detectProject(dir, names);
    if (detected) {
      found.set(this.host.paths.pathKey(dir), detected);
      return; // do not descend into a project
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('$') || IGNORED_DIRS.has(entry.name)) continue;
      await this.#walk(path.join(dir, entry.name), depth + 1, maxDepth, found);
    }
  }

  /* ---------------- moved or renamed folders ---------------- */

  /**
   * What identifies a project folder wherever it is: the folder's own file-system identity (kept
   * when it is renamed or moved on the same disk), its git history (first commits, only when the
   * folder is the repository itself), its top-level files (size and modification time, kept by a
   * move or a copy), its package name and its top-level entries.
   */
  async #fingerprintOf(dir) {
    let names;
    let st;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
      st = await fs.stat(dir, { bigint: true });
    } catch { return null; }
    const has = (n) => names.some((e) => e.name === n);
    const roots = has('.git') ? await this.host.git.rootCommits(dir).catch(() => []) : [];
    let pkg = null;
    if (has('package.json')) {
      try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).name ?? null; } catch { /* unreadable */ }
    }
    const files = {};
    for (const e of names.filter((x) => x.isFile()).slice(0, 40)) {
      const f = await fs.stat(path.join(dir, e.name)).catch(() => null);
      if (f) files[e.name] = `${f.size}:${Math.round(f.mtimeMs)}`;
    }
    const entries = names.map((e) => e.name).filter((n) => n !== '.git' && !IGNORED_DIRS.has(n)).sort().slice(0, 120);
    // ino 0 means the file system gives no stable identity: not used
    return { ino: st.ino ? String(st.ino) : null, dev: String(st.dev), roots, pkg: typeof pkg === 'string' ? pkg : null, files, entries, at: Date.now() };
  }

  async #refreshFingerprint(s) {
    const fp = await this.#fingerprintOf(s.path);
    if (!fp) return;
    s.fingerprint = fp;
    await this.storage.projects.update(s.id, { fingerprint: fp });
  }

  /** Why `cand` is probably the same project as `fp` (strongest reason first), or null. */
  static sameProject(fp, cand) {
    if (!fp || !cand) return null;
    if (fp.ino && fp.ino === cand.ino && fp.dev === cand.dev) return 'same folder';
    if (fp.roots?.length && cand.roots?.length) return cand.roots.some((r) => fp.roots.includes(r)) ? 'same git history' : null;
    // the same top-level files, byte for byte in size and to the millisecond in modification time
    const mine = Object.entries(fp.files ?? {});
    const same = mine.filter(([n, sig]) => cand.files?.[n] === sig).length;
    if (mine.length && same >= Math.min(2, mine.length) && same / mine.length >= 0.5) return 'same files';
    if (fp.pkg && fp.pkg === cand.pkg) return 'same package name';
    const a = new Set(fp.entries ?? []);
    const b = new Set(cand.entries ?? []);
    const common = [...a].filter((x) => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return common >= 3 && common / union >= 0.75 ? 'similar contents' : null;
  }

  /**
   * For every missing project with a fingerprint, look for its folder next to where it was (a
   * rename in place) and among the folders found under the scan roots. The best match is offered
   * to the owner (project.relocation, plus one notification per new place); nothing moves until
   * they confirm. Returns the path keys offered, so discovery does not list them as new projects.
   */
  async #findRelocations(found) {
    const offered = new Set();
    const missing = [...this.live.values()].filter((s) => !s.exists && s.fingerprint);
    if (!missing.length) return offered;
    // other folders' fingerprints, kept a few minutes: a project that stays missing (deleted)
    // must not make every scan read every folder again
    const fpOf = async (key, dir) => {
      const hit = this.fpCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit.fp;
      const fp = await this.#fingerprintOf(dir);
      this.fpCache.set(key, { fp, at: Date.now() });
      return fp;
    };
    const free = (key) => !this.storage.projects.findByPath(key) && !this.storage.projects.isIgnored(key);
    const rank = { 'same folder': 5, 'same git history': 4, 'same files': 3, 'same package name': 2, 'similar contents': 1 };
    for (const s of missing) {
      const dismissed = new Set(s.relocationDismissed ?? []);
      const places = new Map(); // key -> path; siblings first: a rename in place is the likeliest
      try {
        const parent = path.dirname(s.path);
        for (const e of await fs.readdir(parent, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.')) places.set(this.host.paths.pathKey(path.join(parent, e.name)), path.join(parent, e.name));
        }
      } catch { /* the parent is gone too */ }
      for (const [key, d] of found) if (!places.has(key)) places.set(key, d.path);
      let best = null;
      // first the cheap, certain check: the same folder under another name or place
      if (s.fingerprint.ino) {
        for (const [key, dir] of places) {
          if (!free(key) || dismissed.has(key)) continue;
          const st = await fs.stat(dir, { bigint: true }).catch(() => null);
          if (st && String(st.ino) === s.fingerprint.ino && String(st.dev) === s.fingerprint.dev) {
            best = { path: dir, key, name: path.basename(dir), reason: 'same folder' };
            break;
          }
        }
      }
      for (const [key, dir] of best ? [] : places) {
        if (!free(key) || dismissed.has(key)) continue;
        const reason = ProjectService.sameProject(s.fingerprint, await fpOf(key, dir));
        if (reason && (!best || rank[reason] > rank[best.reason])) best = { path: dir, key, name: path.basename(dir), reason };
        if (best?.reason === 'same folder') break;
      }
      const before = s.relocation?.path ?? null;
      // renamed: same parent folder, another name; moved: somewhere else
      const kind = best && this.host.paths.pathKey(path.dirname(best.path)) === this.host.paths.pathKey(path.dirname(s.path)) ? 'renamed' : 'moved';
      s.relocation = best ? { path: best.path, name: best.name, reason: best.reason, kind } : null;
      if (best) {
        offered.add(best.key);
        if (best.path !== before) this.bus.emit('project.relocation_found', s.id, { name: s.name, from: s.path, to: best.path, newName: best.name, reason: best.reason, kind });
      }
      if ((s.relocation?.path ?? null) !== before) this.#scheduleEmit(s.id);
    }
    return offered;
  }

  /** Points a project at its new folder. History, notes, sessions and settings stay with it. */
  async relocate(id, inputPath) {
    const s = this.get(id);
    if (typeof inputPath !== 'string' || !inputPath.trim()) throw httpError(400, 'Choose the folder');
    const dir = this.host.paths.normalizePath(inputPath);
    if (!(await this.host.paths.isDirectory(dir))) throw httpError(400, 'Folder does not exist');
    const key = this.host.paths.pathKey(dir);
    const other = this.storage.projects.findByPath(key);
    if (other && other.id !== id) throw httpError(409, `That folder is already the project ${other.name}`);
    const from = s.path;
    // a name that was only the folder's name follows the folder; a name given by hand stays
    const rename = s.name === path.basename(from) ? { name: path.basename(dir) } : {};
    const record = await this.storage.projects.update(id, { path: dir, pathKey: key, ...rename, relocatedFrom: from, relocatedAt: Date.now(), relocationDismissed: [] });
    if (this.storage.projects.isIgnored(key)) await this.storage.projects.unignore(key);
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.live.delete(id);
    this.candidates.delete(key);
    await this.#activate(record);
    await this.refreshDetection(id).catch(() => {});
    this.bus.emit('project.relocated', id, { from, to: dir });
    this.emit('candidates', this.listCandidates());
    return this.summary(id);
  }

  /** "Not this one": the suggested folder is not offered again for this project. */
  async dismissRelocation(id, inputPath) {
    const s = this.get(id);
    const target = typeof inputPath === 'string' && inputPath ? inputPath : s.relocation?.path;
    if (!target) return this.summary(id);
    const key = this.host.paths.pathKey(this.host.paths.normalizePath(target));
    s.relocationDismissed = [...new Set([...(s.relocationDismissed ?? []), key])].slice(-20);
    await this.storage.projects.update(id, { relocationDismissed: s.relocationDismissed });
    s.relocation = null;
    this.#scheduleEmit(id);
    this.scheduleRescan(300);
    return this.summary(id);
  }

  async ignore(inputPath) {
    const dir = this.host.paths.normalizePath(inputPath);
    const key = this.host.paths.pathKey(dir);
    await this.storage.projects.ignore({ key, path: dir, at: Date.now() });
    this.candidates.delete(key);
    this.emit('candidates', this.listCandidates());
  }

  async unignore(inputPath) {
    await this.storage.projects.unignore(this.host.paths.pathKey(this.host.paths.normalizePath(inputPath)));
    this.scheduleRescan(100);
  }

  ignored() {
    return this.storage.projects.ignored();
  }

  async markOpened(id) {
    this.get(id);
    this.touchActivity(id, 'lastOpenedAt');
    this.bus.emit('project.opened', id, {});
  }
}
