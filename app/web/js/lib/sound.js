import { prefs } from './store.js';

// Interface sounds and the spoken greeting. Everything is synthesised locally:
// Web Audio for sounds (no files); the greeting is a recorded voice (app/web/sounds).
// Sounds mark outcomes only — never hover, typing or navigation.

let ctx = null;
let master = null;

export const soundEnabled = () => prefs.get('sound.enabled', true);
export const voiceEnabled = () => prefs.get('voice.enabled', true);
export const VOICE_VOLUMES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
/** Loudness of the recorded voice (0.1–1), remembered only in this browser. */
export const voiceVolume = () => {
  const v = Number(prefs.get('voice.volume', 1));
  return VOICE_VOLUMES.includes(v) ? v : 1;
};

function audio(force = false) {
  if (!force && !soundEnabled()) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.22;
      // a gentle low-pass keeps every tone soft ("glass", not "beep")
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 5200;
      master.connect(tone).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** One soft note: sine body + a quieter triangle an octave up, fast attack, exponential decay. */
function note(freq, { at = 0, dur = 0.18, gain = 0.9, type = 'sine', force = false } = {}) {
  const c = audio(force);
  if (!c) return;
  const t = c.currentTime + at;
  for (const [mult, level, wave] of [[1, gain, type], [2, gain * 0.18, 'triangle']]) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq * mult, t);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(level, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

/** A short pitch glide, for agent start/stop. */
function glide(from, to, { dur = 0.22, gain = 0.7 } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
  osc.connect(env).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.12);
}

const SOUNDS = {
  unlock: () => { note(659.25, { dur: 0.16 }); note(987.77, { at: 0.09, dur: 0.28 }); },
  ready: () => { note(523.25, { dur: 0.6, gain: 0.5 }); note(659.25, { at: 0.07, dur: 0.6, gain: 0.45 }); note(987.77, { at: 0.14, dur: 0.8, gain: 0.4 }); },
  success: () => note(1318.5, { dur: 0.14, gain: 0.55 }),
  error: () => { note(392, { dur: 0.16, gain: 0.8 }); note(311.13, { at: 0.11, dur: 0.26, gain: 0.8 }); },
  agentStart: () => glide(520, 880),
  agentStop: () => glide(760, 440, { gain: 0.5 }),
  lock: () => { note(783.99, { dur: 0.14 }); note(523.25, { at: 0.09, dur: 0.24 }); },
  tick: () => note(1760, { dur: 0.06, gain: 0.25 }),
  // an agent finished its task: a calm descending third, distinct from "success"
  done: () => { note(880, { dur: 0.22, gain: 0.5 }); note(698.46, { at: 0.12, dur: 0.38, gain: 0.45 }); },
};

/**
 * The timer alarm: three quick high notes and a higher one. It rings even with interface sounds
 * off — the owner set it on purpose.
 */
export function playAlarm() {
  try {
    for (const at of [0, 0.16, 0.32]) note(1046.5, { at, dur: 0.12, gain: 1, force: true });
    note(1396.9, { at: 0.56, dur: 0.34, gain: 1, force: true });
  } catch {
    // audio is a nicety
  }
}

export function play(name) {
  try {
    SOUNDS[name]?.();
  } catch {
    // audio is a nicety: never let it break an action
  }
}

/* ---------------- greeting ---------------- */

export function partOfDay(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  return 'evening';
}

/** The written greeting uses the owner's name; the recorded voice says "Sir". */
export function greeting(date = new Date(), name = 'Sir') {
  return `Good ${partOfDay(date)}, ${name || 'Sir'}.`;
}

/**
 * Plays the recorded greeting for this part of the day (app/web/sounds/greeting-*.mp3).
 * Resolves true when playback started; false when the voice is off or the browser refused.
 */
export async function playGreeting(date = new Date(), { volume = voiceVolume() } = {}) {
  if (!voiceEnabled()) return false;
  try {
    const voice = new Audio(`/sounds/greeting-${partOfDay(date)}.mp3`);
    voice.volume = volume;
    await voice.play();
    return true;
  } catch {
    return false;
  }
}
