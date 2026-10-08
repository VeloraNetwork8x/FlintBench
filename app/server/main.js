import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStorage } from './storage/index.js';
import { EventBus, ActivityAggregator } from './events/bus.js';
import { createHost } from './host/index.js';
import { AuthService } from './auth/service.js';
import { SettingsService } from './settings/service.js';
import { ProjectService } from './projects/service.js';
import { GitService } from './git/service.js';
import { GitHubService } from './github/service.js';
import { TerminalService } from './terminal/service.js';
import { RuntimeService } from './runtime/service.js';
import { DockerService } from './docker/service.js';
import { AgentService } from './agents/service.js';
import { TranscriptService } from './agents/transcript.js';
import { WorkService } from './work/service.js';
import { ContextService } from './context/service.js';
import { InsightsService } from './insights/service.js';
import { FileHistoryService } from './history/service.js';
import { createHttpServer } from './http/server.js';
import { createRoutes } from './http/routes.js';
import { EDITORS } from '../web/js/lib/editors.js';
import { applyResetMarker } from './settings/reset-setup.js';
import { WsHub } from './http/ws-hub.js';

const APP_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env = process.env) {
  const host = env.FLINTBENCH_HOST || '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    throw new Error(`Refusing to bind to ${host}: FlintBench controls shells and files and only listens on loopback.`);
  }
  const port = Number(env.FLINTBENCH_PORT || 4477);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FLINTBENCH_PORT');
  return {
    appRoot: APP_ROOT,
    dataDir: path.resolve(env.FLINTBENCH_DATA_DIR || path.join(APP_ROOT, 'data')),
    webDir: path.join(APP_ROOT, 'app', 'web'),
    host,
    port,
  };
}

export async function startFlintBench(config = loadConfig(), log = console) {
  await applyResetMarker(config.dataDir, log); // `npm run reset-setup`: first run again, before anything reads the account
  const storage = await createStorage(config.dataDir);
  const host = createHost({ log });
  const bus = new EventBus({ storage, log });
  const aggregator = new ActivityAggregator(bus);
  const settings = new SettingsService({ storage, host });
  const auth = new AuthService({ storage, settings, log });
  await auth.init();

  const projects = new ProjectService({ storage, host, bus, settings, dataDir: config.dataDir, log });
  const git = new GitService({ projects, host, bus, log });
  const github = new GitHubService({ host, projects, git, bus, dataDir: config.dataDir, log });
  const terminals = new TerminalService({ host, projects, settings, storage, log });
  const docker = new DockerService({ projects, host, bus, settings, log });
  const runtime = new RuntimeService({ projects, host, terminals, storage, bus, docker, log });
  const agents = new AgentService({ projects, host, terminals, settings, storage, bus, git, runtime, log });
  const transcripts = new TranscriptService({ agents, host, settings, log });
  const work = new WorkService({ storage, projects, bus });
  const context = new ContextService({ projects, host });
  const history = new FileHistoryService({ projects, storage, host, bus, dataDir: config.dataDir, log });
  const insights = new InsightsService({ projects, host, storage, git, work, agents, history, log });

  let integrationsCache = null;
  const app = {
    config, storage, host, bus, auth, settings, projects, git, github, terminals, runtime, docker, agents, work, context, insights, history,
    /** Common code folders that exist on this machine and are not roots yet. */
    async rootSuggestions() {
      const home = os.homedir();
      const candidates = [
        'Projects', 'projects', 'Dev', 'dev', 'code', 'Code', 'src', 'repos', 'source/repos', 'Documents/GitHub',
        'Documents/Projects', 'workspace',
      ].map((p) => path.join(home, p));
      if (host.isWindows) candidates.push('C:\\Dev', 'C:\\Projects', 'D:\\Dev', 'D:\\Projects', 'C:\\src');
      const roots = settings.get().roots.map((r) => host.paths.pathKey(r));
      const out = [];
      for (const c of candidates) {
        if (out.some((o) => host.paths.pathKey(o) === host.paths.pathKey(c))) continue;
        if (roots.some((r) => host.paths.isInside(r, c) || host.paths.isInside(c, r))) continue;
        if (await host.paths.isDirectory(c)) out.push(c);
      }
      return out.slice(0, 6);
    },
    async integrations({ refresh = false } = {}) {
      if (integrationsCache && !refresh && Date.now() - integrationsCache.at < 30_000) return integrationsCache.value;
      if (refresh) {
        await host.exec.refreshPath(); // tools installed since start (also clears the which cache)
        await host.docker.detect().catch(() => {});
      }
      const value = {
        git: { installed: host.git.available(), version: await host.git.version() },
        docker: docker.status(),
        shell: { path: settings.shell(), default: host.shell.defaultShell() },
        editor: { command: settings.get().editor.command, installed: Boolean(host.exec.which(settings.get().editor.command)) },
        editors: EDITORS.map((e) => ({ id: e.id, command: e.command, installed: Boolean(host.exec.which(e.command)) })),
        agents: agents.tools(),
        processCwd: host.processes.cwdSupported,
      };
      integrationsCache = { at: Date.now(), value };
      return value;
    },
  };

  // Wire before init so startup state reaches subscribers.
  terminals.init();
  git.init();
  await projects.init();
  await work.init();
  await docker.init();
  await runtime.init();
  await agents.init();
  insights.init();
  history.init();
  await github.init();

  const router = createRoutes(app);
  const server = createHttpServer({ router, auth, webDir: config.webDir, port: config.port, log });
  const hub = new WsHub({ server, auth, port: config.port, log });

  /* ---------- live push ---------- */
  projects.on('state', (summary) => hub.broadcast({ t: 'project', p: summary }));
  projects.on('removed', (id) => hub.broadcast({ t: 'project.removed', id }));
  projects.on('candidates', (list) => hub.broadcast({ t: 'candidates', list }));
  settings.on('changed', (s) => hub.broadcast({ t: 'settings', s }));
  bus.on('*', (event) => {
    if (event.type === 'file.changed' || event.type === 'file.activity') return;
    hub.broadcast({ t: 'event', e: event });
    if (event.type.startsWith('agent.')) hub.broadcast({ t: 'agents', a: agents.overview() });
  });
  host.pty.on('created', (t) => hub.broadcast({ t: 'terminal', term: t }));
  // a terminal the user closed is killed after its removal: do not resurrect its tab as 'exited'
  host.pty.on('exit', (t) => { if (host.pty.get(t.id)) hub.broadcast({ t: 'terminal', term: t }); });
  host.pty.on('removed', (id) => hub.broadcast({ t: 'terminal.removed', id }));
  // the engine state is global (status bar, boot): push it, do not wait for a reload
  host.docker.on('status', () => hub.broadcast({ t: 'docker', s: docker.status() }));
  host.pty.on('data', (id, d) => hub.sendToTerminal(id, { t: 'pty.out', id, d }));

  hub.on('pty.attach', (client, { id }) => {
    if (!host.pty.get(id)) return;
    client.terminals.add(id);
    hub.send(client, { t: 'pty.replay', id, d: host.pty.scrollback(id) });
  });
  hub.on('pty.detach', (client, { id }) => client.terminals.delete(id));
  // live read-only transcript of an external Claude Code session (opt-in)
  hub.on('transcript.attach', (client, { id }) => {
    if (typeof id !== 'string' || client.transcripts.has(id)) return;
    try {
      const detach = transcripts.subscribe(id, (msg) => hub.send(client, { t: 'transcript', id, ...msg }));
      if (detach) client.transcripts.set(id, detach);
    } catch (error) {
      hub.send(client, { t: 'transcript', id, error: error.message });
    }
  });
  hub.on('transcript.detach', (client, { id }) => {
    client.transcripts.get(id)?.();
    client.transcripts.delete(id);
  });
  hub.on('pty.in', (client, { id, d }) => {
    if (client.terminals.has(id) && typeof d === 'string' && d.length <= 64 * 1024) host.pty.write(id, d);
  });
  hub.on('pty.resize', (client, { id, cols, rows }) => {
    if (client.terminals.has(id)) host.pty.resize(id, cols, rows);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  // "localhost" resolves to ::1 first on Windows: with nothing listening there, every new connection
  // of the page waited for IPv6 to fail (~0.2 s, up to 2 s) before trying 127.0.0.1. The IPv6
  // loopback answers too, through the same handlers; still loopback only.
  const ipv6 = config.host === '127.0.0.1' ? http.createServer() : null;
  if (ipv6) {
    ipv6.on('request', (req, res) => server.emit('request', req, res));
    ipv6.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
    ipv6.on('error', (error) => log.warn(`[http] no IPv6 loopback (${error.code ?? error.message}): localhost may connect a little slower`));
    ipv6.headersTimeout = server.headersTimeout;
    ipv6.requestTimeout = server.requestTimeout;
    ipv6.listen(config.port, '::1');
  }

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    aggregator.stop();
    hub.close();
    server.close();
    ipv6?.close();
    for (const svc of [projects, git, github, docker, runtime, agents, insights, history, auth]) svc.stop?.();
    host.pty.disposeAll();
    await new Promise((r) => setTimeout(r, 200));
    await storage.runtime.releaseInstanceLock();
  }

  return { app, server, stop, url: `http://localhost:${config.port}` };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { stop, url, app } = await startFlintBench();
    console.log(`FlintBench running at ${url}`);
    console.log(`Data directory: ${app.config.dataDir}`);
    const shutdown = async () => {
      console.log('Stopping FlintBench…');
      await stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(`FlintBench failed to start: ${error.message}`);
    process.exit(1);
  }
}
