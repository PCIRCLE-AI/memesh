// =============================================================================
// prompt-recall — which stored memories a user's prompt is strongly about
// =============================================================================
//
// Agents almost never call `recall` on their own, so a memory only reaches
// them at session start or when they edit a file. This is the third moment:
// the user asks about something, and the memories that are plainly about it
// ride along with the prompt.
//
// The hook (scripts/hooks/prompt-recall.js) and the replay script
// (scripts/audit/prompt-recall-replay.mjs) call the same function below
// through its generated copy, so what a grader replays is what the hook
// injects.
//
// Candidates come from the same keyword index `recall` searches, in its own
// BM25 order. Strength is then measured by reading each candidate back — its
// name, title and EVERY observation — and asking how much of the prompt's
// information it covers: the summed inverse document frequency of the prompt's
// words the memory also contains, over the summed inverse document frequency
// of the prompt's most informative words. Common words carry almost no
// weight, so they cannot make a match strong; a memory has to share several
// of the prompt's rare words.
//
// The prompt's words are real words. Latin text splits on spaces. A run of
// Chinese, Japanese or Korean is cut into words by the platform's word
// segmenter (the index holds overlapping character pairs, and most pairs of a
// sentence straddle a word boundary and mean nothing); a word the segmenter
// cannot see whole comes out as single characters, so neighbouring single
// characters are tried as one word, and a candidate word that no memory holds
// has no document frequency and drops out.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { hasTables, MEMORY_READ_TABLES } from '../storage/schema.js';
import { renderPhraseExpression, tokenizeQuery, UNSPACED_SCRIPT_CLASS } from '../storage/fts-index.js';
import { buildReferenceContext, isAutoInjectable } from './work-topology.js';
import {
  AUTO_CONTEXT_EXCLUDED_TYPES,
  autoContextScope,
  projectAliases,
  readRecentRows,
  recentLine,
  staleReason,
  tableColumns,
} from './recent-index.js';

/** Most memories one prompt may bring along (before the out-of-date filter, which does not back-fill). */
export const PROMPT_RECALL_MAX_LINES = 2;
/** Share of the prompt's information a memory must cover to count as strong. */
export const PROMPT_RECALL_MIN_COVERAGE = 0.5;
/** Distinct prompt words a memory must contain. One shared word is a topic, not a match. */
export const PROMPT_RECALL_MIN_TERMS = 2;
/** Only the start of a prompt is read: a pasted log is not a question. */
const PROMPT_CHARS = 1500;
/** The most informative terms of a prompt that take part in scoring. */
const MAX_TERMS = 12;
/** A term in more than this share of memories says nothing about any one of them. */
export const PROMPT_RECALL_MAX_TERM_SHARE = 0.03;
/**
 * Memory types a prompt never brings along beyond the bookkeeping types.
 * Empty: feedback notes are offered like any other memory (measured:
 * leaving them out lost more useful matches than it saved).
 */
export const PROMPT_RECALL_SKIP_TYPES: ReadonlySet<string> = new Set();
/**
 * A `project` memory (a stored status) not touched for this many days is not
 * brought along: the text does not say that it has gone out of date.
 */
export const PROMPT_RECALL_MAX_PROJECT_AGE_DAYS = 30;
/** Rows read back from the index per prompt, best BM25 first. */
const CANDIDATE_WINDOW = 30;
/** Characters of a memory's observations read back for scoring. */
const SCORED_TEXT_CHARS = 20000;
/** Fewer memories than this and document frequency means nothing: only stop words are dropped. */
const MIN_ROWS_FOR_DF = 20;
/** Terms looked up per prompt, so a pasted document cannot turn into hundreds of queries. */
const MAX_LATIN_TERMS = 60;
const MAX_CJK_TERMS = 30;

const EXCLUDED_TYPES = AUTO_CONTEXT_EXCLUDED_TYPES;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'you', 'your', 'with', 'this', 'that', 'these', 'those',
  'have', 'has', 'had', 'not', 'but', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
  'how', 'what', 'why', 'when', 'where', 'who', 'which', 'does', 'did', 'done', 'doing', 'please',
  'about', 'from', 'into', 'than', 'then', 'them', 'they', 'there', 'their', 'its', 'our', 'out',
  'just', 'also', 'any', 'all', 'now', 'use', 'using', 'get', 'got', 'let', 'make', 'need', 'want',
  'like', 'some', 'more', 'most', 'one', 'two', 'yes', 'okay', 'ok', 'go', 'on', 'it', 'is', 'in',
  'of', 'to', 'we', 'be', 'do', 'if', 'or', 'an', 'as', 'at', 'by', 'so', 'no', 'me', 'my', 'up',
]);

export interface ScoredMemory {
  id: number;
  name: string;
  type: string;
  title: string | null;
  /** Share of the prompt's information this memory covers, 0..1. */
  coverage: number;
  /** The prompt terms the memory contains. */
  matched: string[];
  /** Summed inverse document frequency of the matched terms: how rare what they share is. */
  mass: number;
  /** Whether a matched term is in the memory's title or name. */
  inTitle: boolean;
  /** The keyword index's BM25 rank for this memory (more negative is better). */
  rank: number;
}

export interface PromptRecallOptions {
  /** The session's project id (without the `project:` prefix), or null for none. Its proven aliases are searched (recent-index.ts `projectAliases`). */
  project: string | null;
  /** The session's folder, when known: the other id its checkout is known by is then searched too. */
  cwd?: string | null;
  /** Ids already shown in this session; never returned again (and not replaced by the next match). */
  exclude?: ReadonlySet<number>;
  /**
   * The session-start index before its filter (recent-index.ts `poolIds`):
   * a match a newer decision in it replaces is out of date. Absent: the
   * matches are compared with each other only.
   */
  recentPool?: readonly number[];
  minCoverage?: number;
  minTerms?: number;
  maxLines?: number;
  /**
   * Replay only: read the graph as it was at this time (epoch ms). A memory
   * created later does not exist, and a memory is read only from the
   * observations it already had, so a memory written from the prompt itself
   * cannot answer it.
   */
  createdBefore?: number;
  /** Share of memories above which a term is too common to count (default PROMPT_RECALL_MAX_TERM_SHARE). */
  maxTermShare?: number;
  /** Memory types never offered (default PROMPT_RECALL_SKIP_TYPES; an empty set offers every type). */
  skipTypes?: ReadonlySet<string>;
  /**
   * A `project` memory whose newest observation is older than this many days is
   * not offered (default PROMPT_RECALL_MAX_PROJECT_AGE_DAYS; null turns the limit
   * off). Measured against the replay time when `createdBefore` is set, else now.
   */
  maxProjectAgeDays?: number | null;
  /**
   * For the age above: a memory read from a note file is as old as the file was
   * (the modification time recorded when it was read), not as old as the day it
   * was read; a note imported yesterday would otherwise look new whatever it
   * says. Default true; false dates every memory by its observations.
   */
  projectAgeFromNoteDate?: boolean;
}

export interface PromptRecallResult {
  /** The fenced block to inject, or '' when nothing was strong enough. */
  text: string;
  ids: number[];
  /** Why nothing was injected; undefined when something was. */
  reason?: 'no-terms' | 'no-candidates' | 'below-threshold' | 'stale' | 'already-shown';
  /** Strong matches the out-of-date filter removed, and why. */
  removed?: Array<{ id: number; reason: 'superseded' | 'waiting' }>;
  /** Every scored candidate, best first, for threshold studies. */
  scored: ScoredMemory[];
  /** Prompt terms that took part in scoring. */
  terms: string[];
}

/** Lowercase the way the index does; strip marks only from Latin terms (see knowledge-graph.ts `fold`). */
function fold(term: string): string {
  const lower = term.toLowerCase();
  return /^[\p{Script=Latin}\p{M}\p{N}]+$/u.test(lower) ? lower.normalize('NFD').replace(/\p{M}/gu, '') : lower;
}

interface Term {
  /** The word itself, folded: what a candidate's text is checked for. */
  text: string;
  cjk: boolean;
  /** Its FTS5 expression: a quoted token, or the adjacent character pairs of a CJK word. */
  match: string;
}

const CJK_RUN = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]+`, 'gu');
const CJK_ONE = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]`, 'u');

let segmenters: Map<string, Intl.Segmenter> | null = null;
/** Words of one CJK run, or null when the platform has no word segmenter. */
function segmentWords(run: string): string[] | null {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
    segmenters ??= new Map();
    // Kana mean Japanese, Hangul Korean; Han alone is read as Chinese.
    const locale = /[぀-ヿ]/u.test(run) ? 'ja' : /[가-힯]/u.test(run) ? 'ko' : 'zh-Hant';
    let seg = segmenters.get(locale);
    if (!seg) { seg = new Intl.Segmenter(locale, { granularity: 'word' }); segmenters.set(locale, seg); }
    return [...seg.segment(run)].filter((s) => s.isWordLike).map((s) => s.segment);
  } catch {
    return null;
  }
}

/** Candidate words of a CJK run: the segmenter's words, and neighbouring single characters joined. */
function cjkWords(run: string): string[] {
  const words = segmentWords(run);
  if (words === null) {
    // No segmenter: the overlapping character pairs the index holds.
    const chars = [...run];
    return chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
  }
  const out: string[] = [];
  let singles = '';
  const flush = () => { if ([...singles].length >= 2) out.push(singles); singles = ''; };
  for (const w of words) {
    if ([...w].length === 1) { singles += w; continue; }
    flush();
    out.push(w);
  }
  flush();
  return out;
}

function promptTerms(prompt: string): Term[] {
  // Markup tags (a shell wrapper around a pasted command, say) are not words the person chose.
  const text = prompt.slice(0, PROMPT_CHARS).replace(/<\/?[A-Za-z][\w-]*>/g, ' ').normalize('NFC');
  const seen = new Set<string>();
  const latin: Term[] = [];
  const cjk: Term[] = [];
  for (const raw of text.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? []) {
    const word = fold(raw);
    if (word.length < 2 || STOP_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    if (latin.length < MAX_LATIN_TERMS) latin.push({ text: word, cjk: false, match: `"${word.replace(/"/g, '""')}"` });
  }
  for (const run of text.match(CJK_RUN) ?? []) {
    for (const word of cjkWords(run)) {
      const folded = word.toLowerCase();
      if (seen.has(folded) || !CJK_ONE.test(folded)) continue;
      seen.add(folded);
      const match = renderPhraseExpression(tokenizeQuery(folded));
      if (match !== null && cjk.length < MAX_CJK_TERMS) cjk.push({ text: folded, cjk: true, match });
    }
  }
  return [...latin, ...cjk];
}

/** How many memories hold each term, from the vocabulary view for plain words and a phrase count for CJK words. */
function documentFrequencies(db: MemeshDatabase, terms: Term[]): Map<string, number> {
  const df = new Map<string, number>();
  const count = db.prepare('SELECT count(*) AS c FROM entities_fts WHERE entities_fts MATCH ?');
  const plain = terms.filter((t) => !t.cjk);
  if (plain.length > 0) {
    try {
      const rows = db
        .prepare(`SELECT term, doc FROM fts_vocab WHERE term IN (${plain.map(() => '?').join(',')})`)
        .all(...plain.map((t) => t.text)) as Array<{ term: string; doc: number }>;
      for (const t of plain) df.set(t.text, 0);
      for (const r of rows) df.set(r.term, r.doc);
    } catch {
      for (const t of plain) df.set(t.text, (count.get(t.match) as { c: number }).c);
    }
  }
  for (const t of terms.filter((x) => x.cjk)) df.set(t.text, (count.get(t.match) as { c: number }).c);
  return df;
}

function parseMetadata(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * Score every memory the index offers for this prompt. Nothing is filtered by
 * strength here; `selectPromptRecall` applies the threshold, and the replay
 * script reads this to study it.
 */
export function scorePrompt(
  db: MemeshDatabase,
  prompt: string,
  options: Pick<PromptRecallOptions, 'project' | 'cwd' | 'createdBefore' | 'maxTermShare' | 'skipTypes' | 'maxProjectAgeDays' | 'projectAgeFromNoteDate'>,
): { scored: ScoredMemory[]; terms: string[] } {
  const all = promptTerms(prompt);
  if (all.length === 0) return { scored: [], terms: [] };
  // No memories yet (or the schema is still being created): nothing can match.
  if (!hasTables(db, [...MEMORY_READ_TABLES, 'entities_fts'])) return { scored: [], terms: all.map((t) => t.text) };

  const entityCols = tableColumns(db, 'entities');
  const total = (db.prepare(`SELECT count(*) AS c FROM entities${entityCols.has('status') ? " WHERE status = 'active'" : ''}`).get() as { c: number }).c;
  const df = documentFrequencies(db, all);
  const useDf = total >= MIN_ROWS_FOR_DF;
  const idf = (term: Term) => {
    const n = df.get(term.text) ?? 0;
    return Math.log(1 + (total - n + 0.5) / (n + 0.5));
  };
  // A term no memory contains cannot match; a term in many memories is not about any one.
  const informative = all
    .filter((t) => (df.get(t.text) ?? 0) > 0 && (!useDf || (df.get(t.text) ?? 0) <= (options.maxTermShare ?? PROMPT_RECALL_MAX_TERM_SHARE) * total))
    .map((t) => ({ term: t, weight: idf(t) }))
    .sort((a, b) => b.weight - a.weight || (a.term.text < b.term.text ? -1 : 1))
    .slice(0, MAX_TERMS);
  if (informative.length === 0) return { scored: [], terms: [] };
  const promptWeight = informative.reduce((sum, t) => sum + t.weight, 0);

  const match = informative.map((t) => t.term.match).join(' OR ');
  const scope = autoContextScope(projectAliases(options.project, options.cwd));
  const before = options.createdBefore === undefined ? null : new Date(options.createdBefore).toISOString();
  const skipTypes = [...(options.skipTypes ?? PROMPT_RECALL_SKIP_TYPES)];
  const maxProjectAgeDays = options.maxProjectAgeDays === undefined ? PROMPT_RECALL_MAX_PROJECT_AGE_DAYS : options.maxProjectAgeDays;
  const asOfMs = options.createdBefore ?? Date.now();
  const rows = db.prepare(
    `SELECT e.id, e.name, e.type, ${entityCols.has('title') ? 'e.title' : 'NULL AS title'}, e.metadata, fts.rank AS rank
     FROM entities_fts fts JOIN entities e ON e.id = fts.rowid
     WHERE entities_fts MATCH ?${entityCols.has('status') ? " AND e.status = 'active'" : ''}
       AND e.type NOT IN (${[...EXCLUDED_TYPES, ...skipTypes].map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM tags ac WHERE ac.entity_id = e.id AND ac.tag = 'source:auto-capture')
       AND ${scope.sql}
       ${before === null ? '' : 'AND julianday(e.created_at) < julianday(?)'}
     ORDER BY fts.rank, e.id DESC
     LIMIT ?`,
  ).all(
    match, ...EXCLUDED_TYPES, ...skipTypes, ...scope.params, ...(before === null ? [] : [before]), CANDIDATE_WINDOW,
  ) as Array<{ id: number; name: string; type: string; title: string | null; metadata: string | null; rank: number }>;

  const observations = db.prepare(
    `SELECT content, created_at FROM observations WHERE entity_id = ?${before === null ? '' : ' AND julianday(created_at) < julianday(?)'} ORDER BY id`,
  );
  const scored: ScoredMemory[] = [];
  for (const row of rows) {
    const meta = parseMetadata(row.metadata);
    if (meta === undefined || !isAutoInjectable(meta)) continue;
    const read = (before === null ? observations.all(row.id) : observations.all(row.id, before)) as Array<{ content: string; created_at: string }>;
    // Replaying an earlier time: a memory with no observation yet had no text to answer with.
    if (before !== null && read.length === 0) continue;
    if (maxProjectAgeDays !== null && row.type === 'project') {
      const noteMs = options.projectAgeFromNoteDate !== false
        ? (meta as { provenance?: { source?: unknown; note_mtime_ms?: unknown } } | null)?.provenance
        : undefined;
      const fromNote = noteMs?.source === 'note-file' && typeof noteMs.note_mtime_ms === 'number' ? noteMs.note_mtime_ms : null;
      const newest = fromNote ?? Math.max(...read.map((o) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(o.created_at) ? o.created_at : `${o.created_at.replace(' ', 'T')}Z`)));
      if (Number.isFinite(newest) && (asOfMs - newest) / 86_400_000 > maxProjectAgeDays) continue;
    }
    const head = [row.name, row.title ?? ''].join(' ');
    // The whole of what the memory says: title, name and every observation.
    const body = read.map((o) => o.content).join(' ').slice(0, SCORED_TEXT_CHARS);
    const headTerms = new Set(tokenizeQuery(head).map(fold));
    const bodyTerms = new Set(tokenizeQuery(body).map(fold));
    const headText = head.normalize('NFC').toLowerCase();
    const bodyText = body.normalize('NFC').toLowerCase();
    const inHead = (t: Term) => (t.cjk ? headText.includes(t.text) : headTerms.has(t.text));
    const inBody = (t: Term) => (t.cjk ? bodyText.includes(t.text) : bodyTerms.has(t.text));
    const hits = informative.filter(({ term }) => inHead(term) || inBody(term));
    if (hits.length === 0) continue;
    const mass = hits.reduce((sum, t) => sum + t.weight, 0);
    scored.push({
      id: row.id,
      name: row.name,
      type: row.type,
      title: row.title,
      coverage: mass / promptWeight,
      matched: hits.map((t) => t.term.text),
      mass,
      inTitle: hits.some(({ term }) => inHead(term)),
      rank: row.rank,
    });
  }
  scored.sort((a, b) => b.coverage - a.coverage || b.matched.length - a.matched.length || a.rank - b.rank || b.id - a.id);
  return { scored, terms: informative.map((t) => t.term.text) };
}

/** The strong matches for a prompt, rendered as the block the hook injects. */
export function selectPromptRecall(db: MemeshDatabase, prompt: string, options: PromptRecallOptions): PromptRecallResult {
  const { scored, terms } = scorePrompt(db, prompt, options);
  if (terms.length === 0) return { text: '', ids: [], reason: 'no-terms', scored, terms };
  if (scored.length === 0) return { text: '', ids: [], reason: 'no-candidates', scored, terms };

  const minCoverage = options.minCoverage ?? PROMPT_RECALL_MIN_COVERAGE;
  const minTerms = options.minTerms ?? PROMPT_RECALL_MIN_TERMS;
  const maxLines = options.maxLines ?? PROMPT_RECALL_MAX_LINES;
  const top = scored.filter((m) => m.coverage >= minCoverage && m.matched.length >= minTerms).slice(0, maxLines);
  if (top.length === 0) return { text: '', ids: [], reason: 'below-threshold', scored, terms };

  // Out-of-date matches are dropped, then the ones already shown; neither is
  // replaced by the next match.
  const asOf = options.createdBefore ?? Date.now();
  const rows = readRecentRows(db, [...(options.recentPool ?? []), ...top.map((m) => m.id)], asOf, projectAliases(options.project, options.cwd));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const removed: NonNullable<PromptRecallResult['removed']> = [];
  const current = top.filter((m) => {
    const row = byId.get(m.id);
    const reason = row ? staleReason(row, rows, asOf) : null;
    if (reason !== null) removed.push({ id: m.id, reason });
    return reason === null;
  });
  if (current.length === 0) return { text: '', ids: [], reason: 'stale', removed, scored, terms };
  const fresh = current.filter((m) => !options.exclude?.has(m.id));
  if (fresh.length === 0) return { text: '', ids: [], reason: 'already-shown', removed, scored, terms };

  const lines = fresh.map((m) => recentLine({ id: m.id, title: m.title, name: m.name }));
  return { text: buildReferenceContext(lines), ids: fresh.map((m) => m.id), removed, scored, terms };
}
