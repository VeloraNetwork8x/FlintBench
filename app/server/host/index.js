import { run, which, launchDetached, launchInConsoleWindow, killTree, clearWhichCache, refreshPath, IS_WIN } from './exec.js';
import path from 'node:path';
import * as paths from './paths.js';
import { watchProject, watchRoot, watchTree, watchFile } from './fs-watch.js';
import { createGitCli } from './git-cli.js';
import { PtyManager, defaultShell, shellCommandArgs, interactiveShellArgs } from './pty.js';
import { createProcessInspector, descendantsOf } from './processes.js';
import { DockerCli } from './docker-cli.js';
import { createAgentFiles } from './agent-files.js';
import { screenshot, findBrowser } from './screenshot.js';
import { hostTerminalFont } from './terminal-font.js';
import { locateFiles } from './locate.js';

/**
 * Host Interaction Layer.
 * Every OS-touching capability FlintBench has is exposed here and only here.
 * A future out-of-process Host Agent can implement this same shape over IPC.
 */
export function createHost({ log = console } = {}) {
  const processes = { ...createProcessInspector(), descendantsOf };
  return {
    platform: process.platform,
    isWindows: IS_WIN,
    exec: { run, which, killTree, clearWhichCache, refreshPath, launchDetached, launchInConsoleWindow },
    paths,
    watch: { project: watchProject, root: watchRoot, tree: watchTree, file: watchFile },
    git: createGitCli(),
    pty: new PtyManager({ log }),
    shell: { defaultShell, shellCommandArgs, interactiveShellArgs },
    processes,
    docker: new DockerCli({ log }),
    agentFiles: createAgentFiles(),
    preview: { screenshot, browser: findBrowser },
    terminalFont: hostTerminalFont,
    /** Real paths of files dropped into the page, from their name, size and modification time. */
    locateFiles: (files, folders) => locateFiles(files, { explorer: processes.explorerSelection, folders }),
    desktop: {
      /** The editor on a folder; with `file`, that file opened in the folder's window. */
      openInEditor(command, dir, file = null, { goto = false } = {}) {
        launchDetached(command || 'code', file ? [dir, ...(goto ? ['-g'] : []), file] : [dir]);
      },
      /** Open a folder in the file manager, or show a file selected in its folder, in front of everything. */
      async reveal(target, { select = false } = {}) {
        if (IS_WIN) {
          const folder = select ? path.dirname(target) : target;
          const r = await processes.showInExplorer(folder, select ? target : '');
          // fallback: a plain explorer launch (the quotes go inside "/select,…": pass the argument verbatim)
          if (!r.shown) launchDetached('explorer', [select ? `/select,"${target}"` : `"${target}"`], { hide: false, verbatim: true });
          return;
        }
        if (process.platform === 'darwin') launchDetached('open', select ? ['-R', target] : [target], { hide: false });
        else launchDetached('xdg-open', [select ? target.replace(/[\\/][^\\/]*$/, '') : target], { hide: false });
      },
    },
  };
}
