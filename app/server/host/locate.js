import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a file dropped into the browser really lives. The page only knows its name, size and
 * modification time; FlintBench runs on the same machine, so it looks for a file that matches all
 * three: first among what File Explorer has selected (a dragged file is selected) and the folders
 * its windows show, then in the usual places (Desktop, Downloads, …) and the project folder.
 */

// FAT and some network shares keep times to 2 s
const MTIME_TOLERANCE_MS = 2000;

/** The usual folders a file is dragged from, those that exist. */
export async function commonFolders() {
  const home = os.homedir();
  const names = ['Desktop', 'Downloads', 'Documents', 'Pictures', path.join('Pictures', 'Screenshots'), 'Videos', 'Music'];
  const bases = [home];
  // OneDrive moves Desktop / Documents / Pictures under itself
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) if (process.env[key]) bases.push(process.env[key]);
  const out = bases.flatMap((b) => names.map((n) => path.join(b, n)));
  if (process.env.PUBLIC) out.push(path.join(process.env.PUBLIC, 'Desktop'));
  const unique = [...new Map(out.map((d) => [d.toLowerCase(), d])).values()];
  const exists = await Promise.all(unique.map((d) => fs.stat(d).then((s) => s.isDirectory(), () => false)));
  return unique.filter((_, i) => exists[i]);
}

/** True when the file at p is the one the page described. */
export async function matches(p, { name, size, lastModified }) {
  if (path.basename(p).toLowerCase() !== String(name).toLowerCase()) return false;
  const st = await fs.stat(p).catch(() => null);
  if (!st?.isFile() || st.size !== size) return false;
  return !lastModified || Math.abs(st.mtimeMs - lastModified) <= MTIME_TOLERANCE_MS;
}

async function firstMatch(candidates, file) {
  for (const p of candidates) if (await matches(p, file)) return p;
  return null;
}

/**
 * Absolute paths of the described files (null for one not found), in order.
 * `explorer` resolves to { selected, folders } of File Explorer; `folders` are extra places to look.
 */
export async function locateFiles(files, { explorer, folders = [] } = {}) {
  const [shown, common] = await Promise.all([
    (explorer ? explorer() : Promise.resolve(null)).catch(() => null),
    commonFolders(),
  ]);
  const places = [...(shown?.folders ?? []), ...folders, ...common];
  return Promise.all(files.map(async (file) => {
    const name = String(file.name ?? '');
    if (!name || name !== path.basename(name)) return null;
    const selected = (shown?.selected ?? []).filter((p) => path.basename(p).toLowerCase() === name.toLowerCase());
    return (await firstMatch(selected, file)) ?? firstMatch(places.map((d) => path.join(d, name)), file);
  }));
}
