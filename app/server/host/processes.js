import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { run, IS_WIN, which, killTree, yieldPriority } from './exec.js';

const WIN_PROCS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-procs.ps1');
const WIN_PROCS_BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-procs-build.ps1');
const WIN_PROCS_DLL = path.join(os.tmpdir(), 'flintbench-procs-v2.dll');
const WIN_WINDOWS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-windows.ps1');
const psQuote = (text) => `'${String(text).replaceAll("'", "''")}'`;

async function windowsScript(args) {
  const shell = which('powershell') ?? which('pwsh');
  const r = await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_WINDOWS_SCRIPT, ...args], { timeout: 20_000, background: true }).catch(() => null);
  return (r?.stdout.split(/\r?\n/) ?? []).map((line) => line.trim()).filter(Boolean);
}

const parseWindow = (line) => {
  const tab = line.indexOf('\t');
  return tab > 0 ? { pid: Number(line.slice(0, tab)), title: line.slice(tab + 1).trim() } : null;
};

/** Visible top-level window titles of the given process names (Windows only). */
async function windowTitles(names) {
  if (!IS_WIN || !names.length) return [];
  const out = await session.ask(`& ${psQuote(WIN_WINDOWS_SCRIPT)} -Mode names -Names ${psQuote(names.join(','))}`).catch(() => '');
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(parseWindow).filter(Boolean);
}

/** Visible top-level windows owned by the given pids (Windows only). */
async function windowsOf(pids) {
  if (!IS_WIN || !pids.length) return [];
  return (await windowsScript(['-Mode', 'pids', '-Pids', pids.join(',')])).map(parseWindow).filter(Boolean);
}

/** Restores and brings to the front the first window of pid whose title contains titlePart. */
async function focusWindow(pid, titlePart = '') {
  if (!IS_WIN) return { focused: false, reason: 'unsupported' };
  const [line] = await windowsScript(['-Mode', 'focus', '-Pids', String(pid), ...(titlePart ? ['-Title', titlePart] : [])]);
  if (!line) return { focused: false, reason: 'no-window' };
  const [state, , title] = line.split('\t');
  return { focused: state === 'focused', title: title ?? null };
}

/**
 * Shows a folder in File Explorer, reusing a window already open on it, optionally selects a file
 * in it, and brings that window to the front (Windows only).
 */
async function showInExplorer(folder, item = '') {
  if (!IS_WIN) return { shown: false, reason: 'unsupported' };
  const [state] = await windowsScript(['-Mode', 'explorer', '-Path', folder, ...(item ? ['-Item', item] : [])]);
  return { shown: state === 'focused' || state === 'denied', focused: state === 'focused' };
}

/** Selected items and folders of the open File Explorer windows (Windows only). */
async function explorerSelection() {
  const out = { selected: [], folders: [] };
  if (!IS_WIN) return out;
  for (const line of await windowsScript(['-Mode', 'selection'])) {
    const [kind, value] = line.split('\t');
    if (!value) continue;
    if (kind === 'sel') out.selected.push(value);
    else if (kind === 'dir') out.folders.push(value);
  }
  return out;
}

let vscodeFolders = { at: 0, list: [] };
/** Folders VS Code has opened, most recently used first (from its workspaceStorage). Cached 30 s. */
async function vscodeRecentFolders() {
  if (Date.now() - vscodeFolders.at < 30_000) return vscodeFolders.list;
  const base = path.join(process.env.APPDATA ?? '', 'Code', 'User', 'workspaceStorage');
  const list = [];
  for (const dir of await fs.readdir(base).catch(() => [])) {
    const ws = await fs.readFile(path.join(base, dir, 'workspace.json'), 'utf8').catch(() => null);
    const folder = ws ? (() => { try { return JSON.parse(ws).folder; } catch { return null; } })() : null;
    if (typeof folder !== 'string' || !folder.startsWith('file:///')) continue;
    const st = await fs.stat(path.join(base, dir, 'state.vscdb')).catch(() => null);
    let p = decodeURIComponent(folder.slice('file:///'.length)).replaceAll('/', path.sep);
    if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
    list.push({ path: p, usedAt: st?.mtimeMs ?? 0 });
  }
  list.sort((a, b) => b.usedAt - a.usedAt);
  vscodeFolders = { at: Date.now(), list };
  return list;
}

/**
 * One PowerShell kept open for the frequent questions (Windows): the process list, working folders,
 * window titles. A new PowerShell per question cost a process launch each time, and the old scan
 * went through WMI, which choked while agents started and ended processes by the hundred (scans
 * past 20 s, and every other WMI user on the machine waiting with them). The session loads
 * win-procs.ps1 once: native calls, no WMI, ~0.1 s a scan. Below normal priority; one question at
 * a time; one not answered in time takes the session down and the next starts a new one. It ends
 * with FlintBench (its input closes).
 */
const ANSWER_END = '<<flintbench-answer-end>>';

// the native helper is compiled once, on its own (normal priority, no time limit: a busy machine can
// take a minute); the session uses WMI until the DLL is there, then loads it by itself
let helperBuild = null;
function buildNativeHelper() {
  if (!IS_WIN || helperBuild || existsSync(WIN_PROCS_DLL)) return;
  const shell = which('powershell') ?? which('pwsh');
  helperBuild = run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_PROCS_BUILD], { timeout: 10 * 60_000 }).catch(() => null);
}
const session = {
  ps: null,
  out: '',
  waiting: null, // { resolve, reject, timer }
  queue: Promise.resolve(),
  start() {
    const shell = which('powershell') ?? which('pwsh');
    const ps = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    yieldPriority(ps.pid);
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk) => {
      this.out += chunk;
      const end = this.out.indexOf(ANSWER_END);
      if (end === -1 || !this.waiting) return;
      const text = this.out.slice(0, end);
      this.out = this.out.slice(this.out.indexOf('\n', end) + 1 || this.out.length);
      const { resolve, timer } = this.waiting;
      this.waiting = null;
      clearTimeout(timer);
      resolve(text);
    });
    const gone = () => {
      if (this.ps !== ps) return;
      this.ps = null;
      this.out = '';
      if (this.waiting) {
        const { reject, timer } = this.waiting;
        this.waiting = null;
        clearTimeout(timer);
        reject(new Error('the PowerShell session ended'));
      }
    };
    ps.on('exit', gone);
    ps.on('error', gone);
    ps.stdin.on('error', () => {});
    ps.stdin.write(`. ${psQuote(WIN_PROCS_SCRIPT)}\n`);
    this.ps = ps;
  },
  stop() {
    const ps = this.ps;
    this.ps = null;
    if (ps) killTree(ps.pid);
  },
  /** One PowerShell line; resolves to what it printed. The first one also waits for the helper to load. */
  ask(command, timeout = 20_000) {
    const job = this.queue.then(() => new Promise((resolve, reject) => {
      // a new session loads the helper first (the very first time it compiles it: can take a while)
      if (!this.ps) {
        buildNativeHelper();
        this.start();
      }
      const timer = setTimeout(() => {
        this.waiting = null;
        this.stop();
        reject(new Error(`no answer within ${timeout / 1000} s`));
      }, timeout);
      this.waiting = { resolve, reject, timer };
      this.ps.stdin.write(`${command}; "${ANSWER_END}"\n`);
    }));
    this.queue = job.catch(() => {});
    return job;
  },
};
process.once('exit', () => session.stop());

async function listWindows() {
  const stdout = await session.ask('FbList').catch((error) => {
    throw new Error(`process scan: ${error.message}`);
  });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, ppid, started, name, ...cmd] = line.split('\t');
    return { pid: Number(pid), ppid: Number(ppid), startedAt: Number(started) || null, name: name ?? '', cmd: cmd.join('\t') };
  }).filter((p) => p.pid);
}

async function listUnix() {
  const r = await run('ps', ['-axo', 'pid=,ppid=,comm=,args='], { timeout: 10_000 });
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), name: m[3].split('/').at(-1), cmd: m[4] };
  }).filter(Boolean);
}

async function portsWindows() {
  const r = await run('netstat', ['-ano', '-p', 'TCP'], { timeout: 10_000, background: true });
  const r6 = await run('netstat', ['-ano', '-p', 'TCPv6'], { timeout: 10_000, background: true }).catch(() => ({ stdout: '' }));
  const ports = [];
  for (const line of `${r.stdout}\n${r6.stdout}`.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // language independent: listening sockets have a wildcard foreign address ending in :0
    if (cols.length !== 5 || !/^TCP/i.test(cols[0]) || !/:0$/.test(cols[2])) continue;
    const idx = cols[1].lastIndexOf(':');
    const port = Number(cols[1].slice(idx + 1));
    const pid = Number(cols[4]);
    if (port && pid) ports.push({ port, pid, address: cols[1].slice(0, idx) });
  }
  return dedupePorts(ports);
}

async function portsUnix() {
  if (which('lsof')) {
    const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 10_000 }).catch(() => null);
    if (r?.code === 0) {
      const ports = [];
      let pid = 0;
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n')) {
          const idx = line.lastIndexOf(':');
          const port = Number(line.slice(idx + 1));
          if (port) ports.push({ port, pid, address: line.slice(1, idx) });
        }
      }
      return dedupePorts(ports);
    }
  }
  if (which('ss')) {
    const r = await run('ss', ['-ltnpH'], { timeout: 10_000 }).catch(() => null);
    const ports = [];
    for (const line of r?.stdout.split('\n') ?? []) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const local = cols[3];
      const port = Number(local.slice(local.lastIndexOf(':') + 1));
      const pid = Number(/pid=(\d+)/.exec(line)?.[1] ?? 0);
      if (port) ports.push({ port, pid, address: local.slice(0, local.lastIndexOf(':')) });
    }
    return dedupePorts(ports);
  }
  return [];
}

function dedupePorts(ports) {
  const seen = new Map();
  for (const p of ports) {
    const key = `${p.pid}:${p.port}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

// pid -> working directory (null when unreadable); pruned to the pids still asked about
const winCwdCache = new Map();

/** Working directories of several Windows processes, asked of the PowerShell session (see win-procs.ps1). */
async function cwdsWindows(pids) {
  for (const pid of [...winCwdCache.keys()]) if (!pids.includes(pid)) winCwdCache.delete(pid);
  const missing = pids.filter((pid) => !winCwdCache.has(pid));
  if (missing.length) {
    const stdout = await session.ask(`FbCwds ${psQuote(missing.join(','))}`).catch(() => '');
    const found = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab > 0) found.set(Number(line.slice(0, tab)), line.slice(tab + 1).trim());
    }
    for (const pid of missing) winCwdCache.set(pid, found.get(pid) ?? null);
  }
  return new Map(pids.map((pid) => [pid, winCwdCache.get(pid) ?? null]));
}

export function createProcessInspector() {
  return {
    async list() {
      return IS_WIN ? listWindows() : listUnix();
    },
    async listeningPorts() {
      return IS_WIN ? portsWindows() : portsUnix();
    },
    /** Working directory of a process, only where the OS exposes it reliably. */
    async cwd(pid) {
      if (process.platform === 'linux') {
        return fs.readlink(`/proc/${pid}/cwd`).catch(() => null);
      }
      if (process.platform === 'darwin' && which('lsof')) {
        const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000 }).catch(() => null);
        const line = r?.stdout.split('\n').find((l) => l.startsWith('n'));
        return line ? line.slice(1) : null;
      }
      if (IS_WIN) return (await cwdsWindows([pid])).get(pid);
      return null;
    },
    /** Working directories of several processes at once (Windows: one PowerShell call, cached per pid). */
    async cwds(pids) {
      if (IS_WIN) return cwdsWindows(pids);
      const out = new Map();
      for (const pid of pids) out.set(pid, await this.cwd(pid));
      return out;
    },
    cwdSupported: true,
    windowTitles,
    windowsOf,
    focusWindow,
    showInExplorer,
    explorerSelection,
    vscodeRecentFolders,
  };
}

/** All descendants of the given root pids (inclusive). */
export function descendantsOf(processes, rootPids) {
  // PIDs 0 and 4 are Windows' idle and System processes (System owns ports like 139/445): they are
  // nobody's descendant, and a root of 0 (a terminal not spawned yet) must not adopt them
  const SYSTEM = (pid) => !(pid > 4);
  const children = new Map();
  for (const p of processes) {
    if (SYSTEM(p.pid) || p.pid === p.ppid) continue;
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const result = new Set();
  const stack = rootPids.filter((pid) => !SYSTEM(pid));
  while (stack.length) {
    const pid = stack.pop();
    if (result.has(pid)) continue;
    result.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return result;
}
