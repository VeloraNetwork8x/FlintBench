import { AgentAdapter } from './adapter.js';

/** Future agent: detected and listed, not launchable yet. */
export class GeminiAdapter extends AgentAdapter {
  constructor(deps) {
    super({ id: 'gemini', name: 'Gemini CLI', binary: 'gemini', launchable: false }, deps);
  }

  enabled() { return true; }
}
