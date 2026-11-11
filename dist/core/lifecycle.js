import { KnowledgeGraph, isMetadataObject } from '../knowledge-graph.js';
import { dropEntityFromIndexes } from '../storage/entity-index.js';
import { AUTO_CAPTURE_TAG } from './types.js';
import { isTransientDbError, migrationRetryPending, runOnceMigration } from '../storage/schema.js';
import { COMPRESSION_WEEK_FORMAT, writeUnmarkedCompressedCounts } from './compression-ledger.js';
import fs from 'node:fs';
import path from 'node:path';
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_DAYS = 30;
const DECAY_FACTOR = 0.9;
const MIN_CONFIDENCE = 0.01;
export function runAutoDecay(db) {
    const lastDecay = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get();
    if (lastDecay) {
        const elapsed = Date.now() - new Date(lastDecay.value).getTime();
        if (elapsed < DECAY_INTERVAL_MS) {
            return { decayed: 0 };
        }
    }
    const cols = db.prepare('PRAGMA table_info(entities)').all();
    if (!cols.some((c) => c.name === 'confidence')) {
        return { decayed: 0 };
    }
    const threshold = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(`
    UPDATE entities
    SET confidence = MAX(confidence * ?, ?)
    WHERE status = 'active'
      AND (last_accessed_at IS NULL OR last_accessed_at < ?)
      AND confidence > ?
  `).run(DECAY_FACTOR, MIN_CONFIDENCE, threshold, MIN_CONFIDENCE);
    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_decay_at', ?)").run(new Date().toISOString());
    return { decayed: Number(result.changes) };
}
export function getDecayStatus(db) {
    const lastDecay = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get();
    const cols = db.prepare('PRAGMA table_info(entities)').all();
    let belowThreshold = 0;
    if (cols.some((c) => c.name === 'confidence')) {
        const row = db.prepare("SELECT COUNT(*) as c FROM entities WHERE confidence < 0.5 AND status = 'active'").get();
        belowThreshold = row.c;
    }
    return {
        lastDecayAt: lastDecay?.value ?? null,
        entitiesBelowThreshold: belowThreshold,
    };
}
const PRESERVED_TYPES = new Set([
    'decision', 'pattern', 'lesson_learned', 'bug_fix', 'architecture',
    'convention', 'feature', 'best_practice', 'concept', 'tool', 'note',
    'plan', 'release', 'refactoring', 'maintenance',
]);
const NOISE_TYPES = new Set([
    'session_keypoint', 'commit', 'session-insight', 'session-summary',
]);
const COMPRESS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOISE_AGE_DAYS = 7;
const NOISE_THRESHOLD = 20;
export function compressWeeklyNoise(db) {
    const kg = new KnowledgeGraph(db);
    const lastRun = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_noise_compress_at'").get();
    if (lastRun) {
        const elapsed = Date.now() - new Date(lastRun.value).getTime();
        if (elapsed < COMPRESS_INTERVAL_MS) {
            return { compressed: 0, weeksProcessed: 0 };
        }
    }
    const cols = db.prepare('PRAGMA table_info(entities)').all();
    if (!cols.some((c) => c.name === 'status')) {
        return { compressed: 0, weeksProcessed: 0 };
    }
    const cutoff = new Date(Date.now() - NOISE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const noiseTypePlaceholders = Array.from(NOISE_TYPES).map(() => '?').join(',');
    const noiseTypeValues = Array.from(NOISE_TYPES);
    const weekGroups = db.prepare(`
    SELECT strftime('${COMPRESSION_WEEK_FORMAT}', created_at) as week,
           COUNT(*) as count
    FROM entities
    WHERE type IN (${noiseTypePlaceholders})
      AND status = 'active'
      AND created_at < datetime(?)
    GROUP BY week
    HAVING count >= ?
    ORDER BY week
  `).all(...noiseTypeValues, cutoff, NOISE_THRESHOLD);
    let totalCompressed = 0;
    let weeksProcessed = 0;
    for (const { week } of weekGroups) {
        const summaryName = `weekly-summary-${week}`;
        const archiveWeek = db.transaction(() => {
            const entities = db.prepare(`
        SELECT e.id, e.name, e.type
        FROM entities e
        WHERE e.type IN (${noiseTypePlaceholders})
          AND e.status = 'active'
          AND strftime('${COMPRESSION_WEEK_FORMAT}', e.created_at) = ?
          AND e.created_at < datetime(?)
      `).all(...noiseTypeValues, week, cutoff);
            if (entities.length < NOISE_THRESHOLD)
                return 0;
            const typeCounts = new Map();
            for (const e of entities) {
                typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
            }
            const typeBreakdown = Array.from(typeCounts.entries())
                .map(([t, c]) => `${c} ${t}`)
                .join(', ');
            const existing = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName);
            if (existing) {
                kg.createEntity(summaryName, 'weekly-summary', {
                    observations: [`+${entities.length} entities archived (${typeBreakdown})`],
                    trustOverride: 'untrusted',
                });
            }
            else {
                const title = `${week} — ${entities.length} entities compressed`;
                const obsText = `${week}: ${entities.length} auto-tracked entities compressed (${typeBreakdown})`;
                const entityIdPlaceholders = entities.map(() => '?').join(',');
                const projectTags = db.prepare(`
          SELECT DISTINCT t.tag FROM tags t
          JOIN entities e ON e.id = t.entity_id
          WHERE e.id IN (${entityIdPlaceholders})
            AND t.tag LIKE 'project:%'
        `).all(...entities.map(e => e.id));
                kg.createEntity(summaryName, 'weekly-summary', {
                    title,
                    metadata: { title_source: 'heuristic' },
                    observations: [obsText],
                    tags: [...projectTags.map((t) => t.tag), 'source:noise-filter'],
                    trustOverride: 'untrusted',
                });
            }
            const summaryId = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName).id;
            const readMeta = db.prepare('SELECT metadata FROM entities WHERE id = ?');
            const archiveOne = db.prepare("UPDATE entities SET status = 'archived', metadata = ? WHERE id = ?");
            const archiveAsIs = db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?");
            for (const e of entities) {
                dropEntityFromIndexes(db, e.id, e.name);
                const meta = markableMetadata(readMeta.get(e.id).metadata);
                if (!meta) {
                    archiveAsIs.run(e.id);
                    continue;
                }
                meta.compacted_into = summaryId;
                archiveOne.run(JSON.stringify(meta), e.id);
            }
            return entities.length;
        });
        const compressedThisWeek = archiveWeek.immediate();
        if (compressedThisWeek > 0) {
            totalCompressed += compressedThisWeek;
            weeksProcessed++;
        }
    }
    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_noise_compress_at', ?)").run(new Date().toISOString());
    return { compressed: totalCompressed, weeksProcessed };
}
export const AUTO_ARCHIVE_TYPES = ['commit', 'session-insight', 'session-summary'];
export const AUTO_ARCHIVE_UNUSED_DAYS = 14;
const AUTO_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_ARCHIVE_RECORDED_IDS = 100;
export const AUTO_ARCHIVE_AT_KEY = 'last_auto_archive_at';
export const AUTO_ARCHIVE_RUN_KEY = 'last_auto_archive_run';
export function archiveUnusedAutoCaptured(db, now = new Date()) {
    const last = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(AUTO_ARCHIVE_AT_KEY);
    if (last && now.getTime() - new Date(last.value).getTime() < AUTO_ARCHIVE_INTERVAL_MS)
        return null;
    const cols = new Set(db.prepare('PRAGMA table_info(entities)').all().map((c) => c.name));
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
    const run = db.transaction(() => {
        const result = {
            at: now.toISOString(), unusedDays: AUTO_ARCHIVE_UNUSED_DAYS, archived: 0, byType: {}, keptCited: 0, ids: [],
        };
        if (judgeable) {
            result.keptCited = db.prepare(`SELECT COUNT(*) AS c FROM entities e WHERE ${old} AND COALESCE(e.recall_hits, 0) > 0`).get(...params).c;
            const rows = db.prepare(`SELECT e.id, e.name, e.type FROM entities e WHERE ${old} AND COALESCE(e.recall_hits, 0) = 0 ORDER BY e.id`).all(...params);
            const mark = JSON.stringify({ at: result.at, rule: 'unused', days: AUTO_ARCHIVE_UNUSED_DAYS });
            const archiveOne = db.prepare(`UPDATE entities SET status = 'archived',
           metadata = CASE WHEN metadata IS NULL THEN json_object('auto_archive', json(?))
                           WHEN json_valid(metadata) THEN json_set(metadata, '$.auto_archive', json(?))
                           ELSE metadata END
         WHERE id = ?`);
            for (const row of rows) {
                dropEntityFromIndexes(db, row.id, row.name);
                archiveOne.run(mark, mark, row.id);
                result.archived++;
                result.byType[row.type] = (result.byType[row.type] ?? 0) + 1;
                if (result.ids.length < AUTO_ARCHIVE_RECORDED_IDS)
                    result.ids.push(row.id);
            }
        }
        const put = db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
        put.run(AUTO_ARCHIVE_RUN_KEY, JSON.stringify(result));
        put.run(AUTO_ARCHIVE_AT_KEY, result.at);
        return result;
    });
    return run.immediate();
}
export class AutoArchiveRecordUnreadable extends Error {
    constructor(detail) {
        super(`the automatic archive's run record is unreadable: ${detail}`);
        this.name = 'AutoArchiveRecordUnreadable';
    }
}
export function readLastAutoArchiveRun(db) {
    const row = db.prepare(`SELECT value FROM memesh_metadata WHERE key = '${AUTO_ARCHIVE_RUN_KEY}'`).get();
    if (!row)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(row.value);
    }
    catch (err) {
        throw new AutoArchiveRecordUnreadable(err instanceof Error ? err.message : String(err));
    }
    if (typeof parsed?.at !== 'string' || !Number.isInteger(parsed.archived)) {
        throw new AutoArchiveRecordUnreadable('missing "at" or "archived"');
    }
    return parsed;
}
const COMPRESSION_MARKER_KEY = 'compression_marker_backfill';
function markableMetadata(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null)
            return {};
        return isMetadataObject(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function declaredCompressedCounts(observations) {
    const declared = new Map();
    for (const content of observations) {
        const breakdown = /\(([^()]*)\)\s*$/.exec(content);
        if (!breakdown)
            continue;
        for (const [, n, type] of breakdown[1].matchAll(/(\d+) ([\w-]+)/g)) {
            declared.set(type, (declared.get(type) ?? 0) + Number(n));
        }
    }
    return declared;
}
export function markCompressedRows(db, opts = {}) {
    const types = Array.from(NOISE_TYPES);
    const placeholders = types.map(() => '?').join(',');
    const summaries = db.prepare("SELECT id, name FROM entities WHERE type = 'weekly-summary' AND name LIKE 'weekly-summary-%'")
        .all();
    const observationsOf = db.prepare('SELECT content, created_at FROM observations WHERE entity_id = ?');
    const candidatesOf = db.prepare(`
    SELECT id, type, metadata FROM entities
    WHERE status = 'archived' AND type IN (${placeholders})
      AND strftime('${COMPRESSION_WEEK_FORMAT}', created_at) = ?
      AND json_type(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.compacted_into') IS NULL
  `);
    const alreadyMarkedBySummary = new Map();
    for (const r of db.prepare(`
    SELECT json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.compacted_into') AS summary, type, COUNT(*) AS n
    FROM entities WHERE status = 'archived' AND type IN (${placeholders}) AND summary IS NOT NULL
    GROUP BY summary, type
  `).all(...types)) {
        let byType = alreadyMarkedBySummary.get(r.summary);
        if (!byType) {
            byType = new Map();
            alreadyMarkedBySummary.set(r.summary, byType);
        }
        byType.set(r.type, r.n);
    }
    const cutoffBefore = db.prepare(`SELECT datetime(?, '-${NOISE_AGE_DAYS} days') AS t`);
    const rememberedAgain = db.prepare(`
    SELECT type, COUNT(*) AS n FROM entities
    WHERE status = 'active' AND type IN (${placeholders})
      AND strftime('${COMPRESSION_WEEK_FORMAT}', created_at) = ?
      AND created_at < datetime(?)
    GROUP BY type
  `);
    const write = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
    const countsOf = (rows) => new Map(rows.map((r) => [r.type, r.n]));
    let marked = 0;
    let unresolved = 0;
    const unmarkedCounts = {};
    for (const summary of summaries) {
        const week = summary.name.slice('weekly-summary-'.length);
        const observations = observationsOf.all(summary.id);
        const declared = declaredCompressedCounts(observations.map((o) => o.content));
        const lastCompression = observations
            .filter((o) => declaredCompressedCounts([o.content]).size > 0)
            .map((o) => o.created_at).sort().at(-1);
        const before = lastCompression ? cutoffBefore.get(lastCompression).t : null;
        const alreadyMarked = alreadyMarkedBySummary.get(summary.id) ?? new Map();
        const remembered = before ? countsOf(rememberedAgain.all(...types, week, before)) : new Map();
        const byType = new Map([...declared.keys()].map((t) => [t, []]));
        for (const row of candidatesOf.all(...types, week)) {
            let group = byType.get(row.type);
            if (!group) {
                group = [];
                byType.set(row.type, group);
            }
            group.push(row);
        }
        for (const [type, rows] of byType) {
            const expected = (declared.get(type) ?? 0) - (alreadyMarked.get(type) ?? 0);
            const active = remembered.get(type) ?? 0;
            const keepCount = (n) => {
                if (before && n > 0)
                    (unmarkedCounts[week] ??= { before, counts: {} }).counts[type] = n;
            };
            if (rows.length + active !== expected) {
                unresolved += rows.length;
                keepCount(expected - active);
                continue;
            }
            let unmarkable = 0;
            for (const row of rows) {
                const meta = markableMetadata(row.metadata);
                if (!meta) {
                    unmarkable++;
                    continue;
                }
                marked++;
                if (opts.dryRun)
                    continue;
                meta.compacted_into = summary.id;
                write.run(JSON.stringify(meta), row.id);
            }
            keepCount(unmarkable);
        }
    }
    return { marked, unresolved, unmarkedCounts };
}
const BACKFILL_LEASE_KEY = `${COMPRESSION_MARKER_KEY}_lease`;
const BACKFILL_LEASE_MS = 10 * 60 * 1000;
const BACKUP_PREFIX = 'before-compression-marker-';
function acquireBackfillLease(db) {
    const { timeout } = db.prepare('PRAGMA busy_timeout').get();
    db.pragma('busy_timeout = 0');
    try {
        return db.transaction(() => {
            const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(BACKFILL_LEASE_KEY);
            const expires = row ? Number(row.value.split(':')[1]) : 0;
            if (row && Number.isFinite(expires) && expires > Date.now())
                return undefined;
            const token = `${process.pid}:${Date.now() + BACKFILL_LEASE_MS}`;
            db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(BACKFILL_LEASE_KEY, token);
            return token;
        }).immediate();
    }
    finally {
        db.pragma(`busy_timeout = ${timeout}`);
    }
}
export function backfillCompressionMarkers(db) {
    const readKey = (key) => db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key)?.value;
    if (readKey(COMPRESSION_MARKER_KEY))
        return;
    if (migrationRetryPending(db, COMPRESSION_MARKER_KEY)) {
        process.stderr.write('MeMesh: compressed-record marker backfill is waiting out the 24h retry delay after its last failure; nothing was backed up or changed.\n');
        return;
    }
    let lease;
    try {
        lease = acquireBackfillLease(db);
    }
    catch (err) {
        if (!isTransientDbError(err))
            throw err;
        process.stderr.write(`MeMesh: compressed-record marker backfill deferred (${err instanceof Error ? err.message : String(err)}). Another process holds the database; it will run on the next start.\n`);
        return;
    }
    if (!lease) {
        process.stderr.write('MeMesh: compressed-record marker backfill skipped: another process is running it.\n');
        return;
    }
    try {
        const plan = markCompressedRows(db, { dryRun: true });
        let backupPath;
        if (plan.marked > 0) {
            const file = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file;
            try {
                if (!file)
                    throw new Error('the database has no file to back up');
                const backupDir = path.join(path.dirname(file), 'backups');
                fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
                for (const leftover of fs.readdirSync(backupDir)) {
                    if (leftover.startsWith(BACKUP_PREFIX) && leftover.endsWith('.tmp'))
                        fs.rmSync(path.join(backupDir, leftover), { force: true });
                }
                const finalPath = path.join(backupDir, `${BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
                const partial = `${finalPath}.tmp`;
                db.prepare('VACUUM INTO ?').run(partial);
                fs.renameSync(partial, finalPath);
                backupPath = finalPath;
                process.stderr.write(`MeMesh: backed up the database to ${backupPath} before marking records that compression archived.\n`);
            }
            catch (err) {
                process.stderr.write(`MeMesh: compressed-record marker backfill skipped, no backup could be made (${err instanceof Error ? err.message : String(err)}); it will retry on the next start.\n`);
                return;
            }
        }
        const done = runOnceMigration(db, {
            key: COMPRESSION_MARKER_KEY,
            version: 1,
            describe: 'compressed-record marker backfill',
            migrate: () => {
                const { marked, unresolved, unmarkedCounts } = markCompressedRows(db);
                writeUnmarkedCompressedCounts(db, unmarkedCounts);
                if (marked + unresolved > 0) {
                    process.stderr.write(`MeMesh: marked ${marked} archived record${marked === 1 ? '' : 's'} as archived by compression; ${unresolved} more could not be told apart from forgotten ones and were left unmarked.\n`);
                }
            },
        });
        if (!done && backupPath && !readKey(COMPRESSION_MARKER_KEY)) {
            fs.rmSync(backupPath, { force: true });
            process.stderr.write(`MeMesh: removed ${backupPath}: the marking did not happen, so the database is unchanged; the next attempt makes a new copy.\n`);
        }
    }
    finally {
        db.prepare('DELETE FROM memesh_metadata WHERE key = ? AND value = ?').run(BACKFILL_LEASE_KEY, lease);
    }
}
export { PRESERVED_TYPES, NOISE_TYPES };
//# sourceMappingURL=lifecycle.js.map