import { createHash } from 'node:crypto';
import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { projectOwnershipRefusal } from '../storage/memory-mutation.js';
import { remember, shownEntity } from './operations.js';
export async function editMemoryInteractively(name, project, sourceHost, ask, expectedRevision) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const snapshot = () => {
        const refusal = projectOwnershipRefusal(db, name, project);
        if (refusal)
            throw new Error(refusal);
        const entity = kg.getEntity(name);
        if (!entity || entity.archived)
            throw new Error('memory_not_found: Choose an active memory from recall.');
        const row = db.prepare('SELECT metadata FROM entities WHERE name = ?').get(name);
        if (row.metadata) {
            let metadata;
            try {
                metadata = JSON.parse(row.metadata);
            }
            catch { }
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
                throw new Error('metadata_unreadable: The original metadata was left unchanged.');
            }
        }
        const revision = createHash('sha256').update(JSON.stringify([
            entity.id, entity.title, entity.type, entity.archived, entity.observations, entity.tags, row.metadata,
        ])).digest('hex');
        return { entity, revision };
    };
    const before = snapshot();
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
        throw new Error('memory_changed: Reload this memory before saving; your edit was not applied.');
    }
    const viewOf = (entity) => {
        const shown = shownEntity(entity);
        return {
            name: shown.name, project, type: shown.type, createdAt: shown.created_at,
            title: shown.title ?? '', body: shown.observations.join('\n\n'), observations: shown.observations,
        };
    };
    const view = viewOf(before.entity);
    if (view.body.length > 16_000 || before.entity.observations.length > 100) {
        throw new Error('memory_too_large: Use the existing targeted memory tools; no text was clipped or saved.');
    }
    const shownObservations = shownEntity(before.entity).observations;
    const fields = await ask(view, shownObservations);
    if (fields === undefined)
        return { status: 'ready', memory: view, revision: before.revision };
    if (fields === null)
        return { status: 'cancelled', memory: view };
    return db.transaction(() => {
        const current = snapshot();
        if (current.revision !== before.revision)
            throw new Error('memory_changed: Reload this memory before saving; your edit was not applied.');
        const contentUnchanged = JSON.stringify(fields.observations) === JSON.stringify(shownObservations);
        if (fields.title === view.title && contentUnchanged)
            return { status: 'unchanged', memory: view };
        if (!contentUnchanged && JSON.stringify(shownObservations) !== JSON.stringify(before.entity.observations)) {
            throw new Error('masked_content: Edit the individual observation with the existing memory tools; hidden text was left unchanged.');
        }
        remember({
            name, replace: true, project, sourceHost, reinforceConfidence: false,
            ...(fields.title !== view.title ? { title: fields.title } : {}),
            observations: contentUnchanged ? before.entity.observations : fields.observations,
        });
        return { status: 'saved', memory: viewOf(kg.getEntity(name)) };
    }).immediate();
}
//# sourceMappingURL=native-memory-editor.js.map