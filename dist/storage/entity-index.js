import { indexedObservationText, removeFromFts } from './fts-index.js';
export function dropEntityFromIndexes(db, entityId, name) {
    const titleRow = db
        .prepare('SELECT title FROM entities WHERE id = ?')
        .get(entityId);
    removeFromFts(db, entityId, name, indexedObservationText(db, entityId), titleRow?.title ?? null);
}
//# sourceMappingURL=entity-index.js.map