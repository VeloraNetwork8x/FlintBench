import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from '../host/paths.js';
import { IGNORED_DIRS } from '../host/fs-watch.js';

const PRIMARY = [
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'README.md', 'README', 'readme.md', 'ARCHITECTURE.md',
  'CONTRIBUTING.md', 'CHANGELOG.md', 'PROJECT-DESIGN.md', 'DESIGN.md', '.cursorrules',
  '.github/copilot-instructions.md', '.claude/CLAUDE.md',
];
const DOC_DIRS = ['docs', 'doc', '.claude/commands'];
const TEXT_EXT = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const MAX_READ = 512 * 1024;

/** Centralised access to project context documents. Read-only. */
export class ContextService {
  constructor({ projects, host }) {
    this.projects = projects;
    this.host = host;
  }

  async list(projectId) {
    const project = this.projects.get(projectId);
    const root = project.path;
    const files = [];
    const seen = new Set();
    const add = async (rel, group) => {
      const key = rel.toLowerCase();
      if (seen.has(key)) return;
      try {
        const st = await fs.stat(path.join(root, rel));
        if (!st.isFile()) return;
        seen.add(key);
        files.push({ path: rel.replaceAll('\\', '/'), group, size: st.size, modifiedAt: st.mtimeMs });
      } catch { /* missing */ }
    };
    for (const rel of PRIMARY) await add(rel, 'agent-and-readme');
    for (const dir of DOC_DIRS) await this.#walk(root, dir, 0, add, files);
    // other markdown at the root
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && TEXT_EXT.test(entry.name)) await add(entry.name, 'root');
      if (files.length > 120) break;
    }
    return files;
  }

  async #walk(root, rel, depth, add, files) {
    if (depth > 2 || files.length > 120) return;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await this.#walk(root, child, depth + 1, add, files);
      else if (entry.isFile() && TEXT_EXT.test(entry.name)) await add(child, rel.split(/[\\/]/)[0]);
    }
  }

  async read(projectId, rel) {
    const project = this.projects.get(projectId);
    const file = await this.host.paths.resolveInside(project.path, String(rel ?? ''));
    const st = await fs.stat(file);
    if (!st.isFile()) throw httpError(400, 'Not a file');
    const handle = await fs.open(file, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(st.size, MAX_READ)), 0, Math.min(st.size, MAX_READ), 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) throw httpError(415, 'Binary files are not shown');
      return { path: rel, size: st.size, truncated: st.size > MAX_READ, modifiedAt: st.mtimeMs, content: content.toString('utf8') };
    } finally {
      await handle.close();
    }
  }

  /**
   * The knowledge graph written by graphify (graphify-out/graph.json + GRAPH_REPORT.md), if the
   * project has one. Read-only; trimmed to what the graph view draws. meta: only say whether it exists.
   */
  async graph(projectId, { meta = false } = {}) {
    const project = this.projects.get(projectId);
    const dir = path.join(project.path, 'graphify-out');
    const file = path.join(dir, 'graph.json');
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) return { available: false };
    if (meta) return { available: true, builtAt: st.mtimeMs };
    if (st.size > 32 * 1024 * 1024) throw httpError(413, 'graph.json is too large to display');
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw httpError(422, 'graphify-out/graph.json is not valid JSON');
    }
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, 6000).map((n) => ({
      id: String(n.id),
      label: String(n.label ?? n.id).slice(0, 160),
      type: n.file_type ?? null,
      file: n.source_file ?? null,
      loc: n.source_location ?? null,
      community: Number.isInteger(n.community) ? n.community : -1,
      communityName: n.community_name ?? null,
    }));
    const known = new Set(nodes.map((n) => n.id));
    const links = (Array.isArray(raw.links) ? raw.links : raw.edges ?? [])
      .filter((l) => known.has(String(l.source)) && known.has(String(l.target)))
      .slice(0, 20000)
      .map((l) => ({ s: String(l.source), t: String(l.target), rel: l.relation ?? null, conf: l.confidence ?? null }));
    const report = await fs.readFile(path.join(dir, 'GRAPH_REPORT.md'), 'utf8').catch(() => null);
    return {
      available: true,
      builtAt: st.mtimeMs,
      commit: raw.built_at_commit ?? null,
      nodes,
      links,
      report: report ? report.slice(0, MAX_READ) : null,
    };
  }

  /**
   * One directory of the project, for the file explorer. Read-only, contained in the project
   * (realpath checked), folders first. Heavy generated folders are listed but flagged.
   */
  async listDir(projectId, rel = '') {
    const project = this.projects.get(projectId);
    const dir = await this.host.paths.resolveInside(project.path, String(rel || '.'));
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw httpError(400, 'Not a folder');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const base = String(rel || '').replaceAll('\\', '/').replace(/^\.\/?|\/$/g, '');
    const out = [];
    for (const e of entries.slice(0, 3000)) {
      const isDir = e.isDirectory();
      const item = { name: e.name, path: base ? `${base}/${e.name}` : e.name, type: isDir ? 'dir' : e.isSymbolicLink() ? 'link' : 'file' };
      if (isDir) {
        item.heavy = IGNORED_DIRS.has(e.name) || e.name === '.git';
      } else {
        const fst = await fs.stat(path.join(dir, e.name)).catch(() => null);
        item.size = fst?.size ?? null;
        item.modifiedAt = fst?.mtimeMs ?? null;
      }
      out.push(item);
    }
    out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { path: base, entries: out, truncated: entries.length > 3000 };
  }
}
