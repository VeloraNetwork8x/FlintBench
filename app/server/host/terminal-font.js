import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The font the owner's own terminal uses, so FlintBench's terminals look like theirs. Read only:
 * Windows Terminal (the default profile, then its defaults), else VS Code's integrated terminal.
 * Resolves to a list of font family names (most wanted first), or null when nothing is set.
 */

// Windows Terminal's own default when a profile names no font
const WT_DEFAULT_FACE = 'Cascadia Mono';

/** JSON with comments and trailing commas (Windows Terminal and VS Code settings). */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, '$1'));
}

async function readJsonc(file) {
  try {
    return parseJsonc((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** Font family names from a CSS-like list ("'Fira Code', Consolas, monospace"), generic names dropped. */
export function fontFamilies(value) {
  if (typeof value !== 'string') return [];
  return value.split(',')
    .map((f) => f.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter((f) => f && f.length <= 64 && /^[\p{L}\p{N} ._-]+$/u.test(f) && !/^(monospace|serif|sans-serif)$/i.test(f));
}

function windowsTerminalFiles() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'), // unpackaged install
  ];
}

/** The face Windows Terminal's default profile uses (profile → profiles.defaults → WT's own default). */
export function windowsTerminalFace(settings) {
  const profiles = settings?.profiles;
  const list = Array.isArray(profiles) ? profiles : Array.isArray(profiles?.list) ? profiles.list : [];
  const defaults = Array.isArray(profiles) ? {} : profiles?.defaults ?? {};
  const wanted = String(settings?.defaultProfile ?? '').toLowerCase();
  const profile = list.find((p) => String(p?.guid ?? '').toLowerCase() === wanted || String(p?.name ?? '').toLowerCase() === wanted) ?? {};
  // "font": { "face" } since WT 1.10; "fontFace" before
  return profile.font?.face ?? profile.fontFace ?? defaults.font?.face ?? defaults.fontFace ?? WT_DEFAULT_FACE;
}

function vscodeSettingsFile() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Code', 'User', 'settings.json');
}

export async function hostTerminalFont() {
  if (process.platform === 'win32') {
    for (const file of windowsTerminalFiles()) {
      const settings = await readJsonc(file);
      if (!settings) continue;
      const families = fontFamilies(windowsTerminalFace(settings));
      if (families.length) return { families, source: 'Windows Terminal' };
    }
  }
  const vscode = await readJsonc(vscodeSettingsFile());
  const families = fontFamilies(vscode?.['terminal.integrated.fontFamily'] || vscode?.['editor.fontFamily']);
  return families.length ? { families, source: 'VS Code' } : null;
}
