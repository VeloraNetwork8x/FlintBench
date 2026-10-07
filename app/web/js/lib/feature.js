import { store } from './store.js';
import { featureOn, resolveProfile, usesAgents } from './profiles.js';

/** Whether a feature of the profile in force is on (lib/profiles.js FEATURES). */
export const has = (key) => featureOn(store.state.settings, key);

/** The profile in force: id, name, features, style, start tab. */
export const currentProfile = () => resolveProfile(store.state.settings);

/** Whether you build with AI agents (Settings › Agents, asked by the setup). */
export const agentsInUse = () => usesAgents(store.state.settings);
