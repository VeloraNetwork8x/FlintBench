import { EventEmitter } from 'node:events';
import { httpError } from '../host/paths.js';
import { defaultSettings } from './defaults.js';
import { PROFILE_IDS, FEATURE_KEYS, DENSITIES, START_TABS, customDefaults } from '../../web/js/lib/profiles.js';

export const BACKGROUNDS = ['hive', 'dots', 'grid', 'lines', 'none'];
export const PROFILES = PROFILE_IDS;
const AGENT_USE = ['none', 'sometimes', 'mostly'];
const NOTIFY_LEVELS = ['all', 'important', 'quiet'];
const COMMAND = /^[\w.-]+$/;

/**
 * Settings saved by older versions, read in today's terms (in place). "Developer" became Pro, or
 * Custom built on Pro when its accent or background had been changed (they are part of a profile
 * now). An install that already ran had no setup to do: missing keys are filled with today's
 * defaults when the file is read, so it is told by its old profile id (dev / test) with a setup
 * never answered (no date) and not reset on purpose (`npm run reset-setup` marks `reset`).
 */
function migrate(s) {
  const untouched = !s.setup?.done && !s.setup?.at && !s.setup?.reset;
  if (untouched && (s.profile === 'dev' || s.profile === 'test')) s.setup = { done: true, answers: null };
  if (s.profile === 'dev') {
    const styled = Boolean(s.accent) || (s.background && s.background !== 'hive');
    if (styled) {
      const c = customDefaults('pro');
      s.customProfile = { ...c, style: { ...c.style, accent: s.accent || '', background: s.background || 'hive' } };
      s.profile = 'custom';
    } else {
      s.profile = 'pro';
    }
  }
  if (!PROFILE_IDS.includes(s.profile)) s.profile = 'builder';
  return s;
}
export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4];

/** Settings domain: validation + change notification over the SettingsStore. */
export class SettingsService extends EventEmitter {
  constructor({ storage, host }) {
    super();
    this.store = storage.settings;
    this.host = host;
  }

  get() {
    const stored = migrate(structuredClone(this.store.get()));
    const d = defaultSettings();
    // options added after these settings were saved take their default (stored ones win)
    const s = { ...d, ...stored, agents: { ...d.agents, ...stored.agents }, editor: { ...d.editor, ...stored.editor }, notifications: { ...d.notifications, ...stored.notifications } };
    // values saved by older versions are read in today's terms: the former 115% is now 100%
    return UI_SCALES.includes(s.uiScale) ? s : { ...s, uiScale: 1 };
  }

  async update(patch) {
    await this.store.update((s) => {
      migrate(s);
      if ('scanDepth' in patch) {
        const d = Number(patch.scanDepth);
        if (!Number.isInteger(d) || d < 1 || d > 6) throw httpError(400, 'Scan depth must be 1–6');
        s.scanDepth = d;
      }
      if ('autoAddGitRepos' in patch) s.autoAddGitRepos = Boolean(patch.autoAddGitRepos);
      if ('autoLockMinutes' in patch) {
        const m = Number(patch.autoLockMinutes);
        if (!Number.isInteger(m) || m < 0 || m > 24 * 60) throw httpError(400, 'Auto-lock must be 0–1440 minutes');
        s.autoLockMinutes = m;
      }
      if ('theme' in patch) {
        if (!['dark', 'light', 'system'].includes(patch.theme)) throw httpError(400, 'Unknown theme');
        s.theme = patch.theme;
      }
      if ('accent' in patch) {
        const a = String(patch.accent ?? '').trim().toLowerCase();
        if (a && !/^#[0-9a-f]{6}$/.test(a)) throw httpError(400, 'Accent must be a #rrggbb colour');
        s.accent = a;
      }
      if ('background' in patch) {
        if (!BACKGROUNDS.includes(patch.background)) throw httpError(400, 'Unknown background pattern');
        s.background = patch.background;
      }
      if ('uiScale' in patch) {
        const v = Number(patch.uiScale);
        if (!UI_SCALES.includes(v)) throw httpError(400, 'Unknown UI scale');
        s.uiScale = v;
      }
      if ('profile' in patch) {
        if (!PROFILES.includes(patch.profile)) throw httpError(400, 'Unknown profile');
        s.profile = patch.profile;
      }
      if ('onboarded' in patch) s.onboarded = Boolean(patch.onboarded);
      if (patch.customProfile) s.customProfile = this.#customProfile(patch.customProfile);
      if (patch.notifications && 'level' in patch.notifications) {
        if (!NOTIFY_LEVELS.includes(patch.notifications.level)) throw httpError(400, 'Unknown notification level');
        s.notifications = { ...s.notifications, level: patch.notifications.level };
      }
      if (patch.setup) {
        const raw = patch.setup.answers && typeof patch.setup.answers === 'object' ? JSON.stringify(patch.setup.answers) : null;
        if (raw && raw.length > 4000) throw httpError(400, 'Setup answers are too long');
        const answers = raw ? JSON.parse(raw) : s.setup?.answers ?? null;
        s.setup = { done: Boolean(patch.setup.done), answers, at: Date.now() };
      }
      if (patch.terminal && 'shell' in patch.terminal) {
        const shell = String(patch.terminal.shell ?? '').trim();
        if (shell && !this.host.exec.which(shell)) throw httpError(400, `Shell not found: ${shell}`);
        s.terminal.shell = shell;
      }
      if (patch.docker && 'enabled' in patch.docker) s.docker.enabled = Boolean(patch.docker.enabled);
      if (patch.editor && 'command' in patch.editor) {
        const cmd = String(patch.editor.command ?? '').trim();
        if (cmd && !COMMAND.test(cmd)) throw httpError(400, 'Editor command must be a program name on PATH');
        s.editor.command = cmd || 'code';
      }
      if (patch.editor && 'others' in patch.editor) {
        const list = Array.isArray(patch.editor.others) ? patch.editor.others.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
        if (list.length > 12 || list.some((c) => !COMMAND.test(c))) throw httpError(400, 'Editors must be program names on PATH');
        s.editor.others = [...new Set(list)].filter((c) => c !== s.editor.command);
      }
      if (patch.agents) {
        if ('detection' in patch.agents) s.agents.detection = Boolean(patch.agents.detection);
        if ('readSessionFiles' in patch.agents) s.agents.readSessionFiles = Boolean(patch.agents.readSessionFiles);
        if ('readTranscripts' in patch.agents) s.agents.readTranscripts = Boolean(patch.agents.readTranscripts);
        if ('taskPreviews' in patch.agents) s.agents.taskPreviews = Boolean(patch.agents.taskPreviews);
        if ('resumeExchange' in patch.agents) s.agents.resumeExchange = Boolean(patch.agents.resumeExchange);
        if ('use' in patch.agents) {
          if (!AGENT_USE.includes(patch.agents.use)) throw httpError(400, 'Unknown answer about agents');
          s.agents.use = patch.agents.use;
        }
        for (const id of ['claude', 'codex', 'antigravity']) {
          const a = patch.agents[id];
          if (!a) continue;
          s.agents[id] ??= { enabled: true, command: '' };
          if ('enabled' in a) s.agents[id].enabled = Boolean(a.enabled);
          if ('command' in a) {
            const cmd = String(a.command ?? '').trim();
            if (cmd && !this.host.exec.which(cmd)) throw httpError(400, `Command not found: ${cmd}`);
            s.agents[id].command = cmd;
          }
        }
      }
    });
    this.emit('changed', this.get(), patch);
    return this.get();
  }

  /** A Custom profile as sent by the page: known features only, a valid style, a known start tab. */
  #customProfile(input) {
    const base = PROFILE_IDS.includes(input.base) && input.base !== 'custom' ? input.base : 'builder';
    const c = customDefaults(base);
    for (const [k, v] of Object.entries(input.flags ?? {})) if (FEATURE_KEYS.includes(k)) c.flags[k] = Boolean(v);
    const st = input.style ?? {};
    if ('accent' in st) {
      const a = String(st.accent ?? '').trim().toLowerCase();
      if (a && !/^#[0-9a-f]{6}$/.test(a)) throw httpError(400, 'Accent must be a #rrggbb colour');
      c.style.accent = a;
    }
    if ('background' in st) {
      if (!BACKGROUNDS.includes(st.background)) throw httpError(400, 'Unknown background pattern');
      c.style.background = st.background;
    }
    if ('density' in st) {
      if (!DENSITIES.some(([id]) => id === st.density)) throw httpError(400, 'Unknown density');
      c.style.density = st.density;
    }
    if ('startTab' in input) {
      if (!START_TABS.some(([id]) => id === input.startTab)) throw httpError(400, 'Unknown start tab');
      c.startTab = input.startTab;
    }
    return c;
  }

  async addRoot(input) {
    const p = this.host.paths.normalizePath(input);
    if (!(await this.host.paths.isDirectory(p))) throw httpError(400, 'Folder does not exist');
    const key = this.host.paths.pathKey(p);
    await this.store.update((s) => {
      if (s.roots.some((r) => this.host.paths.pathKey(r) === key)) throw httpError(409, 'Folder is already a project root');
      if (s.roots.some((r) => this.host.paths.isInside(r, p) || this.host.paths.isInside(p, r))) {
        throw httpError(409, 'Folder overlaps an existing root');
      }
      s.roots.push(p);
    });
    this.emit('changed', this.get(), { roots: true });
    return this.get();
  }

  async removeRoot(input) {
    const key = this.host.paths.pathKey(String(input ?? ''));
    await this.store.update((s) => {
      s.roots = s.roots.filter((r) => this.host.paths.pathKey(r) !== key);
    });
    this.emit('changed', this.get(), { roots: true });
    return this.get();
  }

  shell() {
    return this.get().terminal.shell || this.host.shell.defaultShell();
  }
}
