import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const COOKIE = 'flintbench_session';
const MAX_BODY = 1024 * 1024;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
};

// Only these files from node_modules are reachable.
const VENDOR = {
  '/vendor/xterm/xterm.mjs': require.resolve('@xterm/xterm/lib/xterm.mjs'),
  '/vendor/xterm/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/vendor/xterm/addon-fit.mjs': require.resolve('@xterm/addon-fit/lib/addon-fit.mjs'),
};

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds = 30 * 24 * 3600) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * access: 'public' | 'session' (locked allowed) | 'unlocked' (default).
   * raw: the handler reads the request body itself (uploads), it is not parsed as JSON.
   */
  add(method, pattern, handler, access = 'unlocked', { raw = false } = {}) {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, regex, keys, handler, access, raw });
  }

  get(p, h, a) { this.add('GET', p, h, a); }
  post(p, h, a) { this.add('POST', p, h, a); }
  put(p, h, a) { this.add('PUT', p, h, a); }
  patch(p, h, a) { this.add('PATCH', p, h, a); }
  delete(p, h, a) { this.add('DELETE', p, h, a); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

async function readJson(req) {
  if (!MUTATING.has(req.method)) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413, expose: true });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400, expose: true });
  }
}

export function allowedHosts(port) {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

export function allowedOrigins(port) {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
}

function securityHeaders(res, port) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", // blob: pictures the page fetched itself (Overview preview)
    "font-src 'self'",
    `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port}`,
    // live previews of the projects' own dev servers (Overview), nothing else can be framed
    'frame-src http://localhost:* http://127.0.0.1:* http://[::1]:*',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

export function createHttpServer({ router, auth, webDir, port, log = console }) {
  const hosts = allowedHosts(port);
  const origins = allowedOrigins(port);

  async function serveStatic(req, res, pathname) {
    let file = VENDOR[pathname];
    if (!file) {
      const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
      const candidate = path.resolve(webDir, rel);
      if (!candidate.startsWith(webDir + path.sep) && candidate !== webDir) return send(res, 403, { error: 'Forbidden' });
      file = candidate;
      try {
        if (!(await fs.stat(file)).isFile()) throw new Error('dir');
      } catch {
        // SPA fallback for client routes (no extension)
        if (path.extname(rel)) return send(res, 404, { error: 'Not found' });
        file = path.join(webDir, 'index.html');
      }
    }
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res, port);
    try {
      // DNS-rebinding protection: only loopback host names are served.
      if (!hosts.has(req.headers.host ?? '')) return send(res, 421, { error: 'Unknown host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return await serveStatic(req, res, url.pathname);
      }

      if (MUTATING.has(req.method)) {
        // CSRF: custom header forces a CORS preflight that we never approve; Origin must be ours.
        if (req.headers['x-flintbench'] !== '1') return send(res, 403, { error: 'Missing FlintBench header' });
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) return send(res, 403, { error: 'Cross-origin request refused' });
      }

      const found = router.match(req.method, url.pathname);
      if (!found) return send(res, 404, { error: 'Not found' });
      if (found.methodNotAllowed) return send(res, 405, { error: 'Method not allowed' });

      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[COOKIE] ?? null;
      const session = auth.session(token);
      const { access } = found.route;
      if (access !== 'public') {
        if (!session) return send(res, 401, { error: 'Not authenticated' });
        if (access === 'unlocked' && session.locked) return send(res, 423, { error: 'Locked' });
        auth.touch(session);
      }

      const body = found.route.raw ? {} : await readJson(req);
      const ctx = {
        req, res, params: found.params, query: url.searchParams, body, token, session,
        userAgent: req.headers['user-agent'],
        setCookie: (value) => res.setHeader('Set-Cookie', value),
      };
      const result = await found.route.handler(ctx);
      if (res.writableEnded) return undefined;
      return send(res, result === undefined ? 204 : 200, result === undefined ? undefined : result);
    } catch (error) {
      if (error.status && error.expose) {
        const headers = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
        // a reason the page can act on (e.g. needs_delete_scope) travels as `reason`
        return send(res, error.status, { error: error.message, ...(error.reason ? { reason: error.reason } : {}) }, headers);
      }
      log.error('[http]', error);
      return send(res, 500, { error: 'Internal error' });
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 330_000; // compose up / git push can be slow
  return server;
}
