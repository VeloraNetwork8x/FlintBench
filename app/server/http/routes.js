import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, sessionCookie, clearCookie } from './server.js';
import { httpError } from '../host/paths.js';
import { defaultSettings } from '../settings/defaults.js';
import { pick } from '../host/picker.js';
import { UI_SCALES } from '../settings/service.js';
import { resolveProfile } from '../../web/js/lib/profiles.js';
import { editorCommands } from '../../web/js/lib/editors.js';

function list(value, name) {
  if (!Array.isArray(value) || !value.length || value.length > 2000 || !value.every((v) => typeof v === 'string')) {
    throw httpError(400, `${name} must be a non-empty list of strings`);
  }
  return value;
}

/** HTTP API. Thin: validation lives in the domain services. */
export function createRoutes(app) {
  const { auth, settings, projects, git, github, terminals, runtime, docker, agents, work, context, insights, host } = app;
  const r = new Router();

  /* ---------- auth ---------- */
  // the look (theme, accent, background) is public so loading, setup and unlock wear the owner's choice
  // the lock screen wears the profile's style before any settings are loaded
  const appearance = () => {
    const s = settings.get();
    const { style } = resolveProfile(s);
    return { theme: s.theme, accent: style.accent, background: style.background, density: style.density, profile: s.profile, uiScale: UI_SCALES.includes(s.uiScale) ? s.uiScale : 1 };
  };
  r.get('/api/auth/state', ({ token }) => ({ ...auth.state(token), appearance: appearance() }), 'public');
  r.post('/api/auth/setup', async ({ body, userAgent, setCookie }) => {
    const token = await auth.setup(body, userAgent);
    setCookie(sessionCookie(token));
    return auth.state(token);
  }, 'public');
  r.post('/api/auth/unlock', async ({ body, token, userAgent, setCookie }) => {
    if (body.pin !== undefined) {
      await auth.unlockWithPin(token, body.pin);
      return auth.state(token);
    }
    const newToken = await auth.unlockWithPassword(token, body.password, userAgent);
    if (newToken) setCookie(sessionCookie(newToken));
    return auth.state(newToken ?? token);
  }, 'public');
  r.post('/api/auth/lock', async ({ token }) => { await auth.lock(token); return auth.state(token); }, 'session');
  r.post('/api/auth/logout', async ({ token, setCookie }) => {
    await auth.logout(token);
    setCookie(clearCookie());
    return auth.state(null);
  }, 'session');
  r.post('/api/auth/password', async ({ body }) => { await auth.changePassword(body.current, body.next); return { ok: true }; });
  r.post('/api/auth/pin', async ({ body, token }) => { await auth.setPin(body.password, body.pin || null); return auth.state(token); });

  /* ---------- bootstrap ---------- */
  r.get('/api/bootstrap', async () => ({
    settings: settings.get(),
    projects: projects.list(),
    candidates: projects.listCandidates(),
    ignored: projects.ignored(),
    agents: agents.overview(),
    integrations: await app.integrations(),
    terminals: host.pty.list(),
    platform: host.platform,
    dataDir: app.config.dataDir,
    lastScanAt: projects.lastScanAt ?? null,
    rootSuggestions: await app.rootSuggestions(),
  }));

  /* ---------- settings ---------- */
  r.get('/api/settings', () => settings.get());
  r.get('/api/settings/defaults', () => defaultSettings());
  r.patch('/api/settings', ({ body }) => settings.update(body));
  r.post('/api/settings/roots', ({ body }) => settings.addRoot(body.path));
  r.delete('/api/settings/roots', ({ body }) => settings.removeRoot(body.path));
  r.get('/api/integrations', () => app.integrations({ refresh: true }));

  /* ---------- projects & discovery ---------- */
  r.get('/api/projects', () => projects.list());
  // adding by hand says so when the folder is already a project (409), instead of "added"
  r.post('/api/projects', ({ body }) => projects.add(body.path, { source: 'manual', failIfExists: true }));
  r.post('/api/projects/scan', async () => ({ candidates: await projects.scan(), lastScanAt: projects.lastScanAt }));
  r.post('/api/candidates/add', async ({ body }) => {
    const added = [];
    for (const p of list(body.paths, 'paths')) added.push(await projects.add(p, { source: 'discovered' }));
    return added;
  });
  r.post('/api/candidates/ignore', async ({ body }) => {
    for (const p of list(body.paths, 'paths')) await projects.ignore(p);
    return { candidates: projects.listCandidates(), ignored: projects.ignored() };
  });
  r.post('/api/ignored/add', async ({ body }) => {
    const dir = String(body?.path ?? '').trim();
    if (!dir || !(await host.paths.isDirectory(host.paths.normalizePath(dir)))) throw httpError(400, 'Folder does not exist');
    await projects.ignore(dir);
    return projects.ignored();
  });
  // native "choose a folder / file" dialog on this computer; { path: null } when cancelled
  r.post('/api/system/pick', async ({ body }) => ({ path: await pick(body ?? {}) }));
  r.post('/api/ignored/remove', async ({ body }) => { await projects.unignore(body.path); return projects.ignored(); });

  r.get('/api/projects/:id', async ({ params }) => ({
    project: projects.summary(projects.get(params.id).id),
    terminals: terminals.list(params.id),
  }));
  r.patch('/api/projects/:id', async ({ params, body }) => {
    if ('name' in body) await projects.rename(params.id, body.name);
    return projects.summary(params.id);
  });
  r.delete('/api/projects/:id', async ({ params }) => {
    for (const t of terminals.list(params.id)) host.pty.remove(t.id);
    await projects.remove(params.id);
  });
  // a moved or renamed folder: point the project at its new place (history, notes and sessions stay)
  r.post('/api/projects/:id/relocate', ({ params, body }) => projects.relocate(params.id, body?.path));
  r.post('/api/projects/:id/relocation/dismiss', ({ params, body }) => projects.dismissRelocation(params.id, body?.path));
  r.post('/api/projects/:id/open', ({ params }) => projects.markOpened(params.id));
  r.post('/api/projects/:id/open-editor', async ({ params, body }) => {
    // with a path: that file, in the project's editor window
    const file = body?.path ? await host.paths.resolveInside(projects.get(params.id).path, String(body.path)) : null;
    // which editor: the default one, or one of the others chosen in Settings (never any program)
    const commands = editorCommands(settings.get());
    const command = body?.command ? String(body.command) : commands[0];
    if (!commands.includes(command)) throw httpError(400, 'That editor is not one of yours (Settings › Integrations)');
    return runtime.openEditor(params.id, command, { file });
  });
  r.post('/api/projects/:id/reveal', async ({ params, body }) => {
    const project = projects.get(params.id);
    if (!body?.path) return host.desktop.reveal(project.path);
    const target = await host.paths.resolveInside(project.path, String(body.path));
    const isDir = await host.paths.isDirectory(target);
    return host.desktop.reveal(target, { select: !isDir });
  });
  r.get('/api/projects/:id/resume', ({ params }) => insights.resume(params.id));
  r.get('/api/projects/:id/work-sessions', async ({ params, query }) => ({ sessions: await insights.workSessions(params.id, { days: Number(query.get('days')) || 30 }) }));
  r.post('/api/projects/:id/resume', async ({ params }) => {
    await projects.markOpened(params.id);
    const tabs = await terminals.restoreTabs(params.id);
    return { resume: await insights.resume(params.id), terminals: tabs };
  });
  r.post('/api/projects/:id/start', async ({ params }) => ({ started: await runtime.startProject(params.id) }));
  r.post('/api/projects/:id/stop', ({ params }) => runtime.stopProject(params.id)); // { stopped, external }

  /* ---------- git ---------- */
  r.get('/api/projects/:id/git', ({ params }) => git.detail(params.id));
  r.get('/api/git/defaults', async () => ({ ...(await host.git.globalDefaults()), github: await host.git.githubStatus() }));
  r.post('/api/projects/:id/git/init', async ({ params, body }) => git.initRepo(params.id, body ?? {}));
  r.post('/api/projects/:id/git/refresh', async ({ params }) => { await git.refresh(params.id, { full: true }); return git.detail(params.id); });
  r.get('/api/projects/:id/file-changes', ({ params, query }) => insights.fileChanges(params.id, { days: Number(query.get('days')) || 7 }));
  // kind: history (what FlintBench saw change in the window), working (not committed), commit (sha)
  r.get('/api/projects/:id/file-changes/diff', async ({ params, query }) => {
    const file = query.get('path');
    if (typeof file !== 'string' || !file || file.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(file)) throw httpError(403, 'Path is outside the project');
    const kind = query.get('kind') ?? (query.get('sha') ? 'commit' : 'working');
    if (kind === 'history') {
      const days = Math.min(90, Math.max(1, Number(query.get('days')) || 7));
      return { diff: await app.history.diff(params.id, file, { since: Date.now() - days * 86_400_000 }) };
    }
    return { diff: await git.fileDiff(params.id, file, kind === 'commit' ? query.get('sha') : null) };
  });
  r.get('/api/projects/:id/git/diff', async ({ params, query }) => ({ diff: await git.diff(params.id, query.get('path'), query.get('staged') === '1') }));
  r.post('/api/projects/:id/git/stage', async ({ params, body }) => { await git.stage(params.id, list(body.paths, 'paths')); return git.detail(params.id); });
  r.post('/api/projects/:id/git/unstage', async ({ params, body }) => { await git.unstage(params.id, list(body.paths, 'paths')); return git.detail(params.id); });
  r.post('/api/projects/:id/git/commit', async ({ params, body }) => ({ output: await git.commit(params.id, body.message), ...git.detail(params.id) }));
  r.post('/api/projects/:id/git/pull', async ({ params }) => ({ output: await git.pull(params.id), ...git.detail(params.id) }));
  r.post('/api/projects/:id/git/push', async ({ params }) => ({ output: await git.push(params.id), ...git.detail(params.id) }));
  r.post('/api/projects/:id/git/fetch', async ({ params }) => { await git.fetch(params.id); return git.detail(params.id); });
  r.post('/api/projects/:id/git/branch', async ({ params, body }) => { await git.createBranch(params.id, body.name, body.checkout !== false); return git.detail(params.id); });
  r.post('/api/projects/:id/git/switch', async ({ params, body }) => { await git.switchBranch(params.id, body.name); return git.detail(params.id); });

  /* ---------- GitHub (through the GitHub CLI) ---------- */
  r.get('/api/github/status', () => github.status());
  r.get('/api/github/repos', ({ query }) => github.repos({ refresh: query.get('refresh') === '1' }));
  r.post('/api/github/repos', ({ body }) => github.create(body ?? {}));
  r.get('/api/github/repos/:owner/:name', ({ params }) => github.detail(params.owner, params.name));
  r.patch('/api/github/repos/:owner/:name', ({ params, body }) => github.update(params.owner, params.name, body ?? {}));
  r.delete('/api/github/repos/:owner/:name', ({ params, body }) => github.remove(params.owner, params.name, body?.confirm));
  r.post('/api/github/repos/:owner/:name/clone', ({ params, body }) => github.clone(params.owner, params.name, body?.parent));
  r.post('/api/github/terminal', ({ body }) => github.openTerminal(body?.action));

  /* ---------- runtime / services ---------- */
  r.get('/api/projects/:id/services', async ({ params }) => ({
    services: projects.get(params.id).runtime.services,
    suggestions: await runtime.suggestions(params.id),
  }));
  r.post('/api/projects/:id/services', ({ params, body }) => runtime.defineService(params.id, body));
  r.patch('/api/projects/:id/services/:sid', ({ params, body }) => runtime.defineService(params.id, { ...body, id: params.sid }));
  r.delete('/api/projects/:id/services/:sid', ({ params }) => runtime.deleteService(params.id, params.sid));
  r.post('/api/projects/:id/services/:sid/:action', async ({ params }) => {
    const actions = { start: 'startService', stop: 'stopService', restart: 'restartService' };
    if (!actions[params.action]) throw httpError(404, 'Unknown action');
    const t = await runtime[actions[params.action]](params.id, params.sid);
    return { terminal: t ?? null };
  });
  r.post('/api/projects/:id/processes/refresh', async () => { await runtime.monitor(); });

  /* ---------- docker ---------- */
  r.post('/api/projects/:id/compose/:action', async ({ params, body }) => ({ output: await docker.compose(params.id, params.action, body.service) }));
  r.post('/api/projects/:id/containers/:cid/:action', async ({ params }) => { await docker.container(params.id, params.cid, params.action); });

  /* ---------- terminals ---------- */
  r.get('/api/projects/:id/terminals', ({ params }) => terminals.list(params.id));
  r.post('/api/projects/:id/terminals', ({ params, body }) => terminals.create(params.id, body));
  r.patch('/api/terminals/:tid', ({ params, body }) => terminals.rename(params.tid, body.name));
  r.post('/api/terminals/:tid/transfer', ({ params, body }) => agents.transferToSystemTerminal(params.tid, { when: body?.when === 'idle' ? 'idle' : 'now' }));
  r.post('/api/terminals/:tid/transfer/cancel', ({ params }) => agents.cancelMove({ terminalId: params.tid }));
  r.post('/api/terminals/:tid/stop', ({ params }) => { terminals.get(params.tid); host.pty.stop(params.tid); });
  r.delete('/api/terminals/:tid', ({ params }) => { terminals.remove(params.tid); });

  /* ---------- agents ---------- */
  r.get('/api/agents', () => agents.overview());
  r.post('/api/agents/detect', async () => { await agents.detect(); return agents.overview(); });
  r.get('/api/agents/journal', ({ query }) => agents.journal({ projectId: query.get('project') || undefined, limit: Math.min(500, Number(query.get('limit')) || 100) }));
  r.post('/api/projects/:id/agents/:agent/start', ({ params, body }) => agents.launch(params.id, params.agent, { mode: body.mode === 'resume' ? 'resume' : 'new', task: body.task, resumeOf: typeof body.resumeOf === 'string' ? body.resumeOf : undefined }));
  r.post('/api/agent-sessions/:sid/focus', ({ params }) => agents.focusSession(params.sid));
  r.post('/api/agent-sessions/:sid/move-here', ({ params, body }) => agents.moveIntoFlintBench(params.sid, { when: body?.when === 'idle' ? 'idle' : 'now' }));
  r.post('/api/agent-sessions/:sid/move/cancel', ({ params }) => agents.cancelMove({ sessionId: params.sid }));
  r.post('/api/projects/:id/editor/focus', ({ params }) => runtime.focusEditor(params.id));
  r.post('/api/agent-sessions/:sid/stop', async ({ params }) => { await agents.stopSession(params.sid); });

  /* ---------- context, work, notes ---------- */
  r.get('/api/projects/:id/context', ({ params }) => context.list(params.id));
  r.get('/api/projects/:id/context/file', ({ params, query }) => context.read(params.id, query.get('path')));
  r.get('/api/projects/:id/files', ({ params, query }) => context.listDir(params.id, query.get('path') ?? ''));
  r.get('/api/projects/:id/files/content', ({ params, query }) => context.read(params.id, query.get('path')));
  // a picture of one of the project's own local pages (Overview preview)
  r.get('/api/projects/:id/preview', async ({ params, query, res }) => {
    const project = projects.get(params.id);
    let u;
    try { u = new URL(String(query.get('url') ?? '')); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400, expose: true }); }
    if (!/^https?:$/.test(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw Object.assign(new Error('Only local pages can be previewed'), { status: 400, expose: true });
    const ports = new Set((project.runtime?.ports ?? []).map(String));
    for (const s of project.runtime?.services ?? []) { try { if (s.url) ports.add(new URL(s.url).port); } catch { /* no url */ } }
    if (!ports.has(u.port || (u.protocol === 'https:' ? '443' : '80'))) throw Object.assign(new Error('That page is not served by this project'), { status: 403, expose: true });
    const step = Number(query.get('step')) || 3;
    const png = await host.preview.screenshot(u.href, { step, fresh: Boolean(query.get('fresh')) });
    if (step >= 3) {
      // the picture that stays: kept with the project, shown (in grey) while its server is offline
      const dir = (await app.storage.project(params.id)).dir;
      await fs.writeFile(path.join(dir, 'preview.png'), png).catch(() => {});
      await fs.writeFile(path.join(dir, 'preview.json'), JSON.stringify({ url: u.href, at: Date.now() })).catch(() => {});
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(png);
  });
  // the last picture kept for the project (its page may be offline now): url and time in headers
  r.get('/api/projects/:id/preview/last', async ({ params, res }) => {
    const dir = (await app.storage.project(params.id)).dir;
    const [png, meta] = await Promise.all([
      fs.readFile(path.join(dir, 'preview.png')).catch(() => null),
      fs.readFile(path.join(dir, 'preview.json'), 'utf8').then(JSON.parse).catch(() => null),
    ]);
    if (!png) throw Object.assign(new Error('No picture yet'), { status: 404, expose: true });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Preview-Url': encodeURI(meta?.url ?? ''), 'X-Preview-At': String(meta?.at ?? '') });
    res.end(png);
  });
  r.get('/api/projects/:id/graph', ({ params, query }) => context.graph(params.id, { meta: query.get('meta') === '1' }));
  r.get('/api/projects/:id/work', ({ params }) => work.list(params.id));
  r.post('/api/projects/:id/work', ({ params, body }) => work.create(params.id, body));
  r.patch('/api/projects/:id/work/:wid', ({ params, body }) => work.update(params.id, params.wid, body));
  r.delete('/api/projects/:id/work/:wid', ({ params }) => work.remove(params.id, params.wid));
  r.get('/api/projects/:id/notes', ({ params }) => work.notes(params.id));
  r.put('/api/projects/:id/notes', ({ params, body }) => work.saveNotes(params.id, body.text));
  r.post('/api/projects/:id/notes', ({ params, body }) => work.addNote(params.id, { type: body.type, text: body.text }));
  r.delete('/api/projects/:id/notes/:noteId', ({ params }) => work.removeNote(params.id, params.noteId));

  /* ---------- insights ---------- */
  r.get('/api/analytics', ({ query }) => insights.analytics({ days: query.get('days'), year: query.get('year'), from: query.get('from'), to: query.get('to'), bucket: query.get('bucket') }));
  r.get('/api/projects/:id/activity', async ({ params, query }) => {
    projects.get(params.id);
    const data = await app.storage.project(params.id);
    return data.activity.read({ limit: Math.min(500, Number(query.get('limit')) || 100) });
  });

  r.get('/api/health', () => ({ ok: true }), 'public');
  return r;
}
