import type { MemeshDatabase } from '../storage/sqlite.js';

/** SQLite `strftime` format of the week compression groups records by; a weekly summary is named `weekly-summary-<week>`. */
export const COMPRESSION_WEEK_FORMAT = '%Y-W%W';

/**
 * `memesh_metadata` key holding the compressed records the one-time marker
 * backfill could not tell apart from forgotten ones, and so left unmarked:
 * per week, how many of each type its summary declared beyond what could be
 * accounted for, and `before`, the compression cutoff (only a record created
 * before it can be one of them). `released` lists the records that were
 * remembered again since and now count as themselves.
 * `{ "weeks": { "2026-W10": { "before": "2026-03-12 12:00:00", "counts": { "commit": 23 } } }, "released": [41] }`.
 * Only the commit total reads it.
 */
export const UNMARKED_COMPRESSED_KEY = 'compression_unmarked_counts';

export type UnmarkedWeeks = Record<string, { before: string; counts: Record<string, number> }>;
type Ledger = { weeks: UnmarkedWeeks; released: number[] };

function readLedger(db: MemeshDatabase): Ledger {
  const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(UNMARKED_COMPRESSED_KEY) as { value: string } | undefined;
  const empty: Ledger = { weeks: {}, released: [] };
  if (!row) return empty;
  try {
    const parsed = JSON.parse(row.value) as Partial<Ledger> | null;
    if (!parsed || typeof parsed.weeks !== 'object' || parsed.weeks === null || !Array.isArray(parsed.released)) return empty;
    return { weeks: parsed.weeks, released: parsed.released };
  } catch {
    return empty;
  }
}

function writeLedger(db: MemeshDatabase, ledger: Ledger): void {
  if (Object.keys(ledger.weeks).length === 0) {
    db.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(UNMARKED_COMPRESSED_KEY);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(UNMARKED_COMPRESSED_KEY, JSON.stringify(ledger));
}

export function writeUnmarkedCompressedCounts(db: MemeshDatabase, weeks: UnmarkedWeeks): void {
  writeLedger(db, { weeks, released: [] });
}

/** Compressed commits the backfill could not mark, summed over every week. */
export function unmarkedCompressedCommits(db: MemeshDatabase): number {
  let total = 0;
  for (const week of Object.values(readLedger(db).weeks)) {
    const n = week?.counts?.commit;
    if (Number.isInteger(n) && n > 0) total += n;
  }
  return total;
}

/**
 * An archived record is being made active again. A compression marker would
 * otherwise outlive it, and a later `forget` would still count it. An
 * unmarked record old enough to have been compressed was counted in its
 * week's number, and now counts as itself — once: forgetting and remembering
 * it again does not take a second one off.
 */
export function releaseCompressedRecord(db: MemeshDatabase, entityId: number): void {
  const row = db.prepare(`
    SELECT type, strftime('${COMPRESSION_WEEK_FORMAT}', created_at) AS week,
      CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.compacted_into') END AS marker
    FROM entities WHERE id = ?
  `).get(entityId) as { type: string; week: string | null; marker: string | null } | undefined;
  if (!row) return;
  if (row.marker !== null) {
    db.prepare("UPDATE entities SET metadata = json_remove(metadata, '$.compacted_into') WHERE id = ? AND json_type(metadata) = 'object'").run(entityId);
    return;
  }
  if (!row.week) return;
  const ledger = readLedger(db);
  const week = ledger.weeks[row.week];
  const n = week?.counts?.[row.type];
  if (!week || !Number.isInteger(n) || n <= 0 || ledger.released.includes(entityId)) return;
  // Compared as SQLite compares them, the way compression chose its rows.
  const old = (db.prepare('SELECT created_at < datetime(?) AS old FROM entities WHERE id = ?').get(week.before, entityId) as { old: number }).old;
  if (!old) return;
  week.counts[row.type] = n - 1;
  ledger.released.push(entityId);
  writeLedger(db, ledger);
}
