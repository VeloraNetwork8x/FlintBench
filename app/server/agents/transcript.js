import { httpError } from '../host/paths.js';

const KEEP_ITEMS = 600; // replayed to a newly attached viewer
const POLL_MS = 2000; // fallback when a file event is missed, and while the transcript does not exist yet
const IDLE_CLOSE_MS = 30_000; // follower kept briefly after the last viewer leaves (tab switches)
const MAX_TEXT = 20_000;
const MAX_RESULT = 6000;
const MAX_PATCH_LINES = 400;
const INPUT_KEYS = ['command', 'description', 'file_path', 'notebook_path', 'path', 'pattern', 'glob', 'url', 'query', 'prompt', 'skill', 'subagent_type'];

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Text the CLI injects into user turns (reminders, local command output) — not something the user typed. */
function stripInjected(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, '')
    .trim();
}

function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url
    ?? input.query ?? input.prompt ?? input.skill ?? Object.values(input).find((v) => typeof v === 'string') ?? '';
  return clip(String(pick).replace(/\s+/g, ' ').trim(), 240);
}

/** The tool arguments Claude Code shows in its own tool header, nothing else. */
function toolInput(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const key of INPUT_KEYS) if (typeof input[key] === 'string') out[key] = clip(input[key], key === 'command' ? 2000 : 400);
  if (Array.isArray(input.todos)) {
    out.todos = input.todos.slice(0, 40).map((t) => ({ content: clip(String(t?.content ?? ''), 300), status: String(t?.status ?? 'pending') }));
  }
  return out;
}

/**
 * Structured outcome recorded by Claude Code next to a tool result (`toolUseResult`):
 * the same data its terminal UI renders (diff hunks, line counts, shell output, match counts).
 */
function resultData(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (Array.isArray(r.structuredPatch)) {
    const all = r.structuredPatch.flatMap((hunk) => (Array.isArray(hunk?.lines) ? hunk.lines : []));
    let budget = MAX_PATCH_LINES;
    const hunks = [];
    for (const hunk of r.structuredPatch) {
      if (budget <= 0) break;
      const lines = (Array.isArray(hunk?.lines) ? hunk.lines : []).slice(0, budget).map((l) => clip(String(l), 500));
      budget -= lines.length;
      hunks.push({ oldStart: Number(hunk.oldStart) || 1, newStart: Number(hunk.newStart) || 1, lines });
    }
    const created = r.type === 'create' && typeof r.content === 'string';
    const contentLines = created ? r.content.replace(/\n$/, '').split('\n') : null;
    return {
      kind: 'patch',
      type: created ? 'create' : 'update',
      filePath: typeof r.filePath === 'string' ? r.filePath : null,
      added: all.filter((l) => l.startsWith('+')).length,
      removed: all.filter((l) => l.startsWith('-')).length,
      hunks,
      truncated: all.length > MAX_PATCH_LINES,
      content: created ? { lines: contentLines.length, head: contentLines.slice(0, MAX_PATCH_LINES).map((l) => clip(l, 500)) } : null,
    };
  }
  if (r.file && typeof r.file.numLines === 'number') return { kind: 'read', filePath: r.file.filePath ?? null, numLines: r.file.numLines };
  if ('stdout' in r || 'stderr' in r) {
    return { kind: 'shell', stdout: clip(String(r.stdout ?? ''), MAX_RESULT), stderr: clip(String(r.stderr ?? ''), MAX_RESULT), interrupted: Boolean(r.interrupted) };
  }
  if (typeof r.numFiles === 'number') return { kind: 'search', mode: r.mode ?? 'files_with_matches', numFiles: r.numFiles, numLines: typeof r.numLines === 'number' ? r.numLines : null };
  return null;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  return '';
}

/**
 * One Claude Code transcript line → zero or more display items.
 * Kept: what the user typed, Claude's replies, tool calls with their outcome, turn ends.
 * Dropped: thinking, attachments, injected context, subagent (sidechain) traffic.
 */
export function claudeItems(raw) {
  if (!raw || typeof raw !== 'object' || raw.isSidechain) return [];
  const at = Date.parse(raw.timestamp) || null;
  const base = raw.uuid ?? `${raw.type}-${at}`;
  const content = raw.message?.content;
  if (raw.type === 'user' && !raw.isMeta) {
    if (typeof content === 'string') {
      const command = /<command-name>([^<]+)<\/command-name>/.exec(content);
      if (command) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim();
        return [{ uid: base, kind: 'command', at, text: clip(`${command[1].trim()}${args ? ` ${args}` : ''}`, 400) }];
      }
      const text = stripInjected(content);
      return text ? [{ uid: base, kind: 'user', at, text: clip(text, MAX_TEXT) }] : [];
    }
    if (!Array.isArray(content)) return [];
    const items = [];
    content.forEach((c, i) => {
      if (c?.type === 'tool_result') {
        items.push({
          uid: `${base}:${i}`, kind: 'result', at, toolId: c.tool_use_id, isError: Boolean(c.is_error),
          text: clip(resultText(c.content), MAX_RESULT),
          data: content.length === 1 ? resultData(raw.toolUseResult) : null,
        });
      } else if (c?.type === 'text') {
        const text = stripInjected(c.text ?? '');
        if (text) items.push({ uid: `${base}:${i}`, kind: 'user', at, text: clip(text, MAX_TEXT) });
      } else if (c?.type === 'image') {
        items.push({ uid: `${base}:${i}`, kind: 'user', at, text: '[image]' });
      }
    });
    return items;
  }
  if (raw.type === 'assistant' && Array.isArray(content)) {
    const items = [];
    content.forEach((c, i) => {
      if (c?.type === 'text' && c.text?.trim()) items.push({ uid: `${base}:${i}`, kind: 'assistant', at, text: clip(c.text, MAX_TEXT) });
      else if (c?.type === 'tool_use') items.push({ uid: `${base}:${i}`, kind: 'tool', at, toolId: c.id, name: String(c.name ?? 'tool'), summary: toolSummary(c.input), input: toolInput(c.input) });
    });
    return items;
  }
  if (raw.type === 'system' && raw.subtype === 'turn_duration') {
    return [{ uid: base, kind: 'turn', at, durationMs: Number(raw.durationMs) || null }];
  }
  return [];
}

const codexText = (content) => (Array.isArray(content) ? content.map((c) => c?.text ?? '').filter(Boolean).join('\n') : String(content ?? ''));

/** Unified diff text → the hunks the viewer draws (same shape as Claude Code's structuredPatch). */
function hunksOf(diff) {
  const hunks = [];
  let cur = null;
  let budget = MAX_PATCH_LINES;
  for (const line of String(diff ?? '').split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) { cur = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }; hunks.push(cur); continue; }
    if (!cur || budget <= 0 || line.startsWith('---') || line.startsWith('+++')) continue;
    if (/^[+\- ]/.test(line)) { cur.lines.push(clip(line, 500)); budget -= 1; }
  }
  return hunks;
}

/**
 * One Codex session line → display items, mapped onto the same kinds as Claude Code's so the
 * viewer draws both alike. Recent Codex writes each finished step as `item_completed`
 * (UserMessage, AgentMessage, CommandExecution, FileChange, McpToolCall…); older sessions only
 * have user_message / agent_message events, used when no item has been seen.
 */
export function codexItems(raw, state = {}) {
  if (!raw || typeof raw !== 'object') return [];
  const at = Date.parse(raw.timestamp) || null;
  const p = raw.payload ?? {};
  if (raw.type === 'event_msg' && p.type === 'item_completed' && p.item) {
    state.items = true;
    const it = p.item;
    const uid = String(it.id ?? `${p.turn_id}-${at}`);
    switch (it.type) {
      case 'UserMessage': {
        const text = stripInjected(codexText(it.content));
        return text ? [{ uid, kind: 'user', at, text: clip(text, MAX_TEXT) }] : [];
      }
      case 'AgentMessage': {
        const text = codexText(it.content).trim();
        return text ? [{ uid, kind: 'assistant', at, text: clip(text, MAX_TEXT) }] : [];
      }
      case 'CommandExecution': {
        const command = it.parsed_cmd?.[0]?.cmd ?? (Array.isArray(it.command) ? it.command[it.command.length - 1] : String(it.command ?? ''));
        const output = String(it.aggregated_output ?? it.formatted_output ?? it.stdout ?? '');
        return [
          { uid: `${uid}:call`, kind: 'tool', at, toolId: uid, name: 'Bash', summary: clip(String(command).replace(/\s+/g, ' ').trim(), 240), input: { command: clip(String(command), 2000) } },
          { uid: `${uid}:out`, kind: 'result', at, toolId: uid, isError: Number(it.exit_code) !== 0, text: clip(output, MAX_RESULT), data: { kind: 'shell', stdout: clip(output, MAX_RESULT), stderr: '', interrupted: it.status === 'interrupted' } },
        ];
      }
      case 'FileChange': {
        const out = [];
        for (const [filePath, change] of Object.entries(it.changes ?? {})) {
          const id = `${uid}:${filePath}`;
          const created = change?.type === 'add';
          const deleted = change?.type === 'delete';
          out.push({ uid: `${id}:call`, kind: 'tool', at, toolId: id, name: created ? 'Write' : deleted ? 'Delete' : 'Update', summary: filePath, input: { file_path: filePath } });
          if (deleted) { out.push({ uid: `${id}:out`, kind: 'result', at, toolId: id, isError: false, text: 'Deleted' }); continue; }
          if (created) {
            const lines = String(change.content ?? '').replace(/\n$/, '').split('\n');
            out.push({ uid: `${id}:out`, kind: 'result', at, toolId: id, isError: false, text: '', data: { kind: 'patch', type: 'create', filePath, added: lines.length, removed: 0, hunks: [], truncated: lines.length > MAX_PATCH_LINES, content: { lines: lines.length, head: lines.slice(0, MAX_PATCH_LINES).map((l) => clip(l, 500)) } } });
            continue;
          }
          const hunks = hunksOf(change?.unified_diff ?? change?.diff);
          const all = hunks.flatMap((x) => x.lines);
          out.push({ uid: `${id}:out`, kind: 'result', at, toolId: id, isError: it.status === 'failed', text: '', data: { kind: 'patch', type: 'update', filePath, added: all.filter((l) => l.startsWith('+')).length, removed: all.filter((l) => l.startsWith('-')).length, hunks, truncated: false, content: null } });
        }
        return out;
      }
      case 'McpToolCall': {
        const name = `${it.server ?? 'mcp'} · ${it.tool ?? 'tool'}`;
        return [
          { uid: `${uid}:call`, kind: 'tool', at, toolId: uid, name, summary: toolSummary(it.arguments), input: toolInput(it.arguments) },
          { uid: `${uid}:out`, kind: 'result', at, toolId: uid, isError: Boolean(it.result?.isError), text: clip(codexText(it.result?.content), MAX_RESULT) },
        ];
      }
      case 'Extension':
        return [
          { uid: `${uid}:call`, kind: 'tool', at, toolId: uid, name: 'Web search', summary: clip(String(it.query ?? it.action?.query ?? ''), 240), input: { query: clip(String(it.query ?? ''), 400) } },
          { uid: `${uid}:out`, kind: 'result', at, toolId: uid, isError: false, text: Array.isArray(it.results) ? `${it.results.length} results` : '' },
        ];
      case 'ImageView':
        return [
          { uid: `${uid}:call`, kind: 'tool', at, toolId: uid, name: 'View image', summary: String(it.path ?? ''), input: { path: String(it.path ?? '') } },
          { uid: `${uid}:out`, kind: 'result', at, toolId: uid, isError: false, text: 'Shown to Codex' },
        ];
      default:
        return []; // reasoning and anything unknown stay out
    }
  }
  if (raw.type === 'event_msg' && p.type === 'task_complete') {
    return [{ uid: `turn-${p.turn_id ?? at}`, kind: 'turn', at, durationMs: Number(p.duration_ms) || null }];
  }
  // older sessions: plain message events
  if (!state.items && raw.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message')) {
    const text = (p.type === 'user_message' ? stripInjected(String(p.message ?? '')) : String(p.message ?? '')).trim();
    return text ? [{ uid: `${p.type}-${at}`, kind: p.type === 'user_message' ? 'user' : 'assistant', at, text: clip(text, MAX_TEXT) }] : [];
  }
  return [];
}


// Antigravity tool names → the names the viewer already knows how to draw
const AGY_TOOLS = { view_file: 'Read', list_dir: 'List', grep_search: 'Search', write_to_file: 'Write', run_command: 'Bash', replace_file_content: 'Update', multi_replace_file_content: 'Update', search_web: 'Web search', read_url_content: 'Fetch' };

/** Antigravity's tool arguments → the summary and inputs the viewer shows. */
function agyInput(name, args = {}) {
  const pick = args.CommandLine ?? args.AbsolutePath ?? args.TargetFile ?? args.DirectoryPath ?? args.Query ?? args.SearchPath ?? args.Url ?? args.toolSummary ?? '';
  const input = {};
  if (args.CommandLine) input.command = clip(String(args.CommandLine), 2000);
  const file = args.AbsolutePath ?? args.TargetFile;
  if (file) input.file_path = clip(String(file), 400);
  if (args.DirectoryPath) input.path = clip(String(args.DirectoryPath), 400);
  if (args.Query) input.pattern = clip(String(args.Query), 400);
  return { summary: clip(String(pick).replace(/\s+/g, ' ').trim(), 240), input };
}

/** The request the user typed: inside <USER_REQUEST>, without Antigravity's added metadata. */
function agyUserText(content) {
  const text = String(content ?? '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  return (m ? m[1] : text.replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g, '')).trim();
}

/** A tool's output without the "Created At / Completed At" header Antigravity puts on top. */
const agyResultText = (content) => String(content ?? '').replace(/^(?:(?:Created|Completed) At:[^\n]*\n)+/, '').trim();

/**
 * One Antigravity transcript step → display items. A model step either answers (content) or calls
 * tools (tool_calls); the next model steps carry those tools' outputs, in order.
 */
export function antigravityItems(raw, state = { pending: [] }) {
  if (!raw || typeof raw !== 'object') return [];
  const at = Date.parse(raw.created_at) || null;
  const uid = `agy-${raw.step_index}`;
  if (raw.type === 'USER_INPUT') {
    const text = agyUserText(raw.content);
    return text ? [{ uid, kind: 'user', at, text: clip(text, MAX_TEXT) }] : [];
  }
  if (raw.source === 'SYSTEM') {
    return raw.type === 'ERROR_MESSAGE' && raw.error ? [{ uid, kind: 'assistant', at, text: clip(`Error: ${raw.error}`, 2000) }] : [];
  }
  if (raw.type === 'PLANNER_RESPONSE') {
    const items = [];
    const text = String(raw.content ?? '').trim();
    if (text) items.push({ uid: `${uid}:text`, kind: 'assistant', at, text: clip(text, MAX_TEXT) });
    (raw.tool_calls ?? []).forEach((t, i) => {
      const toolId = `${uid}:${i}`;
      const { summary, input } = agyInput(t.name, t.args);
      items.push({ uid: `${uid}:tool${i}`, kind: 'tool', at, toolId, name: AGY_TOOLS[t.name] ?? t.name, summary, input });
      state.pending.push(toolId);
    });
    return items;
  }
  if (raw.source === 'MODEL') {
    // a tool's output: pairs with the oldest call still waiting
    const toolId = state.pending.shift();
    if (!toolId) return [];
    const text = agyResultText(raw.content);
    return [{ uid, kind: 'result', at, toolId, isError: raw.status === 'ERROR' || Boolean(raw.error), text: clip(text || String(raw.error ?? ''), MAX_RESULT) }];
  }
  return [];
}

/**
 * Live, read-only view of external Claude Code, Codex and Antigravity conversations. Opt-in (Settings › Agents ›
 * live transcript): this is the only place FlintBench reads conversation content.
 * One follower per session, shared by every attached viewer; nothing is persisted.
 */
export class TranscriptService {
  constructor({ agents, host, settings, log = console }) {
    this.agents = agents;
    this.host = host;
    this.settings = settings;
    this.log = log;
    this.followers = new Map(); // FlintBench session id -> follower
    settings.on('changed', (s) => {
      if (s.agents.readTranscripts) return;
      for (const f of [...this.followers.values()]) {
        for (const fn of f.listeners) fn({ disabled: true });
        this.#close(f);
      }
    });
  }

  enabled() {
    return Boolean(this.settings.get().agents.readTranscripts);
  }

  /** Attach a viewer. listener({ items, reset } | { disabled }). Returns detach(), or null when disabled. */
  subscribe(id, listener) {
    if (!this.enabled()) {
      listener({ disabled: true });
      return null;
    }
    const target = this.agents.transcriptSessionOf(id);
    if (!target) throw httpError(404, 'No agent session with a readable conversation');
    let f = this.followers.get(id);
    if (!f) {
      f = { id, agent: target.agent, parse: { items: false, pending: [] }, agentSessionId: target.agentSessionId, file: null, offset: 0, items: [], listeners: new Set(), watcher: null, timer: null, idleTimer: null, ready: false, reading: false, again: false };
      this.followers.set(id, f);
      f.timer = setInterval(() => this.#read(f), POLL_MS);
      f.timer.unref?.();
      this.#read(f);
    }
    clearTimeout(f.idleTimer);
    f.listeners.add(listener);
    if (f.ready) listener({ items: f.items, reset: true });
    return () => {
      f.listeners.delete(listener);
      if (f.closed || f.listeners.size) return;
      clearTimeout(f.idleTimer);
      f.idleTimer = setTimeout(() => this.#close(f), IDLE_CLOSE_MS);
      f.idleTimer.unref?.();
    };
  }

  #close(f) {
    f.closed = true;
    clearInterval(f.timer);
    clearTimeout(f.idleTimer);
    f.watcher?.close();
    f.listeners.clear();
    if (this.followers.get(f.id) === f) this.followers.delete(f.id);
  }

  async #read(f) {
    if (f.reading) {
      f.again = true;
      return;
    }
    f.reading = true;
    try {
      if (!f.file) {
        // a session opened without messages has no transcript yet; a Codex session seen first as a
        // process learns its file name only once the first message is written, so ask again
        const target = this.agents.transcriptSessionOf(f.id);
        if (target) f.agentSessionId = target.agentSessionId;
        const finder = { codex: 'findCodexTranscript', antigravity: 'findAntigravityTranscript' }[f.agent] ?? 'findClaudeTranscript';
        f.file = await this.host.agentFiles[finder](f.agentSessionId);
        if (!f.file) {
          if (!f.ready) {
            f.ready = true;
            for (const fn of f.listeners) fn({ items: [], reset: true });
          }
          return;
        }
        f.watcher = this.host.watch.file(f.file, () => this.#read(f));
      }
      const chunk = await this.host.agentFiles.readJsonlFrom(f.file, f.offset);
      if (!chunk) return;
      const reset = chunk.reset || !f.ready;
      f.offset = chunk.offset;
      const items = [];
      for (const line of chunk.lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          items.push(...(f.agent === 'codex' ? codexItems(raw, f.parse) : f.agent === 'antigravity' ? antigravityItems(raw, f.parse) : claudeItems(raw)));
        } catch {
          // torn or foreign line: skip
        }
      }
      if (reset) f.items = [];
      f.items.push(...items);
      if (f.items.length > KEEP_ITEMS) f.items.splice(0, f.items.length - KEEP_ITEMS);
      if (!reset && !items.length) return;
      f.ready = true;
      for (const fn of f.listeners) fn(reset ? { items: f.items, reset: true } : { items });
    } catch (error) {
      this.log.warn(`[transcript] ${error.message}`);
    } finally {
      f.reading = false;
      if (f.again) {
        f.again = false;
        this.#read(f);
      }
    }
  }
}
