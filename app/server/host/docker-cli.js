import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { run, spawnStream, which } from './exec.js';
import { httpError } from './paths.js';

function parseLabels(raw) {
  const labels = {};
  if (!raw) return labels;
  // docker formats labels as k=v,k=v (values may contain commas in rare cases; good enough for compose keys)
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) labels[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return labels;
}

function parseContainer(line) {
  const c = JSON.parse(line);
  const labels = parseLabels(c.Labels);
  const status = c.Status || '';
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1]?.replace('health: ', '') ?? null;
  return {
    id: c.ID,
    name: c.Names,
    image: c.Image,
    state: c.State, // running | exited | created | paused | restarting
    status,
    health,
    ports: c.Ports || '',
    composeProject: labels['com.docker.compose.project'] ?? null,
    composeService: labels['com.docker.compose.service'] ?? null,
    workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
    configFiles: labels['com.docker.compose.project.config_files'] ?? null,
  };
}

/**
 * Docker through its CLI. Emits 'container' events from `docker events` and 'status' changes.
 */
export class DockerCli extends EventEmitter {
  constructor({ log = console } = {}) {
    super();
    this.log = log;
    this.stream = null;
    this.restartTimer = null;
    this.enabled = false;
    this.status = { installed: false, running: false, version: null, error: null };
  }

  async detect() {
    if (!which('docker')) {
      this.status = { installed: false, running: false, version: null, error: 'docker CLI not found' };
      return this.status;
    }
    const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 }).catch((e) => ({ code: 1, stderr: e.message, stdout: '' }));
    const running = r.code === 0 && Boolean(r.stdout.trim());
    const before = this.status?.running;
    this.status = {
      installed: true,
      running,
      version: running ? r.stdout.trim() : null,
      error: running ? null : 'Docker engine is not running',
    };
    // every detection that flips the engine state is announced (Docker Desktop started or quit)
    if (before !== undefined && before !== running) this.emit('status', this.status);
    return this.status;
  }

  async containers() {
    if (!this.status.running) return [];
    const r = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeout: 15_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'docker ps failed');
    return r.stdout.split('\n').filter((l) => l.trim()).map(parseContainer);
  }

  async composeServices(cwd, file) {
    const r = await run('docker', ['compose', '-f', file, 'config', '--services'], { cwd, timeout: 15_000 });
    if (r.code !== 0) return [];
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async compose(cwd, file, action, service) {
    const actions = { up: ['up', '-d'], stop: ['stop'], restart: ['restart'], down: ['down'] };
    if (!actions[action]) throw httpError(400, 'Unknown compose action');
    if (service && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service)) throw httpError(400, 'Invalid service name');
    const args = ['compose', '-f', file, ...actions[action]];
    if (service) args.push(service);
    const r = await run('docker', args, { cwd, timeout: 300_000 });
    if (r.code !== 0) throw Object.assign(new Error(r.stderr.trim().split('\n').slice(-3).join('\n') || 'docker compose failed'), { status: 409, expose: true });
    return r.stderr.trim();
  }

  async container(id, action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw httpError(400, 'Unknown container action');
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw httpError(400, 'Invalid container id');
    const r = await run('docker', [action, id], { timeout: 60_000 });
    if (r.code !== 0) throw Object.assign(new Error(r.stderr.trim() || `docker ${action} failed`), { status: 409, expose: true });
  }

  /** Long-running `docker events` stream; restarts with backoff (Docker Desktop may start later). */
  startEvents() {
    this.enabled = true;
    this.#spawnEvents(0);
  }

  #spawnEvents(attempt) {
    if (!this.enabled || this.stream) return;
    if (!which('docker')) return;
    const child = spawnStream('docker', ['events', '--format', '{{json .}}', '--filter', 'type=container']);
    this.stream = child;
    let gotData = false;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      gotData = true;
      try {
        const e = JSON.parse(line);
        this.emit('container', {
          action: e.Action || e.status,
          id: e.id || e.Actor?.ID,
          name: e.Actor?.Attributes?.name,
          workingDir: e.Actor?.Attributes?.['com.docker.compose.project.working_dir'] ?? null,
          service: e.Actor?.Attributes?.['com.docker.compose.service'] ?? null,
        });
      } catch {
        // ignore malformed line
      }
    });
    child.on('error', () => {});
    child.on('close', () => {
      this.stream = null;
      this.emit('stream-closed');
      if (!this.enabled) return;
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));
      this.restartTimer = setTimeout(async () => {
        await this.detect().catch(() => {});
        this.#spawnEvents(gotData ? 0 : attempt + 1);
      }, delay);
      this.restartTimer.unref();
    });
  }

  stopEvents() {
    this.enabled = false;
    clearTimeout(this.restartTimer);
    this.stream?.kill();
    this.stream = null;
  }

  get streaming() {
    return Boolean(this.stream) && this.status.running;
  }
}
