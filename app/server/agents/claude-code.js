import { AgentAdapter, UUID } from './adapter.js';

export class ClaudeCodeAdapter extends AgentAdapter {
  constructor(deps) {
    super({ id: 'claude', name: 'Claude Code', binary: 'claude' }, deps);
  }

  conversationId(agentSessionId) { return UUID.test(agentSessionId ?? '') ? agentSessionId : null; }

  /** `claude --resume <id>` reopens one conversation; `--continue` the most recent one in this directory. */
  resumeArgs(opts = {}) {
    const id = this.conversationId(opts.agentSessionId);
    return id ? ['--resume', id] : ['--continue'];
  }
}
