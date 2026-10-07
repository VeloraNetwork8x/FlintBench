import { store, notify } from './store.js';

// One socket: live project state, events, terminal streams. Reconnects with backoff.

const ptyHandlers = new Map(); // terminalId -> { out(d), replay(d) }
const transcriptHandlers = new Map(); // agent session id -> fn(msg)
const listeners = new Set();
let socket = null;
let retry = 0;
let timer = null;
let wanted = false;
let onLocked = () => {};
let activityTimer = 0;

export function onLock(fn) {
  onLocked = fn;
}

export function onServerEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function connect() {
  wanted = true;
  if (socket && socket.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener('open', () => {
    retry = 0;
    store.set('connected', true);
    for (const id of ptyHandlers.keys()) send({ t: 'pty.attach', id });
    for (const id of transcriptHandlers.keys()) send({ t: 'transcript.attach', id });
  });
  socket.addEventListener('message', (m) => {
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    handle(msg);
  });
  socket.addEventListener('close', (event) => {
    store.set('connected', false);
    socket = null;
    if (event.code === 4001) {
      wanted = false;
      onLocked();
      return;
    }
    if (!wanted) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      // the server may have restarted (sessions start locked) — let the app re-check auth
      try {
        const res = await fetch('/api/auth/state', { credentials: 'same-origin' });
        const s = await res.json();
        if (s.locked) {
          wanted = false;
          onLocked();
          return;
        }
      } catch {
        // server down: keep retrying
      }
      connect();
    }, Math.min(10_000, 500 * 2 ** retry++));
  });
}

export function disconnect() {
  wanted = false;
  clearTimeout(timer);
  socket?.close(1000);
  socket = null;
}

export function send(msg) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(msg));
}

/** Throttled "user is active" ping so auto-lock follows real use. */
export function reportActivity() {
  const now = Date.now();
  if (now - activityTimer < 30_000) return;
  activityTimer = now;
  send({ t: 'activity' });
}

export function attachPty(id, handlers) {
  ptyHandlers.set(id, handlers);
  send({ t: 'pty.attach', id });
}

export function detachPty(id) {
  ptyHandlers.delete(id);
  send({ t: 'pty.detach', id });
}

/** Live read-only transcript of an external agent session. */
export function attachTranscript(id, fn) {
  transcriptHandlers.set(id, fn);
  send({ t: 'transcript.attach', id });
}

export function detachTranscript(id) {
  transcriptHandlers.delete(id);
  send({ t: 'transcript.detach', id });
}

function handle(msg) {
  switch (msg.t) {
    case 'project':
      store.setProject(msg.p);
      break;
    case 'project.removed':
      store.removeProject(msg.id);
      break;
    case 'candidates':
      store.set('candidates', msg.list);
      break;
    case 'settings':
      store.set('settings', msg.s);
      break;
    case 'docker':
      store.set('integrations', { ...(store.state.integrations ?? {}), docker: msg.s });
      break;
    case 'agents':
      store.set('agents', msg.a);
      break;
    case 'terminal':
      store.setTerminal(msg.term);
      break;
    case 'terminal.removed':
      store.removeTerminal(msg.id);
      break;
    case 'pty.out':
      ptyHandlers.get(msg.id)?.out(msg.d);
      break;
    case 'pty.replay':
      ptyHandlers.get(msg.id)?.replay(msg.d);
      break;
    case 'transcript':
      transcriptHandlers.get(msg.id)?.(msg);
      break;
    case 'event':
      store.state.lastEvent = msg.e;
      notify('event');
      break;
    case 'locked':
      wanted = false;
      onLocked();
      break;
    default:
      break;
  }
  listeners.forEach((fn) => fn(msg));
}
