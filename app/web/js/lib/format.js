const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const d = Math.max(0, now - ts);
  if (d < 45_000) return 'just now';
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  if (d < 30 * DAY) return `${Math.round(d / DAY)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Today 14:02", "Yesterday 23:41", "Mon 09:10", "3 Sep 2026" */
export function when(ts) {
  if (!ts) return '—';
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = today.getTime() - new Date(date).setHours(0, 0, 0, 0);
  if (diff <= 0) return `Today ${time}`;
  if (diff <= DAY) return `Yesterday ${time}`;
  if (diff < 6 * DAY) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function clock(ts) {
  return ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';
}

export function duration(ms) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  return `${hrs}h ${String(m % 60).padStart(2, '0')}m`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function shortPath(p, max = 48) {
  if (!p || p.length <= max) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep);
  let out = parts.at(-1);
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    if (out.length + parts[i].length + 4 > max) return `…${sep}${out}`;
    out = `${parts[i]}${sep}${out}`;
  }
  return out;
}
