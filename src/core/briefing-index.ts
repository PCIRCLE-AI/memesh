// =============================================================================
// briefing-index — one line per durable memory, so what is known is visible
// without having to know what to ask (#323)
// =============================================================================
//
// The ranked topology (work-topology.ts) answers "what is most relevant right
// now?" and has to guess. This answers "what do we already know here?" — a
// scannable list, newest first, hard-capped. The two ride together; neither
// replaces the other.
//
// A runtime leaf: it imports only other SOURCES leaves (paths.ts for
// redaction, work-topology.ts for the type constants and the trust gate), so
// scripts/generate-hook-core.mjs copies it next to the hooks. Like
// work-topology, it holds NO SQL — each consumer (the session-start hook, the
// core briefing) owns its own query with its own schema-compat rules. What
// must exist exactly once lives here: which types count, the order, the
// staleness line, the redaction, the caps and the phrasing.

import { redactSecrets, redactUserPaths } from './paths.js';
import { EVIDENCE_LAYER_TYPES, isAutoInjectable, topologyLine } from './work-topology.js';

// --- The budget contract ------------------------------------------------------
// Frozen numbers: #250 measures the index against them. Changing any of these
// is a CHANGELOG entry, not a tweak.

/** At most this many memory lines. */
export const INDEX_MAX_LINES = 40;
/** The whole section — heading, lines, trailers and footer — in UTF-8 bytes. */
export const INDEX_MAX_BYTES = 3072;
/** A memory not created or updated for this many days is counted, not listed. */
export const INDEX_STALE_DAYS = 180;
/** Per-line ceiling for the display text, in characters. */
export const INDEX_LINE_MAX_CHARS = 120;
/** How much of the first observation a consumer should fetch. Generous on
 *  purpose: redaction runs BEFORE the line is clipped, and a secret cut in
 *  half by a short fetch no longer matches its pattern. */
export const INDEX_SNIPPET_FETCH_CHARS = 4000;
/** Candidate window a consumer fetches (durable types only, newest first).
 *  A project with more durable memories than this reports its counts as a
 *  lower bound ("N+ more"), never as exact. */
export const INDEX_CANDIDATE_CAP = 2000;

/**
 * Types that never enter the index: the evidence layer (mechanical capture —
 * commits, session insights and summaries) plus `task-state`, which has its
 * own sole renderer at the top of the block. Derived from the constants, not
 * restated, so a new evidence type is excluded here the moment it is
 * classified there. Consumers bind this list into their SQL so a project
 * with thousands of commits cannot fill the candidate window.
 *
 * Everything else is durable — decisions, lessons, patterns, references,
 * notes — including a type invented later. That default is deliberate: an
 * index that silently drops an unfamiliar type is the failure it exists to
 * prevent.
 */
export const INDEX_EXCLUDED_TYPES: readonly string[] = [...EVIDENCE_LAYER_TYPES, 'task-state'];

export function isIndexableType(type: string | null | undefined): boolean {
  return !INDEX_EXCLUDED_TYPES.includes(type || 'memory');
}

export interface IndexCandidate {
  id: number;
  type: string | null;
  title?: string | null;
  /** First observation, fetched INDEX_SNIPPET_FETCH_CHARS long. */
  snippet?: string | null;
  /** SQLite UTC timestamp (`YYYY-MM-DD HH:MM:SS`) or ISO string: the later
   *  of the entity's creation and its newest observation. */
  lastActivity: string | null;
  /** Parsed metadata — the auto-injection gate reads it. */
  metadata?: unknown;
}

export interface BriefingIndex {
  /** The rendered section, whole lines, ready to sit inside the fence. */
  lines: string[];
  /** Memory lines rendered. */
  shown: number;
  /** Current memories cut by the caps. */
  more: number;
  /** Memories past INDEX_STALE_DAYS, collapsed into one line. */
  older: number;
  /** True when the counts are a lower bound (the candidate window was full). */
  truncated: boolean;
  /** UTF-8 bytes of the section above the footer. */
  bytes: number;
  /** Estimated tokens for those bytes (bytes / 4, rounded up). */
  tokens: number;
  /** Ids rendered, in order — the `[mem:id]` handles the section carries. */
  ids: number[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function sectionBytes(lines: readonly string[]): number {
  // Each line plus its newline — the same arithmetic the fence join produces.
  return lines.reduce((sum, line) => sum + byteLength(line) + 1, 0);
}

/** SQLite's CURRENT_TIMESTAMP has no zone marker but is UTC. */
function parseActivity(value: string | null): number {
  if (!value) return Number.NaN;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/** Newest activity first; id breaks ties so two independent queries agree. */
export function compareIndexCandidates(a: IndexCandidate, b: IndexCandidate): number {
  const at = parseActivity(a.lastActivity);
  const bt = parseActivity(b.lastActivity);
  const av = Number.isNaN(at) ? -Infinity : at;
  const bv = Number.isNaN(bt) ? -Infinity : bt;
  if (av !== bv) return bv - av;
  return b.id - a.id;
}

/** Secrets first, then paths — paths.ts documents why the order matters. */
function redact(text: string | null | undefined): string {
  if (!text) return '';
  return redactUserPaths(redactSecrets(String(text))).replace(/\s+/g, ' ').trim();
}

function indexLine(candidate: IndexCandidate): string {
  const title = redact(candidate.title);
  const snippet = redact(candidate.snippet);
  // Titles are usually derived from the first observation; printing both
  // would send the same sentence twice.
  const repeats = title && snippet && snippet.toLowerCase().startsWith(title.replace(/…$/, '').toLowerCase());
  const text = title && snippet && !repeats ? `${title} — ${snippet}` : (title || snippet);
  return topologyLine(
    { name: String(candidate.id), id: candidate.id, type: candidate.type || 'memory', title: text || null },
    INDEX_LINE_MAX_CHARS,
  );
}

export function indexHeading(projectName: string): string {
  return `Index of durable memories for "${projectName}" (newest first):`;
}

export function indexEmptyLine(projectName: string): string {
  return `- No durable memories (decisions, lessons, patterns, references) for "${projectName}" yet.`;
}

function moreLine(n: number, truncated: boolean, projectName: string): string {
  return `- ${n}${truncated ? '+' : ''} more — memesh recall --tag project:${projectName}`;
}

function olderLine(n: number, truncated: boolean): string {
  return `- ${n}${truncated ? '+' : ''} older memor${n === 1 ? 'y' : 'ies'} (no change in ${INDEX_STALE_DAYS} days) — recall to see`;
}

function footerLine(shown: number, bytes: number, tokens: number): string {
  return `(index cost: ${shown} line${shown === 1 ? '' : 's'}, ${bytes} bytes ≈ ${tokens} tokens; cap ${INDEX_MAX_LINES} lines / ${INDEX_MAX_BYTES} bytes)`;
}

/**
 * Build the index section.
 *
 * `candidates` is the consumer's window: project-scoped, active, non-global,
 * durable-typed rows. This applies the rest — the type exclusion again (so a
 * consumer that forgets it cannot leak evidence rows), the auto-injection
 * gate, the order, the staleness split, redaction and both caps — and always
 * returns a section: a project with nothing durable gets the empty-state
 * line, never silence.
 *
 * `now` is a parameter, never read from the clock inside: the 180-day
 * boundary is exactly the shape of fixture that goes red one hour a day.
 */
export function buildBriefingIndex(
  candidates: readonly IndexCandidate[],
  projectName: string,
  now: number,
  options: { truncated?: boolean } = {},
): BriefingIndex {
  const truncated = options.truncated === true;
  const cutoff = now - INDEX_STALE_DAYS * DAY_MS;
  const eligible = candidates
    .filter((c) => isIndexableType(c.type) && isAutoInjectable(c.metadata))
    .slice()
    .sort(compareIndexCandidates);
  const current: IndexCandidate[] = [];
  let older = 0;
  for (const c of eligible) {
    const at = parseActivity(c.lastActivity);
    // An unparseable timestamp is listed rather than hidden as "old".
    if (!Number.isNaN(at) && at < cutoff) older++;
    else current.push(c);
  }

  const heading = indexHeading(projectName);
  if (current.length === 0 && older === 0) {
    const lines = [heading, indexEmptyLine(projectName)];
    const bytes = sectionBytes(lines);
    const tokens = Math.ceil(bytes / 4);
    return { lines: [...lines, footerLine(0, bytes, tokens)], shown: 0, more: 0, older: 0, truncated, bytes, tokens, ids: [] };
  }

  // Reserve the worst-case trailers before filling: the lines that make the
  // cap visible must always fit under the cap.
  const reserve = sectionBytes([
    moreLine(current.length, truncated, projectName),
    olderLine(older, truncated),
    footerLine(INDEX_MAX_LINES, INDEX_MAX_BYTES, INDEX_MAX_BYTES),
  ]);
  const budget = INDEX_MAX_BYTES - reserve - sectionBytes([heading]);

  const rendered: string[] = [];
  const ids: number[] = [];
  let used = 0;
  for (const c of current) {
    if (rendered.length >= INDEX_MAX_LINES) break;
    const line = indexLine(c);
    const cost = byteLength(line) + 1;
    if (used + cost > budget) break;
    rendered.push(line);
    ids.push(c.id);
    used += cost;
  }

  const more = current.length - rendered.length;
  const lines = [heading, ...rendered];
  if (more > 0) lines.push(moreLine(more, truncated, projectName));
  if (older > 0) lines.push(olderLine(older, truncated));
  const bytes = sectionBytes(lines);
  const tokens = Math.ceil(bytes / 4);
  lines.push(footerLine(rendered.length, bytes, tokens));
  return { lines, shown: rendered.length, more, older, truncated, bytes, tokens, ids };
}
