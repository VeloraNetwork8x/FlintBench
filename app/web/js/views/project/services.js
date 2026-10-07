import { h, icon, replace, actionButton } from '../../lib/dom.js';
import { selectField } from '../../lib/select-menu.js';
import { api, projectUrl } from '../../lib/api.js';
import { ago, clock } from '../../lib/format.js';
import { attempt, confirmDialog, statusDot } from '../../lib/ui.js';

const STATUS = {
  running: ['ok live', 'Running', 'rail-ok'],
  stopped: ['off', 'Stopped', 'rail-idle'],
  exited: ['off', 'Exited', 'rail-idle'],
  failed: ['err', 'Failed', 'rail-err'],
};

function serviceForm(ctx, initial, onDone) {
  const name = h('input.input', { value: initial?.name ?? '', placeholder: 'Frontend', 'aria-label': 'Service name', required: true, maxLength: 40 });
  const command = h('input.input.mono', { value: initial?.command ?? '', placeholder: 'npm run dev', 'aria-label': 'Command', required: true, spellcheck: false });
  const port = h('input.input.num', { value: initial?.port ?? '', placeholder: 'port', inputMode: 'numeric', 'aria-label': 'Expected port (optional)', style: { width: '90px' } });
  const kind = selectField({ label: 'Kind', width: '120px', value: initial?.kind === 'test' ? 'test' : 'process', options: [{ value: 'process', text: 'Process' }, { value: 'test', text: 'Tests' }] });
  const autostart = h('input', { type: 'checkbox', checked: Boolean(initial?.autostart) });
  const error = h('p.field-error', { role: 'alert' });
  const form = h('form.stack',
    h('div.row.wrap', name, command, port, kind),
    h('div.row', h('label.check', autostart, 'Start with project Start'), h('span.spacer'),
      onDone ? h('button.btn.sm.ghost', { type: 'button', onclick: () => onDone(null) }, 'Cancel') : null,
      h('button.btn.sm.primary', { type: 'submit' }, initial?.id ? 'Save service' : 'Add service')),
    error);
  name.style.flex = '1 1 140px';
  command.style.flex = '3 1 240px';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    try {
      const body = { name: name.value, command: command.value, port: port.value ? Number(port.value) : null, kind: kind.value, autostart: autostart.checked };
      const r = initial?.id
        ? await api.patch(projectUrl(ctx.projectId, `/services/${initial.id}`), body)
        : await api.post(projectUrl(ctx.projectId, '/services'), body);
      onDone?.(r);
      if (!initial?.id) form.reset();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return form;
}

export function render(ctx) {
  const el = h('div.p-center-inner');
  let suggestions = null; // null until loaded (or when the request failed)
  let editing = null;
  let showForm = false;

  async function loadSuggestions() {
    const r = await api.get(projectUrl(ctx.projectId, '/services')).catch(() => null);
    suggestions = r?.suggestions ?? null;
    draw();
  }

  const svcAction = (s, action) => attempt(async () => {
    const r = await api.post(projectUrl(ctx.projectId, `/services/${s.id}/${action}`));
    if (r?.terminal && action !== 'stop') ctx.dock.show(r.terminal.id, { focus: false });
  }, { failure: `Could not ${action} ${s.name}` });

  function serviceRow(s) {
    const [dot, label, rail] = STATUS[s.status] ?? STATUS.stopped;
    if (editing === s.id) {
      return h(`li.svc.${rail}`, { style: { display: 'block' } }, serviceForm(ctx, s, () => { editing = null; loadSuggestions(); }));
    }
    return h(`li.svc.${rail}`,
      h('div', { style: { minWidth: 0 } },
        h('div.row', statusDot(dot, label), h('strong', s.name), s.kind === 'test' ? h('span.tag', 'tests') : null, s.autostart ? h('span.tag', 'autostart') : null,
          h('span', { class: s.status === 'running' ? 'ok-text' : s.status === 'failed' ? 'error-text' : 'faint', style: { fontSize: '12px' } },
            s.status === 'running' ? `running since ${clock(s.startedAt)}` : s.exitCode !== null ? `${label.toLowerCase()} · exit ${s.exitCode}` : label.toLowerCase()),
          s.url ? h('a.mono', { href: s.url, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: '12px' } }, s.url.replace('http://', ''), ' ', icon('external', 11)) : null),
        h('div.cmd.ellipsis', s.command, s.ports?.length ? ` · listening ${s.ports.map((p) => `:${p}`).join(' ')}` : '')),
      h('div.actions',
        s.status === 'running'
          ? [actionButton('Stop', () => svcAction(s, 'stop'), { cls: 'btn sm' }), actionButton('Restart', () => svcAction(s, 'restart'), { cls: 'btn sm ghost', iconName: 'restart' })]
          : actionButton(s.kind === 'test' ? 'Run' : 'Start', () => svcAction(s, 'start'), { cls: 'btn sm', iconName: 'play' }),
        s.terminalId ? h('button.btn.sm.ghost', { type: 'button', onclick: () => ctx.dock.show(s.terminalId) }, 'Logs') : null,
        h('button.btn.sm.icon.ghost', { type: 'button', title: 'Edit', onclick: () => { editing = s.id; draw(); } }, icon('settings', 13)),
        actionButton('', async () => {
          if (await confirmDialog({ title: `Delete service ${s.name}?`, body: 'Only the FlintBench definition is removed.', confirm: 'Delete', danger: true })) {
            await attempt(() => api.del(projectUrl(ctx.projectId, `/services/${s.id}`)));
            loadSuggestions();
          }
        }, { cls: 'btn sm icon ghost', iconName: 'trash', title: 'Delete service' })));
  }

  /** Commands the project declares (package.json scripts of the root and of each package, Makefile…), one row per folder. */
  function suggestionGroups(services) {
    if (suggestions === null) return null;
    if (!suggestions.length) {
      return services.length ? null : h('p.svc-sugg-none', 'No runnable commands found in this project (package.json scripts, deno.json, Makefile, manage.py, go.mod, Cargo.toml). Define one above.');
    }
    const groups = new Map();
    for (const s of suggestions) {
      if (!groups.has(s.dir)) groups.set(s.dir, []);
      groups.get(s.dir).push(s);
    }
    const add = (s) => async () => {
      await attempt(() => api.post(projectUrl(ctx.projectId, '/services'), { name: s.name, command: s.command, kind: s.kind, autostart: s.name === 'dev' && !services.length }), { success: `${s.name} added` });
      loadSuggestions();
    };
    return h('div.svc-sugg', { 'aria-label': 'Commands found in the project' },
      h('span.label', 'Found in the project'),
      [...groups].map(([dir, list]) => h('div.svc-sugg-row',
        h('span.svc-sugg-dir.mono', { title: dir || 'Project root' }, dir || 'root'),
        h('div.row.wrap', list.map((s) => actionButton(s.name.slice(dir ? dir.split('/').pop().length + 1 : 0) || s.name, add(s), {
          cls: 'btn sm ghost', iconName: 'plus',
          title: `${s.command}${s.script ? `\n→ ${s.script}` : ''}\nFrom ${s.source}${s.kind === 'test' ? ' · tests' : ''}`,
        }))))));
  }

  function draw() {
    const p = ctx.project();
    if (!p) return;
    const services = p.runtime?.services ?? [];
    const d = p.docker ?? {};
    const containers = d.containers ?? [];
    const external = p.runtime?.processes ?? [];
    const composeAct = (action) => attempt(() => api.post(projectUrl(ctx.projectId, `/compose/${action}`)), { success: `docker compose ${action} done`, failure: `docker compose ${action} failed` });
    const containerAct = (c, action) => attempt(() => api.post(projectUrl(ctx.projectId, `/containers/${c.id.slice(0, 12)}/${action}`)), { failure: `Could not ${action} ${c.name}` });
    const composedServices = new Set(containers.map((c) => c.service));
    const notCreated = (d.composeServices ?? []).filter((s) => !composedServices.has(s));

    replace(el,
      h('div.section-title', h('span.label', 'Services'), h('span.spacer'),
        !showForm ? h('button.btn.sm', { type: 'button', onclick: () => { showForm = true; draw(); } }, icon('plus', 13), 'Define service') : null),
      showForm ? h('div.panel.panel-body', { style: { marginBottom: '10px' } }, serviceForm(ctx, null, () => { showForm = false; loadSuggestions(); })) : null,
      services.length ? h('div.panel', h('ul.list', services.map(serviceRow)))
        : h('div.panel.panel-empty', 'No services defined. Services run in terminal tabs, so their output stays visible.'),
      suggestionGroups(services),

      h('div.section-title', h('span.label', 'Docker'), h('span.spacer'),
        d.composeFiles?.length && d.available ? h('div.row',
          h('span.faint.mono', { style: { fontSize: '11px' } }, d.composeFiles[0]),
          actionButton('Up', () => composeAct('up'), { cls: 'btn sm', iconName: 'play' }),
          actionButton('Stop', () => composeAct('stop'), { cls: 'btn sm ghost' }),
          actionButton('Restart', () => composeAct('restart'), { cls: 'btn sm ghost', iconName: 'restart' })) : null),
      !d.available
        ? h('div.panel.panel-empty', d.composeFiles?.length ? `Compose file found (${d.composeFiles[0]}) but the Docker engine is not running or the integration is disabled.` : 'Docker engine not running or integration disabled.')
        : containers.length || notCreated.length
          ? h('div.panel', h('ul.list',
            containers.map((c) => h(`li.svc.${c.state === 'running' ? (c.health === 'unhealthy' ? 'rail-err' : 'rail-ok') : 'rail-idle'}`,
              h('div', { style: { minWidth: 0 } },
                h('div.row', statusDot(c.state === 'running' ? 'ok' : 'off', c.state), h('strong', c.service ?? c.name), h('span.faint', { style: { fontSize: '12px' } }, c.status), c.health ? h(`span.chip.${c.health === 'healthy' ? 'ok' : c.health === 'unhealthy' ? 'err' : ''}`, c.health) : null),
                h('div.cmd.ellipsis', `${c.image}${c.ports ? ` · ${c.ports}` : ''}`)),
              h('div.actions',
                c.state === 'running'
                  ? [actionButton('Stop', () => containerAct(c, 'stop'), { cls: 'btn sm' }), actionButton('Restart', () => containerAct(c, 'restart'), { cls: 'btn sm ghost', iconName: 'restart' })]
                  : actionButton('Start', () => containerAct(c, 'start'), { cls: 'btn sm', iconName: 'play' })))),
            notCreated.map((s) => h('li.svc.rail-idle',
              h('div', h('div.row', statusDot('off', 'not created'), h('strong', s), h('span.faint', { style: { fontSize: '12px' } }, 'not created'))),
              h('div.actions', actionButton('Up', () => attempt(() => api.post(projectUrl(ctx.projectId, '/compose/up'), { service: s })), { cls: 'btn sm', iconName: 'play' }))))))
          : h('div.panel.panel-empty', 'No containers for this project. Containers are matched through their Compose working directory label.'),

      h('div.section-title', h('span.label', 'Detected outside FlintBench'), h('span.spacer'),
        actionButton('', () => attempt(() => api.post(projectUrl(ctx.projectId, '/processes/refresh'))), { cls: 'btn sm icon ghost', iconName: 'refresh', title: 'Rescan processes' })),
      external.length ? h('div.panel', h('ul.list', external.map((x) => h(`li.svc.${x.ports.length ? 'rail-ok' : 'rail-idle'}`,
        h('div', { style: { minWidth: 0 } },
          h('div.row', statusDot('ok', 'running'), h('strong', x.name), h('span.faint', { style: { fontSize: '12px' } }, `pid ${x.pid}`),
            x.ports.map((port) => h('a.mono', { href: `http://localhost:${port}`, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: '12px' } }, `:${port}`))),
          h('div.cmd.ellipsis', { title: x.cmd }, x.cmd)),
        h('span.evidence', 'command line references this folder')))))
        : h('div.panel.panel-empty', `No dev processes referencing this folder${p.runtime?.scannedAt ? ` (checked ${ago(p.runtime.scannedAt)})` : ''}.`));
  }

  draw();
  loadSuggestions();
  return {
    el,
    update() {
      if (editing || el.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
      draw();
    },
  };
}
