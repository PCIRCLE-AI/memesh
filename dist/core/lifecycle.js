import { KnowledgeGraph } from '../knowledge-graph.js';
import { dropEntityFromIndexes } from '../storage/entity-index.js';
import { runOnceMigration } from '../storage/schema.js';
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
    SELECT strftime('%Y-W%W', created_at) as week,
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
          AND strftime('%Y-W%W', e.created_at) = ?
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
            for (const e of entities) {
                dropEntityFromIndexes(db, e.id, e.name);
                let meta;
                try {
                    const raw = readMeta.get(e.id).metadata;
                    meta = raw ? JSON.parse(raw) : {};
                }
                catch {
                    meta = {};
                }
                if (typeof meta.compacted_into !== 'number')
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
const COMPRESSION_MARKER_KEY = 'compression_marker_backfill';
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
    const observationsOf = db.prepare('SELECT content FROM observations WHERE entity_id = ?');
    const candidatesOf = db.prepare(`
    SELECT id, type, metadata FROM entities
    WHERE status = 'archived' AND type IN (${placeholders})
      AND strftime('%Y-W%W', created_at) = ?
      AND (metadata IS NULL OR json_valid(metadata))
      AND json_type(COALESCE(metadata, '{}'), '$.compacted_into') IS NULL
  `);
    const write = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
    let marked = 0;
    let unresolved = 0;
    for (const summary of summaries) {
        const week = summary.name.slice('weekly-summary-'.length);
        const declared = declaredCompressedCounts(observationsOf.all(summary.id).map((o) => o.content));
        const byType = new Map();
        for (const row of candidatesOf.all(...types, week)) {
            let group = byType.get(row.type);
            if (!group) {
                group = [];
                byType.set(row.type, group);
            }
            group.push(row);
        }
        for (const [type, rows] of byType) {
            if (rows.length !== (declared.get(type) ?? 0)) {
                unresolved += rows.length;
                continue;
            }
            if (opts.dryRun) {
                marked += rows.length;
                continue;
            }
            for (const row of rows) {
                const meta = row.metadata ? JSON.parse(row.metadata) : {};
                meta.compacted_into = summary.id;
                write.run(JSON.stringify(meta), row.id);
                marked++;
            }
        }
    }
    return { marked, unresolved };
}
const BACKFILL_LEASE_KEY = `${COMPRESSION_MARKER_KEY}_lease`;
const BACKFILL_LEASE_MS = 10 * 60 * 1000;
const BACKUP_PREFIX = 'before-compression-marker-';
function acquireBackfillLease(db) {
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
export function backfillCompressionMarkers(db) {
    if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(COMPRESSION_MARKER_KEY))
        return;
    const lease = acquireBackfillLease(db);
    if (!lease)
        return;
    try {
        const plan = markCompressedRows(db, { dryRun: true });
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
                const backupPath = path.join(backupDir, `${BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
                const partial = `${backupPath}.tmp`;
                db.prepare('VACUUM INTO ?').run(partial);
                fs.renameSync(partial, backupPath);
                process.stderr.write(`MeMesh: backed up the database to ${backupPath} before marking records that compression archived.\n`);
            }
            catch (err) {
                process.stderr.write(`MeMesh: compressed-record marker backfill skipped, no backup could be made (${err instanceof Error ? err.message : String(err)}); it will retry on the next start.\n`);
                return;
            }
        }
        runOnceMigration(db, {
            key: COMPRESSION_MARKER_KEY,
            version: 1,
            describe: 'compressed-record marker backfill',
            migrate: () => {
                const { marked, unresolved } = markCompressedRows(db);
                process.stderr.write(`MeMesh: marked ${marked} archived record${marked === 1 ? '' : 's'} as archived by compression; ${unresolved} more could not be told apart from forgotten ones and were left unmarked.\n`);
            },
        });
    }
    finally {
        db.prepare('DELETE FROM memesh_metadata WHERE key = ? AND value = ?').run(BACKFILL_LEASE_KEY, lease);
    }
}
export { PRESERVED_TYPES, NOISE_TYPES };
//# sourceMappingURL=lifecycle.js.map