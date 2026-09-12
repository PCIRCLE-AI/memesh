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
import { deriveNote, NOTE_DEFAULT_TYPE, type DerivedNote } from './note-derive.js';
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
export function remember(input: RememberInput): RememberResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);
  const { args, derived, typeGiven } = resolveRememberInput(input);
  // `remember` is one logical write: the source entity (including metadata),
  // every accepted relation, and every superseded target must either all land
  // or all roll back. The narrower KnowledgeGraph transactions protect their
  // own rows, but without this outer boundary a failure while archiving a
  // superseded target left the new source and relation committed.
  return db.transaction(() => rememberInTransaction(args, derived, typeGiven, db, kg)).immediate();
}

/** Most previous versions a replaced memory keeps in `metadata.replaced_history`. */
export const REPLACED_HISTORY_MAX = 20;
/**
 * Most bytes (serialized JSON) the history may take. The count alone did not
 * bound it: a 256 KB note replaced twenty times is megabytes of metadata on
 * one row. Oldest versions go first; a single version larger than the cap
 * keeps as many of its observations as fit and is marked `truncated`.
 */
export const REPLACED_HISTORY_MAX_BYTES = 64 * 1024;

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** Apply both history bounds. */
function boundReplacedHistory(history: ReplacedVersion[]): ReplacedVersion[] {
  let out = history.slice(-REPLACED_HISTORY_MAX);
  while (out.length > 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES) out = out.slice(1);
  if (out.length === 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES) {
    const only = out[0];
    const kept: string[] = [];
    const base = { ...only, observations: [] as string[], truncated: true };
    for (const obs of only.observations) {
      if (jsonBytes([{ ...base, observations: [...kept, obs] }]) > REPLACED_HISTORY_MAX_BYTES) break;
      kept.push(obs);
    }
    out = [{ ...base, observations: kept }];
  }
  return out;
}

/**
 * Recall answers carry `replaced_history_count` instead of the history
 * itself: every hit's metadata is serialized to the caller, and the history
 * is the one field that can be large. The full history stays readable from
 * `export` and `GET /v1/entities/:name`.
 */
function summarizeReplacedHistory(entities: Entity[]): Entity[] {
  for (const e of entities) {
    const history = e.metadata?.replaced_history;
    if (!Array.isArray(history)) continue;
    const { replaced_history: _dropped, ...rest } = e.metadata!;
    e.metadata = { ...rest, replaced_history_count: history.length };
  }
  return entities;
}

export interface ReplacedVersion {
  replaced_at: string;
  title: string | null;
  observations: string[];
  tags: string[];
  /** Set when the version alone exceeded the byte cap and lost observations. */
  truncated?: boolean;
}

type ResolvedRememberInput = RememberInput & { name: string; type: string };

/**
 * Turn the `note` form into the structured form, or check the structured form
 * is complete. The transports' RememberSchema rejects the same shapes first,
 * with a message naming the key; these throws are for direct core callers.
 */
function resolveRememberInput(
  input: RememberInput,
): { args: ResolvedRememberInput; derived?: DerivedNote; typeGiven: boolean } {
  if (input.note === undefined) {
    if (!input.name || !input.type) throw new Error('remember needs `name` and `type`, or `note`');
    return { args: input as ResolvedRememberInput, typeGiven: true };
  }
  if (input.title !== undefined || input.observations !== undefined) {
    throw new Error('`note` derives title and observations; do not also pass `title` or `observations`');
  }
  const derived = deriveNote(input.note);
  if (!derived) throw new Error('`note` is empty after removing control characters');
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
    // The note form DEFAULTS the type, so `args.type` alone cannot tell a
    // caller who asked for `note` from one who said nothing. The replace path
    // below rewrites the stored type, and rewriting a decision into a `note`
    // because the caller omitted the field would be the same class of silent
    // change it exists to end.
    typeGiven: input.type !== undefined,
  };
}

function rememberInTransaction(
  args: ResolvedRememberInput,
  derived: DerivedNote | undefined,
  typeGiven: boolean,
  db: ReturnType<typeof getDatabase>,
  kg: KnowledgeGraph,
): RememberResult {
  // Only existence + namespace are consumed below — a full kg.getEntity()
  // here cost 4 queries (entity, observations, tags, relations) with the
  // observation text materialized and thrown away, on the write hot path
  // (also hit per-entity by importMemories/createEntitiesBatch).
  const existing = db
    .prepare('SELECT id, namespace, type, title, status FROM entities WHERE name = ?')
    .get(args.name) as { id: number; namespace: string | null; type: string; title: string | null; status: string } | undefined;

  // An explicit `forget` is not undone by a rewrite. `replace` clears the
  // observations and files the old ones into replaced_history, so on an
  // archived memory it would leave a live-looking memory the user had
  // deliberately deleted, with the text they deleted still in its metadata.
  // note-ingest.ts refuses exactly this for a note file; a direct call did
  // not, and `replace` is new in this release.
  //
  // Refusing does not make the name unwritable: plain `remember` reactivates
  // an archived row (knowledge-graph.ts createEntity) and is append-only, so
  // the recovery named here is a real one — pinned by a test, because an
  // error message that recommends something that does not work is its own
  // defect.
  if (args.replace && existing && existing.status === 'archived') {
    throw new Error(
      `"${args.name}" was archived with forget; \`replace\` will not overwrite it. `
      + 'Remember it again without `replace` to bring it back, then replace it.',
    );
  }

  // `replace: true` on a memory that exists: capture what is there, then
  // clear it through `clearEntityData`, which deletes the contentless-FTS row
  // with the EXACT text that was indexed before removing the observations —
  // the only order that leaves no stale tokens behind. `createEntity` below
  // then writes the new content as if onto an empty entity. Nested inside
  // this transaction, clearEntityData's own transaction is a SAVEPOINT, so a
  // failure anywhere below rolls the clear back too.
  let replacedVersion: ReplacedVersion | undefined;
  /** Set when the replace path rewrote the stored type, so the receipt can report it. */
  let retypedTo: string | undefined;
  let tags = args.tags;
  let title = args.title;
  let observations = args.observations;
  if (args.replace && existing) {
    const previousTags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ? ORDER BY tag').all(existing.id) as { tag: string }[])
      .map((t) => t.tag);
    replacedVersion = {
      replaced_at: new Date().toISOString(),
      title: existing.title,
      observations: (db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(existing.id) as { content: string }[])
        .map((o) => o.content),
      tags: previousTags,
    };
    kg.clearEntityData(args.name);
    // The type is part of what `replace` replaces. `createEntity` below uses
    // INSERT OR IGNORE, which leaves the stored type alone, and the clear
    // above only removes observations and tags — so a note file reclassified
    // from feedback to decision kept answering as feedback while the receipt
    // said `replaced`. `type` is not in the FTS document (name and
    // observations are — storage/fts-index.ts), so this needs no reindex.
    if (typeGiven && args.type !== existing.type) {
      db.prepare('UPDATE entities SET type = ? WHERE id = ?').run(args.type, existing.id);
      retypedTo = args.type;
    }
    // Tags omitted means "keep them" — clearEntityData dropped them, so they
    // go back. Replacing a memory's text must not silently untag it from its
    // project.
    if (tags === undefined) tags = previousTags;
  } else if (derived && existing) {
    // A note appended to a memory that already exists (the same text again,
    // or an explicit `name`): its first line must not overwrite the title the
    // memory already has, and a repeat must add nothing — including for the
    // lesson family, whose append path deliberately keeps repeats.
    title = undefined;
    const stored = new Set((db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(existing.id) as { content: string }[])
      .map((o) => o.content));
    observations = observations?.filter((o) => !stored.has(o));
  }

  // Trust signal MUST arrive at createEntity time so the confidence-
  // bump gate (knowledge-graph.ts) can deny it for untrusted callers.
  // Codex review caught a P1 where the trust was being written via
  // updateEntityMetadata AFTER createEntity returned, leaving the gate
  // looking at undefined and defaulting to trusted.
  const entityId = kg.createEntity(args.name, args.type, {
    observations,
    tags,
    namespace: args.namespace,
    trustOverride: args.trustOverride,
    title,
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
  if (replacedVersion) {
    const version = replacedVersion;
    kg.updateEntityMetadata(args.name, (current) => {
      const history = Array.isArray(current.replaced_history) ? current.replaced_history as ReplacedVersion[] : [];
      return { ...current, replaced_history: boundReplacedHistory([...history, version]) };
    });
  }

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
    ...(title !== undefined ? { title } : {}),
    // `createEntity` preserves the stored type on a name collision. Report
    // that persisted value too; echoing args.type made a duplicate remember
    // receipt claim a type that was never written. The replace path is the
    // one place the stored type DOES change, and `retypedTo` carries it.
    type: retypedTo ?? existing?.type ?? args.type,
    observations: observations?.length ?? 0,
    tags: tags?.length ?? 0,
    relations: relationsCreated.length,
    ...(relationsCreated.length > 0 ? { relationsCreated } : {}),
    // Only when it actually moved: same-scope re-remembers say nothing.
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
  const entities = summarizeReplacedHistory(kg.search(args.query, {
    tag: recallTagFilter(args),
    limit: args.limit,
    includeArchived: args.include_archived,
    namespace: args.namespace,
  }));
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
