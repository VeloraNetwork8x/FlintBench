import fs from 'node:fs/promises';
import { withLock, writeFileAtomic, readFileIfExists } from './atomic.js';

/**
 * One JSON file, cached in memory, written atomically.
 * FlintBench is the single writer of its data directory, so the cache is authoritative.
 */
export class JsonDocument {
  constructor(file, { defaults, version = 1, log = console } = {}) {
    this.file = file;
    this.version = version;
    this.defaults = defaults ?? (() => ({}));
    this.log = log;
    this.value = null;
    this.persisted = false;
  }

  async load() {
    const raw = await readFileIfExists(this.file);
    if (raw === null) {
      this.value = { version: this.version, ...this.defaults() };
      this.persisted = false;
      return this;
    }
    try {
      const parsed = JSON.parse(raw);
      this.value = { version: this.version, ...this.defaults(), ...parsed };
      this.persisted = true;
    } catch (error) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      this.log.warn(`[storage] ${this.file} is not valid JSON (${error.message}); moved to ${aside}`);
      await fs.rename(this.file, aside).catch(() => {});
      this.value = { version: this.version, ...this.defaults() };
      this.persisted = false;
    }
    return this;
  }

  get() {
    return structuredClone(this.value);
  }

  /** mutator receives a draft; it may mutate it or return a replacement. */
  async update(mutator) {
    return withLock(this.file, async () => {
      const draft = structuredClone(this.value);
      const result = await mutator(draft);
      const next = result === undefined ? draft : result;
      next.version = this.version;
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.value = next;
      this.persisted = true;
      return structuredClone(next);
    });
  }

  async replace(value) {
    return this.update(() => value);
  }

  async remove() {
    return withLock(this.file, async () => {
      await fs.rm(this.file, { force: true });
      this.value = { version: this.version, ...this.defaults() };
      this.persisted = false;
    });
  }
}
