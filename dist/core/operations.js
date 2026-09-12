import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
import { deriveNote, NOTE_DEFAULT_TYPE } from './note-derive.js';
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
export function remember(input) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const { args, derived, typeGiven } = resolveRememberInput(input);
    return db.transaction(() => rememberInTransaction(args, derived, typeGiven, db, kg)).immediate();
}
export const REPLACED_HISTORY_MAX = 20;
export const REPLACED_HISTORY_MAX_BYTES = 64 * 1024;
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
function boundReplacedHistory(history) {
    let out = history.slice(-REPLACED_HISTORY_MAX);
    while (out.length > 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES)
        out = out.slice(1);
    if (out.length === 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES) {
        const only = out[0];
        const kept = [];
        const base = { ...only, observations: [], truncated: true };
        for (const obs of only.observations) {
            if (jsonBytes([{ ...base, observations: [...kept, obs] }]) > REPLACED_HISTORY_MAX_BYTES)
                break;
            kept.push(obs);
        }
        out = [{ ...base, observations: kept }];
    }
    return out;
}
function summarizeReplacedHistory(entities) {
    for (const e of entities) {
        const history = e.metadata?.replaced_history;
        if (!Array.isArray(history))
            continue;
        const { replaced_history: _dropped, ...rest } = e.metadata;
        e.metadata = { ...rest, replaced_history_count: history.length };
    }
    return entities;
}
function resolveRememberInput(input) {
    if (input.note === undefined) {
        if (!input.name || !input.type)
            throw new Error('remember needs `name` and `type`, or `note`');
        return { args: input, typeGiven: true };
    }
    if (input.title !== undefined || input.observations !== undefined) {
        throw new Error('`note` derives title and observations; do not also pass `title` or `observations`');
    }
    const derived = deriveNote(input.note);
    if (!derived)
        throw new Error('`note` is empty after removing control characters');
    if (input.replace && !input.name) {
        throw new Error('`replace` with `note` needs an explicit `name` (a derived name changes with the text)');
    }
    return {
        args: {
            ...input,
            name: input.name ?? derived.name,
            type: input.type ?? NOTE_DEFAULT_TYPE,
            title: derived.title,
            observations: derived.observations,
        },
        derived,
        typeGiven: input.type !== undefined,
    };
}
function rememberInTransaction(args, derived, typeGiven, db, kg) {
    const existing = db
        .prepare('SELECT id, namespace, type, title, status FROM entities WHERE name = ?')
        .get(args.name);
    if (args.replace && existing && existing.status === 'archived') {
        throw new Error(`"${args.name}" was archived with forget; \`replace\` will not overwrite it. `
            + 'Remember it again without `replace` to bring it back, then replace it.');
    }
    let replacedVersion;
    let retypedTo;
    let tags = args.tags;
    let title = args.title;
    let observations = args.observations;
    if (args.replace && existing) {
        const previousTags = db.prepare('SELECT tag FROM tags WHERE entity_id = ? ORDER BY tag').all(existing.id)
            .map((t) => t.tag);
        replacedVersion = {
            replaced_at: new Date().toISOString(),
            title: existing.title,
            observations: db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(existing.id)
                .map((o) => o.content),
            tags: previousTags,
        };
        kg.clearEntityData(args.name);
        if (typeGiven && args.type !== existing.type) {
            db.prepare('UPDATE entities SET type = ? WHERE id = ?').run(args.type, existing.id);
            retypedTo = args.type;
        }
        if (tags === undefined)
            tags = previousTags;
    }
    else if (derived && existing) {
        title = undefined;
        const stored = new Set(db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(existing.id)
            .map((o) => o.content));
        observations = observations?.filter((o) => !stored.has(o));
    }
    const entityId = kg.createEntity(args.name, args.type, {
        observations,
        tags,
        namespace: args.namespace,
        trustOverride: args.trustOverride,
        title,
    });
    kg.updateEntityMetadata(args.name, (current) => buildLocalMetadata(current, {
        trust: args.trustOverride,
        provenance: {
            ...(args.sourceHost && !existing ? { source_host: args.sourceHost } : {}),
            ...(args.provenanceOverride ?? {}),
        },
    }));
    if (replacedVersion) {
        const version = replacedVersion;
        kg.updateEntityMetadata(args.name, (current) => {
            const history = Array.isArray(current.replaced_history) ? current.replaced_history : [];
            return { ...current, replaced_history: boundReplacedHistory([...history, version]) };
        });
    }
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
        ...(title !== undefined ? { title } : {}),
        type: retypedTo ?? existing?.type ?? args.type,
        observations: observations?.length ?? 0,
        tags: tags?.length ?? 0,
        relations: relationsCreated.length,
        ...(relationsCreated.length > 0 ? { relationsCreated } : {}),
        ...(existing && args.namespace !== undefined && (existing.namespace ?? 'personal') !== args.namespace
            ? { movedFromNamespace: existing.namespace ?? 'personal' }
            : {}),
        ...(superseded.length > 0 ? { superseded } : {}),
        ...(relationErrors.length > 0 ? { relationErrors } : {}),
        ...(args.replace ? { replaced: replacedVersion !== undefined } : {}),
        ...(derived
            ? { derived: { name: args.name, type: retypedTo ?? existing?.type ?? args.type, title: derived.title, observations: derived.observations } }
            : {}),
    };
}
export function recall(args) {
    const { entities, relevanceMap } = searchAndScore(args);
    return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
}
function searchAndScore(args) {
    const kg = new KnowledgeGraph(getDatabase());
    const entities = summarizeReplacedHistory(kg.search(args.query, {
        tag: recallTagFilter(args),
        limit: args.limit,
        includeArchived: args.include_archived,
        namespace: args.namespace,
    }));
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