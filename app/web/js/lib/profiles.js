// Profiles: the structure (which sections, tabs and blocks exist) and the style (accent, background,
// density) of the console. Pure data and functions, no DOM: the server imports this file too.

/** Every feature a profile can turn on or off: [key, group, label, hint]. */
export const FEATURES = [
  ['nav.agents', 'Sidebar', 'Agents section', 'Every agent session across your projects, in its own section.'],
  ['nav.activity', 'Sidebar', 'Activity section', 'A calendar and a chart of the work FlintBench observed.'],
  ['nav.github', 'Sidebar', 'GitHub section', 'Your GitHub repositories, managed from here.'],
  ['tab.services', 'Project tabs', 'Services', 'Start and stop what a project runs: dev servers, tests, containers.'],
  ['tab.agents', 'Project tabs', 'Agents', 'The agent sessions of a project.'],
  ['tab.docs', 'Project tabs', 'Docs', 'README, CLAUDE.md and the other documents of a project.'],
  ['tab.sessions', 'Project tabs', 'Sessions', 'Your work sessions on a project, with what changed in each.'],
  ['tab.tasks', 'Project tabs', 'Tasks', 'A short list of what to do next in a project.'],
  ['tab.graph', 'Project tabs', 'Graph', 'The knowledge graph of a project, when it has one (graphify).'],
  ['home.counters', 'Home', 'Counters', 'Projects, running, need attention, agents active, uncommitted: one click filters.'],
  ['home.live', 'Home', 'Live projects', 'The projects being worked on right now, and what is happening in each.'],
  ['overview.agent', 'Project overview', 'Agent block', 'Start or resume an agent from the overview.'],
  ['overview.preview', 'Project overview', 'Page preview', 'A picture of the page a web app serves, Offline when it is not running.'],
  ['overview.files', 'Project overview', 'Files changed', 'Every file changed lately, with the lines added and removed.'],
  ['ui.technical', 'Details', 'Technical details', 'Docker and running processes in the status bar.'],
  ['ui.greeting', 'Details', 'Welcome sequence', 'The greeting shown after you unlock.'],
];
export const FEATURE_KEYS = FEATURES.map(([key]) => key);

/** Features about AI agents: hidden everywhere when you said you do not use them. */
export const AGENT_FEATURES = new Set(['nav.agents', 'tab.agents', 'overview.agent']);

export const DENSITIES = [['comfortable', 'Comfortable'], ['compact', 'Compact']];
export const START_TABS = [['overview', 'Overview'], ['git', 'Git'], ['files', 'Files'], ['agents', 'Agents']];

const all = (except = []) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, !except.includes(k)]));

/** The ready-made profiles. Labs is the former Test profile: Pro plus features being tried. */
export const PRESETS = {
  essentials: {
    name: 'Essentials',
    tagline: 'Simple and calm',
    description: 'Your projects, their files and Git, and a page preview. Fewer sections and words, nothing technical in the way.',
    flags: all(['nav.agents', 'nav.activity', 'tab.agents', 'tab.docs', 'tab.sessions', 'tab.graph', 'overview.files', 'ui.technical']),
    style: { accent: '#4fd1b5', background: 'none', density: 'comfortable' },
    startTab: 'overview',
  },
  builder: {
    name: 'Builder',
    tagline: 'Balanced, for every day',
    description: 'Everything you use day to day: services, sessions, docs, tasks and activity, without the low-level details.',
    flags: all(['tab.graph', 'ui.technical']),
    style: { accent: '', background: 'hive', density: 'comfortable' },
    startTab: 'overview',
  },
  pro: {
    name: 'Pro',
    tagline: 'Every detail',
    description: 'Every section, tab and detail: processes, Docker, graphs. Denser rows, more on screen.',
    flags: all(),
    style: { accent: '#7c8cff', background: 'grid', density: 'compact' },
    startTab: 'overview',
  },
  pilot: {
    name: 'AI Pilot',
    tagline: 'Agents first',
    description: 'For when agents do most of the work: a project opens on its agents, sessions and live work stay in front.',
    flags: all(['ui.technical']),
    style: { accent: '#b18cff', background: 'dots', density: 'comfortable' },
    startTab: 'agents',
  },
  test: {
    name: 'Labs',
    tagline: 'New features first',
    description: 'Pro, plus the features still being tried before they reach every profile.',
    flags: all(),
    style: { accent: '#ff7ab6', background: 'grid', density: 'compact' },
    startTab: 'overview',
    hidden: true, // not recommended by the setup
  },
};

/** Profile ids, in the order they are offered. */
export const PROFILE_IDS = ['essentials', 'builder', 'pro', 'pilot', 'custom', 'test'];

/** Custom starts from the profile it was made from, then takes what was chosen. */
export function customDefaults(base = 'builder') {
  const p = PRESETS[base] ?? PRESETS.builder;
  return { base, flags: { ...p.flags }, style: { ...p.style }, startTab: p.startTab };
}

/** The profile in force: its id, name, features (key → boolean), style and the tab a project opens on. */
export function resolveProfile(settings) {
  const id = PROFILE_IDS.includes(settings?.profile) ? settings.profile : 'builder';
  if (id === 'custom') {
    const c = settings.customProfile ?? customDefaults();
    const base = customDefaults(c.base);
    return {
      id, name: 'Custom',
      flags: { ...base.flags, ...(c.flags ?? {}) },
      style: { ...base.style, ...(c.style ?? {}) },
      startTab: c.startTab ?? base.startTab,
    };
  }
  const p = PRESETS[id];
  return { id, name: p.name, flags: { ...p.flags }, style: { ...p.style }, startTab: p.startTab };
}

/** Whether you said you build with AI agents (older settings: yes). */
export const usesAgents = (settings) => (settings?.agents?.use ?? 'sometimes') !== 'none';

/** Whether a feature is on for these settings: the profile's choice, and agents only when you use them. */
export function featureOn(settings, key) {
  const { flags } = resolveProfile(settings);
  if (AGENT_FEATURES.has(key) && !usesAgents(settings)) return false;
  return flags[key] !== false;
}

/**
 * The profile the setup recommends. Agents doing most of the work → AI Pilot; otherwise by
 * experience: just starting → Essentials, a few years → Builder, many years → Pro.
 */
export function recommendProfile({ experience, ai } = {}) {
  if (ai === 'mostly') return 'pilot';
  if (experience === 'new') return 'essentials';
  if (experience === 'expert') return 'pro';
  return 'builder';
}
