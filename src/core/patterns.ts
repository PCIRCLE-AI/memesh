// =============================================================================
// User Patterns — shared computation for MCP + HTTP transports
// Extracted to eliminate duplication between handlers.ts and http/server.ts
// =============================================================================

import type { MemeshDatabase } from '../storage/sqlite.js';
import { NOISE_TYPES } from './analytics.js';
import { NOISE_TYPES as COMPRESSED_TYPES } from './lifecycle.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PatternsResult {
  workSchedule: {
    hourDistribution: Array<{ hour: number; count: number }>;
    // dayNum is SQLite strftime('%w'): 0 = Sunday … 6 = Saturday. The row
    // used to also carry an English day NAME baked in by a SQL CASE WHEN;
    // that made every consumer render English regardless of UI language.
    // Names are presentation — each transport localises dayNum itself.
    dayDistribution: Array<{ dayNum: number; count: number }>;
  };
  focusAreas: Array<{ type: string; count: number }>;
  workflow: {
    commitsPerSession: number;
    totalSessions: number;
    totalCommits: number;
  };
  strengths: Array<{ type: string; avgConfidence: number; count: number }>;
  learningAreas: Array<{ tag: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Records the hooks write on their own (commits, session dumps, weekly
// roll-ups, the handoff): they say nothing about what the person works on.
const AUTO_TYPES = [...NOISE_TYPES, 'workflow_checkpoint'];
const SESSION_TYPES = ['session_keypoint', 'session-insight'];

/**
 * Which records count as work that happened. A forgotten memory does not. But
 * archiving also happens without the person asking: lifecycle compression
 * (`compressWeeklyNoise`, run daily) and the dreamer both archive old commits
 * and session records, and both leave `metadata.compacted_into` on each row
 * they archive. `forget` leaves nothing. So an archived record of a compressible
 * type counts exactly when it carries that marker; a record forgotten before
 * its week was compressed was never marked and never counts. The weekly
 * summary itself never counts: its time is the moment of compression. Known
 * limits: rows compressed before the marker existed were marked once, by
 * `backfillCompressionMarkers`, only where a weekly summary's own counts prove
 * it, and the rest stay uncounted; a record forgotten after its week was
 * compressed keeps its marker and still counts, since compression had already
 * recorded it.
 */
const COMPRESSED_TYPE_LIST = [...COMPRESSED_TYPES].map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
function countedSql(alias: string): string {
  return `(${alias}.type != 'weekly-summary' AND (${alias}.status = 'active' OR (${alias}.status = 'archived'
    AND ${alias}.type IN (${COMPRESSED_TYPE_LIST})
    AND json_type(CASE WHEN json_valid(${alias}.metadata) THEN ${alias}.metadata ELSE '{}' END, '$.compacted_into') = 'integer')))`;
}
// Tags memory writes on its own account, not learning topics. Exact labels and
// prefixes with their separator: a bare 'auto' or 'session' prefix also threw
// away real topics such as `automation`, `autoscaling` and `sessions`.
const SYSTEM_TAG_PREFIXES = ['date:', 'session:', 'project:', 'source:', 'severity:', 'error-pattern:'];
const SYSTEM_TAG_LITERALS = [
  'auto', 'auto-captured', 'auto-tracked', 'auto_saved',
  'session_end', 'session-summary', 'session-insight', 'session_keypoint', 'workflow_checkpoint',
  'scope:project',
];
const LEARNING_TYPES = ['lesson_learned', 'mistake', 'bug_fix', 'lesson'];

// ---------------------------------------------------------------------------
// computePatterns — all SQL queries in one place
// ---------------------------------------------------------------------------

export function computePatterns(db: MemeshDatabase, categories?: string[]): PatternsResult {
  const allCategories = !categories || categories.length === 0;

  // --- Work Schedule ---
  let hourDistribution: Array<{ hour: number; count: number }> = [];
  let dayDistribution: Array<{ dayNum: number; count: number }> = [];

  if (allCategories || categories!.includes('workSchedule')) {
    hourDistribution = db.prepare(`
      SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) as hour, COUNT(*) as count
      FROM entities e WHERE ${countedSql('e')}
      GROUP BY hour ORDER BY hour
    `).all() as Array<{ hour: number; count: number }>;

    dayDistribution = db.prepare(`
      SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) as dayNum,
        COUNT(*) as count
      FROM entities e WHERE ${countedSql('e')} GROUP BY dayNum ORDER BY dayNum
    `).all() as Array<{ dayNum: number; count: number }>;
  }

  // --- Focus Areas ---
  let focusAreas: Array<{ type: string; count: number }> = [];

  if (allCategories || categories!.includes('focusAreas')) {
    focusAreas = db.prepare(`
      SELECT type, COUNT(*) as count FROM entities
      WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type ORDER BY count DESC LIMIT 10
    `).all(...AUTO_TYPES) as Array<{ type: string; count: number }>;
  }

  // --- Workflow ---
  let commitsPerSession = 0;
  let totalSessions = 0;
  let totalCommits = 0;

  if (allCategories || categories!.includes('workflow')) {
    totalCommits = (db.prepare(
      `SELECT COUNT(*) as c FROM entities e WHERE e.type = 'commit' AND ${countedSql('e')}`
    ).get() as { c: number }).c;
    // One conversation writes up to three session records, all tagged with the
    // same `session:<id>`: count the ids, and a record with no such tag as one.
    const sessionTypes = SESSION_TYPES.map(() => '?').join(',');
    totalSessions = (db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT t.tag) FROM tags t JOIN entities e ON e.id = t.entity_id
          WHERE ${countedSql('e')} AND e.type IN (${sessionTypes}) AND t.tag LIKE 'session:%')
        +
        (SELECT COUNT(*) FROM entities e
          WHERE ${countedSql('e')} AND e.type IN (${sessionTypes})
            AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag LIKE 'session:%'))
        AS c
    `).get(...SESSION_TYPES, ...SESSION_TYPES) as { c: number }).c;
    commitsPerSession = totalSessions > 0 ? Math.round((totalCommits / totalSessions) * 10) / 10 : 0;
  }

  // --- Strengths ---
  let strengths: Array<{ type: string; avgConfidence: number; count: number }> = [];

  if (allCategories || categories!.includes('strengths')) {
    strengths = db.prepare(`
      SELECT type, ROUND(AVG(confidence), 2) as avgConfidence, COUNT(*) as count
      FROM entities WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type HAVING count >= 2
      ORDER BY avgConfidence DESC LIMIT 5
    `).all(...AUTO_TYPES) as Array<{ type: string; avgConfidence: number; count: number }>;
  }

  // --- Learning Areas ---
  let learningAreas: Array<{ tag: string; count: number }> = [];

  if (allCategories || categories!.includes('learningAreas')) {
    learningAreas = db.prepare(`
      SELECT t.tag, COUNT(*) as count FROM tags t
      JOIN entities e ON t.entity_id = e.id
      WHERE e.type IN (${LEARNING_TYPES.map(() => '?').join(',')})
        AND e.status = 'active'
        ${SYSTEM_TAG_PREFIXES.map(() => 'AND t.tag NOT LIKE ?').join('\n        ')}
        AND t.tag NOT IN (${SYSTEM_TAG_LITERALS.map(() => '?').join(',')})
      GROUP BY t.tag ORDER BY count DESC LIMIT 10
    `).all(...LEARNING_TYPES, ...SYSTEM_TAG_PREFIXES.map((p) => `${p}%`), ...SYSTEM_TAG_LITERALS) as Array<{ tag: string; count: number }>;
  }

  return {
    workSchedule: { hourDistribution, dayDistribution },
    focusAreas,
    workflow: { commitsPerSession, totalSessions, totalCommits },
    strengths,
    learningAreas,
  };
}
