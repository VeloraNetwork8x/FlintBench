import { httpError } from '../host/paths.js';

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
