import { h, replace } from '../lib/dom.js';
import { selectField } from '../lib/select-menu.js';
import { prefs } from '../lib/store.js';
import { api } from '../lib/api.js';
import { projectPath } from '../lib/router.js';
import { ago, duration, plural } from '../lib/format.js';
import { attempt } from '../lib/ui.js';

// Secondary by design: a calm overview to plan the next session, not a productivity tracker.

const DAY_MS = 86_400_000;
const isoDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const UNITS = [
  ['minutes', 'Minutes'],
  ['hours', 'Hours'],
  ['days', 'Days'],
  ['weeks', 'Weeks'],
  ['months', 'Months'],
  ['years', 'Years'],
];

/** Start of "the last n units" (calendar months and years, not 30/365-day blocks). */
function periodStart(n, unit) {
  const d = new Date();
  if (unit === 'minutes') d.setMinutes(d.getMinutes() - n);
  else if (unit === 'hours') d.setHours(d.getHours() - n);
  else if (unit === 'days') d.setDate(d.getDate() - n);
  else if (unit === 'weeks') d.setDate(d.getDate() - 7 * n);
  else if (unit === 'months') d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return d.getTime();
}

const periodText = ({ n, unit }) => (n === 1 ? `the last ${unit.replace(/s$/, '')}` : `the last ${n} ${unit}`);

/** Bar label and tooltip date for one bucket of the series. */
function bucketText(start, bucket, many) {
  const d = new Date(start);
  if (!['day', 'week', 'month'].includes(bucket)) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (bucket === 'day') return many ? String(d.getDate()) : d.toLocaleDateString('en-GB', { weekday: 'short' });
  if (bucket === 'week') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-GB', { month: 'short', ...(many ? { year: '2-digit' } : {}) });
}
function bucketTitle(start, bucket) {
  const d = new Date(start);
  if (!['day', 'week', 'month'].includes(bucket)) return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (bucket === 'day') return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  if (bucket === 'week') return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/**
 * The period as work on the projects: each bar is the observed work time in it (work sessions,
 * pauses under 30 minutes included); a dot above marks commits. Agent sessions are one source of
 * that work: they are counted in each bar's details, not drawn as a series of their own.
 */
function bars(data) {
  const series = data.days;
  const max = Math.max(1, ...series.map((d) => d.workMs ?? 0));
  const every = Math.ceil(series.length / 14); // at most ~14 labels under the bars
  const gap = series.length > 60 ? '1px' : series.length > 24 ? '2px' : '4px';
  const per = { minute: 'Per minute', '5min': 'Every 5 minutes', '15min': 'Every 15 minutes', hour: 'Per hour', day: 'Per day', week: 'Per week', month: 'Per month' }[data.bucket] ?? 'Per day';
  const details = (d) => [
    `${d.workMs ? duration(d.workMs) : 'no'} observed work (projects added up)`,
    plural(d.commits, 'commit'),
    plural(d.sessions, 'agent session'),
    plural(d.projects, 'active project'),
  ].join(' · ');
  return h('div.panel',
    h('div.panel-head', h('span.label', per), h('span.spacer'),
      h('span.row', { style: { fontSize: '11px' } }, h('span.series-dot.is-work'), 'observed work time'),
      h('span.row', { style: { fontSize: '11px' } }, h('span.series-dot.is-commit'), 'commits')),
    h('div.bars', { style: { gap }, role: 'img', 'aria-label': series.map((d) => `${bucketTitle(d.start, data.bucket)}: ${details(d)}`).join('; ') },
      series.map((d) => h('div.bar', { title: `${bucketTitle(d.start, data.bucket)}\n${details(d)}` },
        d.commits ? h('span.bar-commit', { 'aria-hidden': 'true' }) : null,
        h(`div.seg-work${d.workMs ? '.nz' : ''}`, { style: { height: `${((d.workMs ?? 0) / max) * 100}%` } })))),
    h('div.bars-x', { style: { gap }, 'aria-hidden': 'true' }, series.map((d, i) => h('span', i % every === 0 ? bucketText(d.start, data.bucket, series.length > 10) : ''))));
}

/**
 * Contribution calendar, as on GitHub, for one calendar year (January → December): one square per
 * day, brighter the more happened (commits + agent sessions started + work items completed).
 * Brightness stops at a cap (the 90th percentile of active days) so one huge day does not wash
 * out the rest; a day with only file changes gets the lightest shade.
 */
function calendar(data, yearNo, yearTabs) {
  const byDay = new Map(data.days.map((d) => [d.date, d]));
  const count = (d) => (d ? d.commits + d.sessions + d.completed : 0);
  const active = data.days.map(count).filter((n) => n > 0).sort((a, b) => a - b);
  const cap = Math.max(4, active[Math.floor(active.length * 0.9)] ?? 4);
  const level = (n, d) => (n <= 0 ? (d?.projects ? 1 : 0) : Math.min(4, 1 + Math.floor((3 * Math.min(n, cap)) / cap)));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const first = new Date(yearNo, 0, 1);
  const last = new Date(yearNo, 11, 31);
  const start = new Date(first);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday
  const weeks = [];
  const months = [];
  for (let t = new Date(start), w = 0; t <= last; w++) {
    const cells = [];
    for (let i = 0; i < 7; i++, t.setDate(t.getDate() + 1)) {
      const date = new Date(t);
      if (date < first || date > last) { cells.push(h('span.cal-cell.is-out')); continue; }
      if (date.getDate() === 1) months.push({ w, label: date.toLocaleDateString('en-GB', { month: 'short' }) });
      if (date > today) { cells.push(h('span.cal-cell.is-future', { title: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) })); continue; }
      const d = byDay.get(isoDay(date));
      const n = count(d);
      cells.push(h(`span.cal-cell.l${level(n, d)}`, {
        title: `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}: ${n ? `${d.commits} commits · ${d.sessions} agent sessions${d.completed ? ` · ${d.completed} done` : ''}` : d?.projects ? 'files changed, nothing committed' : 'no activity'}`,
      }));
    }
    weeks.push(h('div.cal-week', cells));
  }
  const total = data.days.reduce((s, d) => s + count(d), 0);
  const monthRow = h('div.cal-months', { style: { gridTemplateColumns: `repeat(${weeks.length}, var(--cal))` } },
    months.map((m) => h('span', { style: { gridColumn: `${m.w + 1} / span 4` } }, m.label)));
  return h('section.cal-panel', { 'aria-label': `Activity in ${yearNo}` },
    h('header.cal-head', h('strong', `${total} contributions in ${yearNo}`), h('span.spacer'), yearTabs),
    h('div.cal-scroll',
      h('div.cal',
        h('div.cal-days', ['Mon', '', 'Wed', '', 'Fri', '', ''].map((d) => h('span', d))),
        h('div', monthRow, h('div.cal-grid', weeks)))),
    h('footer.cal-foot',
      h('p.cal-note', 'Each square is a day. It counts commits (every branch of every project), agent sessions started and work items completed; a day with only file changes gets the lightest shade.'),
      h('span.cal-legend', h('span.faint.small', 'Less'), [0, 1, 2, 3, 4].map((l) => h(`span.cal-cell.l${l}`)), h('span.faint.small', 'More'))));
}

export function mount(container) {
  const inner = h('div.view-inner');
  container.append(h('div.view', inner));
  const thisYear = new Date().getFullYear();
  const years = [thisYear - 1, thisYear];
  let yearNo = years.includes(prefs.get('activity.year')) ? prefs.get('activity.year') : thisYear;
  const saved = prefs.get('activity.range', null);
  let range = saved && Number(saved.n) > 0 && UNITS.some(([u]) => u === saved.unit) ? saved : { n: 7, unit: 'days' };
  let data = null;
  let cal = null;
  let calYear = null;
  let destroyed = false;

  async function loadCalendar() {
    const y = yearNo;
    const r = await api.get(`/api/analytics?year=${y}`).catch(() => null);
    if (destroyed || y !== yearNo) return;
    cal = r;
    calYear = y;
    render();
  }

  let rangeSeq = 0;
  async function loadRange() {
    const mine = ++rangeSeq; // a slower answer for an older period must not replace the newer one
    const r = await attempt(() => api.get(`/api/analytics?from=${periodStart(range.n, range.unit)}`), { failure: 'Could not compute activity' });
    if (destroyed || mine !== rangeSeq) return;
    data = r;
    render();
  }

  // the period of everything under the calendar: "the last [n] [unit]"
  const amount = h('input.input.num.range-n', { type: 'number', min: 1, max: 999, step: 1, value: range.n, 'aria-label': 'How many' });
  const unit = selectField({ label: 'Unit', cls: 'range-unit', value: range.unit, options: UNITS.map(([v, text]) => ({ value: v, text })) });
  const apply = () => {
    const n = Math.min(999, Math.max(1, Math.round(Number(amount.value) || 1)));
    amount.value = n;
    if (n === range.n && unit.value === range.unit) return;
    range = { n, unit: unit.value };
    prefs.set('activity.range', range);
    loadRange();
  };
  amount.addEventListener('change', apply);
  unit.addEventListener('change', apply);
  const rangeForm = h('form.range-form', { 'aria-label': 'Period', onsubmit: (e) => { e.preventDefault(); apply(); } },
    h('span.faint', 'Last'), amount, unit);

  function render() {
    const yearTabs = h('div.tabs', { role: 'group', 'aria-label': 'Year' }, years.map((y) => h('button', {
      type: 'button',
      'aria-pressed': String(yearNo === y),
      onclick: () => { if (y === yearNo) return; yearNo = y; prefs.set('activity.year', y); loadCalendar(); render(); },
    }, String(y))));
    const head = h('header.page-head',
      h('div', h('h1', 'Activity'), h('p.sub', 'Computed on demand from git history, the agent journal and FlintBench activity logs on this machine.')));
    const calendarPart = cal && calYear === yearNo ? calendar(cal, yearNo, yearTabs)
      : h('section.cal-panel', h('header.cal-head', h('strong', `Reading ${yearNo}…`), h('span.spacer'), yearTabs));
    const periodBar = h('div.section-title.range-bar', h('span.label', `Activity in ${periodText(range)}`), h('span.spacer'), rangeForm);
    if (!data) {
      replace(inner, head, calendarPart, periodBar, h('div.panel.panel-empty', 'Computing from local history…'));
      return;
    }
    const agentSplit = Object.entries(data.sessionsByAgent).map(([k, v]) => `${k} ${v}`).join(' · ');
    replace(inner,
      head,
      calendarPart,
      periodBar,
      h('div.telemetry',
        h('div', h('div.label', 'Active projects'), h('div.value', String(data.activeProjects))),
        // an observed span, not time spent typing: say so where the number is shown
        h('div', { title: 'From the first to the last observed activity of each work session (file changes, your commits, agent activity, services started here). Pauses shorter than 30 minutes are included; it is not time spent typing.' },
          h('div.label', 'Observed work time'), h('div.value', duration(data.workMs ?? 0)), h('div.faint', { style: { fontSize: '11px', marginTop: '3px' } }, 'work sessions, pauses included')),
        h('div', h('div.label', 'Commits'), h('div.value', String(data.commits))),
        h('div.is-agent', h('div.label', 'Agent sessions'), h('div.value', String(data.sessions), h('small', `${data.sessionHours}h`)), agentSplit ? h('div.faint', { style: { fontSize: '11px', marginTop: '3px' } }, agentSplit) : null),
        h('div', h('div.label', 'Completed work items'), h('div.value', String(data.completedWork)))),
      h('div.grid-2',
        bars(data),
        h('div.panel',
          h('div.panel-head', h('span.label', 'Recently worked')),
          data.recent.length ? h('ul.list', data.recent.map((r) => h('li.svc',
            h('a', { href: projectPath(r.id) }, r.name),
            h('span.faint', ago(r.lastActivityAt))))) : h('div.panel-empty', 'Nothing yet.'))),
      h('div.section-title', h('span.label', 'By project')),
      data.projects.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Project'), h('th', { title: 'Observed work time: work sessions, pauses under 30 minutes included' }, 'Work time'), h('th', 'Commits'), h('th', 'Agent sessions'), h('th', 'Completed'), h('th', 'Last activity'))),
        h('tbody', [...data.projects].sort((a, b) => (b.workMs ?? 0) - (a.workMs ?? 0)).map((p) => h('tr',
          h('td', h('a', { href: projectPath(p.id) }, p.name)),
          h('td.num', p.workMs ? duration(p.workMs) : '—'),
          h('td.num', String(p.commits)),
          h('td.num', String(p.sessions)),
          h('td.num', String(p.completed)),
          h('td.dim', ago(p.lastActivityAt))))))) : h('div.panel.panel-empty', `No activity in ${periodText(range)}.`));
  }

  render();
  loadCalendar();
  loadRange();
  return { destroy() { destroyed = true; } };
}
