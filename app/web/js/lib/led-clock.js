import { h, icon, replace } from './dom.js';
import { timer, formatDuration } from './timer.js';

/**
 * A digital LED clock: seven-segment digits (unlit segments stay faintly visible, like a real
 * display), the week as a column with today lit, and the full date underneath. It also holds a
 * countdown timer: the digits keep the time, the countdown runs small in the bottom-left corner,
 * and an alarm rings at zero.
 */

const SVG = 'http://www.w3.org/2000/svg';
// segments of a 30 × 54 cell: a top, b top-right, c bottom-right, d bottom, e bottom-left, f top-left, g middle
const across = (y) => `5,${y - 2.5} 25,${y - 2.5} 27.5,${y} 25,${y + 2.5} 5,${y + 2.5} 2.5,${y}`;
const down = (x, y0, y1) => `${x},${y0} ${x + 2.5},${y0 + 2.5} ${x + 2.5},${y1 - 2.5} ${x},${y1} ${x - 2.5},${y1 - 2.5} ${x - 2.5},${y0 + 2.5}`;
const SEGMENTS = {
  a: across(2.5),
  b: down(27.5, 4, 25.5),
  c: down(27.5, 28.5, 50),
  d: across(51.5),
  e: down(2.5, 28.5, 50),
  f: down(2.5, 4, 25.5),
  g: across(27),
};
const DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function digit(cls) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 30 54');
  svg.setAttribute('class', `led-digit ${cls}`);
  const segs = {};
  for (const [name, points] of Object.entries(SEGMENTS)) {
    const p = document.createElementNS(SVG, 'polygon');
    p.setAttribute('points', points);
    p.setAttribute('class', 'seg');
    svg.append(p);
    segs[name] = p;
  }
  let shown = null;
  return {
    el: svg,
    /** n: 0–9, or null for a blank digit */
    set(n) {
      if (n === shown) return;
      shown = n;
      for (const [name, p] of Object.entries(segs)) p.classList.toggle('on', n !== null && DIGITS[n].includes(name));
    },
  };
}

const PRESETS = [1, 3, 5, 10, 15, 25, 30, 45, 60];
const TIME_UP = 'Time\u2019s up';

/** The timer panel: presets and h/m/s when idle; pause, +1 min and cancel while it runs. */
function timerPanel(close) {
  const el = h('div.timer-pop', { role: 'dialog', 'aria-label': 'Timer', hidden: true });
  const num = (label, max, value) => h('input.input.mono.timer-num', { type: 'number', min: 0, max, value, inputMode: 'numeric', 'aria-label': label });
  const hh = num('Hours', 23, 0);
  const mm = num('Minutes', 59, 5);
  const ss = num('Seconds', 59, 0);
  const start = (ms) => { if (ms > 0) { timer.start(ms); close(); } };
  const startCustom = () => start(((Number(hh.value) || 0) * 3600 + (Number(mm.value) || 0) * 60 + (Number(ss.value) || 0)) * 1000);
  for (const input of [hh, mm, ss]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startCustom(); } });
  const left = h('div.timer-left.mono');
  const bar = h('span.timer-bar-fill');
  function render() {
    const st = timer.status();
    if (st === 'ringing') {
      replace(el, h('div.timer-title', icon('timer', 14), TIME_UP),
        h('button.btn.primary.timer-wide', { type: 'button', onclick: () => { timer.stop(); close(); } }, 'Stop alarm'));
    } else if (st === 'idle') {
      replace(el,
        h('div.timer-title', icon('timer', 14), 'Timer'),
        h('div.timer-presets', PRESETS.map((m) => h('button.btn.sm', { type: 'button', onclick: () => start(m * 60_000) }, m === 60 ? '1 h' : `${m} min`))),
        h('div.timer-custom',
          h('label.timer-field', hh, h('span', 'h')), h('label.timer-field', mm, h('span', 'min')), h('label.timer-field', ss, h('span', 's')),
          h('button.btn.primary', { type: 'button', onclick: startCustom }, icon('play', 11), 'Start')),
        h('p.timer-note', 'An alarm rings at zero, even with interface sounds off.'));
    } else {
      const paused = st === 'paused';
      const ends = new Date(timer.endsAt() ?? Date.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      replace(el,
        h('div.timer-title', icon('timer', 14), paused ? 'Timer · paused' : `Timer · ends ${ends}`),
        left, h('span.timer-bar', bar),
        h('div.timer-actions',
          h('button.btn', { type: 'button', onclick: () => (paused ? timer.resume() : timer.pause()) }, paused ? 'Resume' : 'Pause'),
          h('button.btn', { type: 'button', onclick: () => timer.add(60_000) }, '+1 min'),
          h('span.spacer'),
          h('button.btn.ghost.danger', { type: 'button', onclick: () => { timer.cancel(); close(); } }, 'Cancel')));
    }
  }
  function tick() {
    if (!['running', 'paused'].includes(timer.status())) return;
    left.textContent = formatDuration(timer.remaining());
    bar.style.transform = `scaleX(${timer.total() ? timer.remaining() / timer.total() : 0})`;
  }
  return { el, render: () => { render(); tick(); }, tick };
}

export function ledClock() {
  const big = [digit('big'), digit('big'), digit('big'), digit('big')];
  const small = [digit('small'), digit('small')];
  const colon = h('span.led-colon', { 'aria-hidden': 'true' }, h('i'), h('i'));
  const days = DAYS.map((d) => h('span.led-day', d));
  const date = h('div.led-date');
  const face = h('div.led-face', { 'aria-hidden': 'true' },
    h('div.led-days', days),
    h('div.led-time', big[0].el, big[1].el, colon, big[2].el, big[3].el, h('span.led-sec', small[0].el, small[1].el)));
  const timerText = h('span.led-timer-text');
  const timerBtn = h('button.led-timer-btn', { type: 'button', title: 'Timer', 'aria-label': 'Timer', 'aria-expanded': 'false' }, icon('timer', 13), timerText);
  const panel = timerPanel(() => setOpen(false));
  const el = h('aside.led-clock', { role: 'timer', 'aria-label': 'Current time' }, face, h('div.led-foot', timerBtn, date), panel.el);

  function setOpen(open) {
    panel.el.hidden = !open;
    timerBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      panel.render();
      panel.el.querySelector('button, input')?.focus();
    }
  }
  timerBtn.addEventListener('click', () => {
    if (timer.status() === 'ringing') { timer.stop(); setOpen(false); return; }
    setOpen(panel.el.hidden);
  });
  document.addEventListener('pointerdown', (e) => { if (!panel.el.hidden && !el.contains(e.target)) setOpen(false); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.el.hidden) { e.stopPropagation(); setOpen(false); timerBtn.focus(); } });

  let lastStatus = timer.status();
  timer.on(() => {
    const st = timer.status();
    if (st !== lastStatus) {
      lastStatus = st;
      if (st === 'ringing') setOpen(true); // the panel offers "Stop alarm"
      else if (!panel.el.hidden) panel.render();
    }
    panel.tick();
    update();
  });

  function update(d = new Date()) {
    const st = timer.status();
    const counting = st === 'running' || st === 'paused';
    el.classList.toggle('is-timer', counting);
    el.classList.toggle('is-paused', st === 'paused');
    el.classList.toggle('is-ringing', st === 'ringing');
    timerText.textContent = st === 'ringing' ? `${TIME_UP} · stop` : counting ? `${formatDuration(timer.remaining())}${st === 'paused' ? ' · paused' : ''}` : '';
    const hh = d.getHours();
    const mm = d.getMinutes();
    const ss = d.getSeconds();
    big[0].set(Math.floor(hh / 10)); big[1].set(hh % 10);
    big[2].set(Math.floor(mm / 10)); big[3].set(mm % 10);
    small[0].set(Math.floor(ss / 10)); small[1].set(ss % 10);
    const today = (d.getDay() + 6) % 7;
    days.forEach((x, i) => x.classList.toggle('on', i === today));
    date.textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    el.setAttribute('aria-label', `${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, ${date.textContent}${counting ? `. Timer: ${formatDuration(timer.remaining())} left` : ''}`);
  }
  update();
  return { el, update };
}
