import { NOTE_FILE_MISSING_TAG, NOTE_FILE_PROVENANCE, PREFERENCE_TYPES, SHARED_EXPERIENCE_TYPE_LIST, SHARED_FEEDBACK_TYPE, } from './work-topology.js';
export const noProjectTag = (alias = 'e') => `NOT EXISTS (SELECT 1 FROM tags sp WHERE sp.entity_id = ${alias}.id AND sp.tag LIKE 'project:%')`;
const metadataField = (alias, field) => `json_extract(CASE WHEN json_valid(${alias}.metadata) THEN ${alias}.metadata END, '$.${field}')`;
export const ownFolderNote = (alias = 'e') => `(${metadataField(alias, 'provenance.source')} = '${NOTE_FILE_PROVENANCE}' AND ${metadataField(alias, 'trust')} = 'trusted'`
    + ` AND NOT EXISTS (SELECT 1 FROM tags sm WHERE sm.entity_id = ${alias}.id AND sm.tag = '${NOTE_FILE_MISSING_TAG}'))`;
const SHARED_NOTE_TYPES = [...PREFERENCE_TYPES, SHARED_FEEDBACK_TYPE];
export const folderNoteMayTravel = (alias = 'e') => `(${metadataField(alias, 'provenance.source')} IS NOT '${NOTE_FILE_PROVENANCE}'`
    + ` OR (${alias}.type IN (${SHARED_NOTE_TYPES.map((type) => `'${type}'`).join(',')}) AND ${ownFolderNote(alias)}))`;
export function projectScopeFilter(scope, alias = 'e') {
    const tags = scope === null ? [] : typeof scope === 'string' ? [scope] : scope;
    const marks = (list) => list.map(() => '?').join(',');
    const shared = `(${alias}.type IN (${marks(SHARED_EXPERIENCE_TYPE_LIST)})`
        + ` AND (${alias}.metadata IS NULL OR json_valid(${alias}.metadata))`
        + ` AND ${metadataField(alias, 'trust')} IS NOT 'untrusted'`
        + ` AND ${metadataField(alias, 'provenance.source')} IS NOT '${NOTE_FILE_PROVENANCE}')`
        + ` OR (${alias}.type IN (${marks(SHARED_NOTE_TYPES)}) AND ${ownFolderNote(alias)})`;
    const own = tags.length === 0
        ? ''
        : `EXISTS (SELECT 1 FROM tags st WHERE st.entity_id = ${alias}.id AND st.tag IN (${marks(tags)})) OR `;
    return {
        sql: `AND (${own}${noProjectTag(alias)} OR ${alias}.namespace = 'global' OR ${shared})`,
        params: [...tags, ...SHARED_EXPERIENCE_TYPE_LIST, ...SHARED_NOTE_TYPES],
    };
}
//# sourceMappingURL=project-scope.js.map