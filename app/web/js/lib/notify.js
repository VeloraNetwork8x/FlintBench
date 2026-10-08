import { toast } from './ui.js';
import { icon } from './dom.js';
import { play } from './sound.js';
import { agentMark, hostLogo } from './agent-icons.js';
import { store } from './store.js';
import { navigate, projectPath } from './router.js';
import { plural } from './format.js';

/** "Claude Code finished · project": who, where, and the gist of its reply; click to go there. */
export function agentFinishedToast({ agent, agentName, summary }, project) {
  play('done');
  toast(summary || 'Task finished. Its reply is in the terminal where it runs.', {
    kind: 'agent',
    title: `${agentName} finished · ${project.name}`,
    iconNode: agentMark(agent, 22),
    timeout: 10_000,
    sound: false,
    onClick: () => navigate(projectPath(project.id)),
  });
}

/** "web started · project": a service or container came up; click to open the project's services. */
export function serviceStartedToast({ name, container = false }, project) {
  toast(`${container ? 'Container ' : ''}${name} started`, {
    kind: 'ok',
    title: `Service started · ${project.name}`,
    iconNode: icon('play', 18),
    timeout: 6000,
    onClick: () => navigate(projectPath(project.id, 'services')),
  });
}

/** "Committed · project": a commit made outside FlintBench (terminal, editor, agent); click for the project's Git. */
export function commitToast({ short, subject }, project) {
  toast(subject || 'New commit', {
    kind: 'ok',
    title: `Committed · ${project.name}`,
    detail: short,
    iconNode: icon('commit', 18),
    timeout: 8000,
    sound: false,
    onClick: () => navigate(projectPath(project.id, 'git')),
  });
}

/**
 * "Pushed · project": commits reached the remote, from wherever they were pushed; click for the project's Git.
 * The mark is the hosting service's (GitHub, GitLab, Bitbucket) when the push went to origin there.
 */
export function pushToast({ upstream, count, published, subject }, project) {
  const toOrigin = String(upstream ?? '').startsWith('origin/');
  const what = published ? `Branch published to ${upstream}` : `${plural(count ?? 1, 'commit')} pushed to ${upstream}`;
  toast(what, {
    kind: 'ok',
    title: `Pushed · ${project.name}`,
    detail: subject || undefined,
    iconNode: (toOrigin && hostLogo(project.git?.webUrl, 18)) || icon('up', 18),
    timeout: 8000,
    onClick: () => navigate(projectPath(project.id, 'git')),
  });
}

/** Why GitHub notified the account, in words (the API's `reason`). */
export const GITHUB_REASONS = {
  approval_requested: 'Approval requested', assign: 'Assigned to you', author: 'On your thread', ci_activity: 'Workflow run',
  comment: 'New comment', invitation: 'Invitation', manual: 'Subscribed', member_feature_requested: 'Feature request',
  mention: 'You were mentioned', review_requested: 'Review requested', security_advisory_credit: 'Security credit',
  security_alert: 'Security alert', state_change: 'State changed', subscribed: 'Watching', team_mention: 'Team mentioned',
};

/** What a notification is about, in words (the API's subject `type`). */
export const GITHUB_TYPES = { PullRequest: 'Pull request', Issue: 'Issue', Release: 'Release', Commit: 'Commit', CheckSuite: 'Checks', WorkflowRun: 'Workflow', Discussion: 'Discussion', RepositoryVulnerabilityAlert: 'Security alert' };

/** "New star · FlintBench": stars or forks on one of your repositories; click for the GitHub section. */
export function githubRepoToast({ name, stars, forks }) {
  const gained = [
    stars.to > stars.from ? `${plural(stars.to - stars.from, 'new star')} · ${plural(stars.to, 'star')} in all` : null,
    forks.to > forks.from ? `${plural(forks.to - forks.from, 'new fork')} · ${plural(forks.to, 'fork')} in all` : null,
  ].filter(Boolean);
  toast(gained[0], {
    kind: 'ok',
    detail: gained[1],
    title: `${stars.to > stars.from ? 'Starred' : 'Forked'} · ${name}`,
    iconNode: icon(stars.to > stars.from ? 'star' : 'github', 18),
    timeout: 9000,
    onClick: () => navigate('/github'),
  });
}

/** Something new in the GitHub inbox: one notification (click opens it on GitHub), or how many. */
export function githubNotificationToast({ count, repo, repos, title, type, reason, url }) {
  if (count > 1) {
    toast(`${count} new notifications on GitHub`, { kind: 'info', title: 'GitHub', detail: (repos ?? []).join(', ') || undefined, iconNode: icon('bell', 18), timeout: 9000, onClick: () => navigate('/github') });
    return;
  }
  toast(title || 'New notification', {
    kind: 'info',
    title: `${GITHUB_TYPES[type] ?? 'GitHub'} · ${repo}`,
    detail: GITHUB_REASONS[reason] ?? undefined,
    iconNode: hostLogo('https://github.com/', 18) || icon('github', 18),
    timeout: 10_000,
    onClick: () => window.open(url, '_blank', 'noopener'),
  });
}

/** Every kind of notification once, a moment apart, so they can be seen and heard. */
export function showSampleNotifications() {
  const projects = [...store.state.projects.values()].sort((a, b) => (b.activity?.lastActivityAt ?? 0) - (a.activity?.lastActivityAt ?? 0));
  const project = projects[0] ?? { id: '', name: 'your project' };
  const samples = [
    () => toast('Changes committed', { kind: 'ok', detail: 'Sample: a successful action.', timeout: 9000 }),
    () => toast('3 uncommitted changes on main', { kind: 'warn', detail: 'Sample: something worth a look.', timeout: 9000 }),
    () => toast('Push rejected', { kind: 'err', detail: 'Sample: an action that failed, with the reason underneath.', timeout: 5000 }),
    () => toast('Scan complete', { kind: 'info', detail: 'Sample: plain information.', timeout: 9000 }),
    () => serviceStartedToast({ name: 'web' }, project),
    () => commitToast({ short: 'a1b2c3d', subject: 'Sample: a commit made in a terminal, an editor or by an agent' }, project),
    () => pushToast({ upstream: 'origin/main', count: 2, subject: 'Sample: the last commit that was pushed' }, { ...project, git: { ...project.git, webUrl: project.git?.webUrl || 'https://github.com/' } }),
    () => agentFinishedToast({ agent: 'claude', agentName: 'Claude Code', summary: 'Sample: the first lines of the agent’s last reply appear here — e.g. “Added the year selector to Activity and verified it.”' }, project),
    () => agentFinishedToast({ agent: 'codex', agentName: 'Codex', summary: 'Sample: Codex finished its task in this project.' }, project),
    () => githubRepoToast({ name: 'your-repository', stars: { from: 11, to: 12 }, forks: { from: 2, to: 2 } }),
    () => githubNotificationToast({ count: 1, repo: 'you/your-repository', title: 'Sample: Add dark mode to the settings page', type: 'PullRequest', reason: 'review_requested', url: 'https://github.com/notifications' }),
  ];
  samples.forEach((show, i) => setTimeout(show, i * 700));
}
