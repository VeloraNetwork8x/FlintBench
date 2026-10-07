// Small syntax highlighter for the read-only file viewer: VS Code-like colours (Dark+/Light+) for
// the common languages, without a dependency. Line-based with a little state carried across lines
// (block comments, template strings, HTML comments), which is what a reader needs to scan code.

const C_LIKE = {
  line: '//', block: ['/*', '*/'], strings: ['"', "'", '`'],
  control: 'if else for while do switch case default break continue return throw try catch finally await yield import export from as new delete typeof instanceof in of void with goto',
  keywords: 'const let var function class extends implements interface type enum namespace module declare public private protected readonly static abstract async get set this super true false null undefined NaN Infinity package struct impl fn pub use mut match where trait func go defer chan map select range int float double char bool boolean string void long short byte unsigned signed auto sizeof using virtual override sealed var val object fun when is',
};
const LANGS = {
  js: C_LIKE, mjs: C_LIKE, cjs: C_LIKE, jsx: C_LIKE, ts: C_LIKE, tsx: C_LIKE, mts: C_LIKE, cts: C_LIKE,
  java: C_LIKE, kt: C_LIKE, cs: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE, go: C_LIKE, rs: C_LIKE, swift: C_LIKE, dart: C_LIKE, php: { ...C_LIKE, line: '//' },
  json: { json: true, strings: ['"'] }, jsonc: { json: true, line: '//', block: ['/*', '*/'], strings: ['"'] },
  css: { css: true, block: ['/*', '*/'], strings: ['"', "'"] }, scss: { css: true, line: '//', block: ['/*', '*/'], strings: ['"', "'"] }, less: { css: true, line: '//', block: ['/*', '*/'], strings: ['"', "'"] },
  py: { line: '#', strings: ['"', "'"], control: 'if elif else for while break continue return raise try except finally with as import from pass yield await lambda in not and or is assert del global nonlocal', keywords: 'def class async True False None self cls print' },
  rb: { line: '#', strings: ['"', "'"], control: 'if elsif else unless case when while until for do end return break next begin rescue ensure yield', keywords: 'def class module require attr_accessor true false nil self' },
  sh: { line: '#', strings: ['"', "'"], control: 'if then else elif fi for while do done case esac in function return exit', keywords: 'echo export local cd source set unset' },
  bash: null, zsh: null, ps1: { line: '#', strings: ['"', "'"], control: 'if elseif else foreach for while do switch return function param try catch finally throw', keywords: '$true $false $null', psVars: true },
  yml: { yaml: true, line: '#', strings: ['"', "'"] }, yaml: null, toml: { yaml: true, line: '#', strings: ['"', "'"] }, ini: { yaml: true, line: ';', strings: ['"'] },
  sql: { line: '--', block: ['/*', '*/'], strings: ["'", '"'], control: 'select from where join left right inner outer on group by order having limit offset union insert into values update set delete create alter drop table index view as and or not null is in between like case when then else end', keywords: 'int integer text varchar boolean primary key references default unique', ci: true },
  html: { html: true }, htm: null, xml: { html: true }, svg: { html: true }, vue: { html: true },
  md: { md: true }, markdown: null, mdx: null,
};
for (const [k, v] of Object.entries({ bash: 'sh', zsh: 'sh', yaml: 'yml', htm: 'html', markdown: 'md', mdx: 'md' })) LANGS[k] = LANGS[v];

const words = (s) => new Set((s ?? '').split(/\s+/).filter(Boolean));

export function languageOf(path) {
  const name = path.toLowerCase().split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : null;
}

/** Returns an array of lines, each an array of [text, className|null] tokens. */
export function highlight(code, path) {
  const spec = LANGS[languageOf(path)];
  const lines = code.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  if (!spec) return lines.map((l) => [[l, null]]);
  if (spec.html) return markup(lines);
  if (spec.md) return markdown(lines);
  const control = words(spec.control);
  const keywords = words(spec.keywords);
  const state = { block: false, str: null };
  return lines.map((line) => codeLine(line, spec, control, keywords, state));
}

function codeLine(line, spec, control, keywords, state) {
  const out = [];
  const push = (t, c) => { if (t) out.push([t, c]); };
  let i = 0;
  if (state.block) {
    const end = line.indexOf(spec.block[1]);
    if (end < 0) return [[line, 'tk-com']];
    push(line.slice(0, end + spec.block[1].length), 'tk-com');
    i = end + spec.block[1].length;
    state.block = false;
  }
  if (state.str) { // multi-line template string
    const end = line.indexOf(state.str);
    if (end < 0) return [[line, 'tk-str']];
    push(line.slice(0, end + 1), 'tk-str');
    i = end + 1;
    state.str = null;
  }
  // YAML / TOML / INI: key: value
  if (spec.yaml) {
    const m = /^(\s*-?\s*)([\w."'@$-]+)(\s*[:=])/.exec(line.slice(i));
    if (m && !line.trim().startsWith(spec.line)) { push(m[1], null); push(m[2], 'tk-prop'); push(m[3], 'tk-punct'); i += m[0].length; }
    const h = /^\s*\[[^\]]+\]/.exec(line);
    if (h) return [[line, 'tk-type']];
  }
  // CSS: what precedes "{" on a rule line is the selector (pseudo-classes included)
  if (spec.css && i === 0) {
    const brace = line.indexOf('{');
    const head = brace > 0 ? line.slice(0, brace) : '';
    if (head.trim() && !head.includes(';') && !head.trim().startsWith('@') && !head.includes('/*')) {
      push(head, 'tk-sel');
      i = brace;
    }
  }
  let lastWord = '';
  while (i < line.length) {
    const rest = line.slice(i);
    if (spec.line && rest.startsWith(spec.line)) { push(rest, 'tk-com'); break; }
    if (spec.block && rest.startsWith(spec.block[0])) {
      const end = rest.indexOf(spec.block[1], spec.block[0].length);
      if (end < 0) { push(rest, 'tk-com'); state.block = true; break; }
      push(rest.slice(0, end + spec.block[1].length), 'tk-com');
      i += end + spec.block[1].length;
      continue;
    }
    const q = spec.strings?.find((s) => rest.startsWith(s));
    if (q) {
      let j = 1;
      while (j < rest.length && rest[j] !== q) j += rest[j] === '\\' ? 2 : 1;
      if (j >= rest.length && q === '`') { push(rest, 'tk-str'); state.str = '`'; break; }
      const str = rest.slice(0, j + 1);
      // a JSON key is a string followed by ':'
      const isKey = spec.json && /^\s*:/.test(rest.slice(j + 1));
      push(str, isKey ? 'tk-prop' : 'tk-str');
      i += str.length;
      continue;
    }
    const num = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)\b/i.exec(rest);
    if (num && !/[\w$]$/.test(line.slice(0, i))) { push(num[0], 'tk-num'); i += num[0].length; continue; }
    if (spec.psVars && rest[0] === '$') {
      const v = /^\$[\w:]+/.exec(rest);
      if (v) { push(v[0], 'tk-prop'); i += v[0].length; continue; }
    }
    if (spec.css) {
      const prop = /^([\w-]+)(\s*:)(?![^{]*\{)/.exec(rest);
      if (prop && /^\s*$/.test(line.slice(0, i).replace(/.*[;{]\s*/, ''))) { push(prop[1], 'tk-prop'); push(prop[2], 'tk-punct'); i += prop[0].length; continue; }
      const at = /^@[\w-]+/.exec(rest);
      if (at) { push(at[0], 'tk-ctrl'); i += at[0].length; continue; }
      if (/\{\s*$/.test(line) && !line.includes(':')) { push(rest.replace(/\{\s*$/, ''), 'tk-sel'); push(rest.slice(rest.replace(/\{\s*$/, '').length), 'tk-punct'); break; }
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const key = spec.ci ? w.toLowerCase() : w;
      const next = rest.slice(w.length);
      let cls = null;
      if (control.has(key)) cls = 'tk-ctrl';
      else if (keywords.has(key)) cls = 'tk-kw';
      else if (spec.json && /^(true|false|null)$/.test(w)) cls = 'tk-kw';
      else if (/^\s*\(/.test(next)) cls = 'tk-fn';
      else if (/^[A-Z]/.test(w) && !spec.css) cls = 'tk-type';
      else if (line[i - 1] === '.' || /^\s*:(?!:)/.test(next) && !spec.css) cls = 'tk-prop';
      else if (['const', 'let', 'var', 'function', 'class', 'def', 'type', 'interface'].includes(lastWord)) cls = lastWord === 'class' || lastWord === 'type' || lastWord === 'interface' ? 'tk-type' : lastWord === 'function' || lastWord === 'def' ? 'tk-fn' : 'tk-var';
      push(w, cls);
      lastWord = w;
      i += w.length;
      continue;
    }
    const punct = /^[^\w\s"'`$]+/.exec(rest);
    if (punct) { push(punct[0], 'tk-punct'); i += punct[0].length; continue; }
    const ws = /^\s+/.exec(rest);
    push(ws ? ws[0] : rest[0], null);
    i += ws ? ws[0].length : 1;
  }
  return out;
}

/** HTML / XML / SVG: tags, attributes, values, comments. */
function markup(lines) {
  let inComment = false;
  return lines.map((line) => {
    const out = [];
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      if (inComment || rest.startsWith('<!--')) {
        const end = rest.indexOf('-->', inComment ? 0 : 4);
        if (end < 0) { out.push([rest, 'tk-com']); inComment = true; break; }
        out.push([rest.slice(0, end + 3), 'tk-com']);
        i += end + 3;
        inComment = false;
        continue;
      }
      const tag = /^<\/?[\w:-]+/.exec(rest);
      if (tag) {
        out.push([tag[0].slice(0, tag[0].startsWith('</') ? 2 : 1), 'tk-punct']);
        out.push([tag[0].replace(/^<\/?/, ''), 'tk-tag']);
        i += tag[0].length;
        let attr;
        while ((attr = /^(\s+)([\w:@.#-]+)(?:(=)("[^"]*"|'[^']*'|[^\s>]+))?/.exec(line.slice(i)))) {
          out.push([attr[1], null], [attr[2], 'tk-attr']);
          if (attr[3]) out.push([attr[3], 'tk-punct'], [attr[4], 'tk-str']);
          i += attr[0].length;
        }
        const close = /^\s*\/?>/.exec(line.slice(i));
        if (close) { out.push([close[0], 'tk-punct']); i += close[0].length; }
        continue;
      }
      const text = /^[^<]+/.exec(rest);
      out.push([text ? text[0] : rest[0], null]);
      i += text ? text[0].length : 1;
    }
    return out;
  });
}

/** Markdown source: headings, emphasis, inline code, links, fences, lists, quotes. */
function markdown(lines) {
  let fence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return [[line, 'tk-com']]; }
    if (fence) return [[line, 'tk-str']];
    if (/^#{1,6}\s/.test(line)) return [[line, 'tk-kw tk-bold']];
    if (/^\s*>/.test(line)) return [[line, 'tk-com']];
    const out = [];
    const list = /^(\s*(?:[-*+]|\d+\.)\s)/.exec(line);
    let rest = line;
    if (list) { out.push([list[1], 'tk-ctrl']); rest = line.slice(list[1].length); }
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      if (m.index > last) out.push([rest.slice(last, m.index), null]);
      out.push([m[0], m[1] ? 'tk-str' : m[2] ? 'tk-bold' : 'tk-fn']);
      last = m.index + m[0].length;
    }
    if (last < rest.length) out.push([rest.slice(last), null]);
    return out;
  });
}
