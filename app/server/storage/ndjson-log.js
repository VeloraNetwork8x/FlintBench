import fs from 'node:fs/promises';
import path from 'node:path';
import { withLock, writeFileAtomic, readFileIfExists } from './atomic.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Append-only NDJSON history with retention.
 * `reduceKey` turns the log into "latest record per key" during reads and compaction
 * (used by the session journal, which appends a snapshot on every update).
 */
export class NdjsonLog {
  constructor(file, { maxLines = 5000, maxAgeDays = 180, reduceKey = null, timeField = 'at' } = {}) {
    this.file = file;
    this.maxLines = maxLines;
    this.maxAge = maxAgeDays * DAY;
    this.reduceKey = reduceKey;
    this.timeField = timeField;
    this.appendsSinceCompaction = 0;
  }

  async append(record) {
    await withLock(this.file, async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    });
    this.appendsSinceCompaction += 1;
    if (this.appendsSinceCompaction >= Math.max(200, this.maxLines / 5)) {
      this.appendsSinceCompaction = 0;
      this.compact().catch(() => {});
    }
  }

  async #readRaw() {
    const raw = await readFileIfExists(this.file);
    if (!raw) return [];
    const records = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // torn or partial line from an interrupted append: skip it
      }
    }
    return records;
  }

  #reduce(records) {
    if (!this.reduceKey) return records;
    const byKey = new Map();
    for (const record of records) {
      const key = record[this.reduceKey];
      if (key === undefined) continue;
      byKey.delete(key); // keep insertion order = latest update order
      byKey.set(key, record);
    }
    return [...byKey.values()];
  }

  /** @returns {Promise<object[]>} oldest first */
  async read({ since = 0, limit = 0 } = {}) {
    let records = this.#reduce(await this.#readRaw());
    if (since) records = records.filter((r) => (r[this.timeField] ?? 0) >= since);
    if (limit) records = records.slice(-limit);
    return records;
  }

  async compact() {
    await withLock(this.file, async () => {
      const cutoff = Date.now() - this.maxAge;
      let records = this.#reduce(await this.#readRaw());
      records = records.filter((r) => (r[this.timeField] ?? Date.now()) >= cutoff);
      if (records.length > this.maxLines) records = records.slice(-this.maxLines);
      if (records.length === 0) {
        await fs.rm(this.file, { force: true });
        return;
      }
      await writeFileAtomic(this.file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    });
  }
}
