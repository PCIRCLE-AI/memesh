import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
function buildLocalMetadata(existingMetadata, overrides) {
    return {
        ...(existingMetadata ?? {}),
        trust: overrides?.trust ?? 'trusted',
        provenance: {
            ...(existingMetadata?.provenance ?? {}),
            source: 'local',
            reviewed_at: new Date().toISOString(),
            ...(overrides?.provenance ?? {}),
        },
    };
}
function recallTagFilter(args) {
    return args.cross_project ? undefined : args.tag;
}
function buildRelevanceMap(entities) {
    return new Map(entities.map((entity, index) => [entity.name, 1 - index / (entities.length + 1)]));
}
export function remember(args) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    return db.transaction(() => rememberInTransaction(args, db, kg)).immediate();
}
function rememberInTransaction(args, db, kg) {
    const existing = db
        .prepare('SELECT id, namespace, type FROM entities WHERE name = ?')
        .get(args.name);
    const entityId = kg.createEntity(args.name, args.type, {
        observations: args.observations,
        tags: args.tags,
        namespace: args.namespace,
        trustOverride: args.trustOverride,
        title: args.title,
    });
    kg.updateEntityMetadata(args.name, (current) => buildLocalMetadata(current, {
        trust: args.trustOverride,
        provenance: {
            ...(args.sourceHost && !existing ? { source_host: args.sourceHost } : {}),
            ...(args.provenanceOverride ?? {}),
        },
    }));
    const relationsCreated = [];
    const relationErrors = [];
    if (args.relations) {
        for (const rel of args.relations) {
            try {
                kg.createRelation(args.name, rel.to, rel.type);
                relationsCreated.push(rel);
            }
            catch (err) {
                relationErrors.push(`Relation to "${rel.to}" failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    const superseded = [];
    if (args.relations) {
        for (const rel of relationsCreated) {
            if (rel.type === 'supersedes') {
                const archiveResult = kg.archiveEntity(rel.to);
                if (archiveResult.archived) {
                    superseded.push(rel.to);
                }
            }
        }
    }
    return {
        stored: true,
        entityId,
        name: args.name,
        ...(args.title !== undefined ? { title: args.title } : {}),
        type: existing?.type ?? args.type,
        observations: args.observations?.length ?? 0,
        tags: args.tags?.length ?? 0,
        relations: relationsCreated.length,
        ...(relationsCreated.length > 0 ? { relationsCreated } : {}),
        ...(existing && args.namespace !== undefined && (existing.namespace ?? 'personal') !== args.namespace
            ? { movedFromNamespace: existing.namespace ?? 'personal' }
            : {}),
        ...(superseded.length > 0 ? { superseded } : {}),
        ...(relationErrors.length > 0 ? { relationErrors } : {}),
    };
}
export function recall(args) {
    const { entities, relevanceMap } = searchAndScore(args);
    return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
}
function searchAndScore(args) {
    const kg = new KnowledgeGraph(getDatabase());
    const entities = kg.search(args.query, {
        tag: recallTagFilter(args),
        limit: args.limit,
        includeArchived: args.include_archived,
        namespace: args.namespace,
    });
    return {
        entities,
        relevanceMap: args.query ? buildRelevanceMap(entities) : new Map(),
    };
}
export async function recallEnhanced(args) {
    const { entities, relevanceMap } = searchAndScore(args);
    if (args.query) {
        for (const entity of entities) {
            entity.match = { source: 'keyword', relevance: relevanceMap.get(entity.name) ?? 0 };
        }
    }
    const limit = args.limit ?? 20;
    const ranked = rankEntities(entities, relevanceMap).slice(0, limit);
    return {
        entities: ranked,
        retrieval: { mode: 'fts', degraded: false, truncated: ranked.length === limit },
    };
}
export async function recallWithConflicts(args) {
    const { entities, retrieval } = await recallEnhanced(args);
    const kg = new KnowledgeGraph(getDatabase());
    const conflicts = kg.findConflicts(entities.map((e) => e.name));
    return { entities, conflicts, retrieval };
}
export { exportMemories, importMemories } from './serializer.js';
export function learn(args) {
    const projectName = getProjectName();
    const result = createExplicitLesson(args.error, args.fix, projectName, {
        rootCause: args.root_cause,
        prevention: args.prevention,
        severity: args.severity,
        sourceHost: args.sourceHost,
    });
    return {
        learned: true,
        name: result.name,
        type: 'lesson_learned',
    };
}
export function forget(args) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    if (args.observation !== undefined) {
        const result = kg.removeObservation(args.name, args.observation);
        return {
            observation_removed: result.removed,
            name: args.name,
            observation: args.observation,
            remaining_observations: result.remainingObservations,
            entity_found: result.entityFound,
        };
    }
    const result = kg.archiveEntity(args.name);
    if (!result.archived) {
        return { archived: false, message: `Entity "${args.name}" not found` };
    }
    return { archived: true, name: args.name };
}
export function setPinned(name, pinned) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const exists = db.prepare('SELECT 1 FROM entities WHERE name = ?').get(name);
    if (!exists)
        return { name, pinned: null, found: false };
    kg.updateEntityMetadata(name, (current) => {
        const next = { ...current };
        if (pinned)
            next.pin = true;
        else
            delete next.pin;
        return next;
    });
    return { name, pinned, found: true };
}
//# sourceMappingURL=operations.js.map