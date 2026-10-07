// REST client. Every mutating call carries the X-FlintBench header (CSRF guard).

export class ApiError extends Error {
  constructor(status, message, reason = null) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const listeners = { locked: new Set(), unauthenticated: new Set() };

export function onAuthLost(kind, fn) {
  listeners[kind].add(fn);
}

export async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-FlintBench': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const isAuthRoute = url.startsWith('/api/auth/');
    if (res.status === 423 && !isAuthRoute) listeners.locked.forEach((fn) => fn());
    if (res.status === 401 && !isAuthRoute) listeners.unauthenticated.forEach((fn) => fn());
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.reason ?? null);
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body),
};

export const projectUrl = (id, rest = '') => `/api/projects/${encodeURIComponent(id)}${rest}`;
