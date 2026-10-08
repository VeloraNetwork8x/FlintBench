import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { killTree, yieldPriority } from './exec.js';

/**
 * Screenshots of a project's own local web pages, for the Overview preview. Pages are not framed
 * (many apps forbid it with X-Frame-Options / frame-ancestors, rightly): an installed Chromium
 * browser renders them headless and we keep the picture. One shot at a time, cached briefly.
 */

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA ?? '';
const CANDIDATES = process.platform === 'win32' ? [
  path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
] : process.platform === 'darwin' ? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'];

export function findBrowser() {
  return CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

const cache = new Map(); // url -> { at, png }
let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const offline = (url) => Object.assign(new Error(`${url} is offline`), { status: 503, expose: true, reason: 'offline' });

/** True when something accepts connections on the page's port (a stopped dev server does not). */
export function reachable(url, timeout = 1500) {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve) => {
    const socket = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// One picture per visit, a few seconds in: past the loader most pages show first, and one headless
// browser kept short (several pictures a visit made the machine sluggish).
export const SHOT_AT_MS = [5000];
const sessions = new Map(); // url -> [deferred] while a visit is under way
// after a browser that would not start or a page that failed: no new browser for a while (a busy
// machine only gets busier with every retry); the page shows the last picture meanwhile
const COOL_DOWN_MS = 2 * 60_000;
let coolUntil = 0;
const busy = () => Object.assign(new Error('Previews are paused for a moment: the machine is busy'), { status: 429, expose: true, reason: 'busy' });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // a step nobody asked for must not be an unhandled rejection
  return { promise, resolve, reject };
}

/**
 * The PNG of url rendered at width × height (`step` is kept for old callers: there is one picture).
 * `fresh` starts a new visit unless one is under way (its picture is shared); otherwise the last
 * picture (≤ maxAgeMs old) answers. A page that is not served (the dev server stopped) fails fast as `offline` (503)
 * without starting a browser; so does one that drops the connection while it loads. Throws when no
 * browser is available or the page fails otherwise.
 */
export function screenshot(url, { width = 1280, height = 800, maxAgeMs = 20_000, step = 3, fresh = false } = {}) {
  const i = Math.min(Math.max(Number(step) || 1, 1), SHOT_AT_MS.length) - 1;
  const running = sessions.get(url);
  if (running) return running[i].promise;
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.png);
  if (Date.now() < coolUntil) return Promise.reject(busy());
  const shots = SHOT_AT_MS.map(deferred);
  sessions.set(url, shots);
  const job = queue.then(async () => {
    if (!(await reachable(url))) throw offline(url);
    const onShot = (n, png) => shots[n].resolve(png);
    // a profile still held by a browser that is closing (Chromium exit code 21): once more, a second later
    await capture(url, width, height, onShot).catch(async (error) => {
      if (!/quit at start \(21\)/.test(error.message)) throw error;
      await sleep(1000);
      return capture(url, width, height, onShot);
    });
  });
  queue = job.catch(() => {});
  job.then(
    () => shots.at(-1).promise.then((png) => cache.set(url, { at: Date.now(), png })),
    (error) => {
      if (error.reason !== 'offline') coolUntil = Date.now() + COOL_DOWN_MS;
      shots.forEach((d) => d.reject(error));
    },
  ).finally(() => sessions.delete(url));
  return shots[i].promise;
}

/** A loopback TCP port nothing listens on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function capture(url, width, height, onShot) {
  const browser = findBrowser();
  if (!browser) throw Object.assign(new Error('No Chrome, Edge or Brave found for previews'), { status: 404, expose: true });
  // a profile of its own per FlintBench (by its port): two instances never lock each other out
  const profile = path.join(os.tmpdir(), `flintbench-preview-profile-${process.env.FLINTBENCH_PORT || 4477}`);
  // a debugging port the system says is free (a random pick could collide with a dev server)
  const port = await freePort();
  // as light as a browser gets: one renderer, nothing in the background, below normal priority
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-sync', '--no-pings', '--renderer-process-limit=1', '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  yieldPriority(child.pid);
  // a browser that quits at once (its profile in use, a crash) is a failure now, not in 15 s
  let exited = null;
  child.once('exit', (code) => { exited = code ?? 'signal'; });
  child.once('error', (error) => { exited = error.code ?? 'error'; });
  const deadline = Date.now() + 15_000;
  try {
    let target = null;
    while (!target && Date.now() < deadline && exited === null) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error(exited !== null ? `browser quit at start (${exited})` : 'browser did not start within 15 s');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let seq = 0;
    const waits = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); }
    });
    const cdp = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waits.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const nav = await cdp('Page.navigate', { url });
    // the server went away between the check and the page (or refuses it): offline, not a failure
    if (/ERR_(CONNECTION_(RESET|REFUSED|CLOSED|ABORTED)|EMPTY_RESPONSE|ADDRESS_UNREACHABLE)/.test(nav.result?.errorText ?? '')) throw offline(url);
    if (nav.result?.errorText) throw new Error(`${url}: ${nav.result.errorText}`);
    // dev servers keep sockets open forever: pictures at fixed moments instead of waiting for "idle"
    const start = Date.now();
    for (let n = 0; n < SHOT_AT_MS.length; n++) {
      await sleep(Math.max(0, start + SHOT_AT_MS[n] - Date.now()));
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      if (!shot.result?.data) throw new Error('capture failed');
      onShot(n, Buffer.from(shot.result.data, 'base64'));
    }
    ws.close();
  } finally {
    // the whole tree: renderer and helper processes left behind would hold the profile (and memory);
    // the next capture starts only once this browser is gone, or it finds the profile locked
    if (exited === null) {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      killTree(child.pid);
      await Promise.race([gone, sleep(5000)]);
    }
  }
}
