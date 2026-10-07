import { prefs } from './store.js';
import { playAlarm } from './sound.js';
import { toast } from './ui.js';
import { icon } from './dom.js';

/**
 * The clock's countdown timer. One timer at a time, kept in this browser so a reload does not
 * lose it. When it reaches zero the alarm rings every 1.6 s until it is stopped (or for a minute).
 */

const KEY = 'timer';
const RING_FOR = 60_000;
let state = prefs.get(KEY, null); // { total, endsAt, pausedLeft }
let ringing = null; // { since, loop, title }
const listeners = new Set();

const save = () => prefs.set(KEY, state);
const emit = () => listeners.forEach((fn) => fn());

export function formatDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

export const timer = {
  /** 'idle' | 'running' | 'paused' | 'ringing' */
  status() {
    if (ringing) return 'ringing';
    if (!state) return 'idle';
    return state.pausedLeft != null ? 'paused' : 'running';
  },
  remaining(now = Date.now()) {
    if (!state) return 0;
    return state.pausedLeft ?? Math.max(0, state.endsAt - now);
  },
  total: () => state?.total ?? 0,
  endsAt: () => (state && state.pausedLeft == null ? state.endsAt : null),
  start(ms) {
    stopRinging();
    state = { total: ms, endsAt: Date.now() + ms, pausedLeft: null };
    save();
    emit();
  },
  pause() {
    if (!state || state.pausedLeft != null) return;
    state.pausedLeft = Math.max(0, state.endsAt - Date.now());
    save();
    emit();
  },
  resume() {
    if (!state || state.pausedLeft == null) return;
    state.endsAt = Date.now() + state.pausedLeft;
    state.pausedLeft = null;
    save();
    emit();
  },
  add(ms) {
    if (!state) return;
    if (state.pausedLeft != null) state.pausedLeft += ms;
    else state.endsAt += ms;
    state.total += ms;
    save();
    emit();
  },
  cancel() {
    state = null;
    save();
    stopRinging();
    emit();
  },
  stop: () => stopRinging(),
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function ring(total) {
  stopRinging(false);
  const title = document.title;
  ringing = { since: Date.now(), title, loop: null };
  const once = () => {
    if (!ringing) return;
    if (Date.now() - ringing.since > RING_FOR) { stopRinging(); return; }
    playAlarm();
    document.title = document.title.startsWith('⏰') ? ringing.title : `⏰ Time's up · ${ringing.title}`;
  };
  once();
  ringing.loop = setInterval(once, 1600);
  toast(`The ${formatDuration(total)} timer has finished.`, {
    kind: 'warn', title: "Time's up", iconNode: icon('timer', 20), timeout: RING_FOR, sound: false,
    onClick: () => stopRinging(),
  });
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification("Time's up", { body: `The ${formatDuration(total)} timer has finished.` }); } catch { /* ignore */ }
  }
  emit();
}

function stopRinging(notify = true) {
  if (!ringing) return;
  clearInterval(ringing.loop);
  document.title = ringing.title;
  ringing = null;
  if (notify) emit();
}

function check() {
  if (!state || state.pausedLeft != null) return;
  const late = Date.now() - state.endsAt;
  if (late < 0) return;
  const { total } = state;
  state = null;
  save();
  // finished while this page was closed long ago: say so quietly instead of ringing late
  if (late > RING_FOR) {
    toast(`A ${formatDuration(total)} timer finished at ${new Date(Date.now() - late).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`, { kind: 'info', iconNode: icon('timer', 20) });
    emit();
    return;
  }
  ring(total);
}

let lastSecond = -1;
setInterval(() => {
  check();
  const sec = Math.floor(Date.now() / 1000);
  if (state && state.pausedLeft == null && sec !== lastSecond) { lastSecond = sec; emit(); }
}, 250);
