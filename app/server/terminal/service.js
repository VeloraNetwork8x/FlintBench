import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { httpError } from '../host/paths.js';

const ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;
const ATTACHMENT_KEEP_MS = 7 * 86_400_000;

/** A file name safe on every OS, keeping the owner's name readable for the agent that reads it. */
export function attachmentName(name) {
  let base = path.basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) base = `_${base}`;
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 16);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base || 'file';
}

/**
 * Project terminals on top of the host PTY manager.
 * Shell tabs are interactive; an optional initial command is typed into the shell
 * so the tab stays usable after the command ends.
 */
export class TerminalService {
  constructor({ host, projects, settings, storage, log = console }) {
    this.host = host;
    this.projects = projects;
    this.settings = settings;
    this.storage = storage;
    this.log = log;
  }

  init() {
    const recount = (t) => t?.projectId && this.#recount(t.projectId);
    this.host.pty.on('created', recount);
    this.host.pty.on('exit', recount);
    this.host.pty.on('removed', () => {
      for (const id of this.projects.live.keys()) this.#recount(id);
    });
  }

  #recount(projectId) {
    if (!this.projects.has(projectId)) return;
    const live = this.host.pty.list((t) => t.projectId === projectId && !t.exited).length;
    this.projects.patch(projectId, 'terminals', live);
  }

  list(projectId) {
    return this.host.pty.list((t) => t.projectId === projectId);
  }

  get(terminalId) {
    const t = this.host.pty.get(terminalId);
    if (!t) throw httpError(404, 'Terminal not found');
    return t;
  }

  create(projectId, { name, command, cols, rows } = {}) {
    const project = this.projects.get(projectId);
    if (!project.exists) throw httpError(409, 'Project folder is missing');
    const shell = this.settings.shell();
    const label = String(name || 'Terminal').slice(0, 40);
    const terminal = this.host.pty.create({
      file: shell,
      args: this.host.shell.interactiveShellArgs(shell),
      cwd: project.path,
      name: label,
      kind: 'shell',
      projectId,
      cols,
      rows,
    });
    if (command) {
      const cmd = String(command).slice(0, 2000);
      setTimeout(() => this.host.pty.write(terminal.id, `${cmd}\r`), 350);
    }
    this.#rememberTabs(projectId).catch(() => {});
    return terminal;
  }

  /** Runs one command in the project's shell; the PTY ends when the command ends. */
  spawnCommand(projectId, { name, command, kind, meta, cols, rows }) {
    const project = this.projects.get(projectId);
    if (!project.exists) throw httpError(409, 'Project folder is missing');
    const shell = this.settings.shell();
    return this.host.pty.create({
      file: shell,
      args: this.host.shell.shellCommandArgs(shell, command),
      cwd: project.path,
      name,
      kind,
      projectId,
      meta,
      cols,
      rows,
    });
  }

  /** Spawns a program directly (agents). */
  spawnProgram(projectId, { name, file, args, kind, meta, env }) {
    const project = this.projects.get(projectId);
    if (!project.exists) throw httpError(409, 'Project folder is missing');
    return this.host.pty.create({ file, args, cwd: project.path, name, kind, projectId, meta, env });
  }

  remove(terminalId) {
    const t = this.get(terminalId);
    this.host.pty.remove(terminalId);
    if (t.projectId && t.kind === 'shell') this.#rememberTabs(t.projectId).catch(() => {});
  }

  rename(terminalId, name) {
    const t = this.get(terminalId);
    this.host.pty.rename(terminalId, String(name || '').slice(0, 40) || t.name);
    if (t.projectId) this.#rememberTabs(t.projectId).catch(() => {});
    return this.get(terminalId);
  }

  /**
   * Where files dropped onto a terminal really are (null for one not found): the browser only says
   * their name, size and modification time, the host finds the matching file on this machine.
   */
  async locateFiles(terminalId, files) {
    const t = this.get(terminalId);
    if (!Array.isArray(files) || !files.length || files.length > 50) throw httpError(400, 'files must list 1 to 50 files');
    const wanted = files.map((f) => ({ name: String(f?.name ?? ''), size: Number(f?.size), lastModified: Number(f?.lastModified) || 0 }));
    const project = t.projectId && this.projects.has(t.projectId) ? this.projects.get(t.projectId) : null;
    return { paths: await this.host.locateFiles(wanted, project?.path ? [project.path] : []) };
  }

  /**
   * A file dropped (or pasted) onto a terminal that the host could not find (a picture pasted from
   * the clipboard, a file from an app that keeps it elsewhere): a copy is kept with the project's
   * FlintBench data for a week and its absolute path is returned, for the page to type into the
   * terminal. Never written into the repository.
   */
  async saveAttachment(terminalId, name, stream, size) {
    const t = this.get(terminalId);
    if (!t.projectId) throw httpError(409, 'This terminal belongs to no project');
    if (size > ATTACHMENT_MAX_BYTES) throw httpError(413, 'File too large (200 MB at most)');
    const root = path.join((await this.storage.project(t.projectId)).dir, 'attachments');
    await this.#pruneAttachments(root);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dir = path.join(root, `${stamp}-${crypto.randomBytes(3).toString('hex')}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, attachmentName(name));
    let received = 0;
    try {
      await pipeline(stream, async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > ATTACHMENT_MAX_BYTES) throw httpError(413, 'File too large (200 MB at most)');
          yield chunk;
        }
      }, createWriteStream(file));
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { path: file, size: received };
  }

  async #pruneAttachments(root) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
      const dir = path.join(root, e.name);
      const stat = await fs.stat(dir).catch(() => null);
      if (stat && now - stat.mtimeMs > ATTACHMENT_KEEP_MS) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }));
  }

  /** Remembers the project's shell tab names so Resume can recreate them. */
  async #rememberTabs(projectId) {
    const tabs = this.list(projectId).filter((t) => t.kind === 'shell' && !t.exited).map((t) => ({ name: t.name }));
    if (!tabs.length) return;
    const data = await this.storage.project(projectId);
    await data.config.update((c) => { c.terminals = tabs.slice(0, 8); });
  }

  async restoreTabs(projectId) {
    const existing = this.list(projectId).filter((t) => t.kind === 'shell' && !t.exited);
    if (existing.length) return existing;
    const data = await this.storage.project(projectId);
    const tabs = data.config.get().terminals?.length ? data.config.get().terminals : [{ name: 'Terminal' }];
    return tabs.map((t) => this.create(projectId, { name: t.name }));
  }
}
