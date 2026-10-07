import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import pty from '@lydell/node-pty';
import { IS_WIN, which, killTree, hostEnv } from './exec.js';

const SCROLLBACK_LIMIT = 256 * 1024;

export function defaultShell() {
  if (IS_WIN) return which('pwsh') ?? which('powershell') ?? process.env.ComSpec ?? 'cmd.exe';
  return process.env.SHELL || which('bash') || '/bin/sh';
}

/** Arguments that make a shell run one command and exit with its status. */
export function shellCommandArgs(shell, command) {
  const name = shell.toLowerCase();
  if (/pwsh|powershell/.test(name)) return ['-NoLogo', '-Command', command];
  if (/cmd(\.exe)?$/.test(name)) return ['/d', '/s', '/c', command];
  return ['-lc', command];
}

export function interactiveShellArgs(shell) {
  const name = shell.toLowerCase();
  if (/pwsh|powershell/.test(name)) return ['-NoLogo'];
  if (/cmd(\.exe)?$/.test(name)) return [];
  return ['-l'];
}

/**
 * Real pseudo-terminals. Terminals outlive browser connections and keep a
 * bounded scrollback so a reconnecting client can replay output.
 * Events: 'data' (id, chunk), 'exit' (terminal), 'created' (terminal), 'removed' (id)
 */

export class PtyManager extends EventEmitter {
  constructor({ log = console } = {}) {
    super();
    this.log = log;
    this.terminals = new Map();
  }

  create({ file, args = [], cwd, name, kind = 'shell', projectId = null, meta = {}, cols = 120, rows = 30, env = {} }) {
    const id = randomUUID();
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env: { ...hostEnv(), TERM_PROGRAM: 'FlintBench', COLORTERM: 'truecolor', ...env },
      useConpty: IS_WIN ? true : undefined,
    });
    const terminal = {
      id,
      pid: proc.pid,
      name: name || kind,
      kind,
      projectId,
      cwd,
      command: [file, ...args].join(' '),
      meta,
      createdAt: Date.now(),
      lastOutputAt: null,
      exited: false,
      exitCode: null,
      exitedAt: null,
      // set when FlintBench was asked to stop it: the non-zero code of a killed process is not a failure
      stoppedByUser: false,
      buffer: '',
      proc,
    };
    proc.onData((chunk) => {
      terminal.buffer += chunk;
      if (terminal.buffer.length > SCROLLBACK_LIMIT) terminal.buffer = terminal.buffer.slice(-SCROLLBACK_LIMIT);
      terminal.lastOutputAt = Date.now();
      this.emit('data', id, chunk);
    });
    proc.onExit(({ exitCode }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      terminal.exitedAt = Date.now();
      this.emit('exit', this.describe(terminal));
    });
    this.terminals.set(id, terminal);
    this.emit('created', this.describe(terminal));
    return this.describe(terminal);
  }

  describe(terminal) {
    const { proc, buffer, ...rest } = terminal;
    // node-pty (ConPTY) assigns the pid asynchronously; always read it live
    return { ...rest, pid: proc.pid };
  }

  get(id) {
    const t = this.terminals.get(id);
    return t ? this.describe(t) : null;
  }

  list(filter = () => true) {
    return [...this.terminals.values()].filter(filter).map((t) => this.describe(t));
  }

  scrollback(id) {
    return this.terminals.get(id)?.buffer ?? '';
  }

  write(id, data) {
    const t = this.terminals.get(id);
    if (!t || t.exited) return false;
    t.proc.write(data);
    return true;
  }

  resize(id, cols, rows) {
    const t = this.terminals.get(id);
    if (!t || t.exited) return;
    const c = Math.max(10, Math.min(500, cols | 0));
    const r = Math.max(4, Math.min(300, rows | 0));
    try {
      t.proc.resize(c, r);
    } catch {
      // process may have exited between checks
    }
  }

  /** Stops the process tree but keeps the terminal (and its output) listed. */
  stop(id) {
    const t = this.terminals.get(id);
    if (!t || t.exited) return;
    t.stoppedByUser = true;
    killTree(t.proc.pid);
    setTimeout(() => {
      if (!t.exited) {
        try { t.proc.kill(); } catch { /* ignore */ }
      }
    }, 1500).unref();
  }

  remove(id) {
    const t = this.terminals.get(id);
    if (!t) return;
    if (!t.exited) this.stop(id);
    this.terminals.delete(id);
    this.emit('removed', id);
  }

  rename(id, name) {
    const t = this.terminals.get(id);
    if (t) t.name = name;
  }

  disposeAll() {
    for (const t of this.terminals.values()) {
      if (!t.exited) killTree(t.proc.pid);
    }
  }

  /** pid of every live PTY root process (used to tell managed from external processes). */
  livePids() {
    return new Set([...this.terminals.values()].filter((t) => !t.exited && t.proc.pid).map((t) => t.proc.pid));
  }
}
