import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonDocument } from './json-document.js';
import { NdjsonLog } from './ndjson-log.js';
import { cleanupTempFiles } from './atomic.js';
import { defaultSettings } from '../settings/defaults.js';

/**
 * Filesystem persistence behind store interfaces.
 * Nothing outside this folder knows file names or formats.
 */

export class AuthStore {
  constructor(dir) {
    this.doc = new JsonDocument(path.join(dir, 'auth.json'), { defaults: () => ({}) });
  }
  load() { return this.doc.load(); }
  exists() { return this.doc.persisted && Boolean(this.doc.value.passwordHash); }
  get() { return this.exists() ? this.doc.get() : null; }
  create({ username, passwordHash, pinHash }) {
    const now = new Date().toISOString();
    return this.doc.replace({ username, passwordHash, pinHash: pinHash ?? null, createdAt: now, updatedAt: now });
  }
  setPasswordHash(passwordHash) {
    return this.doc.update((d) => { d.passwordHash = passwordHash; d.updatedAt = new Date().toISOString(); });
  }
  setPinHash(pinHash) {
    return this.doc.update((d) => { d.pinHash = pinHash; d.updatedAt = new Date().toISOString(); });
  }
}

export class SettingsStore {
  constructor(dir) {
    this.doc = new JsonDocument(path.join(dir, 'settings.json'), { defaults: defaultSettings });
  }
  load() { return this.doc.load(); }
  get() { return this.doc.get(); }
  update(mutator) { return this.doc.update(mutator); }
}

export class ProjectStore {
  constructor(dir) {
    this.doc = new JsonDocument(path.join(dir, 'projects.json'), { defaults: () => ({ projects: [] }) });
    this.ignoredDoc = new JsonDocument(path.join(dir, 'ignored-projects.json'), { defaults: () => ({ paths: [] }) });
  }
  async load() { await this.doc.load(); await this.ignoredDoc.load(); }
  list() { return this.doc.get().projects; }
  get(id) { return this.list().find((p) => p.id === id) ?? null; }
  findByPath(key) { return this.list().find((p) => p.pathKey === key) ?? null; }
  async add(project) {
    await this.doc.update((d) => {
      if (!d.projects.some((p) => p.id === project.id)) d.projects.push(project);
    });
    return this.get(project.id);
  }
  async update(id, patch) {
    await this.doc.update((d) => {
      const p = d.projects.find((x) => x.id === id);
      if (p) Object.assign(p, patch);
    });
    return this.get(id);
  }
  async remove(id) {
    await this.doc.update((d) => { d.projects = d.projects.filter((p) => p.id !== id); });
  }
  ignored() { return this.ignoredDoc.get().paths; }
  isIgnored(key) { return this.ignored().some((p) => p.key === key); }
  async ignore(entry) {
    await this.ignoredDoc.update((d) => {
      if (!d.paths.some((p) => p.key === entry.key)) d.paths.push(entry);
    });
  }
  async unignore(key) {
    await this.ignoredDoc.update((d) => { d.paths = d.paths.filter((p) => p.key !== key); });
  }
}

/** Per-project metadata: config, work items, notes, session journal, activity log. */
export class ProjectDataStore {
  constructor(dir) {
    this.dir = dir;
    this.config = new JsonDocument(path.join(dir, 'config.json'), {
      defaults: () => ({ services: [], terminals: [], defaultServices: [] }),
    });
    this.work = new JsonDocument(path.join(dir, 'work.json'), { defaults: () => ({ items: [] }) });
    this.notes = new JsonDocument(path.join(dir, 'notes.json'), { defaults: () => ({ text: '', updatedAt: null }) });
    this.sessions = new NdjsonLog(path.join(dir, 'sessions.ndjson'), {
      reduceKey: 'id', maxLines: 1000, maxAgeDays: 365, timeField: 'startedAt',
    });
    this.activity = new NdjsonLog(path.join(dir, 'activity.ndjson'), { maxLines: 5000, maxAgeDays: 180 });
  }
  async load() {
    await Promise.all([this.config.load(), this.work.load(), this.notes.load()]);
    return this;
  }
}

export class RuntimeStore {
  constructor(dir) {
    this.dir = path.join(dir, 'runtime');
    this.sessions = new JsonDocument(path.join(this.dir, 'sessions.json'), { defaults: () => ({ sessions: [] }) });
    this.lockFile = path.join(this.dir, 'instance.lock');
  }
  async load() { await this.sessions.load(); }

  /** Single-writer guarantee for the data directory. */
  async acquireInstanceLock() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const pid = Number(await fs.readFile(this.lockFile, 'utf8'));
      if (pid && pid !== process.pid && isAlive(pid)) {
        throw new Error(`Another FlintBench instance (pid ${pid}) is using this data directory.`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.writeFile(this.lockFile, String(process.pid), { mode: 0o600 });
  }
  async releaseInstanceLock() {
    await fs.rm(this.lockFile, { force: true });
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function createStorage(dataDir) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await cleanupTempFiles(dataDir);
  const storage = {
    dataDir,
    auth: new AuthStore(dataDir),
    settings: new SettingsStore(dataDir),
    projects: new ProjectStore(dataDir),
    runtime: new RuntimeStore(dataDir),
    projectData: new Map(),
    /** @returns {Promise<ProjectDataStore>} */
    async project(id) {
      if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('Invalid project id');
      let store = this.projectData.get(id);
      if (!store) {
        store = new ProjectDataStore(path.join(dataDir, 'projects', id));
        this.projectData.set(id, store);
        await store.load();
      }
      return store;
    },
    /** Removes FlintBench metadata for a project. Never touches the repository. */
    async removeProjectData(id) {
      if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('Invalid project id');
      this.projectData.delete(id);
      await fs.rm(path.join(dataDir, 'projects', id), { recursive: true, force: true });
    },
  };
  await Promise.all([storage.auth.load(), storage.settings.load(), storage.projects.load()]);
  await storage.runtime.acquireInstanceLock();
  await storage.runtime.load();
  return storage;
}
