import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from '../host/paths.js';

const EDITOR_POLL_MS = 10_000;
// the full process scan: every 15 s on a quiet machine, further apart when a scan is slow (a busy
// machine: agents and dev servers at work), up to two minutes; never two at once
const SCAN_MIN_MS = 15_000;
const SCAN_MAX_MS = 120_000;
// editors whose window title ends with "<folder> - <suffix>", by command name
const EDITOR_WINDOWS = {
  code: { process: 'Code', suffix: 'Visual Studio Code' },
  'code-insiders': { process: 'Code - Insiders', suffix: 'Visual Studio Code - Insiders' },
  cursor: { process: 'Cursor', suffix: 'Cursor' },
  windsurf: { process: 'Windsurf', suffix: 'Windsurf' },
  antigravity: { process: 'Antigravity', suffix: 'Antigravity' },
  codium: { process: 'VSCodium', suffix: 'VSCodium' },
};

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/;
const DEV_RUNTIMES = /^(node|nodemon|bun|deno|python\d*|py|pythonw|uvicorn|gunicorn|flask|go|cargo|java|dotnet|php|ruby|rails|air)(\.exe)?$/i;
const AGENT_PATTERNS = [
  // --chrome-native-host is the browser-extension bridge, not a coding session
  { agent: 'claude', test: (p) => (/^claude(\.exe)?$/i.test(p.name) || /@anthropic-ai[\\/]claude-code/i.test(p.cmd)) && !/--chrome-native-host\b/i.test(p.cmd) },
  { agent: 'codex', test: (p) => /^codex(\.exe)?$/i.test(p.name) || /@openai[\\/]codex/i.test(p.cmd) },
  { agent: 'antigravity', test: (p) => /^agy(\.exe)?$/i.test(p.name) },
];

const SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview', 'watch', 'test', 'build'];
const MAX_SUGGESTIONS = 40;
// folders that never hold a package of the project itself
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'venv', '__pycache__', 'graphify-out', 'tmp', 'temp']);
// npm lifecycle hooks: run by the package manager itself, not commands to start by hand
const HOOK_SCRIPT = /^(pre|post)?(install|uninstall|prepare|prepublish|prepublishOnly|prepack|postpack|publish|version)$/;
const PLACEHOLDER_SCRIPT = /no test specified/i;
const TEST_SCRIPT = /\b(jest|vitest|mocha|ava|playwright test|node --test|pytest)\b/;

const fileExists = (f) => fs.access(f).then(() => true, () => false);
const quoteArg = (p) => (/\s/.test(p) ? `"${p}"` : p);

/** '' (the project root) plus every folder up to two levels down that has its own package.json. */
async function packageDirs(root) {
  const dirs = [''];
  const walk = async (rel, depth) => {
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (await fileExists(path.join(root, sub, 'package.json'))) dirs.push(sub);
      if (depth < 2) await walk(sub, depth + 1);
    }
  };
  await walk('', 1);
  return dirs.slice(0, 16);
}

/** The package manager a folder uses: its own lockfile first, then the project root's. */
async function packageManager(root, dir) {
  for (const base of dir ? [path.join(root, dir), root] : [root]) {
    if (await fileExists(path.join(base, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await fileExists(path.join(base, 'yarn.lock'))) return 'yarn';
    if (await fileExists(path.join(base, 'bun.lockb')) || await fileExists(path.join(base, 'bun.lock'))) return 'bun';
    if (await fileExists(path.join(base, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

function runScript(pm, dir, script) {
  if (!dir) return `${pm} run ${script}`;
  const flag = { npm: '--prefix', pnpm: '--dir', yarn: '--cwd', bun: '--cwd' }[pm];
  return `${pm} ${flag} ${quoteArg(dir)} run ${script}`;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function dirSuggestions(root, dir) {
  const abs = path.join(root, dir);
  const has = (f) => fileExists(path.join(abs, f));
  const at = (f) => (dir ? `${dir}/${f}` : f);
  const out = [];
  const pkg = await readJson(path.join(abs, 'package.json'));
  // a sub-package is named by its folder: "pulse start" for packages/pulse
  const label = dir ? `${dir.split('/').pop()} ` : '';
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    const pm = await packageManager(root, dir);
    const names = Object.keys(pkg.scripts).filter((n) => typeof pkg.scripts[n] === 'string'
      && !HOOK_SCRIPT.test(n) && !PLACEHOLDER_SCRIPT.test(pkg.scripts[n]));
    names.sort((a, b) => (SCRIPT_ORDER.indexOf(a) + 1 || 99) - (SCRIPT_ORDER.indexOf(b) + 1 || 99));
    for (const n of names.slice(0, 12)) {
      out.push({
        name: `${label}${n}`.slice(0, 40), command: runScript(pm, dir, n), script: pkg.scripts[n], dir,
        kind: /^test/.test(n) || TEST_SCRIPT.test(pkg.scripts[n]) ? 'test' : 'process', source: at('package.json'),
      });
    }
  }
  if (dir) return out;
  const deno = (await readJson(path.join(abs, 'deno.json'))) ?? (await readJson(path.join(abs, 'deno.jsonc')));
  for (const [n, task] of Object.entries(deno?.tasks ?? {}).slice(0, 8)) {
    const body = typeof task === 'string' ? task : task?.command ?? '';
    out.push({ name: n, command: `deno task ${n}`, script: body, dir, kind: /^test/.test(n) ? 'test' : 'process', source: 'deno.json' });
  }
  const makefile = await fs.readFile(path.join(abs, 'Makefile'), 'utf8').catch(() => '');
  const targets = [...makefile.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1]);
  for (const t of [...new Set(targets)].slice(0, 8)) out.push({ name: `make ${t}`, command: `make ${t}`, script: null, dir, kind: /^test/.test(t) ? 'test' : 'process', source: 'Makefile' });
  if (await has('manage.py')) out.push({ name: 'django', command: 'python manage.py runserver', script: null, dir, kind: 'process', source: 'manage.py' });
  for (const f of ['app.py', 'main.py']) {
    if (await has(f)) out.push({ name: f.replace('.py', ''), command: `python ${f}`, script: null, dir, kind: 'process', source: f });
  }
  if (await has('go.mod')) out.push({ name: 'go run', command: 'go run .', script: null, dir, kind: 'process', source: 'go.mod' });
  if (await has('Cargo.toml')) out.push({ name: 'cargo run', command: 'cargo run', script: null, dir, kind: 'process', source: 'Cargo.toml' });
  if ((await has('pytest.ini') || await has('pyproject.toml')) && await has('tests')) {
    out.push({ name: 'pytest', command: 'python -m pytest', script: null, dir, kind: 'test', source: 'tests/' });
  }
  return out;
}

/**
 * Runtime domain: user-defined services (run in PTYs), detection of project processes
 * started outside FlintBench, listening ports, and project start/stop.
 * Emits through the bus: process.started / process.stopped.
 */
export class RuntimeService {
  constructor({ projects, host, terminals, storage, bus, docker, log = console }) {
    this.projects = projects;
    this.host = host;
    this.terminals = terminals;
    this.storage = storage;
    this.bus = bus;
    this.docker = docker;
    this.log = log;
    this.serviceRuns = new Map(); // `${projectId}:${serviceId}` -> { terminalId, url, startedAt }
    this.snapshot = { processes: [], ports: [], at: 0 };
    this.externalByProject = new Map(); // projectId -> Map(pid -> process)
    this.agentProcesses = [];
    this.listeners = new Set();
  }

  async init() {
    this.host.pty.on('data', (id, chunk) => this.#scanOutput(id, chunk));
    this.host.pty.on('exit', (t) => this.#onExit(t));
    this.projects.on('added', (s) => this.publish(s.id).catch(() => {}));
    for (const id of this.projects.live.keys()) await this.publish(id);
    this.#scanLoop(0);
    // VS Code opening and closing shows on the cards within seconds: its window titles alone are
    // read more often than the full process scan, and only while VS Code runs
    this.editorTimer = setInterval(() => this.#pollEditors(), EDITOR_POLL_MS);
    this.editorTimer.unref();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.editorTimer);
  }

  async #pollEditors() {
    if (this.monitoring || this.editorPolling) return;
    this.editorPolling = true;
    try {
      await this.#detectEditors(this.snapshot?.processes ?? []);
    } catch { /* next poll */ } finally {
      this.editorPolling = false;
    }
  }

  onAgentProcesses(fn) {
    this.listeners.add(fn);
  }

  /* ---------------- service definitions ---------------- */

  async definitions(projectId) {
    const data = await this.storage.project(projectId);
    return data.config.get().services ?? [];
  }

  /**
   * Commands the project really declares, read from its own files: package.json scripts (the root
   * and every package folder up to two levels down, e.g. packages/*, apps/*, frontend/), deno.json
   * tasks, Makefile targets and the usual entry points (manage.py, app.py, go.mod, Cargo.toml).
   * Placeholder scripts (npm init's "no test specified") and install hooks are left out.
   * A command for a sub-package runs from the project root through the package manager's own
   * directory flag, so the service keeps the project root as its terminal folder.
   */
  async suggestions(projectId) {
    const project = this.projects.get(projectId);
    const defined = new Set((await this.definitions(projectId)).map((s) => s.command));
    const root = project.path;
    const out = [];
    for (const dir of await packageDirs(root)) out.push(...await dirSuggestions(root, dir));
    return out.filter((s) => !defined.has(s.command)).slice(0, MAX_SUGGESTIONS);
  }

  async defineService(projectId, input) {
    const name = String(input.name ?? '').trim().slice(0, 40);
    const command = String(input.command ?? '').trim();
    if (!name) throw httpError(400, 'Service name is required');
    if (!command || command.length > 2000) throw httpError(400, 'Command is required');
    const port = input.port ? Number(input.port) : null;
    if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw httpError(400, 'Invalid port');
    const service = {
      id: input.id ?? crypto.randomBytes(4).toString('hex'),
      name,
      command,
      port,
      kind: input.kind === 'test' ? 'test' : 'process',
      autostart: Boolean(input.autostart),
    };
    const data = await this.storage.project(projectId);
    await data.config.update((c) => {
      const idx = c.services.findIndex((s) => s.id === service.id);
      if (idx >= 0) c.services[idx] = { ...c.services[idx], ...service };
      else c.services.push(service);
    });
    await this.publish(projectId);
    return service;
  }

  async deleteService(projectId, serviceId) {
    const run = this.serviceRuns.get(`${projectId}:${serviceId}`);
    if (run) this.host.pty.stop(run.terminalId);
    const data = await this.storage.project(projectId);
    await data.config.update((c) => { c.services = c.services.filter((s) => s.id !== serviceId); });
    await this.publish(projectId);
  }

  /* ---------------- service lifecycle ---------------- */

  async startService(projectId, serviceId) {
    const def = (await this.definitions(projectId)).find((s) => s.id === serviceId);
    if (!def) throw httpError(404, 'Service not found');
    const key = `${projectId}:${serviceId}`;
    const current = this.serviceRuns.get(key);
    if (current && !this.host.pty.get(current.terminalId)?.exited) return this.host.pty.get(current.terminalId);
    if (current) this.host.pty.remove(current.terminalId);
    const terminal = this.terminals.spawnCommand(projectId, {
      name: def.name,
      command: def.command,
      kind: 'service',
      meta: { serviceId },
    });
    this.serviceRuns.set(key, { terminalId: terminal.id, url: null, startedAt: Date.now() });
    this.bus.emit('process.started', projectId, { service: def.name, command: def.command, managed: true });
    await this.publish(projectId);
    setTimeout(() => this.monitor().catch(() => {}), 4000);
    return terminal;
  }

  async stopService(projectId, serviceId) {
    const run = this.serviceRuns.get(`${projectId}:${serviceId}`);
    if (!run) return;
    this.host.pty.stop(run.terminalId);
  }

  async restartService(projectId, serviceId) {
    const run = this.serviceRuns.get(`${projectId}:${serviceId}`);
    if (run && !this.host.pty.get(run.terminalId)?.exited) {
      this.host.pty.stop(run.terminalId);
      await waitFor(() => this.host.pty.get(run.terminalId)?.exited, 6000);
    }
    return this.startService(projectId, serviceId);
  }

  /** Dashboard "Start": autostart services (or the first one) + compose up. */
  async startProject(projectId) {
    const project = this.projects.get(projectId);
    const defs = await this.definitions(projectId);
    const chosen = defs.filter((d) => d.autostart && d.kind !== 'test');
    const toStart = chosen.length ? chosen : defs.filter((d) => d.kind !== 'test').slice(0, 1);
    const started = [];
    for (const def of toStart) {
      await this.startService(projectId, def.id);
      started.push(def.name);
    }
    if (project.docker.composeFiles.length && this.docker?.available()) {
      await this.docker.compose(projectId, 'up');
      started.push('compose');
    }
    if (!started.length) throw httpError(409, 'Nothing to start. Define a service in Services first.');
    return started;
  }

  async stopProject(projectId) {
    const project = this.projects.get(projectId);
    const stopped = [];
    for (const [key, run] of this.serviceRuns) {
      if (!key.startsWith(`${projectId}:`)) continue;
      const t = this.host.pty.get(run.terminalId);
      if (t && !t.exited) {
        this.host.pty.stop(run.terminalId);
        stopped.push(t.name);
      }
    }
    if (project.docker.containers.some((c) => c.state === 'running') && project.docker.composeFiles.length) {
      await this.docker.compose(projectId, 'stop');
      stopped.push('compose');
    }
    // started outside FlintBench (`npm run dev` in your own terminal): each one with its process
    // tree, never an agent, and only after checking the pid is still that program (Windows reuses
    // pids). The terminal it ran in stays open, back at its prompt.
    const external = [];
    const known = [...(this.externalByProject.get(projectId)?.values() ?? [])];
    if (known.length) {
      const fresh = new Map((await this.host.processes.list().catch(() => [])).map((p) => [p.pid, p]));
      for (const proc of known) {
        const now = fresh.get(proc.pid);
        if (!now || now.cmd.slice(0, 300) !== proc.cmd || AGENT_PATTERNS.some((a) => a.test(now))) continue;
        this.host.exec.killTree(proc.pid);
        external.push({ pid: proc.pid, name: proc.name, ports: proc.ports });
      }
      await waitFor(() => external.every((p) => !isAlive(p.pid)), 5000);
      this.monitor().catch(() => {});
    }
    return { stopped: [...stopped, ...external.map((p) => p.name)], external };
  }

  #scanOutput(terminalId, chunk) {
    const t = this.host.pty.get(terminalId);
    if (!t || t.kind !== 'service') return;
    const m = URL_RE.exec(chunk.replace(ANSI, ''));
    if (!m) return;
    const run = this.serviceRuns.get(`${t.projectId}:${t.meta.serviceId}`);
    if (run && run.terminalId === terminalId && run.url !== `http://localhost:${m[1]}`) {
      run.url = `http://localhost:${m[1]}`;
      this.publish(t.projectId).catch(() => {});
    }
  }

  async #onExit(t) {
    if (t.kind !== 'service' || !t.projectId || !this.projects.has(t.projectId)) return;
    const defs = await this.definitions(t.projectId);
    const def = defs.find((d) => d.id === t.meta.serviceId);
    // stopped on request: the kill's exit code (1 on Windows) is not reported as an error
    this.bus.emit('process.stopped', t.projectId, { service: t.name, exitCode: t.stoppedByUser ? null : t.exitCode, byUser: t.stoppedByUser, managed: true });
    if (def?.kind === 'test' && !t.stoppedByUser) {
      const data = await this.storage.project(t.projectId);
      await data.config.update((c) => { c.lastTestRun = { service: def.name, exitCode: t.exitCode, at: Date.now() }; });
    }
    await this.publish(t.projectId);
  }

  /* ---------------- live state ---------------- */

  async publish(projectId) {
    if (!this.projects.has(projectId)) return;
    const defs = await this.definitions(projectId);
    const ports = this.#managedPorts();
    const services = defs.map((def) => {
      const run = this.serviceRuns.get(`${projectId}:${def.id}`);
      const t = run ? this.host.pty.get(run.terminalId) : null;
      const status = !t ? 'stopped' : !t.exited ? 'running' : t.stoppedByUser ? 'stopped' : t.exitCode === 0 ? 'exited' : 'failed';
      const servicePorts = t && !t.exited ? (ports.get(t.pid) ?? []) : [];
      const port = servicePorts[0] ?? (run?.url ? Number(run.url.split(':').pop()) : null) ?? null;
      return {
        ...def,
        status,
        exitCode: t?.exited && !t.stoppedByUser ? t.exitCode : null,
        terminalId: t?.id ?? null,
        startedAt: run?.startedAt ?? null,
        ports: servicePorts,
        url: status === 'running' && (port || def.port) ? `http://localhost:${port || def.port}` : null,
      };
    });
    const external = [...(this.externalByProject.get(projectId)?.values() ?? [])];
    const data = await this.storage.project(projectId);
    this.projects.patch(projectId, 'runtime', {
      services,
      processes: external,
      ports: [...new Set([...services.flatMap((s) => s.ports), ...external.flatMap((p) => p.ports)])].sort((a, b) => a - b),
      lastTestRun: data.config.get().lastTestRun ?? null,
      cwdAttribution: this.host.processes.cwdSupported,
      scannedAt: this.snapshot.at,
    });
  }

  /** root pty pid -> listening ports of its whole process tree */
  #managedPorts() {
    const map = new Map();
    const { processes, ports } = this.snapshot;
    if (!processes.length) return map;
    for (const t of this.host.pty.list((x) => !x.exited)) {
      const tree = this.host.processes.descendantsOf(processes, [t.pid]);
      map.set(t.pid, [...new Set(ports.filter((p) => tree.has(p.pid)).map((p) => p.port))].sort((a, b) => a - b));
    }
    return map;
  }

  /**
   * Editors open on a project. VS Code keeps no per-window record of its folder, but every window
   * title ends with "<folder> - Visual Studio Code"; the folder name is matched to a project, and a
   * name shared by several projects is settled by VS Code's own most recently used folders.
   */
  async #detectEditors(processes) {
    const code = processes.filter((p) => /^code(\.exe)?$/i.test(p.name));
    const byProject = new Map();
    {
      const started = new Map(code.map((p) => [p.pid, p.startedAt]));
      // a window opened since the last process scan has no start time yet: keep the one known
      const sinceOf = (id, pid) => started.get(pid) ?? this.projects.live.get(id)?.editors?.find((e) => e.id === 'vscode')?.since ?? Date.now();
      // no VS Code in the last scan: no window to read (a new one shows at the next scan)
      const titles = code.length ? await this.host.processes.windowTitles(['Code']) : [];
      const projects = [...this.projects.live.values()].filter((s) => s.exists);
      const base = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
      for (const { pid, title } of titles) {
        const m = /^(?:● )?(.*?) - Visual Studio Code(?: - Insiders)?$/.exec(title);
        if (!m) continue;
        const root = m[1].split(' - ').pop().replace(/ \(Workspace\)$/, '').trim().toLowerCase();
        let matches = projects.filter((s) => base(s.path) === root);
        if (matches.length > 1) {
          const recent = await this.host.processes.vscodeRecentFolders();
          const hit = recent.find((r) => matches.some((s) => this.host.paths.pathKey(s.path) === this.host.paths.pathKey(r.path)));
          matches = hit ? matches.filter((s) => this.host.paths.pathKey(s.path) === this.host.paths.pathKey(hit.path)) : matches.slice(0, 1);
        }
        for (const s of matches) {
          if (!byProject.has(s.id)) byProject.set(s.id, [{ id: 'vscode', name: 'VS Code', since: sinceOf(s.id, pid), pid, root: m[1].split(' - ').pop().trim() }]);
        }
      }
    }
    for (const s of this.projects.live.values()) {
      const next = byProject.get(s.id) ?? [];
      const prev = s.editors ?? [];
      if (JSON.stringify(next) === JSON.stringify(prev)) continue;
      // recorded for work sessions: which editor was open on the project, and when
      for (const e of next) if (!prev.some((x) => x.id === e.id)) this.bus.emit('editor.opened', s.id, { name: e.name, since: e.since });
      for (const e of prev) if (!next.some((x) => x.id === e.id)) this.bus.emit('editor.closed', s.id, { name: e.name, since: e.since });
      this.projects.patch(s.id, 'editors', next);
    }
  }

  /**
   * VS Code on this project: bring its window to the front when it is open, open it otherwise.
   */
  async focusEditor(projectId) {
    const project = this.projects.get(projectId);
    const editor = (project.editors ?? []).find((e) => e.id === 'vscode');
    if (editor?.pid) {
      const r = await this.host.processes.focusWindow(editor.pid, `${editor.root} - Visual Studio Code`);
      if (r.focused || r.title) return { action: 'focused', ...r };
    }
    this.host.desktop.openInEditor('code', project.path);
    setTimeout(() => this.monitor().catch(() => {}), 4000).unref?.();
    return { action: 'opened' };
  }

  /**
   * "Open in editor": launches the configured editor on the project and brings its window to the
   * front. A launch from a background process cannot take the foreground by itself, so for the
   * VS Code family the project window is awaited (new or reused) and focused explicitly.
   */
  async openEditor(projectId, command, { file = null } = {}) {
    const project = this.projects.get(projectId);
    const cmd = String(command || 'code').trim();
    const base = path.basename(cmd).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
    const family = EDITOR_WINDOWS[base];
    const folder = path.basename(project.path);
    const focusOpen = async () => {
      const windows = await this.host.processes.windowTitles([family.process]);
      const win = windows.find((w) => w.title.includes(`${folder} - ${family.suffix}`));
      return win ? this.host.processes.focusWindow(win.pid, `${folder} - ${family.suffix}`) : null;
    };
    // a file is always handed to the editor (its window opens it); a window alone is just focused
    if (family && process.platform === 'win32' && !file) {
      const already = await focusOpen().catch(() => null);
      if (already?.focused) return { action: 'focused' };
    }
    this.host.desktop.openInEditor(cmd, project.path, file, { goto: Boolean(family) });
    if (family && process.platform === 'win32') {
      // the window shows up a moment later; keep looking for ~10 s in the background
      (async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const r = await focusOpen().catch(() => null);
          if (r) return;
        }
      })();
    }
    setTimeout(() => this.monitor().catch(() => {}), 4000).unref?.();
    return { action: 'opened' };
  }

  /** The window hosting a process: the process itself or its closest ancestor that owns one. */
  async focusProcessWindow(pid) {
    const byPid = new Map(this.snapshot.processes.map((p) => [p.pid, p]));
    const chain = [];
    for (let p = byPid.get(pid), guard = 0; p && guard < 12; p = byPid.get(p.ppid), guard++) chain.push(p.pid);
    if (!chain.length) chain.push(pid);
    const windows = await this.host.processes.windowsOf(chain);
    const owner = chain.find((id) => windows.some((w) => w.pid === id));
    if (!owner) return { focused: false, reason: 'no-window' };
    const r = await this.host.processes.focusWindow(owner);
    return { ...r, app: byPid.get(owner)?.name ?? null };
  }

  /** The periodic scan: the next one waits longer when this one was slow (or failed). */
  #scanLoop(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const started = Date.now();
      const ok = await this.monitor().then(() => !this.lastScanFailed, () => false);
      const took = Date.now() - started;
      // a scan taking 3 s waits 15 s; one taking 8 s waits 48 s; a failed one waits a minute or more
      const next = ok ? Math.min(SCAN_MAX_MS, Math.max(SCAN_MIN_MS, took * 6)) : Math.min(SCAN_MAX_MS, Math.max(60_000, took * 6));
      this.scanInterval = next;
      if (!this.stopped) this.#scanLoop(next);
    }, delay);
    this.timer.unref?.();
  }

  /** Periodic process + port snapshot (reconciliation; there is no portable process event API). */
  async monitor() {
    if (this.monitoring) {
      // a caller needs a snapshot taken after now: run once more when this one ends
      this.monitorAgain = true;
      return;
    }
    this.monitoring = true;
    this.lastScanFailed = false;
    try {
      const [processes, ports] = await Promise.all([
        this.host.processes.list(),
        this.host.processes.listeningPorts().catch(() => []),
      ]);
      this.snapshot = { processes, ports, at: Date.now() };
      const managed = this.host.processes.descendantsOf(processes, [...this.host.pty.livePids(), process.pid]);
      const portsByPid = new Map();
      for (const p of ports) {
        if (!portsByPid.has(p.pid)) portsByPid.set(p.pid, []);
        portsByPid.get(p.pid).push(p.port);
      }

      // agent processes (managed or not)
      this.agentProcesses = [];
      for (const p of processes) {
        const match = AGENT_PATTERNS.find((a) => a.test(p));
        if (match) this.agentProcesses.push({ agent: match.agent, pid: p.pid, startedAt: p.startedAt ?? null, managed: managed.has(p.pid), cmd: p.cmd.slice(0, 300) });
      }
      // drop child processes of the same agent (node -> claude.exe etc.)
      const agentPids = new Set(this.agentProcesses.map((a) => a.pid));
      const byPid = new Map(processes.map((p) => [p.pid, p]));
      this.agentProcesses = this.agentProcesses.filter((a) => !agentPids.has(byPid.get(a.pid)?.ppid));
      // dev servers listening on a port: their working folder can tell the project when the command
      // line does not (`npx serve`, `python -m http.server`, `node server.js`). One lookup with the agents'.
      const listeners = processes.filter((p) => !managed.has(p.pid) && DEV_RUNTIMES.test(p.name) && portsByPid.has(p.pid) && !AGENT_PATTERNS.some((a) => a.test(p)));
      let cwds = new Map();
      if (this.host.processes.cwdSupported && (this.agentProcesses.length || listeners.length)) {
        cwds = await this.host.processes.cwds([...new Set([...this.agentProcesses.map((a) => a.pid), ...listeners.map((p) => p.pid)])]).catch(() => new Map());
        for (const a of this.agentProcesses) a.cwd = cwds.get(a.pid) ?? null;
      }
      for (const fn of this.listeners) fn(this.agentProcesses);
      await this.#detectEditors(processes).catch(() => {});

      // external project processes: command line references the project folder
      const projects = [...this.projects.live.values()].filter((s) => s.exists);
      const needles = projects.map((s) => ({ id: s.id, keys: [s.path.toLowerCase(), s.path.toLowerCase().replaceAll('\\', '/')] }));
      const next = new Map(projects.map((s) => [s.id, new Map()]));
      for (const p of processes) {
        if (managed.has(p.pid) || !DEV_RUNTIMES.test(p.name)) continue;
        const cmd = p.cmd.toLowerCase();
        let owner = null;
        let best = 0;
        for (const n of needles) {
          for (const key of n.keys) {
            if (key.length > best && (cmd.includes(`${key}\\`) || cmd.includes(`${key}/`) || cmd.includes(`${key}"`) || cmd.endsWith(key) || cmd.includes(`${key} `))) {
              owner = n.id;
              best = key.length;
            }
          }
        }
        let evidence = 'command-line';
        if (!owner && portsByPid.has(p.pid) && cwds.get(p.pid)) {
          // not named on the command line: the folder it runs in, when that is inside a project
          const cwd = cwds.get(p.pid).toLowerCase().replaceAll('/', '\\').replace(/\\+$/, '');
          for (const n of needles) {
            const key = n.keys[0].replace(/[\\/]+$/, '');
            if (key.length > best && (cwd === key || cwd.startsWith(`${key}\\`))) {
              owner = n.id;
              best = key.length;
              evidence = 'cwd';
            }
          }
        }
        if (!owner) continue;
        const tree = this.host.processes.descendantsOf(processes, [p.pid]);
        const procPorts = [...new Set([...tree].flatMap((pid) => portsByPid.get(pid) ?? []))].sort((a, b) => a - b);
        next.get(owner).set(p.pid, { pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 300), ports: procPorts, evidence });
      }
      // collapse process trees: keep the top-most matching process
      for (const [id, map] of next) {
        for (const [pid, proc] of map) {
          const parent = byPid.get(pid)?.ppid;
          if (parent && map.has(parent)) {
            map.get(parent).ports = [...new Set([...map.get(parent).ports, ...proc.ports])];
            map.delete(pid);
          }
        }
        const prev = this.externalByProject.get(id) ?? new Map();
        for (const [pid, proc] of map) {
          if (!prev.has(pid) && this.snapshot.at && prev !== undefined && this.started) this.bus.emit('process.started', id, { name: proc.name, pid, ports: proc.ports, managed: false });
        }
        for (const [pid, proc] of prev) {
          if (!map.has(pid)) this.bus.emit('process.stopped', id, { name: proc.name, pid, managed: false });
        }
      }
      this.externalByProject = next;
      this.started = true;
      for (const s of projects) await this.publish(s.id);
    } catch (error) {
      this.lastScanFailed = true;
      this.log.warn(`[runtime] process scan failed: ${error.message} (next one in a minute or more)`);
    } finally {
      this.monitoring = false;
      if (this.monitorAgain) {
        this.monitorAgain = false;
        this.monitor().catch(() => {});
      }
    }
  }
}

/** True while a process with this pid exists (signal 0 only checks; EPERM: exists, not ours). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitFor(check, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
