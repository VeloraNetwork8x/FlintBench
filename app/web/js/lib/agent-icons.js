// Marks for the supported agent CLIs, drawn inline (no image files).
// Claude Code: its terminal mascot, rebuilt pixel by pixel from the block characters the CLI
// prints at startup. Codex: the CLI prompt mark. Antigravity CLI: its mark. Gemini CLI: the sparkle.

const SVG = 'http://www.w3.org/2000/svg';

/** Brand colour per agent, used for marks and for the session containers. */
export const AGENT_COLORS = { claude: '#d97757', codex: '#c9ccd3', antigravity: '#4f8ff7', gemini: '#6e8ef7', vscode: '#2f9ef4' };

// Quadrant block characters → [upper-left, upper-right, lower-left, lower-right]
const QUADRANTS = { ' ': [0, 0, 0, 0], '▐': [0, 1, 0, 1], '▌': [1, 0, 1, 0], '▛': [1, 1, 1, 0], '▜': [1, 1, 0, 1], '█': [1, 1, 1, 1], '▝': [0, 1, 0, 0], '▘': [1, 0, 0, 0] };
const CLAUDE_MASCOT = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '];

function el(name, attrs) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function claude(svg) {
  // a terminal cell is about twice as tall as it is wide, so each quadrant pixel is 1 × 2.
  // The drawing fills rows 0–10 of 12 (the feet use only the top half of their cells): the view
  // starts one unit higher so it sits in the middle of its box, not 1/12 above it
  svg.setAttribute('viewBox', '0 -1 18 12');
  svg.setAttribute('shape-rendering', 'crispEdges');
  CLAUDE_MASCOT.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const [ul, ur, ll, lr] = QUADRANTS[ch] ?? QUADRANTS[' '];
      const cells = [[ul, 0, 0], [ur, 1, 0], [ll, 0, 1], [lr, 1, 1]];
      for (const [on, dx, dy] of cells) {
        if (on) svg.append(el('rect', { x: col * 2 + dx, y: (row * 2 + dy) * 2, width: 1, height: 2, fill: AGENT_COLORS.claude }));
      }
    });
  });
}

function codex(svg) {
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.append(el('rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 4, fill: 'none', stroke: AGENT_COLORS.codex, 'stroke-width': 1.6 }));
  svg.append(el('path', { d: 'M7.5 9.5 10.5 12l-3 2.5M12.5 15h4', fill: 'none', stroke: AGENT_COLORS.codex, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

let gradientId = 0;
function gemini(svg) {
  svg.setAttribute('viewBox', '0 0 24 24');
  const id = `gemini-grad-${++gradientId}`;
  const defs = el('defs', {});
  const grad = el('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.append(el('stop', { offset: '0', 'stop-color': '#4f8ff7' }), el('stop', { offset: '1', 'stop-color': '#a77bf3' }));
  defs.append(grad);
  svg.append(defs, el('path', { d: 'M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10 5.2-.6 9.4-4.8 10-10z', fill: `url(#${id})` }));
}

// Antigravity CLI: its startup mark, rebuilt pixel by pixel — an "A" whose rounded apex is warm
// (yellow → orange → red) and whose legs cool down to blue: the left one through lime, green,
// teal and cyan, the right one through pink and violet. The colour of each pixel follows its
// position along the stroke, as in the CLI's own gradient. '#' = pixel, '.' = empty.
const AGY_SHAPE = [
  '.....##.....',
  '....####....',
  '...###.##...',
  '...##..##...',
  '..##....##..',
  '..##....##..',
  '.##......##.',
  '.##......##.',
  '##........##',
];
// colour stops along each leg, from the apex (0) to the foot (1)
const AGY_LEFT = [[0, '#f9c74f'], [0.18, '#c6d13a'], [0.38, '#5dc35a'], [0.58, '#24b8a0'], [0.78, '#1ea7d8'], [1, '#3b8df0']];
const AGY_RIGHT = [[0, '#f7a23c'], [0.16, '#f2672e'], [0.34, '#e8453c'], [0.52, '#e04690'], [0.7, '#a957d4'], [0.86, '#6c6cf2'], [1, '#4a84f6']];
const hexRgb = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
function gradientAt(stops, t) {
  const i = Math.max(1, stops.findIndex(([at]) => at >= t));
  const [a0, c0] = stops[i - 1];
  const [a1, c1] = stops[i] ?? stops.at(-1);
  const k = a1 === a0 ? 0 : (t - a0) / (a1 - a0);
  const [r0, g0, b0] = hexRgb(c0);
  const [r1, g1, b1] = hexRgb(c1);
  return `rgb(${Math.round(r0 + (r1 - r0) * k)} ${Math.round(g0 + (g1 - g0) * k)} ${Math.round(b0 + (b1 - b0) * k)})`;
}
function antigravity(svg) {
  const rows = AGY_SHAPE.length;
  const cols = AGY_SHAPE[0].length;
  svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  AGY_SHAPE.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      if (ch !== '#') return;
      const left = col < cols / 2;
      // position along the stroke: the row, nudged by how far out the pixel sits
      const t = Math.min(1, Math.max(0, (row + (left ? (cols / 2 - col) * 0.15 : (col - cols / 2) * 0.15)) / (rows - 0.4)));
      svg.append(el('rect', { x: col, y: row, width: 1, height: 1, fill: gradientAt(left ? AGY_LEFT : AGY_RIGHT, t) }));
    });
  });
}

function vscode(svg) {
  svg.setAttribute('viewBox', '0 0 24 24');
  // the folded ribbon: outer shape with the inner chevron cut out
  svg.append(el('path', { d: 'M17.4 2 8.9 9.9 4.2 6.3 2 7.4v9.2l2.2 1.1 4.7-3.6 8.5 7.9L22 19.8V4.2zM17.4 7.3v9.4L11.2 12z', fill: AGENT_COLORS.vscode, 'fill-rule': 'evenodd' }));
}

const DRAW = { claude, codex, antigravity, gemini, vscode };

/**
 * Docker's whale with its stacked containers, simplified, in the current colour (the status bar
 * paints it green while the engine is up, grey when it is down or off).
 */
export function dockerLogo(size = 14) {
  const svg = el('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'docker-logo', fill: 'currentColor' });
  for (const [x, y] of [[9.4, 3.6], [6.8, 6.2], [9.4, 6.2], [12, 6.2], [4.2, 8.8], [6.8, 8.8], [9.4, 8.8], [12, 8.8], [14.6, 8.8]]) {
    svg.append(el('rect', { x, y, width: 2.2, height: 2.2, rx: 0.3 }));
  }
  svg.append(el('path', { d: 'M1.8 11.8h16.9c.6-1.3 1.9-1.9 3.1-1.6-.3 1.3-1.4 2.3-2.7 2.5-1.2 4.3-5 7.1-10 7.1-4.4 0-7-3.1-7.3-8z' }));
  return svg;
}

// Git hosting services, by the host name of the repository's web page: their marks, 24×24
const HOSTS = [
  { test: /(^|\.)github\.com$/i, name: 'GitHub', color: 'var(--text)', d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' },
  { test: /(^|\.)gitlab\.com$/i, name: 'GitLab', color: '#fc6d26', d: 'm23.6 9.593-.034-.086L20.3.981a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.206 6.748H7.538L5.332 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502.4 9.588a6.066 6.066 0 0 0 2.012 7.01l.011.009.03.021 4.976 3.727 2.462 1.863 1.5 1.132a1.009 1.009 0 0 0 1.22 0l1.499-1.132 2.462-1.863 5.006-3.749.012-.01a6.068 6.068 0 0 0 2.01-7.003z' },
  { test: /(^|\.)bitbucket\.org$/i, name: 'Bitbucket', color: '#2684ff', d: 'M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z' },
];

/** The mark of the service hosting a repository (GitHub, GitLab, Bitbucket), from its web page; null for any other. */
export function hostLogo(webUrl, size = 18) {
  let host = '';
  try { host = new URL(webUrl).hostname; } catch { return null; }
  const service = HOSTS.find((s) => s.test.test(host));
  if (!service) return null;
  const svg = el('svg', { width: size, height: size, viewBox: '0 0 24 24', class: 'host-logo', role: 'img', 'aria-label': service.name, fill: 'currentColor', style: `color: ${service.color}` });
  svg.append(el('path', { d: service.d }));
  return svg;
}

/** One mark per tool at work on a project (agents, then editors), each in its own colour. */
export function toolMarks(ids, size = 16) {
  const wrap = document.createElement('span');
  wrap.className = 'tool-marks';
  for (const id of ids) wrap.append(agentMark(id, size));
  return wrap;
}

/** Inline mark for an agent id; a neutral dot for unknown agents. */
export function agentMark(agentId, size = 16) {
  const svg = el('svg', { width: size, height: size, 'aria-hidden': 'true', class: `agent-mark agent-${agentId}` });
  if (agentId === 'antigravity') {
    // same rule as the mascot below: whole device pixels per unit, so it stays crisp when scaled
    const dpr = window.devicePixelRatio || 1;
    const u = Math.max(1, Math.round((size * dpr) / 12));
    svg.setAttribute('width', String((12 * u) / dpr));
    svg.setAttribute('height', String((9 * u) / dpr));
  }
  if (agentId === 'claude') {
    // pixel art must land on whole device pixels or it blurs at 125%/150% display scaling:
    // every mascot unit becomes exactly u device pixels (u ≥ 1), whatever the scale
    const dpr = window.devicePixelRatio || 1;
    const u = Math.max(1, Math.round((size * dpr) / 14));
    svg.setAttribute('width', String((18 * u) / dpr));
    svg.setAttribute('height', String((12 * u) / dpr));
  }
  (DRAW[agentId] ?? ((s) => { s.setAttribute('viewBox', '0 0 24 24'); s.append(el('circle', { cx: 12, cy: 12, r: 5, fill: 'currentColor' })); }))(svg);
  return svg;
}
