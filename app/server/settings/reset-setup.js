import fs from 'node:fs/promises';
import path from 'node:path';

const MARKER = '.reset-setup';

/** Asks for the first run again: applied when FlintBench next starts (it may be running now). */
export async function requestReset(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, MARKER), new Date().toISOString());
}

/**
 * At startup, before the account is read: when a reset was asked for, the account file is kept
 * aside as auth.json.reset-<stamp>.bak (never deleted) and the setup is marked as not done, so
 * the next visit creates the account and runs the setup wizard again. Projects and their history stay.
 */
export async function applyResetMarker(dataDir, log = console) {
  const marker = path.join(dataDir, MARKER);
  if (!(await fs.stat(marker).then(() => true, () => false))) return false;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const auth = path.join(dataDir, 'auth.json');
  if (await fs.stat(auth).then(() => true, () => false)) await fs.rename(auth, `${auth}.reset-${stamp}.bak`);
  const settingsFile = path.join(dataDir, 'settings.json');
  const settings = await fs.readFile(settingsFile, 'utf8').then(JSON.parse).catch(() => null);
  if (settings) {
    settings.setup = { done: false, answers: null, reset: true }; // asked for: not an older install
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
  }
  await fs.rm(marker, { force: true });
  log.log?.(`[setup] reset: account kept as auth.json.reset-${stamp}.bak, the setup runs again`);
  return true;
}
