import path from 'node:path';
import { httpError } from '../host/paths.js';

/**
 * Docker domain: maps containers to projects through Compose labels
 * (com.docker.compose.project.working_dir). Event driven via `docker events`,
 * with a periodic snapshot as fallback.
 */
export class DockerService {
  constructor({ projects, host, bus, settings, log = console }) {
    this.projects = projects;
    this.host = host;
    this.docker = host.docker;
    this.bus = bus;
    this.settings = settings;
    this.log = log;
    this.containers = [];
    this.composeServices = new Map(); // projectId -> string[]
    this.timer = null;
  }

  available() {
    return this.settings.get().docker.enabled && this.docker.status.running;
  }

  status() {
    return { enabled: this.settings.get().docker.enabled, ...this.docker.status, streaming: this.docker.streaming };
  }

  async init() {
    this.docker.on('container', () => this.#scheduleSnapshot());
    this.docker.on('status', () => this.#scheduleSnapshot());
    this.projects.on('added', (s) => this.#publish(s.id));
    this.projects.on('file', ({ projectId, path: p }) => {
      if (/^(docker-)?compose\.ya?ml$/.test(p)) {
        this.composeServices.delete(projectId);
        this.projects.refreshDetection(projectId).then(() => this.#publish(projectId)).catch(() => {});
      }
    });
    this.settings.on('changed', (s, patch) => {
      if (patch.docker) this.#apply().catch(() => {});
    });
    await this.#apply();
    // engine down: look again every 10 s so starting Docker Desktop shows up quickly
    this.timer = setInterval(() => {
      if (!this.settings.get().docker.enabled) return;
      if (!this.docker.streaming || !this.docker.status.running) {
        this.docker.detect().then((st) => {
          if (st.running && !this.docker.streaming) this.docker.startEvents();
          return this.snapshot();
        }).catch(() => {});
      }
    }, 10_000);
    this.timer.unref();
  }

  async #apply() {
    if (!this.settings.get().docker.enabled) {
      this.docker.stopEvents();
      this.containers = [];
      for (const id of this.projects.live.keys()) this.#publish(id);
      return;
    }
    await this.docker.detect();
    this.docker.startEvents();
    await this.snapshot();
  }

  stop() {
    clearInterval(this.timer);
    this.docker.stopEvents();
  }

  #scheduleSnapshot() {
    clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => this.snapshot().catch(() => {}), 400);
  }

  async snapshot() {
    if (!this.available()) {
      this.containers = [];
    } else {
      try {
        this.containers = await this.docker.containers();
      } catch (error) {
        this.log.warn(`[docker] ${error.message}`);
        await this.docker.detect();
        this.containers = [];
      }
    }
    for (const id of this.projects.live.keys()) await this.#publish(id);
  }

  #owner(container) {
    if (!container.workingDir) return null;
    const key = this.host.paths.pathKey(container.workingDir);
    for (const s of this.projects.live.values()) {
      if (s.pathKey === key || this.host.paths.isInside(s.path, container.workingDir)) return s.id;
    }
    return null;
  }

  async #publish(projectId) {
    if (!this.projects.has(projectId)) return;
    const project = this.projects.get(projectId);
    const containers = this.containers.filter((c) => this.#owner(c) === projectId).map((c) => ({
      id: c.id, name: c.name, image: c.image, state: c.state, status: c.status, health: c.health,
      ports: c.ports, service: c.composeService, composeProject: c.composeProject,
    }));
    const composeFiles = project.composeFiles ?? [];
    if (composeFiles.length && this.available() && !this.composeServices.has(projectId)) {
      const services = await this.docker.composeServices(project.path, path.join(project.path, composeFiles[0])).catch(() => []);
      this.composeServices.set(projectId, services);
    }
    const prev = new Map((project.docker.containers ?? []).map((c) => [c.id, c.state]));
    for (const c of containers) {
      const before = prev.get(c.id);
      if (before && before !== c.state) {
        if (c.state === 'running') this.bus.emit('docker.container_started', projectId, { name: c.name, service: c.service });
        else if (before === 'running') this.bus.emit('docker.container_stopped', projectId, { name: c.name, service: c.service, status: c.status });
      }
    }
    this.projects.patch(projectId, 'docker', {
      available: this.available(),
      composeFiles,
      composeServices: this.composeServices.get(projectId) ?? [],
      containers,
      running: containers.filter((c) => c.state === 'running').length,
      total: Math.max(containers.length, this.composeServices.get(projectId)?.length ?? 0),
    });
  }

  async compose(projectId, action, service) {
    if (!this.available()) throw httpError(409, 'Docker is not running');
    const project = this.projects.get(projectId);
    const file = project.composeFiles?.[0];
    if (!file) throw httpError(400, 'No compose file in this project');
    const out = await this.docker.compose(project.path, path.join(project.path, file), action, service);
    await this.snapshot();
    return out;
  }

  async container(projectId, containerId, action) {
    if (!this.available()) throw httpError(409, 'Docker is not running');
    const owned = this.containers.find((c) => c.id.startsWith(containerId) && this.#owner(c) === projectId);
    if (!owned) throw httpError(404, 'Container does not belong to this project');
    await this.docker.container(owned.id, action);
    await this.snapshot();
  }
}
