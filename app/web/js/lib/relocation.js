import { h, actionButton } from './dom.js';
import { api, projectUrl } from './api.js';
import { attempt } from './ui.js';
import { browse } from './picker.js';

/**
 * A project whose folder is gone: renamed or moved (the server found it again and says why), or
 * not found. Shared by the Home notice and the project overview; nothing changes until the owner
 * confirms with "Use this folder".
 */

const REASONS = {
  'same folder': 'the same folder, under a new name or place',
  'same git history': 'the same git history',
  'same files': 'the same files (size and date)',
  'same package name': 'the same package name',
  'similar contents': 'similar contents',
};

export function relocationText(p) {
  const r = p.relocation;
  if (!r) return { title: `${p.name}: folder not found`, detail: 'Moved or renamed it? Show FlintBench where it is now.' };
  return {
    title: r.kind === 'renamed' ? `${p.name} was renamed to ${r.name}` : `${p.name} was moved`,
    detail: `Now at ${r.path} · ${REASONS[r.reason] ?? r.reason}`,
  };
}

const relocate = (p, dir) => attempt(() => api.post(projectUrl(p.id, '/relocate'), { path: dir }), { success: `${p.name}: folder updated`, failure: 'Folder not updated' });

/** Use this folder / Not this one when a place was found, Locate folder… always. */
export function relocationActions(p) {
  const r = p.relocation;
  const locate = actionButton('Locate folder…', async () => {
    const dir = await browse({ kind: 'folder', title: `Where is ${p.name} now?` });
    if (dir) await relocate(p, dir);
  }, { cls: r ? 'btn sm ghost' : 'btn sm primary', iconName: 'folder' });
  return [
    r ? actionButton('Use this folder', () => relocate(p, r.path), { cls: 'btn sm primary', iconName: 'check', title: 'Update the project to this folder: history, notes and sessions stay with it' }) : null,
    r ? actionButton('Not this one', () => attempt(() => api.post(projectUrl(p.id, '/relocation/dismiss'), { path: r.path })), { cls: 'btn sm ghost' }) : null,
    locate,
  ];
}
