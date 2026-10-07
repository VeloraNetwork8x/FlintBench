import fs from 'node:fs/promises';
import path from 'node:path';

const locks = new Map();

/**
 * Serialises async work per key (usually a file path) inside this process.
 * Cross-process safety is provided by the instance lock in runtime/.
 */
export async function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  locks.set(key, chained);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(from, to) {
  // Windows: antivirus/indexers can briefly hold the destination open.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 8) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

/** write tmp → fsync → atomic rename. Caller must hold the file lock. */
export async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmp, file);
}

export async function readFileIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Removes leftover *.tmp files from an interrupted write. */
export async function cleanupTempFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cleanupTempFiles(full);
    if (entry.name.endsWith('.tmp')) await fs.rm(full, { force: true });
  }));
}
