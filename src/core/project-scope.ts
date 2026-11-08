// =============================================================================
// project-scope — which memories a project's reads may see
// =============================================================================
//
// A runtime leaf (it imports only work-topology, itself a leaf), so
// scripts/generate-hook-core.mjs copies it next to the hooks: the graph's recall,
// the briefing and every hook that reads a project's memories decide "is this
// memory in this project's scope" with this one SQL fragment, not with a copy.
//
// Use: `const { sql, params } = projectScopeFilter(ids.map((id) => `project:${id}`), 'e');`
// then `... FROM entities e WHERE 1=1 ${sql}` with `...params` bound in that order.
// `ids` comes from `getProjectIds(cwd)` (paths.ts); `null` is a session with no project.

import { NOTE_FILE_PROVENANCE, SHARED_EXPERIENCE_TYPE_LIST, SHARED_FEEDBACK_TYPE } from './work-topology.js';

/**
 * A recall's project scope: the project tag (`project:<id>`) or tags, or null
 * for a session with no project.
 */
export type ProjectScope = string | readonly string[] | null;

/** Memories that carry no project tag at all (over an entity alias, default `e`). */
export const noProjectTag = (alias = 'e') => `NOT EXISTS (SELECT 1 FROM tags sp WHERE sp.entity_id = ${alias}.id AND sp.tag LIKE 'project:%')`;

/**
 * A memory the note ingester stored from the user's own memory folder (over an
 * entity alias, default `e`): its provenance says so and it is trusted. Nothing a
 * tool, route or command can write sets that provenance; a tag is no evidence.
 */
export const ownFolderNote = (alias = 'e') =>
  `(json_extract(${alias}.metadata, '$.provenance.source') = '${NOTE_FILE_PROVENANCE}' AND json_extract(${alias}.metadata, '$.trust') = 'trusted')`;

/**
 * A default recall's scope over an entity alias (default `e`). The project tag
 * (or tags: one checkout can be written under several ids): that project's
 * memories. null (no bound project) adds none. Always also memories with no
 * project, global ones, and the decisions, lessons and preferences of any
 * project (SHARED_EXPERIENCE_TYPES, and `feedback` from the user's own memory
 * folder). Never another project's detail.
 */
export function projectScopeFilter(scope: ProjectScope, alias = 'e'): { sql: string; params: string[] } {
  const tags = scope === null ? [] : typeof scope === 'string' ? [scope] : scope;
  const shared = `${alias}.type IN (${SHARED_EXPERIENCE_TYPE_LIST.map(() => '?').join(',')})`
    + ` OR (${alias}.type = ? AND ${ownFolderNote(alias)})`;
  const own = tags.length === 0
    ? ''
    : `EXISTS (SELECT 1 FROM tags st WHERE st.entity_id = ${alias}.id AND st.tag IN (${tags.map(() => '?').join(',')})) OR `;
  return {
    sql: `AND (${own}${noProjectTag(alias)} OR ${alias}.namespace = 'global' OR ${shared})`,
    params: [...tags, ...SHARED_EXPERIENCE_TYPE_LIST, SHARED_FEEDBACK_TYPE],
  };
}
