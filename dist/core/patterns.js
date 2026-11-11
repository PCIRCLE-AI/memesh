import { NOISE_TYPES } from './analytics.js';
import { NOISE_TYPES as LIFECYCLE_COMPRESSED_TYPES } from './lifecycle.js';
import { COMPACTABLE_TYPES as DREAMER_COMPACTED_TYPES } from './dreamer.js';
import { unmarkedCompressedCommits } from './compression-ledger.js';
const AUTO_TYPES = [...NOISE_TYPES, 'workflow_checkpoint'];
const SESSION_TYPES = ['session_keypoint', 'session-insight'];
const COMPRESSED_TYPE_LIST = [...new Set([...LIFECYCLE_COMPRESSED_TYPES, ...DREAMER_COMPACTED_TYPES])]
    .filter((t) => t !== 'weekly-summary' && t !== 'weekly_summary')
    .map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
function countedSql(alias) {
    return `(${alias}.type != 'weekly-summary' AND (${alias}.status = 'active' OR (${alias}.status = 'archived'
    AND ${alias}.type IN (${COMPRESSED_TYPE_LIST})
    AND json_type(CASE WHEN json_valid(${alias}.metadata) THEN ${alias}.metadata ELSE '{}' END, '$.compacted_into') = 'integer')))`;
}
const SYSTEM_TAG_PREFIXES = ['date:', 'session:', 'project:', 'source:', 'severity:', 'error-pattern:'];
const SYSTEM_TAG_LITERALS = [
    'auto', 'auto-captured', 'auto-tracked', 'auto_saved',
    'session_end', 'session-summary', 'session-insight', 'session_keypoint', 'workflow_checkpoint',
    'scope:project',
];
const LEARNING_TYPES = ['lesson_learned', 'mistake', 'bug_fix', 'lesson'];
export function computePatterns(db, categories) {
    const allCategories = !categories || categories.length === 0;
    let hourDistribution = [];
    let dayDistribution = [];
    if (allCategories || categories.includes('workSchedule')) {
        hourDistribution = db.prepare(`
      SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) as hour, COUNT(*) as count
      FROM entities e WHERE ${countedSql('e')}
      GROUP BY hour ORDER BY hour
    `).all();
        dayDistribution = db.prepare(`
      SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) as dayNum,
        COUNT(*) as count
      FROM entities e WHERE ${countedSql('e')} GROUP BY dayNum ORDER BY dayNum
    `).all();
    }
    let focusAreas = [];
    if (allCategories || categories.includes('focusAreas')) {
        focusAreas = db.prepare(`
      SELECT type, COUNT(*) as count FROM entities
      WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type ORDER BY count DESC LIMIT 10
    `).all(...AUTO_TYPES);
    }
    let commitsPerSession = 0;
    let totalSessions = 0;
    let totalCommits = 0;
    if (allCategories || categories.includes('workflow')) {
        totalCommits = db.prepare(`SELECT COUNT(*) as c FROM entities e WHERE e.type = 'commit' AND ${countedSql('e')}`).get().c + unmarkedCompressedCommits(db);
        const sessionTypes = SESSION_TYPES.map(() => '?').join(',');
        totalSessions = db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT t.tag) FROM tags t JOIN entities e ON e.id = t.entity_id
          WHERE ${countedSql('e')} AND e.type IN (${sessionTypes}) AND t.tag LIKE 'session:%')
        +
        (SELECT COUNT(*) FROM entities e
          WHERE ${countedSql('e')} AND e.type IN (${sessionTypes})
            AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag LIKE 'session:%'))
        AS c
    `).get(...SESSION_TYPES, ...SESSION_TYPES).c;
        commitsPerSession = totalSessions > 0 ? Math.round((totalCommits / totalSessions) * 10) / 10 : 0;
    }
    let strengths = [];
    if (allCategories || categories.includes('strengths')) {
        strengths = db.prepare(`
      SELECT type, ROUND(AVG(confidence), 2) as avgConfidence, COUNT(*) as count
      FROM entities WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type HAVING count >= 2
      ORDER BY avgConfidence DESC LIMIT 5
    `).all(...AUTO_TYPES);
    }
    let learningAreas = [];
    if (allCategories || categories.includes('learningAreas')) {
        learningAreas = db.prepare(`
      SELECT t.tag, COUNT(*) as count FROM tags t
      JOIN entities e ON t.entity_id = e.id
      WHERE e.type IN (${LEARNING_TYPES.map(() => '?').join(',')})
        AND e.status = 'active'
        ${SYSTEM_TAG_PREFIXES.map(() => 'AND t.tag NOT LIKE ?').join('\n        ')}
        AND t.tag NOT IN (${SYSTEM_TAG_LITERALS.map(() => '?').join(',')})
      GROUP BY t.tag ORDER BY count DESC LIMIT 10
    `).all(...LEARNING_TYPES, ...SYSTEM_TAG_PREFIXES.map((p) => `${p}%`), ...SYSTEM_TAG_LITERALS);
    }
    return {
        workSchedule: { hourDistribution, dayDistribution },
        focusAreas,
        workflow: { commitsPerSession, totalSessions, totalCommits },
        strengths,
        learningAreas,
    };
}
//# sourceMappingURL=patterns.js.map