import { KnowledgeGraph } from '../knowledge-graph.js';
import { dropEntityFromIndexes } from '../storage/entity-index.js';
import { AUTO_CAPTURE_TAG } from './types.js';
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
export { PRESERVED_TYPES, NOISE_TYPES };
//# sourceMappingURL=lifecycle.js.map