import { api, projectUrl } from './api.js';
import { store } from './store.js';
import { attempt, choiceDialog, toast } from './ui.js';

/**
 * What "Resume" does for a project, in the order it does it, from its briefing (GET /resume):
 * reopen the last agent conversation (when no agent is open now), start the services that were
 * running when work stopped, restore the terminals. The same everywhere Resume is offered.
 */
export function resumeSteps(briefing, project) {
  const steps = [];
  const agentOpen = (project?.agents?.active ?? []).length > 0;
  const r = briefing?.resume;
  if (r && !agentOpen) steps.push({ kind: 'agent', resume: r, text: r.resumeOf ? `reopen the ${r.agentName} conversation` : `continue with ${r.agentName}` });
  for (const s of briefing?.wasRunning ?? []) steps.push({ kind: 'service', id: s.id, name: s.name, text: `start ${s.name}` });
  steps.push({ kind: 'terminals', text: 'restore your terminals' });
  return steps;
}

/** "reopen the Claude Code conversation, start web and restore your terminals" */
export function stepsText(steps) {
  const texts = steps.map((s) => s.text);
  return texts.length > 1 ? `${texts.slice(0, -1).join(', ')} and ${texts.at(-1)}` : texts[0];
}

/**
 * The one Resume. When it would do more than restore terminals it says what first (unless the
 * caller already showed the plan: `ask: false`). Resolves with { done, agentTerminal }, or null
 * when cancelled. The caller opens the terminal panel.
 */
export async function resumeWork(projectId, { data, ask = true } = {}) {
  const d = data ?? await api.get(projectUrl(projectId, '/resume')).catch(() => null);
  const p = store.project(projectId);
  const steps = resumeSteps(d?.briefing, p);
  let run = steps;
  if (ask && steps.length > 1) {
    const choice = await choiceDialog({
      title: `Resume ${p?.name ?? 'this project'}?`,
      body: `FlintBench will ${stepsText(steps)}.`,
      choices: [{ value: 'terminals', label: 'Terminals only' }, { value: 'all', label: 'Resume', primary: true }],
    });
    if (!choice) return null;
    if (choice === 'terminals') run = steps.filter((s) => s.kind === 'terminals');
  }
  const done = [];
  let agentTerminal = null;
  for (const step of run) {
    if (step.kind === 'agent') {
      const body = step.resume.resumeOf ? { resumeOf: step.resume.resumeOf } : { mode: 'resume' };
      const r = await attempt(() => api.post(projectUrl(projectId, `/agents/${step.resume.agent}/start`), body), { failure: `Could not reopen ${step.resume.agentName}` });
      if (r?.terminal) {
        store.setTerminal(r.terminal);
        agentTerminal = r.terminal;
        done.push(`${step.resume.agentName} reopened`);
      }
    } else if (step.kind === 'service') {
      const r = await attempt(() => api.post(projectUrl(projectId, `/services/${step.id}/start`)), { failure: `Could not start ${step.name}` });
      if (r !== undefined) done.push(`${step.name} started`);
    } else {
      await api.post(projectUrl(projectId, '/resume')).catch(() => null);
    }
  }
  toast('Back where you left off', { kind: 'ok', detail: done.length ? done.join(' · ') : 'Terminals restored' });
  return { done, agentTerminal };
}
