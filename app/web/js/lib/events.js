import { store } from './store.js';
import { duration, plural } from './format.js';

const AGENT = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity CLI', gemini: 'Gemini CLI' };

/** Human sentence for a server event. Wording follows the attribution rules. */
export function describeEvent(e) {
  const d = e.data ?? {};
  const agent = AGENT[d.agent] ?? d.agent;
  switch (e.type) {
    case 'git.commit_created': return `commit ${d.short} ${d.subject}`;
    case 'git.pushed': return d.published ? `branch published to ${d.upstream}` : `pushed ${plural(d.count ?? 1, 'commit')} to ${d.upstream}`;
    case 'git.branch_changed': return `branch ${d.from ?? '—'} → ${d.to ?? 'detached'}`;
    case 'git.status_changed': return `${d.changed} changed, ${d.staged} staged`;
    case 'agent.started': return d.source === 'external' ? `${agent} session active (outside FlintBench)` : `${agent} started${d.mode === 'resume' ? ' (resume)' : ''}`;
    case 'agent.stopped': return `${agent} ended${d.durationMs ? ` after ${duration(d.durationMs)}` : ''}`;
    case 'agent.moved': return d.direction === 'in' ? `${agent} moved into FlintBench` : `${agent} moved to ${d.app ?? 'a terminal window'}`;
    case 'process.started': return d.managed ? `${d.service} started` : `${d.name} running${d.ports?.length ? ` on :${d.ports.join(', :')}` : ''}`;
    case 'process.stopped': return d.managed ? `${d.service} stopped${d.exitCode ? ` (exit ${d.exitCode})` : ''}` : `${d.name} stopped`;
    case 'docker.container_started': return `container ${d.service ?? d.name} started`;
    case 'docker.container_stopped': return `container ${d.service ?? d.name} stopped`;
    case 'project.discovered': return `new project detected: ${d.name}`;
    case 'project.added': return 'added to FlintBench';
    case 'project.opened': return 'opened';
    case 'work.updated': return `work "${d.title}" → ${String(d.status).replace('_', ' ')}`;
    case 'editor.opened': return `${d.name ?? 'editor'} open on the project`;
    case 'editor.closed': return `${d.name ?? 'editor'} closed`;
    case 'github.repo_changed': return d.stars?.to > d.stars?.from ? `${d.name} starred on GitHub (${plural(d.stars.to, 'star')})` : `${d.name} forked on GitHub (${plural(d.forks?.to ?? 0, 'fork')})`;
    case 'github.notification': return d.count > 1 ? `${d.count} new GitHub notifications` : `GitHub: ${d.title ?? 'new notification'}`;
    default: return e.type;
  }
}

export function eventLine(e) {
  const p = e.projectId ? store.project(e.projectId) : null;
  return `${p ? `${p.name} · ` : ''}${describeEvent(e)}`;
}
