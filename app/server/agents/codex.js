import { AgentAdapter } from './adapter.js';

export class CodexAdapter extends AgentAdapter {
  constructor(deps) {
    super({ id: 'codex', name: 'Codex', binary: 'codex' }, deps);
  }

  /** Codex names its session files "rollout-<time>-<session uuid>". */
  conversationId(agentSessionId) {
    return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(agentSessionId ?? '')?.[1] ?? null;
  }

  /** `codex resume <uuid>` reopens one session; `codex resume --last` the most recent one. */
  resumeArgs(opts = {}) {
    const id = this.conversationId(opts.agentSessionId);
    return id ? ['resume', id] : ['resume', '--last'];
  }
}
