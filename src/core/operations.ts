// =============================================================================
// Core Operations — pure business logic, no MCP/transport dependencies
// Imported by: transports/mcp, transports/http, transports/cli
//
// Contracts:
//   - No Zod validation (transports handle that)
//   - No ToolResult wrapping (transports handle that)
//   - No top-level try/catch (transports handle errors)
//   - Returns typed results directly
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
import type {
  RememberInput,
  RememberResult,
  RecallInput,
  ForgetInput,
  ForgetResult,
  LearnInput,
  LearnResult,
  Entity,
} from './types.js';

type EntityMetadata = {
  trust?: 'trusted' | 'untrusted';
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
};

function buildLocalMetadata(
  existingMetadata: EntityMetadata | undefined,
  overrides?: { trust?: 'trusted' | 'untrusted'; provenance?: Record<string, unknown> }
): EntityMetadata {
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

function recallTagFilter(args: RecallInput): string | undefined {
  return args.cross_project ? undefined : args.tag;
}

/**
 * Turn search results into the relevance input for `rankEntities`.
 *
 * `search()` returns FTS5 hits in BM25 order, so position carries the relevance
 * signal: first hit 1.0, last just above 0. Handing every hit the same value
 * instead would tie them on the 0.30 relevance factor and let `rankEntities`
 * re-sort purely on recency/frequency/confidence, discarding the ordering the
 * search just computed. Callers with no query pass an empty map — there is no
 * relevance signal on the recent-list path, and `rankEntities` already treats a
 * missing entry as the neutral 0.5.
 */
function buildRelevanceMap(entities: Entity[]): Map<string, number> {
  return new Map(entities.map((entity, index) => [entity.name, 1 - index / (entities.length + 1)]));
}

/**
 * Store knowledge as an entity with observations, tags, and relations.
 * If entity exists, appends observations and dedupes tags.
 * If any relation has type "supersedes", auto-archives the target entity.
 */
export function remember(args: RememberInput): RememberResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);
  // Only existence + namespace are consumed below — a full kg.getEntity()
  // here cost 4 queries (entity, observations, tags, relations) with the
  // observation text materialized and thrown away, on the write hot path
  // (also hit per-entity by importMemories/createEntitiesBatch).
  const existing = db
    .prepare('SELECT id, namespace FROM entities WHERE name = ?')
    .get(args.name) as { id: number; namespace: string | null } | undefined;

  // Trust signal MUST arrive at createEntity time so the confidence-
  // bump gate (knowledge-graph.ts) can deny it for untrusted callers.
  // Codex review caught a P1 where the trust was being written via
  // updateEntityMetadata AFTER createEntity returned, leaving the gate
  // looking at undefined and defaulting to trusted.
  const entityId = kg.createEntity(args.name, args.type, {
    observations: args.observations,
    tags: args.tags,
    namespace: args.namespace,
    trustOverride: args.trustOverride,
    title: args.title,
  });
  // `current`, not the snapshot taken before `createEntity`. The updater used
  // to ignore what it was handed and rebuild from `existing?.metadata`, which
  // silently discarded everything `createEntity` had just written — the
  // `previous_namespace` breadcrumb that makes a namespace move undoable, and
  // the `signal_score` every new entity is stamped with.
  //
  // No `?? existing?.metadata` fallback: `updateEntityMetadata` hands over
  // `parseMetadata(row.metadata)`, which returns `{}` for null, for non-object
  // JSON and for a parse failure — so `current` is never nullish, and a
  // fallback there would read as a safety net that cannot fire.
  kg.updateEntityMetadata(args.name, (current) => buildLocalMetadata(
    current as EntityMetadata,
    {
      trust: args.trustOverride,
      // source_host is stamped on FIRST insert only — `!existing` — because
      // buildLocalMetadata spreads these overrides over the stored provenance,
      // so stamping on every call would let host B's re-remember of host A's
      // entity silently rewrite the attribution this field exists to preserve.
      // Same invariant as the hook path (captureEntity's INSERT OR IGNORE),
      // and the one the CHANGELOG promises. source_host first so an explicit
      // provenanceOverride stays authoritative.
      provenance: {
        ...(args.sourceHost && !existing ? { source_host: args.sourceHost } : {}),
        ...(args.provenanceOverride ?? {}),
      },
    }
  ));

  // Create relations (target entities must already exist)
  const relationsCreated: Array<{ to: string; type: string }> = [];
  const relationErrors: string[] = [];

  if (args.relations) {
    for (const rel of args.relations) {
      try {
        kg.createRelation(args.name, rel.to, rel.type);
        relationsCreated.push(rel);
      } catch (err) {
        relationErrors.push(`Relation to "${rel.to}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Auto-archive entities that are superseded
  const superseded: string[] = [];
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
    type: args.type,
    observations: args.observations?.length ?? 0,
    tags: args.tags?.length ?? 0,
    relations: relationsCreated.length,
    ...(relationsCreated.length > 0 ? { relationsCreated } : {}),
    // Only when it actually moved: same-scope re-remembers say nothing.
    ...(existing && args.namespace !== undefined && (existing.namespace ?? 'personal') !== args.namespace
      ? { movedFromNamespace: existing.namespace ?? 'personal' }
      : {}),
    ...(superseded.length > 0 ? { superseded } : {}),
    ...(relationErrors.length > 0 ? { relationErrors } : {}),
  };
}

/**
 * Search and retrieve stored knowledge.
 * Uses FTS5 full-text search with optional tag filtering.
 * Results are ranked by multi-factor score: relevance (0.30, the BM25 position
 * `search()` returned them in), recency (0.25), access frequency (0.18),
 * confidence (0.17), recall-effectiveness impact (0.10).
 * Empty query returns recent entities.
 */
export function recall(args: RecallInput): Entity[] {
  const { entities, relevanceMap } = searchAndScore(args);
  return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
}

/**
 * The half of recall that both entry points share: run the search, and turn its
 * output into the relevance input for `rankEntities`.
 *
 * `recall()` and `recallEnhanced()` share this FTS-backed implementation so
 * ranking behavior cannot drift between the two public entry points.
 */
function searchAndScore(args: RecallInput): { entities: Entity[]; relevanceMap: Map<string, number> } {
  const kg = new KnowledgeGraph(getDatabase());
  // cross_project=true means don't filter by project tag — pass no tag to search all projects
  const entities = kg.search(args.query, {
    tag: recallTagFilter(args),
    limit: args.limit,
    includeArchived: args.include_archived,
    namespace: args.namespace,
  });
  return {
    entities,
    relevanceMap: args.query ? buildRelevanceMap(entities) : new Map<string, number>(),
  };
}

/** Retrieval facts for the FTS-only recall path. */
export interface RetrievalMeta {
  mode: 'fts';
  /** Deprecated compatibility field; FTS-only retrieval cannot degrade. */
  degraded: false;
  /** The bounded result window filled; more matching entities may exist. */
  truncated: boolean;
}

export async function recallEnhanced(
  args: RecallInput,
): Promise<{ entities: Entity[]; retrieval: RetrievalMeta }> {
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

/**
 * recallEnhanced + conflict annotation. The MCP, HTTP, and CLI transports each
 * hand-rolled `recall → new KnowledgeGraph → findConflicts → wrap`; lifting it
 * here makes "recall results carry conflict annotations" a single core rule the
 * transports can't drift on. Always returns `conflicts` (possibly empty) — how
 * to present them (omit when empty, render inline, etc.) stays a transport call.
 */
export async function recallWithConflicts(args: RecallInput) {
  const { entities, retrieval } = await recallEnhanced(args);
  const kg = new KnowledgeGraph(getDatabase());
  const conflicts = kg.findConflicts(entities.map((e) => e.name));
  return { entities, conflicts, retrieval };
}

// --- Serialization (extracted to serializer.ts) ---
export { exportMemories, importMemories } from './serializer.js';

// Noise compression (compressWeeklyNoise) is consumed only by
// session-start.js via dynamic import from dist/core/lifecycle.js, and
// by tests/core/lifecycle.test.ts which imports from lifecycle.js
// directly. No transport calls it. Re-exporting here was dead weight.

/**
 * Create a structured lesson_learned entity from explicit user input.
 * Does not require an LLM — the user provides the structured fields directly.
 * Uses createExplicitLesson from lesson-engine to build and store the entity.
 */
export function learn(args: LearnInput): LearnResult {
  const projectName = getProjectName();

  const result = createExplicitLesson(
    args.error,
    args.fix,
    projectName,
    {
      rootCause: args.root_cause,
      prevention: args.prevention,
      severity: args.severity,
      sourceHost: args.sourceHost,
    }
  );

  return {
    learned: true,
    name: result.name,
    type: 'lesson_learned',
  };
}

/**
 * Archive an entity (soft-delete) or remove a specific observation.
 * Never permanently deletes data.
 */
export function forget(args: ForgetInput): ForgetResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  // Observation-level forget: remove specific observation, keep entity active.
  //
  // `!== undefined`, not truthiness. `""` is a PRESENT selector, and treating
  // it as absent sent a request scoped to one observation into the branch that
  // archives the whole memory — reported as `{archived:true}`, which does not
  // even mention the observation the caller targeted. The schema now rejects
  // an empty string outright (`.min(1)`), so this branch and that one are the
  // only two states left: a selector was given, or it was not.
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

  // Entity-level forget: archive (soft-delete)
  const result = kg.archiveEntity(args.name);

  if (!result.archived) {
    return { archived: false, message: `Entity "${args.name}" not found` };
  }

  return { archived: true, name: args.name };
}

/**
 * Pin or unpin an entity. Agent work-package preparation excludes pinned
 * entities, so this remains the user's deterministic protection control.
 */
export function setPinned(
  name: string,
  pinned: boolean,
): { name: string; pinned: boolean | null; found: boolean } {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);
  const exists = db.prepare('SELECT 1 FROM entities WHERE name = ?').get(name);
  if (!exists) return { name, pinned: null, found: false };

  kg.updateEntityMetadata(name, (current) => {
    const next = { ...current };
    if (pinned) next.pin = true;
    else delete next.pin;
    return next;
  });

  return { name, pinned, found: true };
}
