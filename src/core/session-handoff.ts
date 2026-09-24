// The session handoff: the agent's own last words, kept per project so the
// next session starts from where this one stopped.
//
// A leaf on purpose: the Stop hook that writes the handoff and the
// SessionStart hook that shows it cannot import src/, so this file is mirrored
// to scripts/hooks/_generated/ (scripts/generate-hook-core.mjs). Its one import
// is another mirrored leaf. Everything here is pure; the hooks and core own
// the reads, the write and the record.

import { parseSqliteUtcMs } from './time-utils.js';

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

export interface HandoffRecord {
  /** Entity id — the citation handle. */
  id: number;
  /** The stored text: the handoff entity's newest observation. */
  text: string;
  /** That observation's `created_at` (SQLite UTC). The entity's own
   *  `created_at` is the FIRST Stop's and never moves, so it cannot say how
   *  old the text is. */
  observedAt: string | null | undefined;
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

/**
 * The lines that lead a new session's context: where the last session in this
 * project left off, and how long ago. The ONE renderer both the SessionStart
 * hook and the `briefing` tool/CLI call, so they cannot disagree.
 *
 * Returns [] when there is nothing honest to show: no text, an age that cannot
 * be read, a timestamp more than HANDOFF_FUTURE_SKEW_MINUTES in the future, or
 * a handoff older than HANDOFF_MAX_AGE_DAYS. Past HANDOFF_STALE_HOURS the
 * header says it may be out of date. The header ends in `[mem:<id>]` so a
 * session that uses it can cite it like any other memory.
 */
export function handoffLines(record: HandoffRecord | null | undefined, now: Date = new Date()): string[] {
  if (!record || !record.text || !record.text.trim()) return [];
  const then = typeof record.observedAt === 'string' ? parseSqliteUtcMs(record.observedAt) : null;
  if (then === null) return [];
  const hours = (now.getTime() - then) / 3_600_000;
  if (hours < -HANDOFF_FUTURE_SKEW_MINUTES / 60) return [];
  const age = Math.max(0, hours);
  if (age > HANDOFF_MAX_AGE_DAYS * 24) return [];
  const when = age > HANDOFF_STALE_HOURS
    ? `${ageText(age)} — may be out of date; check it against the repository`
    : ageText(age);
  return [`Where the last session left off (${when}): [mem:${record.id}]`, ...record.text.trim().split('\n')];
}
