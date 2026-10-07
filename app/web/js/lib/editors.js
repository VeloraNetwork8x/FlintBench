// Editors FlintBench can open a project in: the command each one puts on PATH. Pure data (the
// server imports this file too to tell which ones are installed).

export const EDITORS = [
  { id: 'vscode', name: 'VS Code', command: 'code' },
  { id: 'cursor', name: 'Cursor', command: 'cursor' },
  { id: 'windsurf', name: 'Windsurf', command: 'windsurf' },
  { id: 'antigravity', name: 'Antigravity', command: 'antigravity' },
  { id: 'vscodium', name: 'VSCodium', command: 'codium' },
  { id: 'zed', name: 'Zed', command: 'zed' },
  { id: 'sublime', name: 'Sublime Text', command: 'subl' },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm' },
  { id: 'idea', name: 'IntelliJ IDEA', command: 'idea' },
  { id: 'pycharm', name: 'PyCharm', command: 'pycharm' },
];

/** The editor's name for a command ("code" → VS Code); an unknown command is shown as it is. */
export function editorName(command) {
  const c = String(command || 'code').trim().toLowerCase();
  return EDITORS.find((e) => e.command === c)?.name ?? command;
}

/** The default editor first, then the others chosen in Settings (commands, no duplicates). */
export function editorCommands(settings) {
  const main = settings?.editor?.command || 'code';
  return [main, ...(settings?.editor?.others ?? []).filter((c) => c && c !== main)];
}
