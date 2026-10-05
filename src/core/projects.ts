// =============================================================================
// Projects — group entities by project for the dashboard Browse / Lessons UI
// =============================================================================
//
// MeMesh stores memories from multiple projects in one DB. The "project" of
// an entity is encoded two ways, neither of which is enforced at the schema
// level:
//   1) An explicit `project:<name>` tag (the canonical source)
//   2) An implicit prefix in the entity name (e.g. lesson-claude-code-buddy-X
//      where "claude-code-buddy" is the project)
//
// computeProjects() merges both signals and returns a sorted catalogue the
// dashboard can use for filter chips. Pure read-only aggregation; no side
// effects, no caching.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { extractProjectFromEntity } from './project-attribution.js';
import { SESSION_HANDOFF_TYPE } from './session-handoff.js';

// The attribution rule lives in project-attribution.ts (pure, shared with the
// dashboard); re-exported here for the existing importers.
export { extractProjectFromName, extractProjectFromEntity } from './project-attribution.js';

/**
 * The one type a project never counts: the Stop hook writes a session handoff
 * for every project, tagged `project:<name>`, and it is not one of the
 * project's memories. `computeProjects` (the chips) and `listByProject` (the
 * list behind a chip) both filter with this fragment, so neither can start or
 * stop counting it without the other. Alias `e` is the entities table.
 */
export const NOT_A_PROJECT_MEMORY = { sql: 'e.type <> ?', param: SESSION_HANDOFF_TYPE } as const;

export interface ProjectInfo {
  /** Canonical project key, suitable for matching against tag values. */
  name: string;
  /** How many entities belong to this project. */
  count: number;
  /** Distinct entity types observed within the project, sorted by count desc. */
  types: string[];
  /** Whether the assignment came from an explicit tag (vs. name-prefix heuristic). */
  source: 'tag' | 'heuristic' | 'mixed';
}

type RawEntity = {
  id: number;
  name: string;
  type: string;
  tags?: string;
};

export function computeProjects(db: MemeshDatabase): ProjectInfo[] {
  // Single pass: pull every active entity + its tags. We can't aggregate in
  // SQL because the project lookup walks both tags and the name heuristic.
  // json_group_array (rather than GROUP_CONCAT with a delimiter) keeps the
  // representation safe even if a tag value contains the delimiter char —
  // tags are user-supplied and the schema does not currently filter
  // newlines or commas.
  const rows = db.prepare(`
    SELECT e.id, e.name, e.type,
      (SELECT json_group_array(t.tag) FROM tags t WHERE t.entity_id = e.id) AS tags
    FROM entities e
    WHERE e.status = 'active'
      AND ${NOT_A_PROJECT_MEMORY.sql}
  `).all(NOT_A_PROJECT_MEMORY.param) as RawEntity[];

  const acc = new Map<string, { count: number; types: Map<string, number>; sources: Set<'tag' | 'heuristic'> }>();

  for (const row of rows) {
    let tagList: string[] = [];
    if (row.tags) {
      try {
        const parsed = JSON.parse(row.tags);
        if (Array.isArray(parsed)) tagList = parsed.filter((t): t is string => typeof t === 'string');
      } catch {
        /* unexpected non-JSON payload; treat as empty */
      }
    }
    const { project, source } = extractProjectFromEntity(tagList, row.name);
    if (!project || !source) continue;
    let bucket = acc.get(project);
    if (!bucket) {
      bucket = { count: 0, types: new Map(), sources: new Set() };
      acc.set(project, bucket);
    }
    bucket.count++;
    bucket.types.set(row.type, (bucket.types.get(row.type) ?? 0) + 1);
    bucket.sources.add(source);
  }

  return Array.from(acc.entries())
    .map<ProjectInfo>(([name, bucket]) => ({
      name,
      count: bucket.count,
      types: Array.from(bucket.types.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t),
      source: bucket.sources.size === 2 ? 'mixed' : (bucket.sources.has('tag') ? 'tag' : 'heuristic'),
    }))
    .sort((a, b) => b.count - a.count);
}
