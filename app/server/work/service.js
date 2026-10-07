import crypto from 'node:crypto';
import { httpError } from '../host/paths.js';

export const WORK_STATUSES = ['planned', 'in_progress', 'blocked', 'completed'];

/** What a note is about, picked when it is written. */
export const NOTE_TYPES = ['note', 'decision', 'goal', 'constraint', 'state'];

/** The free text older versions kept becomes the first note, so nothing written is lost. */
function migrateFreeText(n) {
  n.entries ??= [];
  if (n.text?.trim()) {
    n.entries.unshift({ id: crypto.randomUUID(), type: 'note', text: n.text.trim().slice(0, 4000), at: n.updatedAt ?? Date.now() });
    n.text = '';
  }
}

export function notesView(n) {
  const entries = [...(n?.entries ?? [])];
  if (n?.text?.trim()) entries.unshift({ id: 'free-text', type: 'note', text: n.text.trim(), at: n.updatedAt ?? 0 });
  return { entries: entries.sort((a, b) => b.at - a.at), updatedAt: n?.updatedAt ?? null, text: n?.text ?? '' };
}

/** Lightweight current-work tracking, stored only in FlintBench's data directory. */
export class WorkService {
  constructor({ storage, projects, bus }) {
    this.storage = storage;
    this.projects = projects;
    this.bus = bus;
  }

  async init() {
    this.projects.on('added', (s) => this.publish(s.id).catch(() => {}));
    for (const id of this.projects.live.keys()) await this.publish(id);
  }

  async list(projectId) {
    this.projects.get(projectId);
    const data = await this.storage.project(projectId);
    return data.work.get().items;
  }

  #clean(input, partial) {
    const out = {};
    if (!partial || 'title' in input) {
      const title = String(input.title ?? '').trim();
      if (!title || title.length > 160) throw httpError(400, 'Title must be 1–160 characters');
      out.title = title;
    }
    if ('status' in input) {
      if (!WORK_STATUSES.includes(input.status)) throw httpError(400, 'Unknown status');
      out.status = input.status;
    }
    if ('branch' in input) out.branch = input.branch ? String(input.branch).slice(0, 200) : null;
    if ('notes' in input) out.notes = String(input.notes ?? '').slice(0, 20_000);
    return out;
  }

  async create(projectId, input) {
    const project = this.projects.get(projectId);
    const fields = this.#clean(input, false);
    const now = Date.now();
    const item = {
      id: crypto.randomBytes(5).toString('hex'),
      title: fields.title,
      status: fields.status ?? 'planned',
      branch: 'branch' in fields ? fields.branch : project.git?.branch ?? null,
      notes: fields.notes ?? '',
      createdAt: now,
      updatedAt: now,
      startedAt: fields.status === 'in_progress' ? now : null,
      completedAt: fields.status === 'completed' ? now : null,
    };
    const data = await this.storage.project(projectId);
    await data.work.update((d) => { d.items.unshift(item); });
    this.bus.emit('work.updated', projectId, { id: item.id, title: item.title, status: item.status, action: 'created' });
    await this.publish(projectId);
    return item;
  }

  async update(projectId, itemId, input) {
    const fields = this.#clean(input, true);
    const data = await this.storage.project(projectId);
    let updated = null;
    let previousStatus = null;
    await data.work.update((d) => {
      const item = d.items.find((i) => i.id === itemId);
      if (!item) throw httpError(404, 'Work item not found');
      previousStatus = item.status;
      Object.assign(item, fields, { updatedAt: Date.now() });
      if (fields.status && fields.status !== previousStatus) {
        if (fields.status === 'in_progress' && !item.startedAt) item.startedAt = Date.now();
        item.completedAt = fields.status === 'completed' ? Date.now() : null;
      }
      updated = item;
    });
    if (fields.status && fields.status !== previousStatus) {
      this.bus.emit('work.updated', projectId, { id: itemId, title: updated.title, status: fields.status, from: previousStatus, action: 'status' });
    }
    await this.publish(projectId);
    return updated;
  }

  async remove(projectId, itemId) {
    const data = await this.storage.project(projectId);
    await data.work.update((d) => { d.items = d.items.filter((i) => i.id !== itemId); });
    await this.publish(projectId);
  }

  /** The project's notes, newest first; the single free note of older versions is the first one. */
  async notes(projectId) {
    this.projects.get(projectId);
    return notesView((await this.storage.project(projectId)).notes.get());
  }

  /** Older clients: replaces the free text (kept as the oldest note of type "note"). */
  async saveNotes(projectId, text) {
    this.projects.get(projectId);
    const value = String(text ?? '').slice(0, 100_000);
    const data = await this.storage.project(projectId);
    return notesView(await data.notes.update((n) => { n.text = value; n.updatedAt = Date.now(); }));
  }

  /** One note of a type the owner picked when writing it: note, decision, goal, constraint, state. */
  async addNote(projectId, { type, text }) {
    this.projects.get(projectId);
    const clean = String(text ?? '').trim().slice(0, 4000);
    if (!clean) throw httpError(400, 'Write the note first');
    if (!NOTE_TYPES.includes(type)) throw httpError(400, 'Unknown note type');
    const data = await this.storage.project(projectId);
    return notesView(await data.notes.update((n) => {
      migrateFreeText(n);
      n.entries.push({ id: crypto.randomUUID(), type, text: clean, at: Date.now() });
      n.entries = n.entries.slice(-200);
      n.updatedAt = Date.now();
    }));
  }

  async removeNote(projectId, noteId) {
    this.projects.get(projectId);
    const data = await this.storage.project(projectId);
    return notesView(await data.notes.update((n) => {
      if (noteId === 'free-text') n.text = ''; // the free text of older versions, shown as a note
      else n.entries = (n.entries ?? []).filter((e) => e.id !== noteId);
      n.updatedAt = Date.now();
    }));
  }

  async publish(projectId) {
    if (!this.projects.has(projectId)) return;
    const items = (await this.storage.project(projectId)).work.get().items;
    const inProgress = items.find((i) => i.status === 'in_progress') ?? null;
    this.projects.patch(projectId, 'work', {
      inProgress: inProgress ? { id: inProgress.id, title: inProgress.title, branch: inProgress.branch } : null,
      open: items.filter((i) => i.status !== 'completed').length,
      blocked: items.filter((i) => i.status === 'blocked').length,
    });
  }
}
