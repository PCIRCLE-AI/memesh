// =============================================================================
// note-derive — turn free text into the shape `remember` stores (#324)
// =============================================================================
//
// Writing a memory used to cost a name, a type, a title and an observation
// array; writing a note costs the text. This module is the difference: given
// the text, it derives the rest, deterministically, so the same text always
// lands on the same entity and a different text never collides with it.
//
// Two callers, one rule: `remember({ note })` (operations.ts, validated by
// RememberSchema in transports/schemas.ts) and note-file ingestion
// (note-ingest.ts). Kept apart from both so neither imports the other.
//
// Hygiene is not optional here. Free text is the one write path where a caller
// can paste anything — a terminal scrollback with a token in it, a file with
// control characters — so the text is cleaned BEFORE anything is derived from
// it, and the derived name hashes the cleaned text (the thing actually stored).

import { createHash } from 'crypto';
import { redactSecrets } from './paths.js';
import { truncateTitle, TITLE_MAX_LENGTH } from './title.js';

/** Same per-observation cap RememberSchema enforces on structured calls. */
export const NOTE_OBSERVATION_MAX_CHARS = 10_000;
/** Same observation-count cap RememberSchema enforces on structured calls. */
export const NOTE_MAX_OBSERVATIONS = 100;
/** Longest note text `remember({ note })` accepts. */
export const NOTE_MAX_CHARS = 20_000;
/** The type a note gets when the caller names none. */
export const NOTE_DEFAULT_TYPE = 'note';

export interface DerivedNote {
  /** The cleaned text every other field was derived from. */
  text: string;
  title: string;
  observations: string[];
  /** slug(title) + '-' + 8 hex chars of sha256(text). */
  name: string;
}

/**
 * Remove what must never be stored: control characters (keeping newline and
 * tab, which carry the paragraph structure) and credential-shaped substrings.
 * Redaction runs on the whole text, before splitting, so a token that spans a
 * line break cannot slip through as two harmless halves.
 */
export function sanitizeNoteText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const stripped = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return redactSecrets(stripped).trim();
}

/** Strip a leading markdown heading or list marker from a line. */
function stripLineMarker(line: string): string {
  return line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

/**
 * Paragraphs → observations. A blank line separates paragraphs; inside one,
 * lines are joined with a space, except that a paragraph made entirely of
 * list items yields one observation per item (a list is several facts, not
 * one sentence). Oversized paragraphs are truncated to the per-observation
 * cap: this is the generator side of the contract, where there is nobody to
 * bounce the input back to (ingested files); `remember({ note })` checks the
 * same limits in its schema and rejects instead.
 */
export function splitObservations(body: string): string[] {
  const out: string[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const isList = lines.every((l) => /^(?:[-*+]\s+|\d+[.)]\s+)/.test(l));
    const parts = isList ? lines.map(stripLineMarker) : [lines.join(' ')];
    for (const part of parts) {
      const text = part.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push(text.length > NOTE_OBSERVATION_MAX_CHARS
        ? `${text.slice(0, NOTE_OBSERVATION_MAX_CHARS - 1).trimEnd()}…`
        : text);
    }
  }
  return out;
}

/** Lowercase ASCII slug; empty when the title has no ASCII letters or digits. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * Derive title, observations and name from note text.
 *
 * - title: the first non-empty line, minus a heading/list marker. When that
 *   line is longer than the title cap, its first sentence is used instead,
 *   and the title is truncated to the cap either way.
 * - observations: the remaining paragraphs, one each. When the first line did
 *   not fit in the title verbatim — or it is the whole note — it is kept as
 *   the first observation too, so no text the caller wrote is lost.
 * - name: `slug(title)-<sha256(text)[0..8]>`, so the same text is idempotent
 *   and different text gets a different entity. A title with no ASCII (a
 *   Chinese note, say) slugs to `note`.
 *
 * Returns null when nothing is left after cleaning.
 */
export function deriveNote(raw: string): DerivedNote | null {
  const text = sanitizeNoteText(raw);
  if (!text) return null;
  const lines = text.split('\n');
  const firstIndex = lines.findIndex((l) => l.trim().length > 0);
  const firstLine = stripLineMarker(lines[firstIndex]).replace(/\s+/g, ' ');
  const rest = lines.slice(firstIndex + 1).join('\n');

  let titleSource = firstLine;
  if (firstLine.length > TITLE_MAX_LENGTH) {
    const sentence = /^(.+?[.!?。！？])(?:\s|$)/.exec(firstLine);
    if (sentence) titleSource = sentence[1];
  }
  const title = truncateTitle(titleSource) || 'note';

  const body = splitObservations(rest);
  const observations = title === firstLine && body.length > 0
    ? body
    : [...splitObservations(firstLine), ...body];

  const digest = createHash('sha256').update(text).digest('hex').slice(0, 8);
  const name = `${slugify(title) || NOTE_DEFAULT_TYPE}-${digest}`;
  return { text, title, observations, name };
}
