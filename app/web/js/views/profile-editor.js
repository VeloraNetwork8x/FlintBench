import { h, icon } from '../lib/dom.js';
import { FEATURES, PRESETS, DENSITIES, START_TABS, AGENT_FEATURES, customDefaults } from '../lib/profiles.js';
import { PATTERNS, DEFAULT_ACCENT } from '../lib/theme.js';
import { accentPicker } from './settings.js';

const ORDER = ['essentials', 'builder', 'pro', 'pilot'];

/** What a profile shows, in a few words: the sections and tabs it adds to the basics. */
function highlights(flags) {
  const on = (k) => flags[k] !== false;
  const parts = [];
  const tabs = ['tab.services', 'tab.agents', 'tab.docs', 'tab.sessions', 'tab.tasks', 'tab.graph'].filter(on).length;
  parts.push(`${tabs + 3} project tabs`);
  const sections = ['nav.agents', 'nav.activity', 'nav.github'].filter(on).length;
  parts.push(`${sections + 3} sections`);
  if (on('ui.technical')) parts.push('technical details');
  return parts.join(' · ');
}

/** A small picture of a profile's style: its accent on its background, at its density. */
function swatch(style) {
  return h(`span.pf-swatch.is-${style.background || 'hive'}`, { 'aria-hidden': 'true' },
    h('i', { style: { background: style.accent || DEFAULT_ACCENT } }), h('i'), h('i'));
}

/**
 * The profiles as cards to choose from (radio semantics): the ready-made ones, then Custom.
 * `recommended` gets a badge; Labs is offered only when `labs` is true.
 */
export function profileCards({ value, recommended = null, labs = false, onPick }) {
  const ids = [...ORDER, 'custom', ...(labs ? ['test'] : [])];
  const name = `pf-${Math.random().toString(36).slice(2, 7)}`;
  return h('div.pf-cards', { role: 'radiogroup', 'aria-label': 'Profiles' }, ids.map((id) => {
    const p = PRESETS[id];
    const input = h('input.pf-radio', { type: 'radio', name, value: id, checked: id === value, onchange: () => onPick(id) });
    return h(`label.pf-card${id === value ? '.is-on' : ''}`, { dataset: { id } },
      input,
      p ? swatch(p.style) : h('span.pf-swatch.is-custom', { 'aria-hidden': 'true' }, icon('settings', 16)),
      h('span.pf-text',
        h('span.pf-name', p?.name ?? 'Custom', id === recommended ? h('span.chip.accent', 'Recommended') : null),
        h('span.pf-tag', p?.tagline ?? 'You choose'),
        h('span.pf-desc', p?.description ?? 'Every section, tab and block on or off, and your own accent, background and density.'),
        p ? h('span.pf-meta', highlights(p.flags)) : null));
  }));
}

/**
 * Custom profile: every feature on or off (grouped as in the console), the style (accent,
 * background, density) and the tab a project opens on. `onChange` gets the whole profile each time.
 * Agent features are marked when you said you do not use agents (they stay hidden then).
 */
export function customEditor(initial, onChange, { agentsInUse = true } = {}) {
  const c = structuredClone(initial ?? customDefaults());
  const emit = () => onChange(structuredClone(c));
  const groups = new Map();
  for (const [key, group, label, hint] of FEATURES) {
    if (!groups.has(group)) groups.set(group, []);
    const box = h('input', { type: 'checkbox', checked: c.flags[key] !== false, onchange: (e) => { c.flags[key] = e.target.checked; emit(); } });
    const off = AGENT_FEATURES.has(key) && !agentsInUse;
    groups.get(group).push(h(`label.pf-flag${off ? '.is-off' : ''}`, box,
      h('span', h('span.pf-flag-name', label), h('span.pf-flag-hint', off ? `${hint} Hidden while you do not use agents.` : hint))));
  }
  const choice = (label, options, value, set) => {
    const name = `pfc-${Math.random().toString(36).slice(2, 7)}`;
    return h('div.pf-choice', { role: 'radiogroup', 'aria-label': label },
      h('span.pf-choice-label', label),
      h('div.pf-seg', options.map(([id, text]) => h('label.pf-seg-opt',
        h('input', { type: 'radio', name, value: id, checked: id === value, onchange: () => { set(id); emit(); } }), h('span', text)))));
  };
  return h('div.pf-editor',
    h('div.pf-groups', [...groups].map(([group, rows]) => h('fieldset.pf-group', h('legend', group), rows))),
    h('fieldset.pf-group.pf-style', h('legend', 'Style'),
      h('div.pf-choice', h('span.pf-choice-label', 'Accent colour'), accentPicker(c.style.accent, (v) => { c.style.accent = v; emit(); })),
      choice('Background', PATTERNS, c.style.background || 'hive', (v) => { c.style.background = v; }),
      choice('Density', DENSITIES, c.style.density || 'comfortable', (v) => { c.style.density = v; }),
      choice('A project opens on', START_TABS, c.startTab || 'overview', (v) => { c.startTab = v; })));
}
