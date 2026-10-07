import './lib/legacy-storage.js';
import { api, onAuthLost } from './lib/api.js';
import { store } from './lib/store.js';
import { connect, disconnect, onLock } from './lib/ws.js';
import { renderSetup, renderLock } from './views/auth.js';
import { mountShell } from './views/shell.js';
import { disposeAllTerminals } from './terminal/dock.js';
import { runBoot } from './views/boot.js';
import { play } from './lib/sound.js';
import { applyTheme, applyCachedAccent, applyDensity, applySettingsLook } from './lib/theme.js';
import { runSetupWizard } from './views/wizard.js';

const root = document.getElementById('root');
let shell = null;
let showingLock = false;


/** Locking removes every trace of project data from the page. */
function teardown() {
  disconnect();
  shell?.destroy();
  shell = null;
  disposeAllTerminals();
  store.setBootstrap({ settings: store.state.settings, projects: [], candidates: [], ignored: [], agents: { tools: [], active: [], processes: [], unattributed: [] }, integrations: null, terminals: [], platform: '', dataDir: '', lastScanAt: null });
  document.querySelectorAll('.overlay, dialog.modal').forEach((el) => el.remove());
  document.getElementById('toasts').replaceChildren();
}

async function showLock() {
  if (showingLock) return;
  showingLock = true;
  teardown();
  document.title = 'FlintBench — Locked';
  const state = await api.get('/api/auth/state');
  wearAppearance(state);
  if (state.needsSetup) {
    showingLock = false;
    renderSetup(root, () => start());
    return;
  }
  renderLock(root, state, () => {
    showingLock = false;
    start();
  });
}

/** Loading, setup and unlock wear the owner's theme, accent and background (the defaults on first run). */
function wearAppearance(state) {
  const a = state?.appearance;
  if (!a) return;
  applyTheme(a.theme, a.accent ?? '', a.background ?? 'hive', a.profile ?? 'builder', a.uiScale ?? 1);
  applyDensity(a.density);
}

/** Terminals measure their cells once: the bundled fonts must be ready before the console opens. */
function fontsReady() {
  const wanted = ['13px "Geist"', '13px "Geist Mono"', '13px "Symbols Nerd Font Mono"'];
  return Promise.race([
    Promise.all(wanted.map((f) => document.fonts.load(f, f.includes('Symbols') ? '\ue0b0' : 'a'))),
    new Promise((r) => setTimeout(r, 2500)),
  ]).catch(() => {});
}

async function start() {
  let state;
  try {
    state = await api.get('/api/auth/state');
  } catch {
    root.replaceChildren(Object.assign(document.createElement('div'), { className: 'boot', textContent: 'FlintBench server is not reachable' }));
    setTimeout(start, 3000);
    return;
  }
  wearAppearance(state);
  if (state.needsSetup) {
    document.title = 'FlintBench — Setup';
    renderSetup(root, () => start());
    return;
  }
  if (state.locked) {
    await showLock();
    return;
  }
  const [boot] = await Promise.all([api.get('/api/bootstrap'), fontsReady()]);
  store.state.auth = state;
  store.setBootstrap(boot);
  applySettingsLook(boot.settings);
  // first run: the setup wizard shapes the console before it opens (once; afterwards, change profile)
  if (!boot.settings.setup?.done) {
    document.title = 'FlintBench — Setup';
    await runSetupWizard(root);
    applySettingsLook(store.state.settings);
  }
  connect();
  shell = mountShell(root, { lock: lockNow, logout: logoutNow, applyTheme });
  // the loading sequence runs on every open of the console (refresh included); after a refresh the
  // browser may block audio until the first click, in which case the greeting stays on screen only
  await runBoot();
}

async function lockNow() {
  play('lock');
  await api.post('/api/auth/lock').catch(() => {});
  await showLock();
}

async function logoutNow() {
  await api.post('/api/auth/logout').catch(() => {});
  await showLock();
}

onLock(() => showLock());
onAuthLost('locked', () => showLock());
onAuthLost('unauthenticated', () => showLock());

applyCachedAccent();
start();
