import fs from 'node:fs/promises';
import path from 'node:path';

export const STRONG_INDICATORS = [
  '.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'deno.json', 'composer.json', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
];
// A bare index.html marks a static site (common for hand-built web projects).
export const WEAK_INDICATORS = ['index.html'];
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const ALL = new Set([...STRONG_INDICATORS, ...WEAK_INDICATORS]);

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readText(file, max = 64 * 1024) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.slice(0, max);
  } catch {
    return '';
  }
}

const NODE_STACK = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['svelte', 'Svelte'],
  ['vue', 'Vue'], ['react', 'React'], ['@angular/core', 'Angular'], ['astro', 'Astro'],
  ['solid-js', 'Solid'], ['vite', 'Vite'], ['express', 'Express'], ['fastify', 'Fastify'],
  ['@nestjs/core', 'NestJS'], ['hono', 'Hono'], ['electron', 'Electron'], ['discord.js', 'discord.js'],
  ['tailwindcss', 'Tailwind'], ['prisma', 'Prisma'], ['typescript', 'TypeScript'],
];

/** Inspects one directory; returns null when it does not look like a project. */
export async function detectProject(dir, names) {
  const entries = names ?? (await fs.readdir(dir).catch(() => []));
  const present = entries.filter((n) => ALL.has(n));
  if (!present.length) return null;
  const strong = present.filter((n) => STRONG_INDICATORS.includes(n));
  if (!strong.length && !present.includes('index.html')) return null;

  const stack = new Set();
  const set = new Set(entries);
  if (set.has('package.json')) {
    const pkg = await readJson(path.join(dir, 'package.json'));
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    for (const [dep, label] of NODE_STACK) if (dep in deps) stack.add(label);
    if (set.has('tsconfig.json')) stack.add('TypeScript');
    if (!stack.size) stack.add('Node.js');
  }
  if (set.has('pyproject.toml') || set.has('requirements.txt')) {
    const text = (await readText(path.join(dir, 'pyproject.toml'))) + (await readText(path.join(dir, 'requirements.txt')));
    stack.add('Python');
    if (/\bdjango\b/i.test(text)) stack.add('Django');
    if (/\bfastapi\b/i.test(text)) stack.add('FastAPI');
    if (/\bflask\b/i.test(text)) stack.add('Flask');
  }
  if (set.has('Cargo.toml')) stack.add('Rust');
  if (set.has('go.mod')) stack.add('Go');
  if (set.has('deno.json')) stack.add('Deno');
  if (set.has('composer.json')) stack.add('PHP');
  if (set.has('Gemfile')) stack.add('Ruby');
  if (set.has('pom.xml') || set.has('build.gradle') || set.has('build.gradle.kts')) stack.add('JVM');
  if (COMPOSE_FILES.some((f) => set.has(f)) || set.has('Dockerfile')) stack.add('Docker');
  if (!strong.length) stack.add('Static site');
  if (set.has('.git')) stack.add('Git');

  return {
    name: path.basename(dir),
    path: dir,
    indicators: present,
    stack: [...stack],
    hasGit: set.has('.git'),
    composeFiles: COMPOSE_FILES.filter((f) => set.has(f)),
  };
}
