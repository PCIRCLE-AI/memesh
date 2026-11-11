// =============================================================================
// project-scope — which memories a project's reads may see
// =============================================================================
//
// A runtime leaf (it imports only work-topology, itself a leaf), so
// scripts/generate-hook-core.mjs copies it next to the hooks. The graph's recall
// (word, listing, by id, relations) decides "is this memory in this project's
// scope" with `projectScopeFilter`; the briefing's shared pool uses `ownFolderNote`.
//
// Use: `const { sql, params } = projectScopeFilter(ids.map((id) => `project:${id}`), 'e');`
// then `... FROM entities e WHERE 1=1 ${sql}` with `...params` bound in that order.
// `ids` comes from `getProjectIds(cwd)` (paths.ts); `null` is a session with no project.

import {
  NOTE_FILE_MISSING_TAG,
  NOTE_FILE_PROVENANCE,
  PREFERENCE_TYPES,
  SHARED_EXPERIENCE_TYPE_LIST,
  SHARED_FEEDBACK_TYPE,
} from './work-topology.js';

/**
 * A recall's project scope: the project tag (`project:<id>`) or tags, or null
 * for a session with no project.
 */
export type ProjectScope = string | readonly string[] | null;

/** Memories that carry no project tag at all (over an entity alias, default `e`). */
export const noProjectTag = (alias = 'e') => `NOT EXISTS (SELECT 1 FROM tags sp WHERE sp.entity_id = ${alias}.id AND sp.tag LIKE 'project:%')`;

/** A metadata field; NULL when the column is not valid JSON (it has no validity constraint). */
const metadataField = (alias: string, field: string) =>
  `json_extract(CASE WHEN json_valid(${alias}.metadata) THEN ${alias}.metadata END, '$.${field}')`;

/**
 * A memory the note ingester stored from the user's own memory folder (over an
 * entity alias, default `e`): its provenance says so, it is trusted, and its file
 * is still there. Nothing a tool, route or command can write sets that
 * provenance; a tag is no evidence.
 */
export const ownFolderNote = (alias = 'e') =>
  `(${metadataField(alias, 'provenance.source')} = '${NOTE_FILE_PROVENANCE}' AND ${metadataField(alias, 'trust')} = 'trusted'`
  + ` AND NOT EXISTS (SELECT 1 FROM tags sm WHERE sm.entity_id = ${alias}.id AND sm.tag = '${NOTE_FILE_MISSING_TAG}'))`;

/** The memory folder's notes that are shared: how the user works, not what a project decided. */
const SHARED_NOTE_TYPES: readonly string[] = [...PREFERENCE_TYPES, SHARED_FEEDBACK_TYPE];

/**
 * Over an entity alias (default `e`): not a memory-folder note, or one of the notes of
 * a memory folder that may reach another project (its preferences and feedback,
 * `ownFolderNote`). For any read that shows other projects' memories.
 */
export const folderNoteMayTravel = (alias = 'e') =>
  `(${metadataField(alias, 'provenance.source')} IS NOT '${NOTE_FILE_PROVENANCE}'`
  + ` OR (${alias}.type IN (${SHARED_NOTE_TYPES.map((type) => `'${type}'`).join(',')}) AND ${ownFolderNote(alias)}))`;

/**
 * A default recall's scope over an entity alias (default `e`). The project tag
 * (or tags: one checkout can be written under several ids): that project's
 * memories. null (no bound project) adds none. Always also memories with no
 * project, global ones that are not untrusted, and of any project: the decisions,
 * lessons and preferences (SHARED_EXPERIENCE_TYPES) that are not untrusted, not
 * from a memory folder and have readable metadata; and the preferences and feedback
 * of the user's own memory folder (`ownFolderNote`). Never another project's detail,
 * its untrusted memories, an untrusted global memory, or the decisions and lessons
 * of its memory folder.
 */
export function projectScopeFilter(scope: ProjectScope, alias = 'e'): { sql: string; params: string[] } {
  const tags = scope === null ? [] : typeof scope === 'string' ? [scope] : scope;
  const marks = (list: readonly unknown[]) => list.map(() => '?').join(',');
  const shared = `(${alias}.type IN (${marks(SHARED_EXPERIENCE_TYPE_LIST)})`
    + ` AND (${alias}.metadata IS NULL OR json_valid(${alias}.metadata))`
    + ` AND ${metadataField(alias, 'trust')} IS NOT 'untrusted'`
    + ` AND ${metadataField(alias, 'provenance.source')} IS NOT '${NOTE_FILE_PROVENANCE}')`
    + ` OR (${alias}.type IN (${marks(SHARED_NOTE_TYPES)}) AND ${ownFolderNote(alias)})`;
  const own = tags.length === 0
    ? ''
    : `EXISTS (SELECT 1 FROM tags st WHERE st.entity_id = ${alias}.id AND st.tag IN (${marks(tags)})) OR `;
  // Global is a storage scope, not a pass: an untrusted global memory (an imported bundle's)
  // is no more shared than any other untrusted one.
  const notUntrustedGlobal = `NOT (${alias}.namespace = 'global' AND ${metadataField(alias, 'trust')} IS 'untrusted')`;
  return {
    sql: `AND (${own}((${noProjectTag(alias)} OR ${alias}.namespace = 'global') AND ${notUntrustedGlobal}) OR ${shared})`,
    params: [...tags, ...SHARED_EXPERIENCE_TYPE_LIST, ...SHARED_NOTE_TYPES],
  };
}
