import { h, icon, replace } from '../../lib/dom.js';
import { api, projectUrl } from '../../lib/api.js';
import { ago, plural } from '../../lib/format.js';
import { renderMarkdown } from '../../lib/ui.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const light = () => document.documentElement.dataset.theme === 'light';

/** Community colours: evenly spread hues, tuned for the current theme. */
function palette(i) {
  if (i < 0) return light() ? 'hsl(220 8% 55%)' : 'hsl(220 8% 58%)';
  const hue = (i * 137.508 + 200) % 360;
  return light() ? `hsl(${hue} 58% 44%)` : `hsl(${hue} 70% 66%)`;
}

/* ---------------- Barnes–Hut force layout (no dependencies) ---------------- */

function buildTree(nodes) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y;
  }
  const size = Math.max(maxX - minX, maxY - minY) + 1;
  const root = { x0: minX, y0: minY, size, mass: 0, cx: 0, cy: 0, node: null, kids: null };
  const insert = (q, n, depth) => {
    if (!q.kids && !q.node && q.mass === 0) {
      q.node = n; q.mass = 1; q.cx = n.x; q.cy = n.y;
      return;
    }
    if (!q.kids) {
      if (depth > 24) { q.mass += 1; return; } // coincident points
      const half = q.size / 2;
      q.kids = [0, 1, 2, 3].map((k) => ({ x0: q.x0 + (k & 1) * half, y0: q.y0 + (k >> 1) * half, size: half, mass: 0, cx: 0, cy: 0, node: null, kids: null }));
      const old = q.node;
      q.node = null;
      if (old) insert(q.kids[(old.x >= q.x0 + half ? 1 : 0) + (old.y >= q.y0 + half ? 2 : 0)], old, depth + 1);
    }
    q.cx = (q.cx * q.mass + n.x) / (q.mass + 1);
    q.cy = (q.cy * q.mass + n.y) / (q.mass + 1);
    q.mass += 1;
    const half = q.size / 2;
    insert(q.kids[(n.x >= q.x0 + half ? 1 : 0) + (n.y >= q.y0 + half ? 2 : 0)], n, depth + 1);
  };
  for (const n of nodes) insert(root, n, 0);
  return root;
}

function repulse(q, n, strength) {
  if (!q || q.mass === 0 || q.node === n) return;
  const dx = q.cx - n.x;
  const dy = q.cy - n.y;
  const d2 = dx * dx + dy * dy + 0.01;
  if (!q.kids || (q.size * q.size) / d2 < 0.64) {
    const f = (strength * q.mass) / d2;
    n.vx -= dx * f;
    n.vy -= dy * f;
    return;
  }
  for (const k of q.kids) repulse(k, n, strength);
}

function tick(nodes, links, alpha) {
  const tree = buildTree(nodes);
  for (const n of nodes) repulse(tree, n, 32 * alpha);
  for (const l of links) {
    const dx = l.t.x - l.s.x;
    const dy = l.t.y - l.s.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = ((d - 26) / d) * 0.06 * alpha;
    l.s.vx += dx * f; l.s.vy += dy * f;
    l.t.vx -= dx * f; l.t.vy -= dy * f;
  }
  for (const n of nodes) {
    // gentle pull to the community centre keeps clusters readable, and to the origin keeps it compact
    n.vx += (n.hx - n.x) * 0.004 * alpha - n.x * 0.002 * alpha;
    n.vy += (n.hy - n.y) * 0.004 * alpha - n.y * 0.002 * alpha;
    n.x += (n.vx *= 0.55);
    n.y += (n.vy *= 0.55);
  }
}

/* ---------------- view ---------------- */

export function render(ctx) {
  const el = h('div.graph-view');
  let graph = null;
  let mode = 'graph';
  let raf = 0;
  let destroyed = false;

  async function load() {
    try {
      graph = await api.get(projectUrl(ctx.projectId, '/graph'));
    } catch (error) {
      replace(el, h('p.ov-empty', `Could not read the graph: ${error.message}`));
      return;
    }
    if (!graph?.available) {
      replace(el, h('div.empty-state', h('h3', 'No graph yet'), h('p', 'Run graphify in this project to build graphify-out/graph.json, then come back here.')));
      return;
    }
    draw();
  }

  function draw() {
    cancelAnimationFrame(raf);
    cleanup();
    const communities = new Map();
    for (const n of graph.nodes) {
      const c = communities.get(n.community) ?? { id: n.community, name: n.communityName, size: 0 };
      c.size += 1;
      communities.set(n.community, c);
    }
    const tabs = h('div.tabs', { role: 'group', 'aria-label': 'View' },
      ['graph', 'report'].map((m) => h('button', { type: 'button', 'aria-pressed': String(mode === m), onclick: () => { mode = m; draw(); }, disabled: m === 'report' && !graph.report }, m === 'graph' ? 'Graph' : 'Report')));
    const head = h('header.graph-head',
      h('div.graph-stats',
        h('span', h('strong.num', String(graph.nodes.length)), ' nodes'),
        h('span', h('strong.num', String(graph.links.length)), ' links'),
        h('span', h('strong.num', String(communities.size)), ' communities'),
        h('span.faint', `built ${ago(graph.builtAt)}${graph.commit ? ` · ${String(graph.commit).slice(0, 8)}` : ''}`)),
      h('span.spacer'),
      tabs);
    if (mode === 'report') {
      replace(el, head, h('div.graph-report', renderMarkdown(graph.report)));
      return;
    }
    replace(el, head, canvasView([...communities.values()].sort((a, b) => b.size - a.size)));
  }

  function canvasView(communities) {
    const canvas = h('canvas.graph-canvas', { tabIndex: 0, 'aria-label': 'Knowledge graph. Use the search to find a node.' });
    const tip = h('div.graph-tip', { hidden: true });
    const detail = h('aside.graph-detail', { hidden: true });
    const search = h('input.input', { type: 'search', placeholder: 'Find a node', 'aria-label': 'Find a node', spellcheck: false });
    const results = h('ul.graph-results', { hidden: true });
    const legend = h('ul.graph-legend');
    const fitBtn = h('button.btn.sm', { type: 'button', title: 'Fit the whole graph' }, icon('maximize', 12), 'Fit');
    const stage = h('div.graph-stage', canvas, tip,
      h('div.graph-tools', h('div.graph-search', icon('search', 13), search, results), fitBtn),
      h('div.graph-legend-box', h('span.label', 'Communities'), legend),
      detail);

    // model
    const byId = new Map();
    const count = Math.max(1, communities.length);
    const centre = new Map(communities.map((c, i) => {
      const a = (i / count) * Math.PI * 2;
      const r = 60 + Math.sqrt(count) * 70;
      return [c.id, { x: Math.cos(a) * r, y: Math.sin(a) * r }];
    }));
    const nodes = graph.nodes.map((n) => {
      const c = centre.get(n.community) ?? { x: 0, y: 0 };
      const node = { ...n, x: c.x + (Math.random() - 0.5) * 60, y: c.y + (Math.random() - 0.5) * 60, hx: c.x, hy: c.y, vx: 0, vy: 0, deg: 0, adj: new Set() };
      byId.set(n.id, node);
      return node;
    });
    const links = graph.links.map((l) => ({ s: byId.get(l.s), t: byId.get(l.t), rel: l.rel })).filter((l) => l.s && l.t && l.s !== l.t);
    for (const l of links) {
      l.s.deg += 1; l.t.deg += 1;
      l.s.adj.add(l.t); l.t.adj.add(l.s);
    }
    for (const n of nodes) n.r = 2.2 + Math.sqrt(n.deg) * 1.15;
    const byDegree = [...nodes].sort((a, b) => b.deg - a.deg);
    const hubs = new Set(byDegree.slice(0, 14));

    // view state
    let scale = 1; let ox = 0; let oy = 0;
    let hover = null; let selected = null; let focusCommunity = null;
    let alpha = 1;
    const dpr = () => window.devicePixelRatio || 1;
    const toScreen = (n) => [n.x * scale + ox, n.y * scale + oy];
    const toWorld = (x, y) => [(x - ox) / scale, (y - oy) / scale];

    function fit() {
      const w = canvas.clientWidth; const hgt = canvas.clientHeight;
      if (!w || !hgt || !nodes.length) return;
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
      scale = Math.min(4, Math.max(0.05, Math.min(w / (maxX - minX + 80), hgt / (maxY - minY + 80))));
      ox = w / 2 - ((minX + maxX) / 2) * scale;
      oy = hgt / 2 - ((minY + maxY) / 2) * scale;
    }

    function paint() {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.clientWidth; const hgt = canvas.clientHeight; const r = dpr();
      if (canvas.width !== Math.round(w * r) || canvas.height !== Math.round(hgt * r)) {
        canvas.width = Math.round(w * r);
        canvas.height = Math.round(hgt * r);
      }
      ctx2.setTransform(r, 0, 0, r, 0, 0);
      ctx2.clearRect(0, 0, w, hgt);
      const focus = selected ?? hover;
      const lit = focus ? new Set([focus, ...focus.adj]) : null;
      const dimmed = (n) => (lit && !lit.has(n)) || (focusCommunity !== null && n.community !== focusCommunity);
      const lineBase = light() ? '20,30,50' : '210,220,240';
      // links
      ctx2.lineWidth = 1;
      for (const l of links) {
        const on = focus && (l.s === focus || l.t === focus);
        if (!on && (dimmed(l.s) || dimmed(l.t)) && (lit || focusCommunity !== null)) continue;
        const [x1, y1] = toScreen(l.s); const [x2, y2] = toScreen(l.t);
        ctx2.strokeStyle = on ? palette(focus.community) : `rgba(${lineBase},${lit || focusCommunity !== null ? 0.16 : 0.08})`;
        ctx2.beginPath(); ctx2.moveTo(x1, y1); ctx2.lineTo(x2, y2); ctx2.stroke();
      }
      // nodes
      for (const n of nodes) {
        const [x, y] = toScreen(n);
        if (x < -20 || y < -20 || x > w + 20 || y > hgt + 20) continue;
        const rad = Math.max(1.4, n.r * Math.min(1.6, Math.max(0.6, scale)));
        ctx2.globalAlpha = dimmed(n) ? 0.12 : 1;
        ctx2.fillStyle = palette(n.community);
        ctx2.beginPath(); ctx2.arc(x, y, rad, 0, Math.PI * 2); ctx2.fill();
        if (n === focus) {
          ctx2.strokeStyle = light() ? '#000' : '#fff';
          ctx2.lineWidth = 2;
          ctx2.beginPath(); ctx2.arc(x, y, rad + 3, 0, Math.PI * 2); ctx2.stroke();
        }
      }
      ctx2.globalAlpha = 1;
      // labels: hubs always, everything near the focus, more as you zoom in
      ctx2.font = '500 11px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
      ctx2.textBaseline = 'middle';
      // most-connected first; a label that would overlap one already drawn is skipped
      const placed = [];
      for (const n of byDegree) {
        const show = n === focus || ((lit ? lit.has(n) : hubs.has(n) || (scale > 1.6 && n.deg > 2) || scale > 2.6) && !(focusCommunity !== null && n.community !== focusCommunity && !lit));
        if (!show) continue;
        const [x, y] = toScreen(n);
        if (x < 0 || y < 0 || x > w || y > hgt) continue;
        const text = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
        const lx = x + n.r * Math.min(1.6, Math.max(0.6, scale)) + 5;
        const box = { x: lx - 2, y: y - 8, w: ctx2.measureText(text).width + 4, h: 16 };
        if (n !== focus && placed.some((b) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) continue;
        placed.push(box);
        ctx2.fillStyle = light() ? 'rgba(10,14,22,0.82)' : 'rgba(255,255,255,0.86)';
        ctx2.fillText(text, lx, y);
      }
    }

    function run() {
      if (destroyed) return;
      if (alpha > 0.02) {
        tick(nodes, links, alpha);
        alpha *= 0.985;
        if (alpha < 0.3 && !fitted) { fit(); fitted = true; }
      }
      paint();
      if (alpha > 0.02) raf = requestAnimationFrame(run);
    }
    let fitted = false;
    const redraw = () => { if (alpha <= 0.02) paint(); };

    function nodeAt(px, py) {
      const [wx, wy] = toWorld(px, py);
      let best = null; let bestD = Infinity;
      for (const n of nodes) {
        const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
        const hit = (n.r + 4) / Math.min(1.6, Math.max(0.6, scale)) + 4 / scale;
        if (d < hit * hit && d < bestD) { best = n; bestD = d; }
      }
      return best;
    }

    function select(n, { center = false } = {}) {
      selected = n;
      if (!n) {
        detail.hidden = true;
        redraw();
        return;
      }
      if (center) {
        scale = Math.max(scale, 1.4);
        ox = canvas.clientWidth / 2 - n.x * scale;
        oy = canvas.clientHeight / 2 - n.y * scale;
      }
      const neighbours = [...n.adj].sort((a, b) => b.deg - a.deg);
      replace(detail,
        h('div.row', h('span.graph-swatch', { style: { background: palette(n.community) } }), h('strong.ellipsis', n.label), h('span.spacer'),
          h('button.btn.sm.icon.ghost', { type: 'button', title: 'Close', onclick: () => select(null) }, icon('x', 12))),
        h('dl.kv',
          n.file ? [h('dt', 'File'), h('dd.mono.small', `${n.file}${n.loc ? ` · ${n.loc}` : ''}`)] : null,
          n.type ? [h('dt', 'Kind'), h('dd', n.type)] : null,
          [h('dt', 'Community'), h('dd', n.communityName ?? (n.community >= 0 ? `#${n.community}` : '—'))],
          [h('dt', 'Links'), h('dd.num', String(n.deg))]),
        neighbours.length ? h('div.graph-neigh', h('span.label', 'Connected to'),
          h('ul', neighbours.slice(0, 40).map((m) => h('li', h('button', { type: 'button', onclick: () => select(m, { center: true }) },
            h('span.graph-swatch', { style: { background: palette(m.community) } }), h('span.ellipsis', m.label)))))) : null);
      detail.hidden = false;
      redraw();
    }

    // legend: biggest communities, click to isolate
    replace(legend, communities.slice(0, 12).map((c) => h('li', h('button', {
      type: 'button',
      'aria-pressed': 'false',
      onclick: (e) => {
        focusCommunity = focusCommunity === c.id ? null : c.id;
        legend.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        if (focusCommunity !== null) e.currentTarget.setAttribute('aria-pressed', 'true');
        redraw();
      },
    }, h('span.graph-swatch', { style: { background: palette(c.id) } }), h('span.ellipsis', c.name ?? `#${c.id}`), h('span.faint.num', String(c.size))))));

    // search
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      if (!q) { results.hidden = true; return; }
      const found = nodes.filter((n) => n.label.toLowerCase().includes(q) || n.file?.toLowerCase().includes(q)).sort((a, b) => b.deg - a.deg).slice(0, 8);
      replace(results, found.length ? found.map((n) => h('li', h('button', { type: 'button', onclick: () => { results.hidden = true; select(n, { center: true }); } },
        h('span.graph-swatch', { style: { background: palette(n.community) } }), h('span.ellipsis', n.label), h('span.faint.small', plural(n.deg, 'link'))))) : h('li.faint.small', 'No match'));
      results.hidden = false;
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') results.querySelector('button')?.click();
      if (e.key === 'Escape') { search.value = ''; results.hidden = true; }
    });

    // pointer: pan, hover, click; wheel: zoom at cursor
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.offsetX, y: e.offsetY, ox, oy, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.offsetX - drag.x; const dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        ox = drag.ox + dx; oy = drag.oy + dy;
        redraw();
        return;
      }
      const n = nodeAt(e.offsetX, e.offsetY);
      if (n !== hover) {
        hover = n;
        canvas.style.cursor = n ? 'pointer' : 'grab';
        tip.hidden = !n;
        if (n) replace(tip, h('strong', n.label), n.file ? h('div.faint.small.mono', n.file) : null);
        redraw();
      }
      if (n) { tip.style.left = `${e.offsetX + 14}px`; tip.style.top = `${e.offsetY + 14}px`; }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) select(nodeAt(e.offsetX, e.offsetY));
      drag = null;
    });
    canvas.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; redraw(); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(8, Math.max(0.05, scale * k));
      ox = e.offsetX - ((e.offsetX - ox) / scale) * next;
      oy = e.offsetY - ((e.offsetY - oy) / scale) * next;
      scale = next;
      redraw();
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });
    fitBtn.addEventListener('click', () => { fit(); redraw(); });

    const ro = new ResizeObserver(() => { if (fitted) redraw(); });
    ro.observe(stage);
    cleanup = () => ro.disconnect();

    requestAnimationFrame(() => {
      if (reduced()) {
        // settle off-screen, draw once: no motion
        for (let i = 0; i < 260 && alpha > 0.02; i++) { tick(nodes, links, alpha); alpha *= 0.985; }
        alpha = 0;
        fit(); fitted = true; paint();
      } else {
        fit();
        run();
      }
    });
    return stage;
  }

  let cleanup = () => {};
  replace(el, h('p.ov-empty', 'Reading graphify-out/graph.json…'));
  load();
  return {
    el,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      cleanup();
    },
  };
}
