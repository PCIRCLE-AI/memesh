import { NOTE_FILE_PROVENANCE, SHARED_EXPERIENCE_TYPE_LIST, SHARED_FEEDBACK_TYPE } from './work-topology.js';
export const noProjectTag = (alias = 'e') => `NOT EXISTS (SELECT 1 FROM tags sp WHERE sp.entity_id = ${alias}.id AND sp.tag LIKE 'project:%')`;
export const ownFolderNote = (alias = 'e') => `(json_extract(${alias}.metadata, '$.provenance.source') = '${NOTE_FILE_PROVENANCE}' AND json_extract(${alias}.metadata, '$.trust') = 'trusted')`;
export function projectScopeFilter(scope, alias = 'e') {
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
//# sourceMappingURL=project-scope.js.map