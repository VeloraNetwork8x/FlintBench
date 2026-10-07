import { h, icon, brandMark } from '../lib/dom.js';
import { toolMarks } from '../lib/agent-icons.js';
import { store } from '../lib/store.js';
import { play, playGreeting, greeting } from '../lib/sound.js';
import { has, agentsInUse } from '../lib/feature.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lines of the systems check — all from the real bootstrap state, nothing invented. */
function checks() {
  const s = store.state;
  const projects = [...s.projects.values()];
  const running = projects.filter((p) => p.running).length;
  const active = projects.reduce((n, p) => n + (p.agents?.active?.length ?? 0), 0);
  const tools = (s.agents.tools ?? []).filter((t) => t.installed);
  const docker = s.integrations?.docker;
  const lines = [
    { icon: 'lock', label: 'Identity', detail: s.auth?.username ? `Signed in as ${s.auth.username}` : 'Signed in' },
    { icon: 'folder', label: 'Projects', detail: `${projects.length} registered · ${running} running` },
    // agents only for someone who uses them (Settings › Agents)
    agentsInUse() ? { marks: tools.map((t) => t.id), icon: 'agent', label: 'Agents', detail: tools.length ? `${tools.length} ready` : 'none detected' } : null,
    agentsInUse() ? { icon: 'activity', label: 'Sessions', detail: active ? `${active} active` : 'none active' } : null,
  ].filter(Boolean);
  if (docker) lines.push({ icon: 'box', label: 'Docker', detail: docker.enabled ? (docker.running ? 'engine up' : 'engine down') : 'off', warn: docker.enabled && !docker.running });
  lines.push({ icon: 'refresh', label: 'Live link', detail: 'connecting…', live: true });
  return lines;
}

/**
 * Boot sequence shown over the freshly mounted console after an unlock or sign-in, in three
 * beats: the systems check fills its panel row by row; the panel closes; the greeting rises
 * (on screen and spoken), then the whole screen fades out onto the dashboard.
 * Any key or click skips straight to the dashboard.
 */
export function runBoot() {
  // the profile can leave the welcome sequence out: the console is simply there, with its ready tone
  if (!has('ui.greeting')) {
    play('ready');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const now = new Date();
    const text = greeting(now, store.state.auth?.username);
    const lines = checks();
    const list = h('ol.boot-lines');
    const state = h('span.boot-state', 'Starting');
    const panel = h('section.boot-panel',
      h('header.boot-head', h('span.brand-mark', brandMark()), h('strong', 'FlintBench'), h('span.spacer'), state),
      list);
    const greet = h('div.boot-greet',
      h('h1', text),
      h('p', now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }), ' · ', h('span.num', now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))));
    const el = h('div.bootseq', { role: 'status', 'aria-live': 'polite', 'aria-label': 'Starting FlintBench' },
      h('div.boot-core',
        panel,
        greet),
      h('p.boot-skip', 'Press any key to continue'));
    document.body.append(el);

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', skip, true);
      el.removeEventListener('pointerdown', skip);
      el.classList.add('is-out');
      await wait(reduced() ? 0 : 420);
      el.remove();
      resolve();
    };
    const skip = (e) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      finish();
    };
    window.addEventListener('keydown', skip, true);
    el.addEventListener('pointerdown', skip);

    (async () => {
      const step = reduced() ? 0 : 170;
      for (let i = 0; i < lines.length && !finished; i++) {
        const line = lines[i];
        const detail = h('span.boot-detail', line.marks?.length ? toolMarks(line.marks, 15) : null, line.detail);
        const dot = h(`span.dot.${line.warn ? 'warn' : 'ok'}`, { 'aria-hidden': 'true' });
        const li = h(`li${line.warn ? '.is-warn' : ''}`,
          h('span.boot-icon', { 'aria-hidden': 'true' }, icon(line.icon, 15)),
          h('span.boot-label', line.label), detail, dot);
        list.append(li);
        if (line.live) {
          // the websocket is opening in parallel: show its real outcome
          for (let t = 0; t < 15 && !store.state.connected && !finished; t++) await wait(100);
          detail.textContent = store.state.connected ? 'connected' : 'reconnecting in background';
          li.classList.toggle('is-warn', !store.state.connected);
          dot.className = `dot ${store.state.connected ? 'ok' : 'warn'}`;
        }
        play('tick');
        await wait(step);
      }
      if (finished) return;
      // 1 · everything is loaded
      state.textContent = 'Ready';
      el.classList.add('is-ready');
      await wait(reduced() ? 0 : 420);
      if (finished) return;
      // 2 · the panel closes
      panel.classList.add('is-closing');
      await wait(reduced() ? 0 : 360);
      if (finished) return;
      // 3 · the greeting rises, spoken; then the screen fades onto the dashboard
      el.classList.add('is-greeting');
      play('ready');
      playGreeting(now);
      await wait(reduced() ? 1200 : 2000);
      finish();
    })();
  });
}
