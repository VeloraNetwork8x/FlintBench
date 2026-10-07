/**
 * Line diff without git: what was added and what was removed between two versions of a text file.
 * Common lines at the start and at the end are set aside first (an edit usually touches a small
 * part of a file); the middle is aligned with a longest-common-subsequence table when it is small
 * enough, otherwise it is reported as replaced (still a correct diff, only not the shortest).
 */

const MAX_CELLS = 4_000_000; // middle part up to ~2000 × 2000 lines is aligned line by line
const CONTEXT = 3;

export const splitLines = (text) => {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** Edit script: [{ t: '=', a, b } | { t: '-', a } | { t: '+', b }] with line indexes. */
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ t: '=', a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n && m && n * m <= MAX_CELLS) {
    // lcs[i][j]: common lines of a[start+i..] and b[start+j..], one flat table
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { ops.push({ t: '=', a: start + i, b: start + j }); i += 1; j += 1; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { ops.push({ t: '-', a: start + i }); i += 1; }
      else { ops.push({ t: '+', b: start + j }); j += 1; }
    }
    for (; i < n; i += 1) ops.push({ t: '-', a: start + i });
    for (; j < m; j += 1) ops.push({ t: '+', b: start + j });
  } else {
    for (let i = 0; i < n; i += 1) ops.push({ t: '-', a: start + i });
    for (let j = 0; j < m; j += 1) ops.push({ t: '+', b: start + j });
  }
  for (let i = 0; i < a.length - endA; i += 1) ops.push({ t: '=', a: endA + i, b: endB + i });
  return { ops, a, b };
}

/** Lines added and removed between two versions. */
export function lineCounts(oldText, newText) {
  const { ops } = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === '+') added += 1;
    else if (op.t === '-') removed += 1;
  }
  return { added, removed };
}

/** Unified diff ("--- a/x", "+++ b/x", "@@ -1,3 +1,4 @@" hunks with 3 lines of context). */
export function unifiedDiff(oldText, newText, file) {
  const { ops, a, b } = diffLines(oldText, newText);
  const changed = ops.map((op, k) => (op.t === '=' ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return '';
  const out = [`--- ${oldText === null ? '/dev/null' : `a/${file}`}`, `+++ ${newText === null ? '/dev/null' : `b/${file}`}`];
  // hunks: runs of changes closer than 2 × context are one hunk
  let k = 0;
  while (k < changed.length) {
    let last = k;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= CONTEXT * 2 + 1) last += 1;
    const from = Math.max(0, changed[k] - CONTEXT);
    const to = Math.min(ops.length - 1, changed[last] + CONTEXT);
    const slice = ops.slice(from, to + 1);
    // where the hunk starts in each version: the first line of that side at or after `from`
    const firstA = ops.slice(from).find((op) => op.a !== undefined)?.a ?? a.length;
    const firstB = ops.slice(from).find((op) => op.b !== undefined)?.b ?? b.length;
    const lenA = slice.filter((op) => op.t !== '+').length;
    const lenB = slice.filter((op) => op.t !== '-').length;
    out.push(`@@ -${lenA ? firstA + 1 : firstA},${lenA} +${lenB ? firstB + 1 : firstB},${lenB} @@`);
    for (const op of slice) out.push(op.t === '=' ? ` ${a[op.a]}` : op.t === '-' ? `-${a[op.a]}` : `+${b[op.b]}`);
    k = last + 1;
  }
  return out.join('\n');
}
