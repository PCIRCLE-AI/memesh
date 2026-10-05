// =============================================================================
// briefing-pools — the one selection behind every briefing
// =============================================================================
//
// `briefing` (core/briefing.ts) and the SessionStart hook assemble the same
// block. They used to issue the same SQL twice — the hook could not import a
// database-dependent core module — held together only by parity tests, and the
// copies had drifted: the hook ranked in SQL without the recall-impact term
// core's `rankEntities` uses. This module is the selection both now run. It
// takes the database it is given (the hook opens its own read-only handle and
// loads this module's generated copy, scripts/hooks/_generated/briefing-pools.js), so nothing here reaches for a shared
// connection, config or cwd.
//
// Every read tolerates a database from before a column existed — the hook
// opens read-only and cannot migrate, so a missing column narrows the query
// (or reads as NULL) instead of failing it.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { redactMemoryText, redactShownTogether } from './paths.js';
import { rankEntities } from './scoring.js';
import { SESSION_HANDOFF_TYPE, sessionHandoffName } from './session-handoff.js';
import { INDEX_CANDIDATE_CAP, INDEX_EXCLUDED_TYPES, INDEX_SNIPPET_FETCH_CHARS, type IndexCandidate } from './briefing-index.js';
import {
  DECISION_LAYER_TYPES,
  DECISION_TYPES,
  GLOBAL_TOPOLOGY_LIMIT,
  LESSON_TYPE_LIST,
  SNIPPET_FETCH_CHARS,
  TOPOLOGY_CANDIDATE_CAP,
  WHY_PREFIX,
  isAutoInjectable,
  prioritizeDecisions,
  unconfirmedDaysSince,
  type TopologyEntity,
} from './work-topology.js';

/** The lesson pool's window: enough for a count, of which the block shows LESSON_LIMIT. */
const LESSON_POOL_LIMIT = 50;
const LESSON_LIMIT = 5;
const RECENT_LIMIT = 5;
/** Memories that belong to no project shown to every project's session. */
const NO_PROJECT_LIMIT = 5;

const SCORING_COLUMNS = ['access_count', 'last_accessed_at', 'confidence', 'recall_hits', 'recall_misses'] as const;

/** Which optional columns this database has. */
interface EntityColumns {
  status: boolean;
  title: boolean;
  namespace: boolean;
  scoring: Set<string>;
}

function entityColumns(db: MemeshDatabase): EntityColumns {
  const names = new Set((db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>).map((c) => c.name));
  return {
    status: names.has('status'),
    title: names.has('title'),
    namespace: names.has('namespace'),
    scoring: new Set(SCORING_COLUMNS.filter((c) => names.has(c))),
  };
}

/** The auto-injection gate on the RAW metadata column: absent is allowed,
 *  unparseable is refused (never read as absent), parsed goes to the shared rule. */
function trustedForAutoContext(rawMetadata: string | null | undefined): boolean {
  if (rawMetadata == null) return true;
  const parsed = parseMetadata(rawMetadata);
  return parsed !== null && isAutoInjectable(parsed);
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const active = (cols: EntityColumns) => (cols.status ? " AND e.status = 'active'" : '');
const nonGlobal = (cols: EntityColumns) => (cols.namespace ? " AND (e.namespace IS NULL OR e.namespace <> 'global')" : '');
/** A row carrying no `project:` tag at all — a memory that belongs to no project. */
const NO_PROJECT_TAG = "NOT EXISTS (SELECT 1 FROM tags pt WHERE pt.entity_id = e.id AND pt.tag LIKE 'project:%')";
const titleCol = (cols: EntityColumns) => (cols.title ? 'e.title' : 'NULL AS title');
const candidateColumns = (cols: EntityColumns) => [
  'e.id', 'e.name', 'e.type', titleCol(cols), 'e.metadata',
  ...SCORING_COLUMNS.map((c) => (cols.scoring.has(c) ? `e.${c}` : `NULL AS ${c}`)),
].join(', ');

/** One selected memory: what ranking reads and what the block renders. */
export interface PoolRow {
  id: number;
  name: string;
  type: string | null;
  title: string | null;
  /** The raw column, as stored. */
  metadata: string | null;
  access_count?: number;
  last_accessed_at?: string;
  confidence?: number;
  recall_hits?: number;
  recall_misses?: number;
  /** Decision-layer rows only: latest valid activity (see RECENCY_SQL). */
  recency?: string | null;
}

interface CandidateRow extends Omit<PoolRow, 'access_count' | 'last_accessed_at' | 'confidence' | 'recall_hits' | 'recall_misses'> {
  access_count: number | null;
  last_accessed_at: string | null;
  confidence: number | null;
  recall_hits: number | null;
  recall_misses: number | null;
}

// SQLite hands back null for absent scalars; rankEntities wants undefined.
const toPoolRow = (row: CandidateRow): PoolRow => ({
  id: row.id,
  name: row.name,
  type: row.type,
  title: row.title,
  metadata: row.metadata,
  access_count: row.access_count ?? undefined,
  last_accessed_at: row.last_accessed_at ?? undefined,
  confidence: row.confidence ?? undefined,
  recall_hits: row.recall_hits ?? undefined,
  recall_misses: row.recall_misses ?? undefined,
  recency: row.recency ?? null,
});

/**
 * Rank a candidate window with core's scoring, gate it, and cap it. Wide fetch
 * BEFORE the gate: a top-N cut applied before a filter lets one blocked class
 * consume the whole window (measured on a real graph: 30 of 30 filtered out).
 */
function selectPool(rows: CandidateRow[], cap: number): PoolRow[] {
  return rankEntities(rows.map(toPoolRow), new Map())
    .filter((row) => trustedForAutoContext(row.metadata))
    .slice(0, cap);
}

/**
 * A timestamp column that counts: it round-trips through strftime unchanged
 * (the rule of time-utils' parseSqliteUtcMs) and is not more than 5 minutes in
 * the future — so an impossible or future date can never make a decision look
 * newest, or look confirmed.
 */
const validUtc = (column: string) => `replace(${column}, 'T', ' ') = strftime('%Y-%m-%d %H:%M:%S', ${column})
      AND replace(${column}, 'T', ' ') <= strftime('%Y-%m-%d %H:%M:%S', 'now', '+5 minutes')`;

/**
 * A decision's latest VALID activity, as canonical SQLite UTC text: its newest
 * observation, else its creation (see `validUtc`). NULL = unknown, sorted last.
 */
const RECENCY_SQL = `COALESCE(
  (SELECT MAX(replace(o.created_at, 'T', ' ')) FROM observations o
    WHERE o.entity_id = e.id
      AND ${validUtc('o.created_at')}),
  CASE WHEN ${validUtc('e.created_at')}
       THEN replace(e.created_at, 'T', ' ') END)`;

/** The handoff row of one project: its newest observation, active. Exported
 *  with BriefingPools and PoolOptions because selectBriefingPools' signature uses them. */
export interface HandoffRow { id: number; name: string; metadata: string | null; text: string; observedAt: string }

export interface BriefingPools {
  /** Where the last session in this project left off, if it may be shown. */
  handoff: HandoffRow | undefined;
  /** Why an existing handoff row is not in `handoff`: 'untrusted', or undefined. */
  handoffHidden: 'untrusted' | undefined;
  /** Every trusted lesson in the window (≤ LESSON_POOL_LIMIT), for a count. */
  lessonCount: number;
  lessons: PoolRow[];
  project: PoolRow[];
  /** Memories with no project (preferences, general lessons), every level. */
  noProject: PoolRow[];
  global: PoolRow[];
  recent: PoolRow[];
}

export interface PoolOptions {
  /** Slots for the project's own memories (decisions first). */
  projectLimit: number;
  global: boolean;
  foreign: boolean;
  /** A failed handoff, decision or lesson read becomes an empty part and is
   *  reported here; without it the read throws. */
  onError?: (label: 'handoff' | 'decisions' | 'lessons', err: unknown) => void;
}

function guarded<T>(label: 'handoff' | 'decisions' | 'lessons', fallback: T, read: () => T, onError: PoolOptions['onError']): T {
  if (!onError) return read();
  try { return read(); } catch (err) { onError(label, err); return fallback; }
}

/** Select every pool a briefing renders, for one project, at one level's policy. */
export function selectBriefingPools(db: MemeshDatabase, projectName: string, options: PoolOptions): BriefingPools {
  const cols = entityColumns(db);
  const projectTag = `project:${projectName}`;
  const columns = candidateColumns(cols);

  const handoffRead = guarded('handoff', undefined as HandoffRow | undefined, () => db.prepare(
    `SELECT e.id, e.name, e.metadata, o.content AS text, o.created_at AS observedAt
     FROM entities e JOIN observations o ON o.entity_id = e.id
     WHERE e.name = ? AND e.type = ?${active(cols)}
     ORDER BY o.id DESC
     LIMIT 1`,
  ).get(sessionHandoffName(projectName), SESSION_HANDOFF_TYPE) as HandoffRow | undefined, options.onError);
  const handoffTrusted = !!handoffRead && trustedForAutoContext(handoffRead.metadata);

  const projectRows = db.prepare(
    `SELECT DISTINCT ${columns}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ?${active(cols)} AND e.type <> ?${nonGlobal(cols)}
     ORDER BY e.id DESC
     LIMIT ?`,
  ).all(projectTag, SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[];
  // Decisions first (#434 step 3): the project's newest trusted decision-layer
  // rows take slots before the score-ordered candidates fill the rest.
  const decisions = guarded('decisions', [] as PoolRow[], () => (db.prepare(
    `SELECT DISTINCT ${columns}, ${RECENCY_SQL} AS recency
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ?${active(cols)}${nonGlobal(cols)}
       AND e.type IN (${DECISION_LAYER_TYPES.map(() => '?').join(',')})
     ORDER BY recency IS NULL, recency DESC, e.id DESC
     LIMIT ?`,
  ).all(projectTag, ...DECISION_LAYER_TYPES, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[])
    .map(toPoolRow).filter((row) => trustedForAutoContext(row.metadata)), options.onError);
  const project = prioritizeDecisions(decisions, selectPool(projectRows, TOPOLOGY_CANDIDATE_CAP), options.projectLimit);

  const lessonRows = guarded('lessons', [] as PoolRow[], () => (db.prepare(
    `SELECT DISTINCT ${columns}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE e.type IN (${LESSON_TYPE_LIST.map(() => '?').join(', ')})${active(cols)}${nonGlobal(cols)} AND t.tag = ?
     ORDER BY e.id DESC
     LIMIT ${LESSON_POOL_LIMIT}`,
  ).all(...LESSON_TYPE_LIST, projectTag) as unknown as CandidateRow[])
    .map(toPoolRow).filter((row) => trustedForAutoContext(row.metadata)), options.onError);

  // Memories that belong to no project (stored with project: false, or legacy
  // rows that never had a tag): not this project's, not global, but meant for
  // whoever works next — the same active/trust/ranking rules, a small window,
  // at every level. Global rows keep their own pool below.
  const noProject = selectPool(db.prepare(
    `SELECT ${columns} FROM entities e
     WHERE ${NO_PROJECT_TAG} AND e.type <> ?${active(cols)}${nonGlobal(cols)}
     ORDER BY e.id DESC
     LIMIT ?`,
  ).all(SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[], NO_PROJECT_LIMIT);

  // `global` is an explicit storage scope, not a project tag: its own bounded
  // pool, and the only path a global row can enter by.
  const global = options.global && cols.namespace
    ? selectPool(db.prepare(
      `SELECT ${columns} FROM entities e
       WHERE e.namespace = 'global'${active(cols)}
       ORDER BY e.id DESC
       LIMIT ?`,
    ).all(TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[], GLOBAL_TOPOLOGY_LIMIT)
    : [];

  // Newest activity across ALL projects; anything only here is from another
  // project. Rows with no project are the pool above, not "another project".
  const recent = options.foreign
    ? selectPool(db.prepare(
      `SELECT ${columns} FROM entities e
       WHERE NOT ${NO_PROJECT_TAG} AND e.type <> ?${active(cols)}${nonGlobal(cols)}
       ORDER BY e.id DESC
       LIMIT ?`,
    ).all(SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[], RECENT_LIMIT)
    : [];

  return {
    handoff: handoffTrusted ? handoffRead : undefined,
    handoffHidden: handoffRead && !handoffTrusted ? 'untrusted' : undefined,
    lessonCount: lessonRows.length,
    lessons: lessonRows.slice(0, LESSON_LIMIT),
    project,
    noProject,
    global,
    recent,
  };
}

/** What a row shows: its first non-empty observation and, when it has one,
 *  its latest structured `Fix: …` observation (the shape `learn` stores). */
export interface Snippet {
  first: string | null;
  fix: string | null;
  /** The latest `Why: ` observation, prefix removed. */
  why?: string | null;
  /** When the newest observation was added (valid UTC text, `validUtc`), or null. */
  lastAddedAt?: string | null;
}

/**
 * Each row's first non-empty observation and its latest `Fix: …` observation,
 * redacted, cut to SNIPPET_FETCH_CHARS, then whitespace flattened (the final
 * cut is the renderer's, on a word boundary). One query for all of them — this
 * runs before the first turn.
 *
 * The WHOLE observation is read and redacted BEFORE it is cut (#523), not cut
 * by `substr()` in SQL: a credential longer than the fetch window lost its
 * terminating `@` to the cut, stopped matching its pattern, and its prefix
 * was printed (`postgres://user:pppp…`). These are the selected rows only, a
 * few dozen, so reading whole observations is cheap.
 */
export function readSnippets(db: MemeshDatabase, ids: readonly number[]): Map<number, Snippet> {
  const unique = [...new Set(ids)];
  const snippets = new Map<number, Snippet>();
  if (unique.length === 0) return snippets;
  // A database from before observations carried a time reads as "never
  // added to": the snippets still render (the hook cannot migrate).
  const timed = (db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>).some((c) => c.name === 'created_at');
  const rows = db.prepare(
    `SELECT entity_id, content,
       ${timed ? `CASE WHEN ${validUtc('created_at')} THEN replace(created_at, 'T', ' ') END` : 'NULL'} AS added_at
     FROM observations
     WHERE entity_id IN (${unique.map(() => '?').join(',')})
     ORDER BY id ASC`,
  ).all(...unique) as Array<{ entity_id: number; content: string | null; added_at: string | null }>;
  // Redacted whole, cut to SNIPPET_FETCH_CHARS characters of the redacted
  // text, THEN flattened: text that starts only after that many characters
  // (whitespace included) is not shown, on either reader. A credential that
  // redaction shortens can bring later text inside the bound; that text is
  // redacted too.
  const shown = (content: string) => redactMemoryText(content).slice(0, SNIPPET_FETCH_CHARS).replace(/\s+/g, ' ').trim() || null;
  for (const row of rows) {
    const content = String(row.content ?? '');
    const entry = snippets.get(row.entity_id) ?? { first: null, fix: null, why: null, lastAddedAt: null };
    // The first NON-EMPTY observation: observations are append-only, so it is
    // the defining statement and later ones are refinements.
    if (entry.first === null) entry.first = shown(content);
    // The LATEST fix: learning the same error again appends a corrected one.
    if (content.startsWith('Fix: ')) entry.fix = shown(content);
    // The LATEST reason: a decision confirmed again may append a new one.
    if (content.startsWith(WHY_PREFIX)) entry.why = shown(content.slice(WHY_PREFIX.length));
    // The newest observation's time: it counts as a confirmation of a decision
    // whatever its type (only the decision layer has `recency`). Canonical
    // text, so a string comparison orders it.
    if (row.added_at && (entry.lastAddedAt == null || row.added_at > entry.lastAddedAt)) entry.lastAddedAt = row.added_at;
    snippets.set(row.entity_id, entry);
  }
  return snippets;
}

/**
 * A selected row as the shared assembler renders it. A lesson that carries a
 * structured fix leads with it — "Fix: … — <what happened>" — so a line cut to
 * its budget still says what to do; without it a lesson told an agent only
 * what went wrong.
 */
export function toTopologyEntity(row: PoolRow, snippets: ReadonlyMap<number, Snippet>, now: number = Date.now()): TopologyEntity {
  const signal = parseMetadata(row.metadata)?.signal_score;
  const snippet = snippets.get(row.id);
  const decision = row.type !== null && DECISION_TYPES.has(row.type);
  // #464: redacted like the index, so a memory that is in both cannot be
  // printed verbatim here and redacted a few lines below. What one line shows
  // is one set: a key split between the title and an observation is masked
  // as a whole.
  const [title, first, fix, why] = redactShownTogether([
    row.title ?? null,
    snippet?.first ?? null,
    row.type && LESSON_TYPE_LIST.includes(row.type) ? snippet?.fix ?? null : null,
    decision ? snippet?.why ?? null : null,
  ]);
  // Shown after the fix, unless it IS the fix (a lesson whose only content, or
  // whose title, is its fix), so a line never reads "Fix: X — Fix: X".
  const background = title || first;
  const after = background === fix ? null : background;
  return {
    name: row.name,
    type: row.type || 'memory',
    // The citation handle `[mem:<id>]`, the same on every surface.
    id: row.id,
    title: fix ? (after ? `${fix} — ${after}` : fix) : title,
    snippet: first,
    signalScore: typeof signal === 'number' ? signal : null,
    recency: row.recency ?? null,
    // Confirmed when last read (a recall stamps last_accessed_at) or added to:
    // the newest observation, which every decision type has (`recency` only
    // the decision layer).
    ...(decision ? { why, unconfirmedDays: unconfirmedDaysSince([row.last_accessed_at, snippet?.lastAddedAt, row.recency], now) } : {}),
  };
}

/**
 * The durable-memory index candidates for one project (#323): project-tagged,
 * active, non-global, durable-typed rows, newest activity first. What to show
 * and how lives in briefing-index.ts; this is only the read.
 */
export function readIndexCandidates(
  db: MemeshDatabase, projectName: string,
): { candidates: Array<IndexCandidate & { name: string }>; truncated: boolean } {
  const cols = entityColumns(db);
  const excluded = INDEX_EXCLUDED_TYPES.map(() => '?').join(',');
  const decisionTypes = [...DECISION_TYPES];
  const decisionOnly = `e.type IN (${decisionTypes.map(() => '?').join(',')})`;
  const rows = db.prepare(
    `SELECT e.id, e.name, e.type, ${titleCol(cols)}, e.metadata,
       ${cols.scoring.has('last_accessed_at') ? 'e.last_accessed_at' : 'NULL AS last_accessed_at'},
       (SELECT o.content FROM observations o
         WHERE o.entity_id = e.id ORDER BY o.id ASC LIMIT 1) AS snippet,
       max(e.created_at, COALESCE((SELECT MAX(o2.created_at) FROM observations o2
         WHERE o2.entity_id = e.id), e.created_at)) AS last_activity,
       CASE WHEN ${decisionOnly} THEN
         (SELECT o3.content FROM observations o3
           WHERE o3.entity_id = e.id AND substr(o3.content, 1, ${WHY_PREFIX.length}) = '${WHY_PREFIX}'
           ORDER BY o3.id DESC LIMIT 1) END AS why_content,
       CASE WHEN ${decisionOnly} THEN ${RECENCY_SQL} END AS recency
     FROM entities e
     WHERE e.id IN (SELECT entity_id FROM tags WHERE tag = ?)${active(cols)}${nonGlobal(cols)}
       AND e.type NOT IN (${excluded})
     ORDER BY last_activity DESC, e.id DESC
     LIMIT ?`,
  ).all(...decisionTypes, ...decisionTypes, `project:${projectName}`, ...INDEX_EXCLUDED_TYPES, INDEX_CANDIDATE_CAP) as Array<{
    id: number; name: string; type: string | null; title: string | null; metadata: string | null;
    last_accessed_at: string | null; snippet: string | null; last_activity: string | null;
    why_content: string | null; recency: string | null;
  }>;
  const candidates = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    title: row.title,
    // Whole observation fetched, redacted, THEN bounded (#523; see readSnippets).
    snippet: row.snippet == null ? null : redactMemoryText(row.snippet).slice(0, INDEX_SNIPPET_FETCH_CHARS),
    lastActivity: row.last_activity,
    // A decision carries its latest reason (null: it has none) and when it
    // was last confirmed; every other type leaves these unread (undefined).
    ...(row.type !== null && DECISION_TYPES.has(row.type) ? {
      why: row.why_content == null ? null : redactMemoryText(row.why_content.slice(WHY_PREFIX.length)).slice(0, INDEX_SNIPPET_FETCH_CHARS),
      recency: row.recency,
      lastAccessedAt: row.last_accessed_at,
    } : {}),
    // The RAW column: the index's gate tells an absent column (allowed) from
    // unparseable JSON (refused); parsing here would collapse both.
    metadata: row.metadata,
  }));
  return { candidates, truncated: rows.length >= INDEX_CANDIDATE_CAP };
}
