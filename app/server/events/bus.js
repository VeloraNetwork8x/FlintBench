import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** Event types and whether they are persisted to the project's activity log. */
export const EVENT_POLICY = {
  'project.discovered': { persist: false },
  'project.added': { persist: true },
  'project.removed': { persist: false },
  'project.opened': { persist: true },
  'project.relocation_found': { persist: false }, // a missing project's folder seems to be elsewhere
  'project.relocated': { persist: true }, // its path was updated to the new folder
  'file.changed': { persist: false },
  'file.activity': { persist: true }, // aggregated bucket, see ActivityAggregator
  'file.recorded': { persist: false }, // a file's change kept in its history (lines +/-): live lists
  'git.status_changed': { persist: false },
  'git.commit_created': { persist: true },
  'git.branch_changed': { persist: true },
  'git.pushed': { persist: true }, // commits reached the remote (from FlintBench or anywhere else)
  'docker.container_started': { persist: true },
  'docker.container_stopped': { persist: true },
  'process.started': { persist: true },
  'process.stopped': { persist: true },
  'editor.opened': { persist: true }, // an editor window is open on the project (VS Code)
  'editor.closed': { persist: true },
  'agent.started': { persist: true },
  'agent.stopped': { persist: true },
  'agent.turn_completed': { persist: false }, // a notification: an agent finished a task
  'agent.moved': { persist: true }, // a conversation moved between a FlintBench tab and a terminal window
  'work.updated': { persist: true },
  'github.repo_changed': { persist: false }, // a notification: new stars or forks on one of the owner's repositories
  'github.notification': { persist: false }, // a notification: something new in the GitHub inbox
  'github.inbox': { persist: false }, // how many GitHub notifications are unread (sidebar badge)
};

/**
 * In-memory fan-out. Subscribers: websocket hub, agent journal, insights.
 * Persistence is decided by EVENT_POLICY, never by the emitter.
 */
export class EventBus {
  constructor({ storage, log = console }) {
    this.storage = storage;
    this.log = log;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  emit(type, projectId, data = {}) {
    if (!EVENT_POLICY[type]) this.log.warn(`[events] unknown event type ${type}`);
    const event = { id: randomUUID(), type, projectId: projectId ?? null, at: Date.now(), data };
    this.emitter.emit(type, event);
    this.emitter.emit('*', event);
    if (EVENT_POLICY[type]?.persist && projectId) {
      this.storage.project(projectId)
        .then((store) => store.activity.append(event))
        .catch((error) => this.log.warn(`[events] persist ${type} failed: ${error.message}`));
    }
    return event;
  }

  on(type, handler) {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }
}

/**
 * Collapses high-frequency file.changed events into one persisted
 * `file.activity` record per project per 10-minute bucket.
 */
export class ActivityAggregator {
  constructor(bus, bucketMs = 10 * 60 * 1000) {
    this.bus = bus;
    this.bucketMs = bucketMs;
    this.buckets = new Map(); // projectId -> { bucket, count, files:Set }
    bus.on('file.changed', (event) => this.#track(event));
    this.timer = setInterval(() => this.flush(false), 60 * 1000);
    this.timer.unref();
  }

  #track(event) {
    const bucket = Math.floor(event.at / this.bucketMs);
    const current = this.buckets.get(event.projectId);
    if (current && current.bucket !== bucket) this.#write(event.projectId, current);
    const entry = current && current.bucket === bucket ? current : { bucket, count: 0, files: new Set() };
    entry.count += 1;
    if (entry.files.size < 500) entry.files.add(event.data.path);
    this.buckets.set(event.projectId, entry);
  }

  #write(projectId, entry) {
    this.buckets.delete(projectId);
    this.bus.emit('file.activity', projectId, {
      bucketStart: entry.bucket * this.bucketMs,
      events: entry.count,
      files: entry.files.size,
      // which files: lets a work session count distinct files across buckets and name the main ones
      paths: [...entry.files].slice(0, 40),
    });
  }

  flush(all = true) {
    const nowBucket = Math.floor(Date.now() / this.bucketMs);
    for (const [projectId, entry] of this.buckets) {
      if (all || entry.bucket < nowBucket) this.#write(projectId, entry);
    }
  }

  stop() {
    clearInterval(this.timer);
    this.flush(true);
  }
}
