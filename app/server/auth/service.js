import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hashSecret, verifySecret } from './passwords.js';
import { httpError } from '../host/paths.js';

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_PIN_FAILURES = 5;

const tokenId = (token) => crypto.createHash('sha256').update(token).digest('hex');

function validateUsername(username) {
  if (typeof username !== 'string') throw httpError(400, 'Username is required');
  const u = username.trim();
  if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(u)) throw httpError(400, 'Username: 1–40 letters, numbers, space, dot, dash or underscore');
  return u;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  if (password.length > 512) throw httpError(400, 'Password is too long');
  return password;
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw httpError(400, 'PIN must be 4–8 digits');
  return pin;
}

/**
 * One local owner. Sessions are random tokens; only their SHA-256 is stored.
 * Lock state lives on the server. Events: 'locked' (sessionId), 'logout' (sessionId).
 */
export class AuthService extends EventEmitter {
  constructor({ storage, settings, log = console }) {
    super();
    this.storage = storage;
    this.settings = settings;
    this.log = log;
    this.sessions = new Map();
    this.failures = { count: 0, lastAt: 0 };
  }

  async init() {
    const now = Date.now();
    for (const s of this.storage.runtime.sessions.get().sessions) {
      if (now - s.createdAt > SESSION_TTL) continue;
      // every session starts locked after a restart
      this.sessions.set(s.id, { ...s, locked: true, lastSeenAt: s.lastSeenAt ?? now });
    }
    await this.#persist();
    this.sweepTimer = setInterval(() => this.#autoLockSweep(), 30_000);
    this.sweepTimer.unref();
  }

  stop() {
    clearInterval(this.sweepTimer);
  }

  async #persist() {
    const sessions = [...this.sessions.values()].map(({ id, createdAt, lastSeenAt, locked, pinFailures, agent }) => ({
      id, createdAt, lastSeenAt, locked, pinFailures, agent,
    }));
    await this.storage.runtime.sessions.replace({ sessions });
  }

  #autoLockSweep() {
    const minutes = this.settings.get().autoLockMinutes;
    if (!minutes) return;
    const limit = Date.now() - minutes * 60_000;
    let changed = false;
    for (const s of this.sessions.values()) {
      if (!s.locked && s.lastSeenAt < limit) {
        s.locked = true;
        changed = true;
        this.emit('locked', s.id);
      }
    }
    if (changed) this.#persist().catch(() => {});
  }

  #throttle() {
    const { count, lastAt } = this.failures;
    if (count < 3) return;
    const wait = Math.min(30_000, 1000 * 2 ** (count - 3));
    const remaining = lastAt + wait - Date.now();
    if (remaining > 0) {
      throw Object.assign(httpError(429, `Too many attempts. Try again in ${Math.ceil(remaining / 1000)}s`), { retryAfter: Math.ceil(remaining / 1000) });
    }
  }

  #fail() {
    this.failures = { count: this.failures.count + 1, lastAt: Date.now() };
  }

  #newSession(userAgent) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const session = { id: tokenId(token), createdAt: now, lastSeenAt: now, locked: false, pinFailures: 0, agent: String(userAgent || '').slice(0, 160) };
    this.sessions.set(session.id, session);
    return { token, session };
  }

  /** Session for a raw cookie token (or null). */
  session(token) {
    if (!token) return null;
    const s = this.sessions.get(tokenId(token));
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL) {
      this.sessions.delete(s.id);
      return null;
    }
    return s;
  }

  touch(session) {
    if (session && !session.locked) session.lastSeenAt = Date.now();
  }

  state(token) {
    const owner = this.storage.auth.get();
    const s = this.session(token);
    return {
      needsSetup: !owner,
      username: owner?.username ?? null,
      hasPin: Boolean(owner?.pinHash),
      authenticated: Boolean(s),
      locked: s ? s.locked : true,
      // PIN unlock is only offered to a browser that already holds a session
      pinAvailable: Boolean(owner?.pinHash && s && s.pinFailures < MAX_PIN_FAILURES),
      autoLockMinutes: this.settings.get().autoLockMinutes,
    };
  }

  async setup({ username, password, confirm, pin }, userAgent) {
    if (this.storage.auth.exists()) throw httpError(409, 'FlintBench is already set up');
    const name = validateUsername(username);
    validatePassword(password);
    if (password !== confirm) throw httpError(400, 'Passwords do not match');
    const pinHash = pin ? await hashSecret(validatePin(String(pin))) : null;
    await this.storage.auth.create({ username: name, passwordHash: await hashSecret(password), pinHash });
    const { token } = this.#newSession(userAgent);
    await this.#persist();
    return token;
  }

  async unlockWithPassword(token, password, userAgent) {
    const owner = this.storage.auth.get();
    if (!owner) throw httpError(409, 'Setup required');
    this.#throttle();
    if (!(await verifySecret(String(password ?? ''), owner.passwordHash))) {
      this.#fail();
      throw httpError(401, 'Incorrect password');
    }
    this.failures = { count: 0, lastAt: 0 };
    let s = this.session(token);
    let newToken = null;
    if (!s) {
      const created = this.#newSession(userAgent);
      s = created.session;
      newToken = created.token;
    }
    s.locked = false;
    s.pinFailures = 0;
    s.lastSeenAt = Date.now();
    await this.#persist();
    return newToken;
  }

  async unlockWithPin(token, pin) {
    const owner = this.storage.auth.get();
    const s = this.session(token);
    if (!owner?.pinHash) throw httpError(400, 'No PIN configured');
    if (!s) throw httpError(401, 'Sign in with your password on this browser first');
    if (s.pinFailures >= MAX_PIN_FAILURES) throw httpError(403, 'PIN disabled after too many attempts. Use your password.');
    this.#throttle();
    if (!(await verifySecret(String(pin ?? ''), owner.pinHash))) {
      s.pinFailures += 1;
      this.#fail();
      await this.#persist();
      const left = MAX_PIN_FAILURES - s.pinFailures;
      throw httpError(401, left > 0 ? `Incorrect PIN (${left} attempt${left === 1 ? '' : 's'} left)` : 'PIN disabled. Use your password.');
    }
    this.failures = { count: 0, lastAt: 0 };
    s.locked = false;
    s.pinFailures = 0;
    s.lastSeenAt = Date.now();
    await this.#persist();
  }

  async lock(token) {
    const s = this.session(token);
    if (!s) return;
    s.locked = true;
    this.emit('locked', s.id);
    await this.#persist();
  }

  async logout(token) {
    const s = this.session(token);
    if (!s) return;
    this.sessions.delete(s.id);
    this.emit('logout', s.id);
    await this.#persist();
  }

  async changePassword(current, next) {
    const owner = this.storage.auth.get();
    if (!(await verifySecret(String(current ?? ''), owner.passwordHash))) throw httpError(401, 'Current password is incorrect');
    validatePassword(next);
    await this.storage.auth.setPasswordHash(await hashSecret(next));
  }

  async setPin(password, pin) {
    const owner = this.storage.auth.get();
    if (!(await verifySecret(String(password ?? ''), owner.passwordHash))) throw httpError(401, 'Password is incorrect');
    const pinHash = pin ? await hashSecret(validatePin(String(pin))) : null;
    await this.storage.auth.setPinHash(pinHash);
    for (const s of this.sessions.values()) s.pinFailures = 0;
    await this.#persist();
  }
}
