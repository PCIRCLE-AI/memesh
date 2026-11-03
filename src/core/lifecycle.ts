import type { MemeshDatabase } from '../storage/sqlite.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { dropEntityFromIndexes } from '../storage/entity-index.js';
import { AUTO_CAPTURE_TAG } from './types.js';

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STALE_THRESHOLD_DAYS = 30;
const DECAY_FACTOR = 0.9;
const MIN_CONFIDENCE = 0.01;

/**
 * Run auto-decay on stale entities.
 * Reduces confidence by 0.9x for entities not accessed in 30+ days.
 * Only runs if last decay was 24+ hours ago (throttled).
 * Never deletes data — only reduces confidence score.
 * Skips archived entities and entities already at the confidence floor.
 */
export function runAutoDecay(db: MemeshDatabase): { decayed: number } {
  // Check throttle: skip if last decay was less than 24h ago
  const lastDecay = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'"
  ).get() as { value: string } | undefined;

  if (lastDecay) {
    const elapsed = Date.now() - new Date(lastDecay.value).getTime();
    if (elapsed < DECAY_INTERVAL_MS) {
      return { decayed: 0 };
    }
  }

  // Backward-compat guard: skip if confidence column doesn't exist
  const cols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'confidence')) {
    return { decayed: 0 };
  }

  // Entities are stale if last_accessed_at is older than threshold, or NULL (never accessed)
  const threshold = new Date(
    Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const result = db.prepare(`
    UPDATE entities
    SET confidence = MAX(confidence * ?, ?)
    WHERE status = 'active'
      AND (last_accessed_at IS NULL OR last_accessed_at < ?)
      AND confidence > ?
  `).run(DECAY_FACTOR, MIN_CONFIDENCE, threshold, MIN_CONFIDENCE);

  // Record when decay last ran (even if 0 entities were decayed)
  db.prepare(
    "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_decay_at', ?)"
  ).run(new Date().toISOString());

  return { decayed: Number(result.changes) };
}

/**
 * Get decay status for reporting or diagnostics.
 */
export function getDecayStatus(db: MemeshDatabase): {
  lastDecayAt: string | null;
  entitiesBelowThreshold: number;
} {
  const lastDecay = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'"
  ).get() as { value: string } | undefined;

  const cols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
  let belowThreshold = 0;
  if (cols.some((c) => c.name === 'confidence')) {
    const row = db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE confidence < 0.5 AND status = 'active'"
    ).get() as { c: number };
    belowThreshold = row.c;
  }

  return {
    lastDecayAt: lastDecay?.value ?? null,
    entitiesBelowThreshold: belowThreshold,
  };
}

// Types that should NEVER be compressed — they represent intentional knowledge
const PRESERVED_TYPES = new Set([
  'decision', 'pattern', 'lesson_learned', 'bug_fix', 'architecture',
  'convention', 'feature', 'best_practice', 'concept', 'tool', 'note',
  'plan', 'release', 'refactoring', 'maintenance',
]);

// Types considered auto-generated noise
const NOISE_TYPES = new Set([
  'session_keypoint', 'commit', 'session-insight', 'session-summary',
]);

const COMPRESS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NOISE_AGE_DAYS = 7;
const NOISE_THRESHOLD = 20; // minimum noise entities per week to trigger compression

/**
 * Compress old auto-generated entities into weekly summaries.
 * Groups session_keypoint, commit, session-insight entities older than 7 days
 * by ISO week. Creates one summary entity per week and archives the originals.
 *
 * - Throttled to once per 24 hours via memesh_metadata
 * - Only compresses if > 20 noise entities exist for a given week
 * - Never touches: decisions, patterns, lessons, bug_fixes, or any intentional knowledge
 */
export function compressWeeklyNoise(db: MemeshDatabase): { compressed: number; weeksProcessed: number } {
  const kg = new KnowledgeGraph(db);

  // Throttle: skip if last compression was less than 24h ago
  const lastRun = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'last_noise_compress_at'"
  ).get() as { value: string } | undefined;

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.value).getTime();
    if (elapsed < COMPRESS_INTERVAL_MS) {
      return { compressed: 0, weeksProcessed: 0 };
    }
  }

  // Backward-compat: skip if status column doesn't exist
  const cols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'status')) {
    return { compressed: 0, weeksProcessed: 0 };
  }

  // Find old noise entities grouped by calendar week
  const cutoff = new Date(Date.now() - NOISE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const noiseTypePlaceholders = Array.from(NOISE_TYPES).map(() => '?').join(',');
  const noiseTypeValues = Array.from(NOISE_TYPES);

  const weekGroups = db.prepare(`
    SELECT strftime('%Y-W%W', created_at) as week,
           COUNT(*) as count
    FROM entities
    WHERE type IN (${noiseTypePlaceholders})
      AND status = 'active'
      AND created_at < datetime(?)
    GROUP BY week
    HAVING count >= ?
    ORDER BY week
  `).all(...noiseTypeValues, cutoff, NOISE_THRESHOLD) as Array<{ week: string; count: number }>;

  let totalCompressed = 0;
  let weeksProcessed = 0;

  for (const { week } of weekGroups) {
    // Create or update the summary and archive its sources in one per-week
    // transaction. KnowledgeGraph.createEntity() nests through a savepoint,
    // so an index failure while archiving rolls back the summary mutation too.
    // Keeping the boundary per week preserves the existing partial-progress
    // semantics across independent weeks.
    const summaryName = `weekly-summary-${week}`;
    const archiveWeek = db.transaction(() => {
      // Re-resolve the complete source set only after BEGIN IMMEDIATE. A list
      // read before the lock could contain a stale name after another process
      // renamed the row, so the contentless FTS delete used bytes that were no
      // longer indexed and left the new-name token behind.
      const entities = db.prepare(`
        SELECT e.id, e.name, e.type
        FROM entities e
        WHERE e.type IN (${noiseTypePlaceholders})
          AND e.status = 'active'
          AND strftime('%Y-W%W', e.created_at) = ?
          AND e.created_at < datetime(?)
      `).all(...noiseTypeValues, week, cutoff) as Array<{ id: number; name: string; type: string }>;

      // The outer grouping is only a cheap candidate scan. Re-check the
      // threshold against the locked snapshot so concurrent archiving cannot
      // turn a qualifying week into a partial under-threshold compression.
      if (entities.length < NOISE_THRESHOLD) return 0;

      const typeCounts = new Map<string, number>();
      for (const e of entities) {
        typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
      }
      const typeBreakdown = Array.from(typeCounts.entries())
        .map(([t, c]) => `${c} ${t}`)
        .join(', ');

      // Create or update weekly summary entity — through KnowledgeGraph.
      // A raw INSERT here used to be a fourth entity-write path (besides
      // createEntity/captureEntity): its append branch skipped the
      // contentless-FTS delete+insert dance (stale index tokens on every
      // appended summary), and its create branch skipped the signal_score
      // stamp. createEntity owns both invariants; `untrusted` opts out of
      // the confidence bump — a machine summary adds no truth value.
      const existing = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName) as { id: number } | undefined;

      if (existing) {
        kg.createEntity(summaryName, 'weekly-summary', {
          observations: [`+${entities.length} entities archived (${typeBreakdown})`],
          trustOverride: 'untrusted',
        });
      } else {
        // Heuristic title, same as the auto-capture hooks generate.
        const title = `${week} — ${entities.length} entities compressed`;
        const obsText = `${week}: ${entities.length} auto-tracked entities compressed (${typeBreakdown})`;
        // Copy project tags from originals
        const entityIdPlaceholders = entities.map(() => '?').join(',');
        const projectTags = db.prepare(`
          SELECT DISTINCT t.tag FROM tags t
          JOIN entities e ON e.id = t.entity_id
          WHERE e.id IN (${entityIdPlaceholders})
            AND t.tag LIKE 'project:%'
        `).all(...entities.map(e => e.id)) as Array<{ tag: string }>;
        kg.createEntity(summaryName, 'weekly-summary', {
          title,
          metadata: { title_source: 'heuristic' },
          observations: [obsText],
          tags: [...projectTags.map((t) => t.tag), 'source:noise-filter'],
          trustOverride: 'untrusted',
        });
      }

      // Archive originals — out of BOTH indexes, then out of circulation.
      //
      // This used to be the bare UPDATE alone, and an archived entity kept its
      // FTS row. Measured on the maintainer's graph, this path
      // alone accounted for all 213 archived entities still in the keyword index
      // (`MATCH 'ae83279'` answered with the archived `commit-ae83279`), and it
      // is also what made re-remembering one of them insert a second, permanently
      // undeletable document at the same FTS rowid — see `createEntityInner`.
      //
      // Per entity rather than one set-UPDATE: a contentless FTS5 delete has to
      // repeat that row's own indexed text, so there is no set form of it.
      const archiveOne = db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?");
      for (const e of entities) {
        dropEntityFromIndexes(db, e.id, e.name);
        archiveOne.run(e.id);
      }
      return entities.length;
    });
    const compressedThisWeek = archiveWeek.immediate();
    if (compressedThisWeek > 0) {
      totalCompressed += compressedThisWeek;
      weeksProcessed++;
    }
  }

  // Record timestamp
  db.prepare(
    "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_noise_compress_at', ?)"
  ).run(new Date().toISOString());

  return { compressed: totalCompressed, weeksProcessed };
}

// ---------------------------------------------------------------------------
// Unused auto-captured memories
// ---------------------------------------------------------------------------

/** The mechanical records the hooks write on their own. Everything else was written by an agent or a person. */
export const AUTO_ARCHIVE_TYPES = ['commit', 'session-insight', 'session-summary'] as const;
/** Days without a citation, a recall or a new observation after which one of them is archived. */
export const AUTO_ARCHIVE_UNUSED_DAYS = 14;
const AUTO_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Ids kept in the run record; the count is always exact. */
const AUTO_ARCHIVE_RECORDED_IDS = 100;
export const AUTO_ARCHIVE_AT_KEY = 'last_auto_archive_at';
export const AUTO_ARCHIVE_RUN_KEY = 'last_auto_archive_run';

/** What one run of the archiver did; `memesh doctor` shows the last one. */
export interface AutoArchiveRun {
  at: string;
  unusedDays: number;
  archived: number;
  byType: Record<string, number>;
  /** Old enough, but kept because a session cited or fetched them. */
  keptCited: number;
  /** The first ids archived, for recovery. */
  ids: number[];
}

/**
 * Archive auto-captured commits and session rollups that nobody has used for
 * AUTO_ARCHIVE_UNUSED_DAYS.
 *
 * "Auto-captured" is the `source:auto-capture` tag the capture hooks stamp,
 * not the type: a commit an agent wrote with `remember` carries no such tag and
 * is never touched, and neither is any decision, lesson or other type. "Used"
 * is any of: ever cited or fetched (`recall_hits`), recalled in the window
 * (`last_accessed_at`), or added to in the window. A cited memory is kept
 * however old it is.
 *
 * Archiving is the same state change `forget` makes: the row, its text and its
 * tags stay, only the keyword index forgets it. It is recoverable — read it
 * with `recall --include-archived`, bring it back by `remember`ing the same
 * name — and the row carries `metadata.auto_archive` so these can be told from
 * ones a person archived.
 *
 * Throttled to once a day; returns null when it did not run. Every run that
 * did is recorded in `memesh_metadata` (AUTO_ARCHIVE_RUN_KEY), including one
 * that archived nothing.
 */
export function archiveUnusedAutoCaptured(db: MemeshDatabase, now: Date = new Date()): AutoArchiveRun | null {
  const last = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(AUTO_ARCHIVE_AT_KEY) as { value: string } | undefined;
  if (last && now.getTime() - new Date(last.value).getTime() < AUTO_ARCHIVE_INTERVAL_MS) return null;

  const cols = new Set((db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>).map((c) => c.name));
  // A database from before these columns has nothing the rule can judge. That
  // is still a run, and it is recorded as one that archived nothing.
  const judgeable = cols.has('status') && cols.has('recall_hits') && cols.has('last_accessed_at');
  const cutoff = new Date(now.getTime() - AUTO_ARCHIVE_UNUSED_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const types = [...AUTO_ARCHIVE_TYPES];
  const typeList = types.map(() => '?').join(',');
  const old = `e.status = 'active' AND e.type IN (${typeList})
    AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?)
    AND julianday(e.created_at) < julianday(?)
    AND (e.last_accessed_at IS NULL OR julianday(e.last_accessed_at) < julianday(?))
    AND COALESCE((SELECT MAX(julianday(o.created_at)) FROM observations o WHERE o.entity_id = e.id), 0) < julianday(?)`;
  const params = [...types, AUTO_CAPTURE_TAG, cutoff, cutoff, cutoff];

  const run = db.transaction((): AutoArchiveRun => {
    const result: AutoArchiveRun = {
      at: now.toISOString(), unusedDays: AUTO_ARCHIVE_UNUSED_DAYS, archived: 0, byType: {}, keptCited: 0, ids: [],
    };
    if (judgeable) {
      result.keptCited = (db.prepare(`SELECT COUNT(*) AS c FROM entities e WHERE ${old} AND COALESCE(e.recall_hits, 0) > 0`).get(...params) as { c: number }).c;
      const rows = db.prepare(
        `SELECT e.id, e.name, e.type FROM entities e WHERE ${old} AND COALESCE(e.recall_hits, 0) = 0 ORDER BY e.id`,
      ).all(...params) as Array<{ id: number; name: string; type: string }>;
      const mark = JSON.stringify({ at: result.at, rule: 'unused', days: AUTO_ARCHIVE_UNUSED_DAYS });
      const archiveOne = db.prepare(
        `UPDATE entities SET status = 'archived',
           metadata = CASE WHEN metadata IS NULL THEN json_object('auto_archive', json(?))
                           WHEN json_valid(metadata) THEN json_set(metadata, '$.auto_archive', json(?))
                           ELSE metadata END
         WHERE id = ?`,
      );
      for (const row of rows) {
        // Out of the keyword index first (a contentless delete repeats the
        // indexed text), then out of circulation.
        dropEntityFromIndexes(db, row.id, row.name);
        archiveOne.run(mark, mark, row.id);
        result.archived++;
        result.byType[row.type] = (result.byType[row.type] ?? 0) + 1;
        if (result.ids.length < AUTO_ARCHIVE_RECORDED_IDS) result.ids.push(row.id);
      }
    }
    const put = db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
    put.run(AUTO_ARCHIVE_RUN_KEY, JSON.stringify(result));
    put.run(AUTO_ARCHIVE_AT_KEY, result.at);
    return result;
  });
  return run.immediate();
}

/** The archiver's run record exists but cannot be read (truncated or not the shape it writes). */
export class AutoArchiveRecordUnreadable extends Error {
  constructor(detail: string) {
    super(`the automatic archive's run record is unreadable: ${detail}`);
    this.name = 'AutoArchiveRecordUnreadable';
  }
}

/**
 * The last run of the archiver, or null when it has never run. A record that
 * is there but cannot be read throws `AutoArchiveRecordUnreadable`: "never
 * ran" and "ran, and the record is damaged" are different answers.
 */
export function readLastAutoArchiveRun(db: { prepare(sql: string): { get(): unknown } }): AutoArchiveRun | null {
  const row = db.prepare(`SELECT value FROM memesh_metadata WHERE key = '${AUTO_ARCHIVE_RUN_KEY}'`).get() as { value: string } | undefined;
  if (!row) return null;
  let parsed: AutoArchiveRun;
  try {
    parsed = JSON.parse(row.value) as AutoArchiveRun;
  } catch (err) {
    throw new AutoArchiveRecordUnreadable(err instanceof Error ? err.message : String(err));
  }
  if (typeof parsed?.at !== 'string' || !Number.isInteger(parsed.archived)) {
    throw new AutoArchiveRecordUnreadable('missing "at" or "archived"');
  }
  return parsed;
}

// Export preserved/noise type sets for testing
export { PRESERVED_TYPES, NOISE_TYPES };

// memesh_metadata is created by SCHEMA_SQL (db.ts / openHookDb) — the only
// two schema owners. The ad-hoc CREATE TABLE that used to live here was the
// exact drift class check-schema-drift.mjs cannot see, and its bare DDL exec
// broke the read-only-file degradation the schema owners handle deliberately.
