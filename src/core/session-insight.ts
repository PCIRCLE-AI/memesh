// session-insight — the Stop hook's extraction rules, for hosts that hand
// memesh a chat message list instead of a Claude Code JSONL transcript.
//
// The Claude Code Stop hook (scripts/hooks/session-summary.js) turns a
// session into at most three `session-insight` entities: `-files` (what was
// edited), `-fixes` (errors met while editing) and `-summary` (a heavy
// session's commands). Hermes Agent used to archive its raw message list
// instead — a transcript dump, the high-volume/low-signal shape "memory is
// not status" argued against. This module lets a chat-format host produce
// the SAME three entities under the SAME rules and thresholds.
//
// The rules (`buildSessionInsights`) are host-neutral: they take counted
// activity, not a transcript. Only the parser (`activityFromChatMessages`) is
// format-specific. Two older copies of the same rules still exist: the Stop
// hook's own (scripts/hooks/session-summary.js) and `RuleBasedExtractor` in
// ./extractor.ts (no titles, no file tags, no Bash-edit paths; referenced
// only by its tests). Both should call this module so there is one copy;
// until then the thresholds below are the ones to keep in step.
//
// #322 diverged the Stop hook's write mode from this one's: it now REPLACES
// its three entities on every Stop (a session-insight is a snapshot; Stop
// fires every turn, so appending kept restating the same sentences), while
// `captureChatSession` below still APPENDS. See its own doc comment for why
// that split is intentional, not an oversight left behind by #322.

import { redactSecrets } from './paths.js';
import { truncateTitle } from './title.js';
import { remember } from './operations.js';

/** Fewer tool calls than this is a quiet session — same guard as the Stop hook. */
export const MIN_TOOL_CALLS = 3;
/** Tool calls at or above this make a session "significant" (Rule 3). */
export const HEAVY_SESSION_TOOL_CALLS = 20;

export interface SessionActivity {
  /** Basenames, deduplicated. */
  filesEdited: string[];
  /** Redacted, then truncated to 100 chars. */
  bashCommands: string[];
  /** Redacted, then truncated to 200 chars. */
  errorsEncountered: string[];
  toolCallCount: number;
  /**
   * Tool names that were called but that the parser has no rule for. They
   * still count toward `toolCallCount`; they are listed so a host whose tool
   * names drifted shows up as "N unrecognised", not as a session that
   * silently edited nothing.
   */
  unrecognizedTools: string[];
  /**
   * Tool results that were not a JSON object, so the error rule could not
   * read them. [ASSUMPTION] Hermes returns tool results as JSON; if a host
   * returns plain text, errors are never counted and `-fixes` is never
   * written. This count is what makes that blind spot visible instead of
   * reading as "no errors".
   */
  toolResultsNonJson: number;
}

export interface InsightEntity {
  name: string;
  type: 'session-insight';
  title: string;
  observations: string[];
  tags: string[];
}

/**
 * File paths a shell command writes in place: heredoc redirection, `cat >`,
 * `tee`, `sed -i`, pathlib `write_text`, `fs.writeFileSync`. Mirrors the Stop
 * hook's recogniser; anything unmatched is simply uncounted.
 */
export function bashEditedPaths(cmd: unknown): string[] {
  if (typeof cmd !== 'string') return [];
  const found = new Set<string>();
  for (const re of [
    /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/g,
    /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/g,
    /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/g,
    /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/g,
    /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/g,
    /writeFileSync\(\s*['"]([^'"]+)['"]/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
      if (m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/')) found.add(m[1]);
    }
  }
  return [...found];
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Hermes Agent's tool names, as its OpenAI-format `tool_calls` carry them.
// [ASSUMPTION] taken from Hermes's tool registry naming (`write_file`,
// `patch`, `terminal`), not from a captured session. Claude-style names are
// accepted too so a host that forwards those is not misread. A name outside
// both sets lands in `unrecognizedTools`.
const FILE_WRITE_TOOLS = new Set(['write_file', 'patch', 'edit_file', 'Write', 'Edit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['terminal', 'shell', 'bash', 'Bash']);
const KNOWN_READ_ONLY_TOOLS = new Set([
  'read_file', 'search_files', 'list_files', 'web_search', 'web_extract', 'Read', 'Grep', 'Glob',
  'memesh_recall', 'memesh_remember', 'memesh_forget', 'memory', 'todo',
]);

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    // Truncated or non-JSON arguments: the call still counts, its paths do not.
    return {};
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text : ''))
      .join(' ');
  }
  return '';
}

/**
 * A tool result is an error when its JSON body says so explicitly: a
 * non-empty `error`, `success: false`, or a non-zero numeric `exit_code`.
 * Same principle as the Stop hook's `is_error` flag — an explicit signal, not
 * a substring match on the word "Error" (which counted READMEs as failures).
 * Non-JSON results are never counted as errors.
 */
function toolResultError(content: unknown): string | null | 'unreadable' {
  const text = contentText(content);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return 'unreadable'; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unreadable';
  const b = body as Record<string, unknown>;
  const failed = (typeof b.error === 'string' && b.error.trim() !== '')
    || b.success === false
    || (typeof b.exit_code === 'number' && b.exit_code !== 0);
  if (!failed) return null;
  const detail = typeof b.error === 'string' && b.error.trim() !== '' ? b.error : text;
  return detail;
}

/**
 * Count a chat-format (OpenAI `tool_calls` / `role: "tool"`) message list
 * into the activity the insight rules consume. Never throws on malformed
 * entries — each is skipped on its own.
 */
export function activityFromChatMessages(messages: unknown): SessionActivity {
  const filesEdited = new Set<string>();
  const bashCommands: string[] = [];
  const errorsEncountered: string[] = [];
  const unrecognized = new Set<string>();
  let toolCallCount = 0;
  let toolResultsNonJson = 0;

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const fn = call && typeof call === 'object' ? (call as { function?: unknown }).function : undefined;
        const name = fn && typeof fn === 'object' ? (fn as { name?: unknown }).name : undefined;
        if (typeof name !== 'string' || name === '') continue;
        toolCallCount++;
        const args = parseArgs((fn as { arguments?: unknown }).arguments);
        if (FILE_WRITE_TOOLS.has(name)) {
          const fp = args.path ?? args.file_path;
          if (typeof fp === 'string' && fp) filesEdited.add(basename(fp));
        } else if (SHELL_TOOLS.has(name)) {
          const cmd = args.command;
          for (const fp of bashEditedPaths(cmd)) filesEdited.add(basename(fp));
          if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
            // Redact BEFORE truncating, as the Stop hook does: truncation can
            // cut a token in half and leave the fragment unmatched.
            bashCommands.push(redactSecrets(cmd).slice(0, 100));
          }
        } else if (!KNOWN_READ_ONLY_TOOLS.has(name)) {
          unrecognized.add(name);
        }
      }
    } else if (m.role === 'tool') {
      const err = toolResultError(m.content);
      if (err === 'unreadable') toolResultsNonJson++;
      else if (err !== null) errorsEncountered.push(redactSecrets(err).slice(0, 200));
    }
  }

  return {
    filesEdited: [...filesEdited],
    bashCommands,
    errorsEncountered,
    toolCallCount,
    unrecognizedTools: [...unrecognized],
    toolResultsNonJson,
  };
}

function fileTagsFor(files: string[]): string[] {
  const tags = new Set<string>();
  for (const f of files) {
    if (!f) continue;
    tags.add(`file:${f}`);
    const noExt = f.replace(/\.[^.]+$/, '');
    if (noExt && noExt !== f) tags.add(`file:${noExt}`);
  }
  return [...tags];
}

export interface InsightContext {
  sessionId: string;
  /**
   * Tags every entity carries besides `session:<id>`. The Claude Code hooks
   * add `source:auto-capture` here; the Hermes path deliberately does not,
   * because `memesh doctor` reads that tag as evidence about the Claude Code
   * hook loop, and a Hermes-only machine would get a wrong liveness verdict.
   * Hermes captures are identified by `platform:hermes` and
   * `metadata.provenance.source_host`.
   */
  baseTags: string[];
  /** Label after the date in each title — the project, or the host when there is none. */
  titleLabel: string;
  /** ISO date (YYYY-MM-DD) for titles; defaults to today. */
  date?: string;
}

/**
 * The three Stop-hook rules. Returns an empty list for a quiet session
 * (fewer than MIN_TOOL_CALLS tool calls).
 */
export function buildSessionInsights(activity: SessionActivity, ctx: InsightContext): InsightEntity[] {
  if (activity.toolCallCount < MIN_TOOL_CALLS) return [];
  const { filesEdited, errorsEncountered, bashCommands, toolCallCount } = activity;
  const baseTags = [`session:${ctx.sessionId}`, ...ctx.baseTags];
  const titlePrefix = `${ctx.date ?? new Date().toISOString().slice(0, 10)} ${ctx.titleLabel}`;
  const out: InsightEntity[] = [];

  if (filesEdited.length > 0) {
    out.push({
      name: `session-${ctx.sessionId}-files`,
      type: 'session-insight',
      title: truncateTitle(`${titlePrefix}: edited ${filesEdited.length} file(s)`),
      observations: [
        `Session edited ${filesEdited.length} file(s): ${filesEdited.join(', ')}`,
        `Total tool calls: ${toolCallCount}`,
      ],
      tags: [...baseTags, ...fileTagsFor(filesEdited)],
    });
  }

  if (errorsEncountered.length > 0 && filesEdited.length > 0) {
    out.push({
      name: `session-${ctx.sessionId}-fixes`,
      type: 'session-insight',
      title: truncateTitle(`${titlePrefix}: fixed ${errorsEncountered.length} error(s)`),
      observations: [
        `Fixed ${errorsEncountered.length} error(s) by editing ${filesEdited.join(', ')}`,
        ...errorsEncountered.slice(0, 3).map((e) => `Error: ${e.slice(0, 100)}`),
      ],
      tags: [...baseTags, 'type:bugfix', ...fileTagsFor(filesEdited)],
    });
  }

  if (toolCallCount >= HEAVY_SESSION_TOOL_CALLS) {
    out.push({
      name: `session-${ctx.sessionId}-summary`,
      type: 'session-insight',
      title: truncateTitle(`${titlePrefix}: significant session (${toolCallCount} tool calls)`),
      observations: [
        `Significant session: ${toolCallCount} tool calls, ${filesEdited.length} files edited`,
        ...bashCommands.slice(0, 3).map((c) => `Command: ${c}`),
      ],
      tags: [...baseTags, 'type:heavy-session'],
    });
  }

  return out;
}

export interface ChatSessionCaptureResult {
  outcome: 'wrote' | 'skipped';
  reason?: string;
  written: string[];
  toolCallCount: number;
  filesEdited: number;
  errorsEncountered: number;
  unrecognizedTools: string[];
  toolResultsNonJson: number;
}

/**
 * Parse a chat-format message list and store its insight entities, stamped
 * with `sourceHost`. Re-capturing the same session appends rather than
 * replacing (contrast the Stop hook, which replaces — see #322 in the
 * module comment above): in a chat host the later boundary (session end
 * after a compression) carries genuinely new content, and `createEntity`
 * already refuses to store an identical observation twice on one entity, so
 * appending here never restates a sentence that is already on the entity.
 */
export function captureChatSession(input: {
  sessionId: string;
  messages: unknown;
  sourceHost: string;
  baseTags: string[];
  titleLabel: string;
}): ChatSessionCaptureResult {
  const activity = activityFromChatMessages(input.messages);
  const counts = {
    toolCallCount: activity.toolCallCount,
    filesEdited: activity.filesEdited.length,
    errorsEncountered: activity.errorsEncountered.length,
    unrecognizedTools: activity.unrecognizedTools,
    toolResultsNonJson: activity.toolResultsNonJson,
  };
  const entities = buildSessionInsights(activity, {
    sessionId: input.sessionId,
    baseTags: input.baseTags,
    titleLabel: input.titleLabel,
  });
  if (entities.length === 0) {
    const reason = activity.toolCallCount < MIN_TOOL_CALLS
      ? `too little activity to be worth saving (${activity.toolCallCount} tool call(s))`
      : `no rule matched (no edited file and fewer than ${HEAVY_SESSION_TOOL_CALLS} tool calls)`;
    return { outcome: 'skipped', reason, written: [], ...counts };
  }
  for (const e of entities) {
    remember({ ...e, sourceHost: input.sourceHost });
  }
  return { outcome: 'wrote', written: entities.map((e) => e.name), ...counts };
}
