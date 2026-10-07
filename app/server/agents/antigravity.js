import { AgentAdapter, UUID } from './adapter.js';

/** Antigravity CLI (`agy`), Google's agent CLI that took over from Gemini CLI. */
export class AntigravityAdapter extends AgentAdapter {
  constructor(deps) {
    super({ id: 'antigravity', name: 'Antigravity CLI', binary: 'agy' }, deps);
  }

  conversationId(agentSessionId) { return UUID.test(agentSessionId ?? '') ? agentSessionId : null; }

  /** `agy --conversation <id>` reopens one conversation; `agy --continue` the most recent one. */
  resumeArgs(opts = {}) {
    const id = this.conversationId(opts.agentSessionId);
    return id ? ['--conversation', id] : ['--continue'];
  }
}
