import path from 'node:path';

/**
 * What happened in one agent session, read from the agent's own transcript (the unified items of
 * agents/transcript.js): the owner's requests, the files the agent's own edit tools wrote (proven
 * attribution: the tool call names the file), the commands it ran, and whether it stopped in the
 * middle of a turn. Deterministic: no summarising model, only counting and quoting.
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update', 'Delete', 'apply_patch', 'str_replace_editor', 'write_file', 'edit_file']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'exec_command', 'run_shell_command']);
const CLIP = 420;

const clip = (t, n = CLIP) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
const oneLine = (t) => t.replace(/\s+/g, ' ').trim();

/** A tool's file argument, relative to the project with forward slashes (absolute when outside). */
function relPath(projectPath, file) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(projectPath, file);
  const rel = path.relative(projectPath, abs);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs).split(path.sep).join('/');
}

/**
 * @param {object[]} items       unified transcript items, oldest first
 * @param {object}   opts
 * @param {string}   opts.projectPath
 * @param {number}   [opts.from]  only items at or after (the agent session start; a resumed
 *                                conversation carries older history in the same file)
 * @param {number}   [opts.to]
 */
export function digestTranscript(items, { projectPath, from = 0, to = Infinity }) {
  const inWindow = items.filter((x) => x.at === null || x.at === undefined || (x.at >= from - 60_000 && x.at <= to + 60_000));
  const prompts = inWindow.filter((x) => x.kind === 'user' && x.text && x.text !== '[image]');
  const agentFiles = new Map(); // path -> edits
  const commands = [];
  for (const x of inWindow) {
    if (x.kind !== 'tool') continue;
    const input = x.input ?? {};
    if (EDIT_TOOLS.has(x.name)) {
      const file = relPath(projectPath, input.file_path ?? input.path ?? input.notebook_path ?? null);
      if (file) agentFiles.set(file, (agentFiles.get(file) ?? 0) + 1);
    } else if (SHELL_TOOLS.has(x.name) && input.command) {
      // `cd "<project>" && npm test` reads as `npm test`
      commands.push(clip(oneLine(String(input.command)).replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, ''), 160));
    }
  }

  const lastUser = inWindow.findLastIndex((x) => x.kind === 'user' && x.text && x.text !== '[image]');
  const reply = lastUser >= 0 ? inWindow.slice(lastUser + 1).findLast((x) => x.kind === 'assistant' && x.text?.trim()) : null;
  // stopped mid-turn: the last request got no written answer, or the agent's last move was a tool
  // call (or its result) with nothing after it
  const lastMeaningful = inWindow.findLast((x) => ['user', 'assistant', 'tool', 'result'].includes(x.kind));
  const unfinished = lastUser >= 0 && (!reply || lastMeaningful?.kind === 'tool' || lastMeaningful?.kind === 'result');

  return {
    exchange: lastUser >= 0 ? {
      prompt: clip(inWindow[lastUser].text.trim()),
      reply: reply ? clip(reply.text.trim()) : null,
      at: reply?.at ?? inWindow[lastUser].at ?? null,
    } : null,
    requests: prompts.length,
    // the owner's requests in this session, most recent first (one line each)
    prompts: prompts.slice(-5).reverse().map((x) => clip(oneLine(x.text), 160)),
    agentFiles: [...agentFiles].sort((a, b) => b[1] - a[1]).map(([file, edits]) => ({ path: file, edits })),
    commands: commands.length,
    lastCommands: commands.slice(-3).reverse(),
    unfinished,
  };
}
