import { indexedObservationText, insertFtsRow, removeFromFts } from './fts-index.js';
export function runEntityWrite(db, write) {
    return db.transaction(write)();
}
export function insertOrGetEntity(db, entity) {
    const insertResult = entity.namespace === undefined
        ? db
            .prepare('INSERT OR IGNORE INTO entities (name, type, metadata, title) VALUES (?, ?, ?, ?)')
            .run(entity.name, entity.type, entity.metadataJson, entity.title)
        : db
            .prepare('INSERT OR IGNORE INTO entities (name, type, metadata, namespace, title) VALUES (?, ?, ?, ?, ?)')
            .run(entity.name, entity.type, entity.metadataJson, entity.namespace, entity.title);
    const isNew = insertResult.changes > 0;
    const row = db
        .prepare('SELECT id, type, title, status, namespace, metadata FROM entities WHERE name = ?')
        .get(entity.name);
    if (!row)
        return null;
    return { ...row, isNew };
}
export function appendObservations(db, entityId, observations, options) {
    const seen = new Set(options.dedupe && options.readExisting
        ? db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(entityId).map((o) => o.content)
        : []);
    const written = [];
    for (const observation of observations) {
        if (options.exclude?.(observation))
            continue;
        if (options.dedupe) {
            if (seen.has(observation))
                continue;
            seen.add(observation);
        }
        written.push(observation);
    }
    const insertObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
    for (const observation of written)
        insertObs.run(entityId, observation);
    return written;
}
export function addTags(db, entityId, tags) {
    const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
    for (const tag of tags)
        insertTag.run(entityId, tag);
}
export function reindexEntityFts(db, entityId, name, previous, current = {}) {
    if (previous !== undefined) {
        removeFromFts(db, entityId, name, previous.observationsText, previous.title);
    }
    const observationsText = 'observationsText' in current && current.observationsText !== undefined
        ? current.observationsText
        : indexedObservationText(db, entityId);
    const title = 'title' in current
        ? (current.title ?? null)
        : (db.prepare('SELECT title FROM entities WHERE id = ?').get(entityId)?.title ?? null);
    insertFtsRow(db, entityId, name, observationsText, title);
}
//# sourceMappingURL=entity-write.js.map