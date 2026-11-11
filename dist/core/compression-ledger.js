export const COMPRESSION_WEEK_FORMAT = '%Y-W%W';
export const UNMARKED_COMPRESSED_KEY = 'compression_unmarked_counts';
function readLedger(db) {
    const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(UNMARKED_COMPRESSED_KEY);
    const empty = { weeks: {}, released: [] };
    if (!row)
        return empty;
    try {
        const parsed = JSON.parse(row.value);
        if (!parsed || typeof parsed.weeks !== 'object' || parsed.weeks === null || !Array.isArray(parsed.released))
            return empty;
        return { weeks: parsed.weeks, released: parsed.released };
    }
    catch {
        return empty;
    }
}
function writeLedger(db, ledger) {
    if (Object.keys(ledger.weeks).length === 0) {
        db.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(UNMARKED_COMPRESSED_KEY);
        return;
    }
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(UNMARKED_COMPRESSED_KEY, JSON.stringify(ledger));
}
export function writeUnmarkedCompressedCounts(db, weeks) {
    writeLedger(db, { weeks, released: [] });
}
export function unmarkedCompressedCommits(db) {
    let total = 0;
    for (const week of Object.values(readLedger(db).weeks)) {
        const n = week?.counts?.commit;
        if (Number.isInteger(n) && n > 0)
            total += n;
    }
    return total;
}
export function releaseCompressedRecord(db, entityId) {
    const row = db.prepare(`
    SELECT type, strftime('${COMPRESSION_WEEK_FORMAT}', created_at) AS week,
      CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.compacted_into') END AS marker
    FROM entities WHERE id = ?
  `).get(entityId);
    if (!row)
        return;
    if (row.marker !== null) {
        db.prepare("UPDATE entities SET metadata = json_remove(metadata, '$.compacted_into') WHERE id = ? AND json_type(metadata) = 'object'").run(entityId);
        return;
    }
    if (!row.week)
        return;
    const ledger = readLedger(db);
    const week = ledger.weeks[row.week];
    const n = week?.counts?.[row.type];
    if (!week || !Number.isInteger(n) || n <= 0 || ledger.released.includes(entityId))
        return;
    const old = db.prepare('SELECT created_at < datetime(?) AS old FROM entities WHERE id = ?').get(week.before, entityId).old;
    if (!old)
        return;
    week.counts[row.type] = n - 1;
    ledger.released.push(entityId);
    writeLedger(db, ledger);
}
//# sourceMappingURL=compression-ledger.js.map