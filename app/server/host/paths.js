import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { IS_WIN } from './exec.js';

/** Absolute, normalised path; expands a leading ~. */
export function normalizePath(input) {
  if (typeof input !== 'string' || !input.trim()) throw httpError(400, 'Path is required');
  let p = input.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw httpError(400, 'Path must be absolute');
  if (p.includes('\0')) throw httpError(400, 'Invalid path');
  return path.resolve(p);
}

/** Comparison key: case-insensitive on Windows/macOS default filesystems. */
export function pathKey(p) {
  const resolved = path.resolve(p);
  return IS_WIN || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export function isInside(parent, child) {
  const rel = path.relative(pathKey(parent), pathKey(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves a user-supplied relative path inside `root`, following symlinks,
 * and refuses anything that escapes the root.
 */
export async function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0')) throw httpError(400, 'Invalid path');
  if (path.isAbsolute(relative)) throw httpError(400, 'Path must be relative to the project');
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, relative);
  if (!isInside(realRoot, candidate)) throw httpError(403, 'Path is outside the project');
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw httpError(404, 'File not found');
  }
  if (!isInside(realRoot, real)) throw httpError(403, 'Path is outside the project');
  return real;
}

/** Validates a repo-relative path string before handing it to git (after `--`). */
export function assertRelativeRepoPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || path.isAbsolute(p)) throw httpError(400, 'Invalid path');
  const normalized = path.posix.normalize(p.replaceAll('\\', '/'));
  if (normalized.startsWith('../') || normalized === '..') throw httpError(403, 'Path is outside the project');
  return normalized;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
