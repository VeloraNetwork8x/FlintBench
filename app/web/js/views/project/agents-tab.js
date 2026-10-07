import { h } from '../../lib/dom.js';
import { createAgentPanel } from './agent-panel.js';

/** Agents section of a project: launch, the live session, recent sessions. */
export function render(ctx) {
  const panel = createAgentPanel(ctx);
  return {
    el: h('div.p-center-inner.agents-tab', panel.el),
    destroy: () => panel.destroy(),
  };
}
