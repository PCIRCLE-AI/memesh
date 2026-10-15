// The session handoff: the agent's own last words, kept per project so the
// next session starts from where this one stopped.
//
// A leaf on purpose: the Stop hook that writes the handoff and the
// SessionStart hook that shows it cannot import src/, so this file is mirrored
// to scripts/hooks/_generated/ (scripts/generate-hook-core.mjs). Its one import
// is another mirrored leaf. Everything here is pure; the hooks and core own
// the reads, the write and the record.

import { parseSqliteUtcMs } from './time-utils.js';
import { redactMemoryText } from './paths.js';

export const SESSION_HANDOFF_TYPE = 'session-handoff';

/** Older than this, the handoff is shown with a warning that it may be out of date. */
export const HANDOFF_STALE_HOURS = 72;

/** Older than this, the handoff is not shown at all. */
export const HANDOFF_MAX_AGE_DAYS = 14;

/** A timestamp this far in the future is clock skew; beyond it, the age is unknown. */
export const HANDOFF_FUTURE_SKEW_MINUTES = 5;

/** Most characters kept, the leading ellipsis included. The tail of a final message is where "next" lives. */
export const HANDOFF_MAX_CHARS = 800;

/** Fewer characters than this is an acknowledgement, not a handoff. */
export const HANDOFF_MIN_CHARS = 80;

/** Transcript bytes read from the end when the Stop payload has no message. */
export const HANDOFF_TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** One entity per project: each Stop replaces it. */
export function sessionHandoffName(project: string): string {
  return `${SESSION_HANDOFF_TYPE}:${project}`;
}

interface TranscriptLine {
  type?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  message?: { model?: unknown; content?: unknown };
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Drop fenced code, one line at a time so the cost stays linear whatever the
 * input. A fence opens on a line that STARTS (at any indent — list items nest
 * them) with ``` or ~~~, and closes on the next line that starts with at
 * least as many of the same character; an unclosed fence runs to the end.
 * A ``` in the middle of a sentence, or a backtick line that closes itself
 * (```x```), is prose about code, not a fence.
 */
function stripFences(text: string): string {
  const kept: string[] = [];
  let open: { char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    const m = FENCE_LINE.exec(line);
    if (open) {
      if (m && m[1][0] === open.char && m[1].length >= open.len) open = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = { char: m[1][0], len: m[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The text worth keeping from an assistant message: prose only (fenced code is
 * dropped — it is what the diff and the repo already hold), blank runs
 * collapsed, and if it is longer than HANDOFF_MAX_CHARS the END is kept behind
 * a `…`, cut at a line break where one is near. Never longer than
 * HANDOFF_MAX_CHARS. Returns '' when there is nothing left.
 *
 * Redact BEFORE calling: a secret cut in half at the boundary no longer
 * matches the pattern that would have caught it.
 */
export function cleanHandoffText(raw: string): string {
  let text = stripFences(String(raw ?? '').replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= HANDOFF_MAX_CHARS) return text;

  text = text.slice(-(HANDOFF_MAX_CHARS - 1));
  // Never start on half of a surrogate pair.
  const first = text.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) text = text.slice(1);
  const newline = text.indexOf('\n');
  if (newline >= 0 && newline < HANDOFF_MAX_CHARS / 3) text = text.slice(newline + 1);
  return `…${text.trim()}`;
}

/**
 * The text of the newest real assistant message in a JSONL transcript tail,
 * or null. Claude Code writes each content block of a message as its own
 * `assistant` line, and most of them are tool calls — so this walks backwards
 * to the newest line that carries text. Skipped: sub-agent (`isSidechain`)
 * lines, and the synthetic lines Claude Code writes for API errors
 * (`isApiErrorMessage`, model `<synthetic>`), which are not the agent's words.
 * A torn line (the tail window starts mid-line) is not evidence either way.
 */
export function lastAssistantText(jsonl: string): string | null {
  const lines = String(jsonl ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: TranscriptLine | null;
    try { entry = JSON.parse(line) as TranscriptLine | null; } catch { continue; }
    if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
    if (entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>') continue;
    const content = entry.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
        : '';
    if (text.trim()) return text;
  }
  return null;
}

/** Text that replaces what the agent quoted from another agent's message (#469). */
export const AGENT_TEXT_OMITTED = '[text from an agent message omitted]';
/** A run of at least this many characters copied verbatim from an agent message is a quotation; a few shared words are not. */
export const AGENT_QUOTE_MIN_CHARS = 24;

const CHANNEL_OPEN = '<channel source="memesh-channel"';
/** How far an opening tag may run before its `>`. */
const CHANNEL_TAG_MAX_CHARS = 512;
/**
 * How far one channel body is scanned. A Channels delivery cannot exceed
 * AGENT_NATIVE_MESSAGE_MAX_BYTES (core/agent-messaging.ts, 16 KiB, at least as
 * many bytes as characters); the extra 1 KiB is slack. Bounding every scan is
 * what keeps a hostile transcript from making the Stop hook quadratic.
 */
export const CHANNEL_SCAN_MAX_CHARS = 17 * 1024;

/**
 * The end (exclusive) of the JSON object or array that starts at `i` after
 * optional whitespace, or -1 — matched by brackets outside strings, so a
 * `</channel>` inside the payload does not end it. Never scans past
 * CHANNEL_SCAN_MAX_CHARS.
 */
function jsonValueEnd(s: string, i: number): number {
  while (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t') i++;
  if (s[i] !== '{' && s[i] !== '[') return -1;
  let depth = 0;
  let inString = false;
  for (let j = i, stop = Math.min(s.length, i + CHANNEL_SCAN_MAX_CHARS); j < stop; j++) {
    const c = s[j];
    if (inString) { if (c === '\\') j++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return j + 1;
  }
  return -1;
}

/** An agent-message envelope: the shape of a Channels delivery and of a `message` fetch result. */
function isEnvelope(o: Record<string, unknown>): boolean {
  return typeof o.message_id === 'string' && typeof o.sender === 'string' && o.payload !== undefined && o.payload !== null;
}

/** Every text an envelope payload carries: itself when a string; for an object or array, its compact JSON and every string inside it. */
function payloadTexts(payload: unknown, out: Set<string>, depth = 0): void {
  if (depth > 12 || payload === null || payload === undefined) return;
  if (typeof payload === 'string') { out.add(payload); return; }
  if (depth === 0) out.add(JSON.stringify(payload));
  if (Array.isArray(payload)) { for (const v of payload) payloadTexts(v, out, depth + 1); return; }
  if (typeof payload === 'object') for (const v of Object.values(payload as Record<string, unknown>)) payloadTexts(v, out, depth + 1);
}

/**
 * The texts of every agent message visible in a transcript tail: the payload
 * of a message delivered through Claude Channels (a `<channel
 * source="memesh-channel">` tag carrying the envelope JSON) and of one
 * returned by the `message` tool (an envelope inside a tool result's JSON).
 * The walk is generic, so it does not depend on where a host puts tool
 * results. A channel body is the JSON value right after the tag, found by
 * bracket matching outside strings — so a payload that itself contains
 * `</channel>` is still read — and every scan is bounded, so a hostile
 * transcript cannot make the Stop hook slow. `unreadTags` counts channel tags
 * whose body could not be read.
 */
export function agentMessageTexts(jsonl: string): { texts: string[]; unreadTags: number } {
  const found = new Set<string>();
  let unreadTags = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (let from = value.indexOf(CHANNEL_OPEN); from >= 0; from = value.indexOf(CHANNEL_OPEN, from + 1)) {
        const gt = value.slice(from, from + CHANNEL_TAG_MAX_CHARS).indexOf('>');
        const end = gt < 0 ? -1 : jsonValueEnd(value, from + gt + 1);
        let body: unknown;
        try { body = end < 0 ? undefined : JSON.parse(value.slice(from + gt + 1, end)); } catch { body = undefined; }
        if (body === undefined) { unreadTags++; continue; }
        walk(body, depth + 1);
        from = end - 1;
      }
      const t = value.trim();
      if ((t.startsWith('{') || t.startsWith('[')) && t.includes('"payload"')) {
        try { walk(JSON.parse(t), depth + 1); } catch { /* text that only looks like JSON */ }
      }
      return;
    }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    if (typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (isEnvelope(o)) payloadTexts(o.payload, found);
      for (const v of Object.values(o)) walk(v, depth + 1);
    }
  };
  for (const raw of String(jsonl ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || (!line.includes('payload') && !line.includes('memesh-channel'))) continue;
    try { walk(JSON.parse(line), 0); } catch { /* a torn line */ }
  }
  return { texts: [...found], unreadTags };
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** Whitespace, or CJK punctuation, kana, ideographs, Hangul or fullwidth forms. */
const PROSE = /[\s\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/**
 * Replace, in `text`, every run of characters it copies verbatim from one of
 * `payloads` (#469: a handoff must not carry another agent's words into the
 * next session). A position is covered when a window of
 * AGENT_QUOTE_MIN_CHARS characters starting there also occurs in a payload;
 * each maximal covered run that reads as prose (it has a space or CJK text)
 * becomes one AGENT_TEXT_OMITTED, and `omitted` counts the runs. A run
 * without either — a shared path, URL, branch or file name — is kept. It needs no sentence ends, spaces or JSON layout, so a
 * quote that drops its final period, a partial quote and CJK text are all
 * caught. Not caught: paraphrases, reflowed whitespace, overlaps shorter than
 * AGENT_QUOTE_MIN_CHARS.
 */
export function omitAgentMessageText(text: string, payloads: readonly string[]): { text: string; omitted: number } {
  const src = String(text ?? '');
  const n = AGENT_QUOTE_MIN_CHARS;
  const windows = new Set<string>();
  for (const p of payloads) {
    const s = String(p);
    for (let i = 0; i + n <= s.length; i++) windows.add(s.slice(i, i + n));
  }
  if (windows.size === 0 || src.length < n) return { text: src, omitted: 0 };
  const covered = new Uint8Array(src.length);
  for (let i = 0; i + n <= src.length; i++) if (windows.has(src.slice(i, i + n))) covered.fill(1, i, i + n);
  let out = '';
  let omitted = 0;
  for (let i = 0; i < src.length;) {
    if (!covered[i]) { out += src[i]; i++; continue; }
    const runStart = i;
    while (i < src.length && covered[i]) i++;
    let start = runStart;
    let end = i;
    // Whole characters only: never leave half of a surrogate pair behind.
    if (start > 0 && isLowSurrogate(src.charCodeAt(start)) && isHighSurrogate(src.charCodeAt(start - 1))) start++;
    if (end < src.length && isLowSurrogate(src.charCodeAt(end)) && isHighSurrogate(src.charCodeAt(end - 1))) end--;
    const run = src.slice(start, end);
    // Prose only: a quotation has spaces or CJK text. A run without either is
    // a path, URL, branch or file name the agent shares with the message, and
    // stays — that is the agent's own working state, not another agent's words.
    if (run.length >= n && PROSE.test(run.trim())) {
      out += src.slice(runStart, start) + AGENT_TEXT_OMITTED + src.slice(end, i);
      omitted++;
    } else {
      out += src.slice(runStart, i);
    }
  }
  return { text: out, omitted };
}

export interface HandoffRecord {
  /** Entity id — the citation handle. */
  id: number;
  /** The stored text: the handoff entity's newest observation. */
  text: string;
  /** That observation's `created_at` (SQLite UTC). The entity's own
   *  `created_at` is the FIRST Stop's and never moves, so it cannot say how
   *  old the text is. */
  observedAt: string | null | undefined;
  /** Source metadata, when available; legacy records may have none. */
  metadata?: string | null;
}

function ageText(hours: number): string {
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) {
    const h = Math.floor(hours);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(hours / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Why a handoff is, or is not, shown. Everything but `shown`/`stale` hides it. */
export type HandoffStatus = 'shown' | 'stale' | 'expired' | 'undatable' | 'future' | 'empty';

/**
 * The lines that lead a new session's context — where the last session in this
 * project left off, and how long ago — plus the reason when there are none.
 * The ONE renderer both the SessionStart hook and the `briefing` tool/CLI
 * call, so they cannot disagree.
 *
 * The text goes through cleanHandoffText again, whoever wrote it: the Stop
 * hook bounds what it stores, but a handoff written through `remember` is not
 * bounded, and an unbounded one would take the whole block's budget.
 *
 * Hidden when there is nothing honest to show: no text, an age that cannot be
 * read, a timestamp more than HANDOFF_FUTURE_SKEW_MINUTES in the future, or a
 * handoff older than HANDOFF_MAX_AGE_DAYS. Past HANDOFF_STALE_HOURS the header
 * says it may be out of date. The header ends in `[mem:<id>]` so a session
 * that uses it can cite it like any other memory.
 */
export function handoffView(
  record: HandoffRecord | null | undefined,
  now: Date = new Date(),
): { lines: string[]; status: HandoffStatus } {
  // #523: redacted on DISPLAY as well as at capture. The Stop hook stores a
  // new handoff redacted, but one stored before that keeps its text for up
  // to 14 days, and this is the one view both the briefing and the
  // SessionStart hook render through. Redaction runs on the WHOLE stored
  // text before `cleanHandoffText` keeps only the last 800 characters, so
  // the cut cannot expose a fragment of a credential.
  const text = record ? cleanHandoffText(redactMemoryText(record.text ?? '')) : '';
  if (!record || !text) return { lines: [], status: 'empty' };
  const then = typeof record.observedAt === 'string' ? parseSqliteUtcMs(record.observedAt) : null;
  if (then === null) return { lines: [], status: 'undatable' };
  const hours = (now.getTime() - then) / 3_600_000;
  if (hours < -HANDOFF_FUTURE_SKEW_MINUTES / 60) return { lines: [], status: 'future' };
  const age = Math.max(0, hours);
  if (age > HANDOFF_MAX_AGE_DAYS * 24) return { lines: [], status: 'expired' };
  const stale = age > HANDOFF_STALE_HOURS;
  const when = stale
    ? `${ageText(age)} — may be out of date; check it against the repository`
    : ageText(age);
  let source = '';
  try {
    const host = JSON.parse(record.metadata ?? 'null')?.provenance?.source_host;
    if (host === 'codex' || host === 'claude-code') source = `; source: ${host}`;
  } catch { /* Legacy or malformed metadata gives no reliable source. */ }
  return {
    lines: [`Where the last session left off (${when}${source}): [mem:${record.id}]`, ...text.split('\n')],
    status: stale ? 'stale' : 'shown',
  };
}

export function handoffLines(record: HandoffRecord | null | undefined, now: Date = new Date()): string[] {
  return handoffView(record, now).lines;
}
