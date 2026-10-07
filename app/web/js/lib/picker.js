import { api } from './api.js';
import { actionButton } from './dom.js';
import { toast } from './ui.js';

/**
 * Opens the native file dialog (Explorer on Windows) on this computer and resolves to the chosen
 * absolute path, or null when the owner cancels. The dialog appears on the FlintBench machine.
 */
export async function browse({ kind = 'folder', title, initial, filterName, filterSpec } = {}) {
  try {
    const r = await api.post('/api/system/pick', { kind, title, initial, filterName, filterSpec });
    return r?.path ?? null;
  } catch (error) {
    toast('Could not open the file dialog', { kind: 'err', detail: error.message });
    return null;
  }
}

/** "Choose folder…" style button: busy while the dialog is open, then hands the path on. */
export function browseButton(label, options, onPick, { cls = 'btn', title } = {}) {
  return actionButton(label, async () => {
    const chosen = await browse(typeof options === 'function' ? options() : options);
    if (chosen) await onPick(chosen);
  }, { cls, iconName: 'folder', title: title ?? 'Opens the file dialog of this computer' });
}
