// File and folder icons in the spirit of the editor icon themes: a small coloured badge per
// language (label + colour), and a filled folder coloured by its role, open when expanded.

const SVG = 'http://www.w3.org/2000/svg';

// extension → [label, colour]
const BY_EXT = {
  js: ['JS', '#e8c547'], mjs: ['JS', '#e8c547'], cjs: ['JS', '#e8c547'], jsx: ['JSX', '#5fd3f3'],
  ts: ['TS', '#3c8ef0'], mts: ['TS', '#3c8ef0'], cts: ['TS', '#3c8ef0'], tsx: ['TSX', '#3c8ef0'], 'd.ts': ['DTS', '#5b8fc7'],
  json: ['{}', '#d6a24a'], jsonc: ['{}', '#d6a24a'], json5: ['{}', '#d6a24a'],
  md: ['M↓', '#5aa2ff'], mdx: ['MDX', '#f2a33a'], markdown: ['M↓', '#5aa2ff'], txt: ['TXT', '#9aa3b2'], rst: ['RST', '#9aa3b2'],
  css: ['#', '#9b7bf2'], scss: ['S', '#d6609b'], sass: ['S', '#d6609b'], less: ['L', '#3d76c2'],
  html: ['<>', '#ef6b3a'], htm: ['<>', '#ef6b3a'], vue: ['V', '#42b883'], svelte: ['S', '#ff5d32'], astro: ['A', '#ff7e33'],
  py: ['PY', '#4f8fd6'], ipynb: ['NB', '#f0883e'], rb: ['RB', '#d6463f'], go: ['GO', '#3dc2d6'], rs: ['RS', '#e0844d'],
  java: ['J', '#e76f2f'], kt: ['KT', '#a97bff'], cs: ['C#', '#68a063'], cpp: ['C++', '#5b8fc7'], c: ['C', '#5b8fc7'], h: ['H', '#9aa3b2'],
  php: ['PHP', '#8892bf'], swift: ['SW', '#f05138'], dart: ['DT', '#41c4f0'], lua: ['LUA', '#5865f2'],
  sh: ['$_', '#7fd27f'], bash: ['$_', '#7fd27f'], zsh: ['$_', '#7fd27f'], ps1: ['PS', '#5aa2ff'], bat: ['BAT', '#c1c66b'], cmd: ['CMD', '#c1c66b'],
  yml: ['YML', '#cb5a5a'], yaml: ['YML', '#cb5a5a'], toml: ['TOML', '#9c7a5b'], ini: ['INI', '#9aa3b2'], env: ['ENV', '#e8c547'],
  xml: ['XML', '#ef8a3a'], svg: ['SVG', '#f2b13c'], sql: ['SQL', '#d7ae5b'], graphql: ['GQL', '#e535ab'], prisma: ['PR', '#5a67d8'],
  png: ['IMG', '#b77ee0'], jpg: ['IMG', '#b77ee0'], jpeg: ['IMG', '#b77ee0'], gif: ['IMG', '#b77ee0'], webp: ['IMG', '#b77ee0'], ico: ['ICO', '#b77ee0'], avif: ['IMG', '#b77ee0'],
  mp3: ['♪', '#e0607e'], wav: ['♪', '#e0607e'], mp4: ['▶', '#e0607e'], webm: ['▶', '#e0607e'],
  woff: ['F', '#e05d5d'], woff2: ['F', '#e05d5d'], ttf: ['F', '#e05d5d'], otf: ['F', '#e05d5d'],
  pdf: ['PDF', '#e2463f'], zip: ['ZIP', '#a59a6a'], lock: ['LCK', '#8b93a1'], log: ['LOG', '#8b93a1'],
  ndjson: ['{}', '#c79a4a'], csv: ['CSV', '#5fbf73'], tsv: ['TSV', '#5fbf73'], vsix: ['VS', '#3c8ef0'],
};

// whole file names → [label, colour]
const BY_NAME = {
  'package.json': ['npm', '#e2463f'], 'package-lock.json': ['npm', '#9b4a46'], 'pnpm-lock.yaml': ['pn', '#f69220'], 'yarn.lock': ['yn', '#2c8ebb'],
  'tsconfig.json': ['TS', '#3c8ef0'], 'jsconfig.json': ['JS', '#e8c547'], dockerfile: ['🐳', '#2496ed'], 'docker-compose.yml': ['🐳', '#2496ed'], 'compose.yaml': ['🐳', '#2496ed'],
  '.gitignore': ['git', '#f05133'], '.gitattributes': ['git', '#f05133'], '.env': ['ENV', '#e8c547'], '.npmrc': ['npm', '#e2463f'],
  'readme.md': ['i', '#5aa2ff'], license: ['§', '#d9b44a'], 'license.md': ['§', '#d9b44a'], 'claude.md': ['CL', '#d97757'], 'agents.md': ['AG', '#9aa3b2'],
  '.eslintrc': ['ES', '#7b6fe0'], 'eslint.config.js': ['ES', '#7b6fe0'], 'eslint.config.mjs': ['ES', '#7b6fe0'], '.prettierrc': ['PR', '#56b3b4'],
  'vite.config.ts': ['⚡', '#9b6dff'], 'vite.config.js': ['⚡', '#9b6dff'], 'next.config.js': ['N', '#c9ccd3'], 'next.config.ts': ['N', '#c9ccd3'], 'next.config.mjs': ['N', '#c9ccd3'],
  'tailwind.config.js': ['TW', '#38bdf8'], 'tailwind.config.ts': ['TW', '#38bdf8'], makefile: ['MK', '#a6714e'],
};

// folder name → colour (role)
const FOLDERS = {
  src: '#4f8fe6', app: '#3fb8c9', lib: '#7f8ff0', components: '#a77bf3', pages: '#e07a5f', routes: '#e07a5f', api: '#5fbf73', server: '#3fb8a0',
  web: '#6b8cf5', public: '#5fbf73', static: '#5fbf73', assets: '#e6a23c', images: '#b77ee0', img: '#b77ee0', fonts: '#e05d5d', styles: '#9b7bf2', css: '#9b7bf2',
  test: '#e8c547', tests: '#e8c547', __tests__: '#e8c547', qa: '#e8c547', spec: '#e8c547', docs: '#5aa2ff', doc: '#5aa2ff', scripts: '#7fd27f', bin: '#7fd27f',
  config: '#9aa3b2', data: '#d6a24a', db: '#d7ae5b', migrations: '#d7ae5b', hooks: '#3fb8c9', utils: '#7f8ff0', types: '#3c8ef0', sounds: '#e0607e',
  '.git': '#f05133', '.github': '#9aa3b2', '.vscode': '#3c8ef0', '.claude': '#d97757', 'graphify-out': '#7f8ff0',
  node_modules: '#5d8a5d', dist: '#8b93a1', build: '#8b93a1', out: '#8b93a1', coverage: '#8b93a1', '.next': '#8b93a1', vendor: '#8b93a1',
};
const DEFAULT_FOLDER = '#c9a456';

function lookup(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.endsWith('.d.ts')) return BY_EXT['d.ts'];
  if (name.startsWith('.env')) return BY_EXT.env;
  const dot = name.lastIndexOf('.');
  return (dot > 0 && BY_EXT[name.slice(dot + 1)]) || ['', '#8b93a1'];
}

/** Coloured language badge for a file path (blank document glyph when the type is unknown). */
export function fileBadge(path) {
  const [label, color] = lookup(path);
  const el = document.createElement('span');
  el.className = `file-badge${label.length > 2 ? ' is-wide' : ''}${label ? '' : ' is-plain'}`;
  el.style.setProperty('--fc', color);
  el.setAttribute('aria-hidden', 'true');
  el.textContent = label;
  return el;
}

/** Filled folder, coloured by the folder's role; drawn open when expanded. */
export function folderIcon(name, open = false, size = 16) {
  const color = FOLDERS[name.toLowerCase()] ?? DEFAULT_FOLDER;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 16');
  svg.setAttribute('width', String(size + 2));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('folder-icon');
  const path = (d, fill, opacity = 1) => {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill);
    p.setAttribute('fill-opacity', String(opacity));
    svg.append(p);
  };
  if (open) {
    path('M1 3.2C1 2.5 1.5 2 2.2 2h4.4l1.7 1.8h7.5c.7 0 1.2.5 1.2 1.2V6H4.3L1 13z', color, 0.55);
    path('M4 6.5h14.6c.8 0 1.3.7 1 1.4l-2.4 6.3c-.2.5-.7.8-1.2.8H1.6c-.6 0-1-.6-.8-1.1l2.3-6.6c.2-.5.5-.8.9-.8z', color);
  } else {
    path('M1 3.2C1 2.5 1.5 2 2.2 2h4.4l1.7 1.8h9.5c.7 0 1.2.5 1.2 1.2v8.8c0 .7-.5 1.2-1.2 1.2H2.2C1.5 15 1 14.5 1 13.8z', color, 0.55);
    path('M1 5.6h17.8c.1 0 .2.1.2.2v8c0 .7-.5 1.2-1.2 1.2H2.2C1.5 15 1 14.5 1 13.8z', color);
  }
  return svg;
}
