// The session handoff: the agent's own last words, kept per project so the
// next session starts from where this one stopped.
//
// A leaf (no imports) on purpose: the Stop hook that writes the handoff cannot
// import src/, so this file is mirrored to scripts/hooks/_generated/
// (scripts/generate-hook-core.mjs). Everything here is pure; the hook owns the
// reads, the write and the record.

export const SESSION_HANDOFF_TYPE = 'session-handoff';

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

// A fence is a line that OPENS with ``` (up to three spaces in) and has no
// backtick after it. A ``` in the middle of a sentence is prose about
// backticks, not a fence, and must not swallow what follows it.
const FENCED_BLOCK = /^ {0,3}```[^`\n]*\n[\s\S]*?^ {0,3}```[ \t]*$/gm;
const UNCLOSED_FENCE = /^ {0,3}```[^`\n]*(?:\n[\s\S]*)?$/m;

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
  let text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(FENCED_BLOCK, '')
    .replace(UNCLOSED_FENCE, '')
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
