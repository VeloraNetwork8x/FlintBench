import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, IS_WIN, which } from './exec.js';

const WIN_CWD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-cwd.ps1');
const WIN_WINDOWS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-windows.ps1');

async function windowsScript(args) {
  const shell = which('powershell') ?? which('pwsh');
  const r = await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_WINDOWS_SCRIPT, ...args], { timeout: 20_000 }).catch(() => null);
  return (r?.stdout.split(/\r?\n/) ?? []).map((line) => line.trim()).filter(Boolean);
}

const parseWindow = (line) => {
  const tab = line.indexOf('\t');
  return tab > 0 ? { pid: Number(line.slice(0, tab)), title: line.slice(tab + 1).trim() } : null;
};

/** Visible top-level window titles of the given process names (Windows only). */
async function windowTitles(names) {
  if (!IS_WIN || !names.length) return [];
  return (await windowsScript(['-Mode', 'names', '-Names', names.join(',')])).map(parseWindow).filter(Boolean);
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

const WIN_PS_SCRIPT = [
  '$ErrorActionPreference="SilentlyContinue";',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object {',
  '  $c = if ($_.CommandLine) { $_.CommandLine -replace "[\\t\\r\\n]", " " } else { "" };',
  '  $t = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 };',
  '  "$($_.ProcessId)`t$($_.ParentProcessId)`t$t`t$($_.Name)`t$c"',
  '}',
].join(' ');

async function listWindows() {
  const shell = which('powershell') ?? which('pwsh');
  const r = await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WIN_PS_SCRIPT], { timeout: 20_000 });
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
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
  const r = await run('netstat', ['-ano', '-p', 'TCP'], { timeout: 10_000 });
  const r6 = await run('netstat', ['-ano', '-p', 'TCPv6'], { timeout: 10_000 }).catch(() => ({ stdout: '' }));
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

/** Working directories of several Windows processes in one PowerShell call (see win-cwd.ps1). */
async function cwdsWindows(pids) {
  for (const pid of [...winCwdCache.keys()]) if (!pids.includes(pid)) winCwdCache.delete(pid);
  const missing = pids.filter((pid) => !winCwdCache.has(pid));
  if (missing.length) {
    const shell = which('powershell') ?? which('pwsh');
    const r = await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_CWD_SCRIPT, '-Pids', missing.join(',')], { timeout: 20_000 }).catch(() => null);
    const found = new Map();
    for (const line of r?.stdout.split(/\r?\n/) ?? []) {
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
