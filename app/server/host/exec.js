import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';

// Markers a running Claude Code session sets for its own children. If FlintBench was started
// from inside one, what it opens must not inherit them: Claude Code opened from FlintBench would
// think it is a child session (no transcript, no session registry) instead of the user's own.
const AGENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN|SSE_PORT))$/;

/** FlintBench's environment without another agent session's markers: for terminals and windows it opens. */
export function hostEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !AGENT_SESSION_ENV.test(key)));
}

const whichCache = new Map();

/** Resolves an executable on PATH (PATHEXT aware on Windows). */
export function which(name) {
  if (!name) return null;
  const cached = whichCache.get(name);
  if (cached && Date.now() - cached.at < 60_000) return cached.file;
  const file = resolveExecutable(name);
  whichCache.set(name, { file, at: Date.now() });
  return file;
}

export function clearWhichCache() {
  whichCache.clear();
}

const PATH_KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
let pathReadAt = 0;

/**
 * A program installed while FlintBench runs (winget, an installer) adds its folder to the PATH
 * saved in the registry, which this process read once at start. Folders found there and missing
 * here are appended (what already resolves keeps resolving the same way); the which cache is
 * cleared. Terminals opened afterwards inherit them too. At most once every 3 s; a no-op off Windows.
 */
export async function refreshPath() {
  clearWhichCache();
  if (!IS_WIN || Date.now() - pathReadAt < 3000) return false;
  pathReadAt = Date.now();
  const read = (key) => new Promise((resolve) => {
    const child = spawn('reg', ['query', key, '/v', 'Path'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(Buffer.concat(out).toString('utf8'))?.[1]?.trim() ?? ''));
  });
  const expand = (dir) => dir.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const known = new Set(current.map((d) => d.replace(/[\\/]+$/, '').toLowerCase()));
  const added = [];
  for (const value of await Promise.all(PATH_KEYS.map(read))) {
    for (const dir of value.split(';').map((d) => expand(d.trim())).filter(Boolean)) {
      const key = dir.replace(/[\\/]+$/, '').toLowerCase();
      if (known.has(key) || dir.includes('%')) continue;
      known.add(key);
      added.push(dir);
    }
  }
  if (added.length) process.env.PATH = [...current, ...added].join(path.delimiter);
  return added.length > 0;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveExecutable(name) {
  const exts = IS_WIN
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)]
    : [''];
  const candidates = (dir) => exts.map((ext) => path.join(dir, name + ext));
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const resolved = path.resolve(name);
    const found = exts.map((ext) => resolved + ext).find((c) => isFile(c));
    if (found) return found;
    // a full path to an app execution alias (as returned below) still resolves
    const alias = IS_WIN ? appAlias(path.basename(resolved)) : null;
    return alias && alias.toLowerCase() === resolved.toLowerCase() ? alias : null;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates(dir)) {
      // On Windows an extension-less file next to a .cmd shim (npm installs) is a sh script; skip it.
      if (IS_WIN && path.extname(candidate) === '' && exts.length > 1) continue;
      if (isFile(candidate)) return candidate;
    }
  }
  return IS_WIN ? appAlias(name) : null;
}

/**
 * Store apps (Windows Terminal's wt.exe...) are reached through "app execution aliases" in
 * %LOCALAPPDATA%/Microsoft/WindowsApps: they launch fine, but stat() reports them missing.
 * The folder listing shows them.
 */
function appAlias(name) {
  if (!process.env.LOCALAPPDATA) return null;
  const dir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
  const wanted = (path.extname(name) ? name : `${name}.exe`).toLowerCase();
  try {
    const entry = fs.readdirSync(dir).find((e) => e.toLowerCase() === wanted);
    return entry ? path.join(dir, entry) : null;
  } catch {
    return null;
  }
}

/** Windows .cmd/.bat shims cannot be spawned without cmd.exe; arguments are validated, never interpolated raw. */
export function commandFor(file, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    for (const arg of [file, ...args]) {
      if (/["%\r\n]/.test(arg)) throw new Error('Argument contains characters that are unsafe for a command shim');
    }
    const line = [file, ...args].map((a) => `"${a}"`).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file, args, verbatim: false };
}

/**
 * Runs a program without a shell and collects output.
 * Resolves with { code, stdout, stderr }; rejects only on spawn failure or timeout.
 */
export function run(program, args = [], { cwd, timeout = 20_000, env, input, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const file = which(program) ?? program;
    let command;
    try {
      command = commandFor(file, args);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(command.file, command.args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    let size = 0;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killTree(child.pid);
      reject(Object.assign(new Error(`${program} timed out after ${timeout}ms`), { code: 'ETIMEDOUT' }));
    }, timeout);
    const collect = (bucket) => (chunk) => {
      size += chunk.length;
      if (size <= maxBuffer) bucket.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

/** Long-running child (e.g. `docker events`). Caller handles lifecycle. */
export function spawnStream(program, args, { cwd, env } = {}) {
  const file = which(program) ?? program;
  const command = commandFor(file, args);
  return spawn(command.file, command.args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    windowsVerbatimArguments: command.verbatim,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Opens a console program in a new console window of its own (`start`), in `cwd`. Unlike a
 * detached spawn, the program gets a real console: an interactive CLI keeps running there.
 */
export function launchInConsoleWindow(file, args, { cwd, title = '' }) {
  for (const a of [file, cwd, title, ...args]) {
    if (/["%^&|<>\r\n]/.test(a)) throw new Error('Argument contains characters that are unsafe for cmd start');
  }
  const line = `start "${title}" /D "${cwd}" "${file}" ${args.map((a) => `"${a}"`).join(' ')}`;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true, // only the short-lived cmd.exe is hidden; the window `start` opens is shown
    windowsVerbatimArguments: true,
    env: hostEnv(),
  });
  child.on('error', () => {});
  child.unref();
}

/** Detached launch for GUI programs (editor, file manager). */
export function launchDetached(program, args, { cwd, hide = true, verbatim = false } = {}) {
  const file = which(program);
  if (!file) throw new Error(`${program} not found on PATH`);
  const command = commandFor(file, args);
  const child = spawn(command.file, command.args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    // hide only the console of command-line tools; a GUI program (File Explorer) must show its window
    windowsHide: hide,
    windowsVerbatimArguments: command.verbatim || verbatim,
    env: hostEnv(),
  });
  child.on('error', () => {});
  child.unref();
}

export function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    // already gone
  }
}
