import { httpError } from '../host/paths.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * AgentAdapter: one coding-agent CLI. FlintBench never proxies model traffic;
 * it starts the user's installed CLI in the project directory inside a PTY,
 * so the agent uses its own local authentication, plan and limits.
 *
 * Interface: detect(), getStatus(projectId), start(project, opts), stop(sessionId),
 *            sendInput(sessionId, data), resume(project, opts)
 */
export class AgentAdapter {
  /** @param {{ id: string, name: string, binary: string, launchable?: boolean }} spec */
  constructor(spec, { host, terminals, settings }) {
    this.id = spec.id;
    this.name = spec.name;
    this.binary = spec.binary;
    this.launchable = spec.launchable ?? true;
    this.host = host;
    this.terminals = terminals;
    this.settings = settings;
    this.detection = { installed: false, path: null, version: null, checkedAt: null };
    this.sessions = null; // injected by AgentService (live sessions map)
  }

  /** Arguments for a fresh session / a resumed one. Override per agent. */
  newArgs() { return []; }
  resumeArgs() { return []; }

  /**
   * The id this agent's CLI reopens a conversation by, from the session id FlintBench recorded
   * (null when it cannot name that conversation). Override per agent.
   */
  conversationId() { return null; }

  /** The installed binary and the arguments that reopen one conversation, for a window outside FlintBench. */
  resumeCommand(agentSessionId) {
    const file = this.host.exec.which(this.command());
    if (!file || !this.conversationId(agentSessionId)) return null;
    return { file, args: this.resumeArgs({ agentSessionId }), isShim: this.host.isWindows && /\.(cmd|bat)$/i.test(file) };
  }
  versionArgs() { return ['--version']; }

  command() {
    return this.settings.get().agents[this.id]?.command || this.binary;
  }

  enabled() {
    return this.settings.get().agents[this.id]?.enabled ?? true;
  }

  async detect() {
    const file = this.host.exec.which(this.command());
    let version = null;
    if (file) {
      const r = await this.host.exec.run(file, this.versionArgs(), { timeout: 15_000 }).catch(() => null);
      if (r?.code === 0) version = (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80);
    }
    this.detection = { installed: Boolean(file), path: file, version, checkedAt: Date.now() };
    return this.detection;
  }

  getStatus(projectId) {
    const live = [...(this.sessions?.values() ?? [])].filter((s) => s.agent === this.id && (!projectId || s.projectId === projectId) && !s.endedAt);
    return { ...this.detection, enabled: this.enabled(), launchable: this.launchable, active: live.length };
  }

  #launch(project, args, opts) {
    if (!this.launchable) throw httpError(400, `${this.name} launching is not supported yet`);
    if (!this.enabled()) throw httpError(409, `${this.name} is disabled in Settings`);
    if (!this.detection.installed) throw httpError(409, `${this.name} is not installed or not on PATH`);
    const command = this.host.exec.which(this.command());
    // .cmd shims (npm global installs on Windows) must run through cmd.exe
    const isShim = this.host.isWindows && /\.(cmd|bat)$/i.test(command);
    return this.terminals.spawnProgram(project.id, {
      name: opts.name ?? this.name,
      file: isShim ? (process.env.ComSpec || 'cmd.exe') : command,
      args: isShim ? ['/d', '/c', command, ...args] : args,
      kind: 'agent',
      meta: { agentId: this.id, sessionId: opts.sessionId },
    });
  }

  start(project, opts = {}) {
    return this.#launch(project, this.newArgs(), opts);
  }

  resume(project, opts = {}) {
    return this.#launch(project, this.resumeArgs(opts), { ...opts, name: `${this.name} (resume)` });
  }

  stop(session) {
    if (session?.terminalId) this.host.pty.stop(session.terminalId);
  }

  sendInput(session, data) {
    if (!session?.terminalId) return false;
    return this.host.pty.write(session.terminalId, data);
  }
}
