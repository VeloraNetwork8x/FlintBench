import { PROFILE_IDS, resolveProfile } from './profiles.js';
/**
 * Theme (dark / light / system) and the accent colour.
 * The accent is chosen as one vivid colour; from it we derive what each theme needs to stay
 * readable: a lighter shade on dark surfaces, a deeper one on light surfaces. The raw colour is
 * kept for the LED clock, which always sits on a dark face.
 */

export const DEFAULT_ACCENT = '#6cc6ff';
const CACHE_KEY = 'flintbench:accent';

export const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v ?? ''));

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
function luminance(c) {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/** Mixes the colour toward `toward` in small steps until it reaches `min` contrast against `bg`. */
function readable(hex, bg, toward, min) {
  const c = rgb(hex);
  const b = rgb(bg);
  for (let t = 0; t <= 1; t += 0.04) {
    const mixed = c.map((v, i) => v + (toward[i] - v) * t);
    if (contrast(mixed, b) >= min) return toHex(mixed);
  }
  return toHex(toward);
}

/** HSL (h 0–360, s/l 0–100) → #rrggbb. */
export function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return toHex([f(0), f(8), f(4)]);
}

/** Hue (0–360) of a colour, for the hue slider. */
export function hueOf(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

export function applyAccent(hex) {
  const root = document.documentElement.style;
  if (!isHex(hex) || hex.toLowerCase() === DEFAULT_ACCENT) {
    for (const p of ['--accent-raw', '--accent-dark', '--accent-light']) root.removeProperty(p);
  } else {
    root.setProperty('--accent-raw', hex);
    root.setProperty('--accent-dark', readable(hex, '#0f1218', [255, 255, 255], 4.2));
    root.setProperty('--accent-light', readable(hex, '#fafbfc', [0, 0, 0], 4.5));
  }
  try { localStorage.setItem(CACHE_KEY, isHex(hex) ? hex : ''); } catch { /* storage unavailable */ }
}

export const PATTERNS = [['hive', 'Hexagons'], ['dots', 'Dots'], ['grid', 'Grid'], ['lines', 'Diagonal lines'], ['none', 'None']];
const PATTERN_KEY = 'flintbench:pattern';

/** Background pattern of the console (and of the lock screen, from the copy kept in this browser). */
export function applyPattern(name) {
  const value = PATTERNS.some(([id]) => id === name) ? name : 'hive';
  document.documentElement.dataset.pattern = value;
  try { localStorage.setItem(PATTERN_KEY, value); } catch { /* storage unavailable */ }
}

const PROFILE_KEY = 'flintbench:profile';

/** The profile in force (lib/profiles.js), on <html data-profile>; Labs is 'test'. */
export function applyProfile(name) {
  const value = PROFILE_IDS.includes(name) ? name : 'builder';
  document.documentElement.dataset.profile = value;
  try { localStorage.setItem(PROFILE_KEY, value); } catch { /* storage unavailable */ }
}

/** True in the Labs profile (id 'test'), where features are tried before they reach every profile. */
export const isTestProfile = () => document.documentElement.dataset.profile === 'test';

const DENSITY_KEY = 'flintbench:density';

/** Row heights and spacing of the profile: comfortable (default) or compact. */
export function applyDensity(value) {
  const v = value === 'compact' ? 'compact' : 'comfortable';
  document.documentElement.dataset.density = v;
  try { localStorage.setItem(DENSITY_KEY, v); } catch { /* storage unavailable */ }
}

/** Theme and scale are yours; accent, background and density come from the profile. */
export function applySettingsLook(s) {
  if (!s) return;
  const { style } = resolveProfile(s);
  applyTheme(s.theme, style.accent ?? '', style.background ?? 'hive', s.profile, s.uiScale ?? 1);
  applyDensity(style.density);
}

const SCALE_KEY = 'flintbench:ui-scale';

/** Size of the content area relative to its designed size (0.8–1.4, 1 = 100%); the sidebar keeps its size. */
export function applyScale(value) {
  const v = Number(value);
  const scale = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4].includes(v) ? v : 1;
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* storage unavailable */ }
}

export function applyTheme(theme, accent, pattern, profile, scale) {
  const resolved = theme === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme ?? 'dark';
  document.documentElement.dataset.theme = resolved;
  if (accent !== undefined) applyAccent(accent);
  if (pattern !== undefined) applyPattern(pattern);
  if (profile !== undefined) applyProfile(profile);
  if (scale !== undefined) applyScale(scale);
}

/** The last accent seen in this browser, so the lock screen wears it before settings load. */
export function applyCachedAccent() {
  try {
    applyAccent(localStorage.getItem(CACHE_KEY) ?? '');
    applyPattern(localStorage.getItem(PATTERN_KEY) ?? 'hive');
    applyProfile(localStorage.getItem(PROFILE_KEY) ?? 'builder');
    applyDensity(localStorage.getItem(DENSITY_KEY) ?? 'comfortable');
    applyScale(localStorage.getItem(SCALE_KEY) ?? 1);
  } catch { /* storage unavailable */ }
}
