import { MemeshDatabase } from './storage/sqlite.js';
import path from 'path';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { computeSignalScore } from './core/signal-scorer.js';
import { getDbPath } from './core/paths.js';
import { insertFtsRow, joinIndexedObservations, removeFromFts } from './storage/fts-index.js';
import { dedupeObservations, dropArchivedIndexRows, repairFusedLessonShellHistory, retractZeroEditClaims, splitFusedLessons } from './storage/graph-repairs.js';
import {
  SCHEMA_SQL,
  FTS_SQL,
  safeAlter,
  migrateEntitiesSchema,
  ensureTagsUniqueIndex,
  ensureHookRunsSince,
  ensureFtsSegmentation,
  rebuildFtsIndex,
  runOnceMigration,
  FTS_SEGMENTATION_VERSION,
} from './storage/schema.js';

// Existing import surface (tests, sqlite driver docs) — the implementations
// moved to storage/schema.ts, the shared owner both core and the hooks run.
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
import type { PragmaColumnRow } from './core/types.js';
import { truncateTitle, isBoilerplateObservation } from './core/title.js';

let db: MemeshDatabase | null = null;

// SCHEMA_SQL / FTS_SQL and the whole migration toolkit live in
// storage/schema.ts — the single owner both this file and the hooks (via
// scripts/hooks/_generated/schema.js) execute. The ~300-line hand-mirror
// this file and _shared.js used to keep "in lockstep" is gone.




export function openDatabase(dbPath?: string): MemeshDatabase {
  if (db) return db;

  const resolvedPath = dbPath ?? getDbPath();

  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }

  // The module singleton is published only once initialisation SUCCEEDS.
  //
  // This used to assign `db` first and initialise through it, so any throw
  // after `new Database()` — a peer holding the write lock during SCHEMA_SQL, a
  // read-only file, or a failed migration — left the singleton pointing at a
  // handle with no schema or completed migrations. `if (db) return db`
  // then handed that handle to every later caller in the process, forever.
  // Reproduced: with a peer holding BEGIN EXCLUSIVE the first call threw
  // "database is locked", and the next call returned the poisoned handle and
  // threw "no such table: memesh_metadata" — while `runOnceMigration`'s
  // careful transient-error backoff, which exists precisely so a held lock is
  // retried later, never got the chance to run.
  //
  // Failing closed matters more than usual here: writes would still go through
  // `insertFtsRow`'s current segmentation rules into an index that was never
  // migrated, which is the contentless-FTS delete mismatch the rest of this
  // release exists to eliminate.
  const opening = new MemeshDatabase(resolvedPath);
  try {
    initialiseDatabase(opening, resolvedPath);
  } catch (err) {
    try { opening.close(); } catch { /* already closing down */ }
    throw err;
  }
  db = opening;
  return db;
}

/**
 * Everything `openDatabase` does to a freshly-opened handle before it is safe
 * to publish. Extracted so the failure path has something to unwind: while this
 * was inline, "assign the singleton" and "finish initialising it" could not be
 * separated.
 */
/**
 * Is this error SQLite refusing a write because the database FILE is
 * read-only? The one error class the open path deliberately survives.
 */
function isReadonlyDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /readonly database|SQLITE_READONLY/i.test(msg);
}

function initialiseDatabase(db: MemeshDatabase, resolvedPath: string): MemeshDatabase {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Bringing the schema current is a WRITE, and "cannot migrate" must not
  // mean "cannot open": a database file that is read-only (a backup, a
  // snapshot, a permissions accident) but behind on schema used to die
  // right here — first on a DML statement that lived inside SCHEMA_SQL,
  // and once that moved out, on the CREATE TABLE any release adds. The
  // class of failure is the same each time, so the tolerance is general:
  // if the file refuses writes, open it for what it can still do — reads.
  // Anything else still throws; a read-only file is the ONE state where
  // an incomplete migration is survivable, because nothing can write to
  // the old shape either.
  try {
    migrateToCurrentSchema(db, resolvedPath);
  } catch (err) {
    if (!isReadonlyDbError(err)) throw err;
    try {
      process.stderr.write(
        'MeMesh: the database file is read-only, so schema migration was skipped — ' +
          'opened for reads only. Capture and migrations resume when the file is writable.\n',
      );
    } catch { /* stderr gone */ }
  }
  return db;
}

/**
 * Everything that makes an opened handle CURRENT: schema, FTS, one-time
 * migrations and maintenance sweeps. Split from
 * `initialiseDatabase` so the read-only-file tolerance above has a single
 * boundary to wrap — every statement in here may write, and none of them
 * is load-bearing for reading what the database already holds.
 */

function migrateToCurrentSchema(db: MemeshDatabase, resolvedPath: string): void {
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  ensureTagsUniqueIndex(db);
  ensureHookRunsSince(db);

  // Tighten file mode on the DB and its WAL/SHM sidecars so other local
  // users on a shared system cannot read memory contents. The DB
  // contains all observations and possibly secrets pasted into Claude.
  //
  // Two-layer defence:
  //   1. Tighten the process umask BEFORE writing any sidecar so that
  //      any SQLite-created -wal/-shm files (including ones recreated
  //      after a checkpoint(TRUNCATE) or fresh shm-mapping) are born
  //      with 0600. The earlier one-shot chmod missed sidecars that
  //      SQLite created later during normal operation.
  //   2. Belt-and-suspenders: explicitly chmod the existing files now,
  //      in case the umask was looser when this process started and
  //      SQLite already created them.
  try { process.umask(0o077); } catch { /* non-POSIX */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(`${resolvedPath}${suffix}`, 0o600); }
    catch { /* sidecar may not exist yet, or non-POSIX */ }
  }

  // The full conditional-ALTER chain — shared with the hooks via
  // storage/schema.ts, so a new column lands in ONE place and reaches both
  // sides of the F5 boundary through the generated copy.
  migrateEntitiesSchema(db);

  // Run auto-decay: reduce confidence for stale entities (throttled to once per 24h)
  runAutoDecay(db);

  // Phase-1 of #39: backfill metadata.signal_score on any entity
  // that doesn't already have one. One-time scan per install (the
  // MARKER key in backfillSignalScores guards against repeats).
  // Rule-based scorer is fast — 3000 entities cost ~50ms. Future
  // schema-version bumps to the scorer can re-run by changing the
  // marker key.
  backfillSignalScores(db);

  // UX-1: give pre-title rows a human-readable heuristic title. Same
  // marker + fill-only discipline as backfillSignalScores above.
  backfillTitles(db);

  // A1: release the auto-injection block on memories a human already
  // accepted via `dream accept`. Same marker + fill-only discipline.
  backfillAcceptedProposalTrust(db);

  // Repair what 4.8.1 hooks wrote wrongly (#240 duplicate session
  // observations, #241 lessons fused into one `-other` bucket). The fixes in
  // 4.8.2 stop new damage; these passes clean the rows already there, once.
  // After the title backfill so a bucket already has its title when its FTS
  // row is re-derived, and a split-out lesson gets one the same way.
  dedupeObservations(db);
  retractZeroEditClaims(db);

  splitFusedLessons(db, { deriveTitle: deriveHeuristicTitle });

  // D15: shells splitFusedLessons emptied and archived before this file
  // learned to zero their recall_hits/recall_misses still carry the fused
  // bucket's stale history. Runs after splitFusedLessons so it only ever
  // sees shells that pass has already produced (a split_from referrer must
  // exist), never a bucket mid-split in the same open.
  repairFusedLessonShellHistory(db);

  // Agent work packages stage proposals here for explicit human review.
  ensureDreamProposalsTable(db);

  // Rebuild entities_fts once when the way text is segmented changes.
  // Databases written before CJK segmentation hold whole-run tokens that no
  // segmented query can match, so without this the change would take Chinese
  // recall from bad to zero while English kept working — a silent regression.
  ensureFtsSegmentation(db);

  // One-shot repair for FTS rows written before archived entities were removed
  // from the keyword index. It rebuilds from active entities only and has no
  // dependency on an optional secondary index.
  dropArchivedIndexRows(db);

}

// FTS_SEGMENTATION_VERSION, runOnceMigration, isTransientDbError,
// rebuildFtsIndex and ensureFtsSegmentation live in storage/schema.ts (the
// shared owner) — re-exported below for the existing import surface.



/**
 * Rebuild the full-text index on demand, regardless of the version marker.
 *
 * The marker is monotonic, which leaves one state it cannot describe: a
 * database migrated by a segmentation-aware build, then written to by an older
 * one. The older build does not know the marker exists, so it indexes new
 * memories with the old rules and leaves the marker alone; re-upgrading then
 * short-circuits and those memories stay unreachable by any partial-phrase
 * query. Users legitimately end up in that state — an npm-global and a
 * plugin-marketplace install side by side, or a deliberate downgrade to
 * recover from a bad release.
 *
 * Rather than guess at version archaeology the older build left no trace of,
 * this is the escape hatch: an explicit, always-runs rebuild. `memesh doctor`
 * detects the condition directly and points here.
 */
export function reindexFts(): { entities: number } {
  const database = getDatabase();
  // Rebuild and marker in ONE immediate transaction, so a failure between them
  // cannot leave a rebuilt index under a stale marker. The marker only moves
  // forward, so that state never reconciles itself.
  //
  // Pinned by `tests/migration-atomicity.test.ts`, which fails the marker write
  // exactly where a crash would — a BEFORE INSERT trigger on `memesh_metadata`
  // — and asserts the rebuild rolled back with it. This was first written off
  // as untestable, on the grounds that observing it needs the process killed
  // mid-transaction. That was a failure to design the test: the fault can be
  // injected in-process, deterministically. Splitting the transaction fails it.
  //
  // `.immediate()` specifically is NOT load-bearing here, and the test does not
  // claim it is: `rebuildFtsIndex` now has no read half, so its first executed
  // statement is the `delete-all` write and a DEFERRED transaction takes the
  // lock at the same instant. Confirmed by mutation — `.immediate()` -> `()`
  // changes nothing observable. It stays for consistency with
  // `runOnceMigration`, where the callback reads BEFORE writing and the
  // distinction is the whole fix.
  database.transaction(() => {
    rebuildFtsIndex(database);
    database
      .prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
      .run('fts_segmentation_version', String(FTS_SEGMENTATION_VERSION));
    database.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(
      'fts_segmentation_version_last_attempt'
    );
  }).immediate();

  const { c } = database
    .prepare("SELECT count(*) AS c FROM entities WHERE status = 'active'")
    .get() as { c: number };
  return { entities: c };
}

/**
 * Create the dream_proposals staging table (#39 Phase 2).
 *
 * Agent work packages write proposals here before any reviewed effect.
 * Acceptance and rejection remain explicit human actions.
 *
 * Schema notes:
 *   - source_ids: JSON array of entity ids the proposal would compact.
 *   - proposed_digest: JSON with name + type + observations + tags
 *     an agent proposes as the digest entity.
 *   - status: 'pending' | 'accepted' | 'rejected' | 'applied'.
 *     'applied' means the digest has been created + sources archived;
 *     useful for an audit trail of what consolidations have run.
 *   - prompt_version identifies the work-package contract that staged the
 *     proposal. Older databases may still contain an inert llm_model column.
 */
function ensureDreamProposalsTable(db: MemeshDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      proposed_digest TEXT NOT NULL,
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_status ON dream_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_project ON dream_proposals(project);
  `);

  // source_kind distinguishes where a proposal's raw material came from:
  // 'entities' (the original path — clusters of already-captured KG rows) or
  // 'transcript' (mined directly from a Claude Code session JSONL, which does
  // not depend on any capture hook having fired). Additive with a default so
  // every pre-existing proposal reads as 'entities' — no backfill, no
  // reclassification. Idempotent via the PRAGMA guard, matching the entities
  // ALTER blocks above.
  const dpCols = db.prepare("PRAGMA table_info(dream_proposals)").all() as PragmaColumnRow[];
  if (!dpCols.some((c) => c.name === 'source_kind')) {
    safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'entities'");
  }
  // What accepting the proposal DOES: 'digest' creates an entity (compaction
  // or pattern — those two are discriminated by cluster_key/type, as before);
  // 'relation' creates a RELATION between two existing entities and archives
  // nothing (the conflict pipeline's judge stages these). A column and not a
  // cluster_key convention because the dreamer's pending-proposal scans
  // compare source_ids as entity-id arrays — a relation row's [a,b] pair
  // would read as a two-entity digest and cancel real compaction work.
  if (!dpCols.some((c) => c.name === 'kind')) {
    safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'digest'");
  }
}

/**
 * Backfill metadata.signal_score on existing entities (#39 Phase 1).
 *
 * One-time pass keyed by the MARKER constant below. Subsequent
 * openDatabase calls are no-ops. If the scorer rules change materially,
 * or a bug leaves rows unscored, bump the marker's version suffix to
 * trigger a re-scan.
 *
 * The marker is named by pointing at the constant, not by quoting its
 * value: three comments in this file quoted 'v1' and all three still
 * said it after the code moved to v2. A copy of a fact drifts; a
 * pointer cannot.
 *
 * Safe to run on a fresh DB (no entities → no-op) and on a 50k DB
 * (~200ms at rule-based speed). Reads observations + tags per
 * entity to feed the scorer the same inputs createEntity uses.
 */
function backfillSignalScores(db: MemeshDatabase): void {

  // v2 re-runs the scan once. `remember()` used to rebuild an entity's
  // metadata from a snapshot taken before the row was written, discarding the
  // score stamped at creation — so every memory written through `remember`
  // after the v1 backfill has none. Left alone, an upgraded graph is split:
  // old rows scored, remember-written rows not, and the three consumers
  // disagree about what a missing score means (kg-backfill treats it as 1.0,
  // the dreamer as 0.5, the dashboard passes it through). The pass only fills
  // rows that lack a score, so re-running costs one scan and changes nothing
  // that already has one.
  const MARKER = 'signal_score_backfill_v2';
  const done = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = ?"
  ).get(MARKER);
  if (done) return;

  const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ?');
  const tagStmt = db.prepare('SELECT tag FROM tags WHERE entity_id = ?');
  const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');

  // The work list is read HERE, inside the write transaction, not before
  // it. Reading it outside — as this used to — let a concurrent writer
  // (another process holds no exclusive claim on this database file)
  // insert a new, unscored entity between the read and this transaction's
  // write lock; that row would never appear in `rows`, and the marker set
  // at the end of a successful pass would still record the backfill as
  // done, forever, for a row it never saw. `runOnceMigration` exists for
  // exactly this: read the work list and commit the result under the same
  // lock, so nothing can be inserted into the gap between them.
  const tx = db.transaction(() => {
    // Re-check under the write lock — another process may have completed
    // this same backfill (and set MARKER) between the pre-check above and
    // this transaction acquiring the lock.
    if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER)) return;

    const rows = db.prepare(
      'SELECT id, name, type, metadata FROM entities'
    ).all() as Array<{ id: number; name: string; type: string; metadata: string | null }>;

    let scored = 0;
    let skipped = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      if (row.metadata) {
        // Unparseable metadata is LEFT ALONE. The catch used to fall back to
        // `{}`, and the row is written back whole further down — so a column
        // this function could not read was replaced by one holding only a
        // score, destroying whatever was in it. Harmless while the pass ran
        // once on a young graph; not harmless now that it re-runs.
        try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { skipped++; continue; }
        if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) { skipped++; continue; }
      } else {
        metadata = {};
      }
      if (typeof metadata.signal_score === 'number') {
        skipped++;
        continue;
      }
      const observations = (obsStmt.all(row.id) as Array<{ content: string }>).map(o => o.content);
      const tags = (tagStmt.all(row.id) as Array<{ tag: string }>).map(t => t.tag);
      metadata.signal_score = computeSignalScore({
        type: row.type,
        name: row.name,
        observations,
        tags,
      });
      updateStmt.run(JSON.stringify(metadata), row.id);
      scored++;
    }
    db.prepare(
      "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)"
    ).run(MARKER, JSON.stringify({ at: new Date().toISOString(), scored, skipped }));
  });
  tx();
}

// Title cap + truncation come from core/title.ts — the single owner all
// three writers (schemas validation, hook generators via _generated/, this
// backfill) execute. The hand-mirrored copy that lived here is gone.

/**
 * Derive a heuristic title for a pre-title row, or null to leave it
 * untitled. Null is a fine answer: the dashboard's display fallback
 * (pickBestObservation → typeLabel+date) already covers untitled rows,
 * so a title is only written when it says something the fallback cannot.
 * Never derived from `name` — that is the machine key the title exists
 * to hide.
 */
function deriveHeuristicTitle(type: string, observations: string[]): string | null {
  if (observations.length === 0) return null;

  // Failure lessons: the Error line is the story. Strip the label,
  // keep the first line of the description.
  if (type === 'lesson_learned' || type === 'lesson' || type === 'mistake') {
    const errObs = observations.find((o) => /^Error:\s*/.test(o.trim()));
    if (errObs) {
      const firstLine = errObs.trim().replace(/^Error:\s*/, '').split('\n')[0].trim();
      if (firstLine) return truncateTitle(firstLine);
    }
  }

  // Commits: post-commit.js stores the commit subject as the first
  // observation ("Branch: ..." / "Diff stats: ..." follow it).
  if (type === 'commit') {
    const first = observations[0]?.split('\n')[0].trim();
    if (first && !/^(Branch|Diff stats):/.test(first)) return truncateTitle(first);
  }

  // Generic: same selection MemoryRow's preview used pre-title — the
  // longest non-boilerplate observation among the first few — reduced
  // to its first line. Boilerplate list from core/title.ts (the union the
  // dashboard's preview picker also uses), so this backfill can no longer
  // pick a "title" the dashboard would have skipped as noise.
  const nonTrivial = observations.filter(
    (o) => o.length > 30 && !isBoilerplateObservation(o)
  );
  const pool = nonTrivial.length > 0 ? nonTrivial : observations;
  const best = pool.slice(0, 3).reduce((a, b) => (b.length > a.length ? b : a), pool[0]);
  const firstLine = best?.split('\n')[0].trim();
  return firstLine ? truncateTitle(firstLine) : null;
}

/**
 * Backfill `title` on rows created before the column existed (UX-1).
 *
 * Same shape as backfillSignalScores above: one-time pass keyed by the
 * MARKER constant, fill-only (`WHERE title IS NULL` — an existing title is
 * never overwritten, so the pass is idempotent by construction as well as
 * by marker), single transaction, unparseable metadata leaves the row
 * untouched. Every written title is stamped `metadata.title_source =
 * 'heuristic'` so readers can distinguish generated display text from a
 * human-supplied title.
 *
 * FTS: the title is folded into each entity's FTS feed on index, and these
 * rows were indexed BEFORE they had one — so every titled row must be
 * reindexed here, or the next contentless-FTS delete (issued with the
 * now-current title folded in) would not match what the index holds and
 * would silently corrupt it. Active rows only: archived rows have no FTS
 * entry (archiveEntity removes it), and a contentless delete for text that
 * was never indexed is exactly the corruption this block exists to avoid.
 */
/**
 * Clear the auto-injection block on memories a human accepted.
 *
 * `dream accept` used to stamp `metadata.trust = 'untrusted'` on the entity it
 * created, which `isTrustedForAutoContext` reads as "never inject this
 * unprompted". Measured on a real graph, that inverted the injection channel:
 * 74/74 raw commits were injectable while 29 facts, 11 lessons and 6 decisions
 * — every one of them human-accepted — were not. The write path stopped
 * setting the marker (see dreamer.ts); this releases the rows already carrying
 * it.
 *
 * Scoped by `proposal_id`, which only the two `dream accept` paths write, so
 * this can never touch an import or an auto-learned lesson — those mark
 * themselves untrusted with no human in the loop and must stay blocked.
 *
 * Fill-only and marker-guarded, like the two backfills below it: re-running is
 * a no-op, and an entity whose metadata will not parse is left exactly as it
 * is rather than being rewritten from a guess.
 */
function backfillAcceptedProposalTrust(db: MemeshDatabase): void {
  const MARKER = 'accepted_proposal_trust_v1';
  if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER)) return;

  const stamp = (cleared: number, skipped: number) =>
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
      .run(MARKER, JSON.stringify({ at: new Date().toISOString(), cleared, skipped }));

  const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
  // The work list is read HERE, inside the write transaction — see the
  // comment on the same shape in backfillSignalScores above. Read before
  // the lock, and a concurrent process's `dream accept` between the read
  // and this transaction's write lock inserts a row this pass would never
  // see, permanently, once the marker below is set.
  const tx = db.transaction(() => {
    if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER)) return;

    // json_extract rather than a LIKE scan: the two markers are structural,
    // and a substring match would also hit an observation that merely
    // quotes them.
    let rows: Array<{ id: number; metadata: string | null }>;
    try {
      rows = db.prepare(
        `SELECT id, metadata FROM entities
          WHERE metadata IS NOT NULL
            AND json_valid(metadata)
            AND json_extract(metadata, '$.trust') = 'untrusted'
            AND json_extract(metadata, '$.proposal_id') IS NOT NULL`,
      ).all() as Array<{ id: number; metadata: string | null }>;
    } catch {
      // A SQLite build without JSON1 cannot run the predicate. Leaving the
      // marker unset means a later open on a JSON1-capable build still does
      // the work — the honest outcome, versus stamping "done" over a pass
      // that never ran. Returning here commits an empty transaction: a
      // no-op, not a rollback, which is what "nothing happened" should be.
      return;
    }

    let cleared = 0;
    let skipped = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.metadata ?? '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { skipped++; continue; }
        metadata = parsed as Record<string, unknown>;
      } catch { skipped++; continue; }
      delete metadata.trust;
      updateStmt.run(JSON.stringify(metadata), row.id);
      cleared++;
    }
    stamp(cleared, skipped);
  });
  tx();
}

function backfillTitles(db: MemeshDatabase): void {
  const MARKER = 'title_backfill_v1';
  const done = db.prepare(
    'SELECT value FROM memesh_metadata WHERE key = ?'
  ).get(MARKER);
  if (done) return;

  const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id');
  const updateStmt = db.prepare('UPDATE entities SET title = ?, metadata = ? WHERE id = ?');

  // The work list is read HERE, inside the write transaction — see the
  // comment on the same shape in backfillSignalScores above. Read before
  // the lock, and a concurrent process's `remember` between the read and
  // this transaction's write lock inserts a title-less row this pass would
  // never see, permanently, once the marker below is set.
  const tx = db.transaction(() => {
    if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER)) return;

    const rows = db.prepare(
      'SELECT id, name, type, status, metadata FROM entities WHERE title IS NULL'
    ).all() as Array<{ id: number; name: string; type: string; status: string; metadata: string | null }>;

    let titled = 0;
    let skipped = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          // Skip rows with corrupt metadata — backfill should not overwrite
          // unparseable metadata, as we don't know what was stored there.
          skipped++;
          continue;
        }
        if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
          // Skip non-object metadata for the same reason
          skipped++;
          continue;
        }
      } else {
        metadata = {};
      }

      const observations = (obsStmt.all(row.id) as Array<{ content: string }>).map(o => o.content);
      const title = deriveHeuristicTitle(row.type, observations);
      if (!title) { skipped++; continue; }

      metadata.title_source = 'heuristic';
      updateStmt.run(title, JSON.stringify(metadata), row.id);

      if (row.status === 'active') {
        const obsText = joinIndexedObservations(observations);
        removeFromFts(db, row.id, row.name, obsText); // pre-title index entry: no title folded
        insertFtsRow(db, row.id, row.name, obsText, title);
      }
      titled++;
    }
    db.prepare(
      'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
    ).run(MARKER, JSON.stringify({ at: new Date().toISOString(), titled, skipped }));
  });
  tx();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDatabase(): MemeshDatabase {
  if (!db) throw new Error('Database not opened');
  return db;
}

// F16: Used by callers (e.g. doctor) that need to know whether the global
// database is already open before they touch it. The HTTP server opens
// the db at startup and expects it to stay open for the process lifetime;
// any caller that opens-and-closes inside a request handler would close
// the server's shared connection. Such callers must check this flag and
// skip the close if the db was open before they arrived.
export function isDatabaseOpen(): boolean {
  return db !== null;
}
