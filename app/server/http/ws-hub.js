import { WebSocketServer } from 'ws';
import { parseCookies, COOKIE, allowedHosts, allowedOrigins } from './server.js';

/**
 * One authenticated WebSocket per tab: live project state, events, terminal streams.
 * Locked or logged-out sessions are disconnected immediately.
 */
export class WsHub {
  constructor({ server, auth, port, log = console }) {
    this.auth = auth;
    this.log = log;
    this.clients = new Set();
    this.handlers = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    const hosts = allowedHosts(port);
    const origins = allowedOrigins(port);

    server.on('upgrade', (req, socket, head) => {
      const reject = (code, text) => {
        socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') return reject(404, 'Not Found');
      if (!hosts.has(req.headers.host ?? '')) return reject(421, 'Misdirected Request');
      if (!origins.has(req.headers.origin ?? '')) return reject(403, 'Forbidden');
      const session = this.auth.session(parseCookies(req.headers.cookie)[COOKIE]);
      if (!session) return reject(401, 'Unauthorized');
      if (session.locked) return reject(423, 'Locked');
      return this.wss.handleUpgrade(req, socket, head, (ws) => this.#connect(ws, session));
    });

    const kick = (sessionId) => {
      for (const c of this.clients) {
        if (c.session.id === sessionId) {
          this.#send(c, { t: 'locked' });
          c.ws.close(4001, 'locked');
        }
      }
    };
    auth.on('locked', kick);
    auth.on('logout', kick);

    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  #connect(ws, session) {
    const client = { ws, session, alive: true, terminals: new Set(), transcripts: new Map() };
    this.clients.add(client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => {
      this.clients.delete(client);
      for (const detach of client.transcripts.values()) detach();
      client.transcripts.clear();
    });
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      if (session.locked) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.t === 'activity') {
        this.auth.touch(session);
        return;
      }
      const handler = this.handlers.get(msg?.t);
      if (handler) {
        try {
          handler(client, msg);
        } catch (error) {
          this.log.warn(`[ws] ${msg.t}: ${error.message}`);
        }
      }
    });
    this.#send(client, { t: 'hello', at: Date.now() });
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  #send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  send(client, msg) {
    this.#send(client, msg);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (!c.session.locked && c.ws.readyState === 1) c.ws.send(data);
    }
  }

  /** Terminal output goes only to clients attached to that terminal. */
  sendToTerminal(terminalId, msg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.terminals.has(terminalId) && !c.session.locked && c.ws.readyState === 1) c.ws.send(data);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.close(1001, 'shutdown');
    this.wss.close();
  }
}
