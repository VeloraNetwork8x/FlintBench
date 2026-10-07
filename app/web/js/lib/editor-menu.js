import { api, projectUrl } from './api.js';
import { store } from './store.js';
import { toast } from './ui.js';
import { agentMark } from './agent-icons.js';
import { editorCommands, editorName } from './editors.js';

/** The project (or one of its files) in an editor: the default one, or another one of yours. */
export function openIn(projectId, { path = null, command = null } = {}) {
  return api.post(projectUrl(projectId, '/open-editor'), { ...(path ? { path } : {}), ...(command ? { command } : {}) })
    .catch((e) => toast(e.message, { kind: 'err' }));
}

/** Name of the editor a click opens (Settings › Integrations). */
export const defaultEditorName = () => editorName(editorCommands(store.state.settings)[0]);

/**
 * Menu items "Open in <editor>": the default editor first, then the others chosen in Settings.
 * `skip` leaves some commands out (e.g. VS Code when the menu already brings it to the front).
 */
export function editorItems(projectId, { path = null, disabled = false, skip = [] } = {}) {
  return editorCommands(store.state.settings).filter((c) => !skip.includes(c)).map((command, i) => ({
    label: `Open in ${editorName(command)}`,
    ...(command === 'code' ? { iconNode: agentMark('vscode', 14) } : { icon: 'editor' }),
    disabled,
    run: () => openIn(projectId, { path, command: i === 0 && !skip.length ? null : command }),
  }));
}
