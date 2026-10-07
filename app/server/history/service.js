import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { IGNORED_DIRS } from '../host/fs-watch.js';
import { lineCounts, unifiedDiff } from './diff.js';

/**
 * File history: FlintBench's own record of how each text file of a project changed, so lines
 * added/removed and the changes themselves are known with or without git.
 *
 * - Every text file saved in the project (seen by the file watcher, 0.8 s after the last write) is
 *   compared with the last version FlintBench kept of it; a real change is logged
 *   ({ at, path, from, to, added, removed }) and the new version kept (gzip, by content hash, so
 *   identical versions are stored once).
 * - The first version of a file: in a git repository it is the committed one (HEAD), read only
 *   when needed — git makes this cheap. Without git FlintBench reads the project once (text
 *   files up to 512 KB, at most 4000 files / 64 MB, dependency and build folders skipped).
 * - When FlintBench starts it compares the files it knows with the disk again: changes made while
 *   it was closed are logged too, at the file's modification time.
 * Stored in the project's data folder (history/), never in the project.
 */

const TEXT_LIMIT = 512 * 1024;
const SNAPSHOT_FILES = 4000;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SETTLE_MS = 800;
const KEEP_DAYS = 30;

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex');

async function readText(file) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return { kind: 'dir' };
    if (st.size > TEXT_LIMIT) return { kind: 'binary', st };
    const buf = await fs.readFile(file);
    if (buf.includes(0)) return { kind: 'binary', st };
    return { kind: 'text', text: buf.toString('utf8'), st };
  } catch (error) {
    return { kind: error.code === 'ENOENT' ? 'gone' : 'error' };
  }
}

export class FileHistoryService {
  constructor({ projects, storage, host, bus, dataDir = null, log = console }) {
    this.projects = projects;
    this.storage = storage;
    this.host = host;
    this.bus = bus;
    this.dataDir = dataDir;
    this.log = log;
    this.states = new Map(); // id -> { dir, index, ready, timers, saveTimer }
  }

  init() {
    this.projects.on('added', (s) => this.#open(s).catch((e) => this.log.warn(`[history] ${e.message}`)));
    this.projects.on('removed', (id) => this.#close(id));
    this.projects.on('file', (ev) => { if (ev.kind === 'file' && ev.path) this.#schedule(ev.projectId, ev.path); });
    let i = 0;
    for (const s of this.projects.live.values()) {
      setTimeout(() => this.#open(s).catch((e) => this.log.warn(`[history] ${e.message}`)), 3000 + (i++) * 1500).unref?.();
    }
  }

  stop() {
    for (const st of this.states.values()) {
      for (const t of st.timers.values()) clearTimeout(t);
      clearTimeout(st.saveTimer);
    }
  }

  #close(id) {
    const st = this.states.get(id);
    if (!st) return;
    for (const t of st.timers.values()) clearTimeout(t);
    clearTimeout(st.saveTimer);
    this.states.delete(id);
  }

  /* ---------------- storage ---------------- */

  async #state(id) {
    if (this.states.has(id)) return this.states.get(id);
    const data = await this.storage.project(id);
    const dir = path.join(data.dir, 'history');
    const st = { id, dir, index: {}, since: null, complete: false, timers: new Map(), saveTimer: null, ready: null, chain: Promise.resolve() };
    this.states.set(id, st);
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
      st.index = raw.files ?? {};
      st.since = raw.since ?? null;
      st.complete = Boolean(raw.complete);
    } catch { /* first time */ }
    return st;
  }

  #saveSoon(st) {
    clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(async () => {
      await fs.mkdir(st.dir, { recursive: true });
      const tmp = path.join(st.dir, `index.json.${process.pid}.tmp`);
      await fs.writeFile(tmp, JSON.stringify({ version: 1, since: st.since, complete: st.complete, files: st.index }));
      await fs.rename(tmp, path.join(st.dir, 'index.json'));
    }, 1500);
    st.saveTimer.unref?.();
  }

  async #putBlob(st, text) {
    const id = sha(text);
    const file = path.join(st.dir, 'blobs', id.slice(0, 2), `${id}.gz`);
    try { await fs.access(file); } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, zlib.gzipSync(text));
    }
    return id;
  }

  async #blob(st, id) {
    if (!id) return null;
    try { return zlib.gunzipSync(await fs.readFile(path.join(st.dir, 'blobs', id.slice(0, 2), `${id}.gz`))).toString('utf8'); } catch { return null; }
  }

  async #log(st, change) {
    await fs.mkdir(st.dir, { recursive: true });
    await fs.appendFile(path.join(st.dir, 'changes.ndjson'), `${JSON.stringify(change)}\n`);
  }

  async #changes(st, since = 0) {
    let raw = '';
    try { raw = await fs.readFile(path.join(st.dir, 'changes.ndjson'), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const c = JSON.parse(line); if (c.at >= since) out.push(c); } catch { /* torn line */ }
    }
    return out;
  }

  /* ---------------- first look and reconciliation ---------------- */

  /** The project's own data folder (FlintBench inside itself) is never part of its history. */
  #ownPrefix(s) {
    if (!this.dataDir || !this.host.paths.isInside(s.path, this.dataDir)) return null;
    return path.relative(s.path, this.dataDir).split(path.sep).join('/');
  }

  async #open(s) {
    if (!s.exists) return;
    const st = await this.#state(s.id);
    if (st.ready) return st.ready;
    st.ready = (async () => {
      const isRepo = await this.host.git.isRepo(s.path).catch(() => false);
      const own = this.#ownPrefix(s);
      if (!st.since) st.since = Date.now();
      // without git the first versions come from one read of the project; with git, from HEAD
      if (!isRepo && !st.complete) {
        await this.#snapshot(st, s.path, own);
        this.#saveSoon(st);
        return;
      }
      // files known before: what changed while FlintBench was closed
      for (const rel of Object.keys(st.index)) await this.#record(s.id, rel, { quiet: true });
      await this.#prune(st);
    })();
    return st.ready;
  }

  async #snapshot(st, root, own) {
    let files = 0;
    let bytes = 0;
    let complete = true;
    const walk = async (dir, rel) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!complete) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (own && (r === own || r.startsWith(`${own}/`))) continue;
        if (e.isDirectory()) {
          if (e.name === '.git' || IGNORED_DIRS.has(e.name)) continue;
          await walk(path.join(dir, e.name), r);
        } else if (e.isFile()) {
          const f = await readText(path.join(dir, e.name));
          if (f.kind !== 'text') continue;
          files += 1;
          bytes += f.text.length;
          if (files > SNAPSHOT_FILES || bytes > SNAPSHOT_BYTES) { complete = false; return; }
          if (st.index[r]) continue;
          st.index[r] = { sha: await this.#putBlob(st, f.text), size: f.st.size, mtime: Math.round(f.st.mtimeMs) };
        }
      }
    };
    await walk(root, '');
    st.complete = complete;
  }

  /** Changes older than KEEP_DAYS leave the log; versions nothing points to any more are deleted. */
  async #prune(st) {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    const all = await this.#changes(st, 0);
    const keep = all.filter((c) => c.at >= cutoff);
    if (keep.length === all.length) return;
    await fs.writeFile(path.join(st.dir, 'changes.ndjson'), keep.map((c) => JSON.stringify(c)).join('\n') + (keep.length ? '\n' : ''));
    const used = new Set([...keep.flatMap((c) => [c.from, c.to]), ...Object.values(st.index).map((x) => x.sha)].filter(Boolean));
    for (const d of await fs.readdir(path.join(st.dir, 'blobs')).catch(() => [])) {
      for (const f of await fs.readdir(path.join(st.dir, 'blobs', d)).catch(() => [])) {
        if (!used.has(f.replace(/\.gz$/, ''))) await fs.rm(path.join(st.dir, 'blobs', d, f), { force: true });
      }
    }
  }

  /* ---------------- recording ---------------- */

  #schedule(id, rel) {
    const s = this.projects.live.get(id);
    if (!s?.exists) return;
    const own = this.#ownPrefix(s);
    if (own && (rel === own || rel.startsWith(`${own}/`))) return;
    this.#state(id).then((st) => {
      clearTimeout(st.timers.get(rel));
      st.timers.set(rel, setTimeout(() => {
        st.timers.delete(rel);
        this.#record(id, rel).catch((e) => this.log.warn(`[history] ${rel}: ${e.message}`));
      }, SETTLE_MS));
    });
  }

  /** The committed version of a file, as the first version of a git project's file. */
  async #headText(s, rel) {
    if (!s.git?.isRepo) return null;
    const text = await this.host.git.showHead(s.path, rel).catch(() => null);
    return text !== null && !text.includes('\0') && text.length <= TEXT_LIMIT ? text : null;
  }

  async #record(id, rel, { quiet = false } = {}) {
    const s = this.projects.live.get(id);
    if (!s?.exists) return;
    const st = await this.#state(id);
    // one file at a time per project: two saves of the same file must not interleave
    st.chain = st.chain.then(async () => {
      const f = await readText(path.join(s.path, rel));
      const known = st.index[rel] ?? null;
      if (f.kind === 'dir' || f.kind === 'error') return;
      if (quiet && known && f.st && f.st.size === known.size && Math.round(f.st.mtimeMs) === known.mtime) return;
      let change = null;
      if (f.kind === 'gone') {
        if (!known) return;
        const old = await this.#blob(st, known.sha);
        change = { path: rel, from: known.sha, to: null, added: 0, removed: old === null ? null : lineCounts(old, '').removed };
        delete st.index[rel];
      } else if (f.kind === 'binary') {
        if (known?.binary && known.size === f.st.size && known.mtime === Math.round(f.st.mtimeMs)) return;
        change = { path: rel, from: null, to: null, added: null, removed: null, binary: true };
        st.index[rel] = { binary: true, size: f.st.size, mtime: Math.round(f.st.mtimeMs) };
      } else {
        const to = sha(f.text);
        let fromSha = known?.binary ? null : known?.sha ?? null;
        let old = fromSha ? await this.#blob(st, fromSha) : null;
        if (!known && !st.complete) {
          // first time this file is seen changing: its committed version, when there is one
          old = await this.#headText(s, rel);
          fromSha = old === null ? null : await this.#putBlob(st, old);
        }
        st.index[rel] = { sha: to, size: f.st.size, mtime: Math.round(f.st.mtimeMs) };
        if (fromSha === to) { this.#saveSoon(st); return; }
        await this.#putBlob(st, f.text);
        const counts = lineCounts(old, f.text);
        change = { path: rel, from: fromSha, to, ...counts, ...(!fromSha && !known && !st.complete && !s.git?.isRepo ? { unknownBase: true } : {}) };
      }
      change.at = quiet && f.st ? Math.round(f.st.mtimeMs) : Date.now();
      await this.#log(st, change);
      this.#saveSoon(st);
      this.bus.emit('file.recorded', id, { path: rel, added: change.added, removed: change.removed });
    }).catch((e) => this.log.warn(`[history] ${rel}: ${e.message}`));
    return st.chain;
  }

  /* ---------------- reading ---------------- */

  /**
   * Files changed since `since`, one row per file: how it changed over the whole window (first
   * version seen in it → latest), with lines added and removed between those two, how many
   * times it was saved with a change, and when last.
   */
  async files(id, { since }) {
    const s = this.projects.get(id);
    await this.#open(s);
    const st = await this.#state(id);
    const rows = new Map();
    for (const c of await this.#changes(st, since)) {
      const r = rows.get(c.path) ?? { path: c.path, first: c, last: c, saves: 0 };
      r.last = c;
      r.saves += 1;
      rows.set(c.path, r);
    }
    const out = [];
    for (const r of rows.values()) {
      const from = r.first.from;
      const to = r.last.to;
      // created and deleted inside the window (temporary files): nothing changed
      if (!from && !to && !r.first.binary && !r.first.unknownBase) continue;
      let added = null;
      let removed = null;
      if (!r.first.binary && !r.last.binary && !r.first.unknownBase) {
        const counts = lineCounts(await this.#blob(st, from), await this.#blob(st, to));
        added = counts.added;
        removed = counts.removed;
      }
      out.push({
        path: r.path,
        at: r.last.at,
        saves: r.saves,
        status: r.last.binary ? 'binary' : !to ? 'deleted' : !from && !r.first.unknownBase ? 'new' : 'edited',
        added,
        removed,
      });
    }
    return { since: st.since, complete: st.complete, files: out.sort((a, b) => b.at - a.at) };
  }

  /** The file's changes over the window as a unified diff (first version seen in it → latest). */
  async diff(id, rel, { since }) {
    const st = await this.#state(id);
    const changes = (await this.#changes(st, since)).filter((c) => c.path === rel);
    if (!changes.length) return '';
    const first = changes[0];
    const last = changes.at(-1);
    if (first.binary || last.binary) return 'Binary file: its changes cannot be shown as text.';
    return unifiedDiff(await this.#blob(st, first.from), await this.#blob(st, last.to), rel);
  }
}
