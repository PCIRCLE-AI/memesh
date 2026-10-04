// =============================================================================
// Recall — the agent-facing view (#494)
//
// The MCP `recall` tool and the CLI `memesh recall` (including `--json`) put
// their answer straight into an agent's context. Nothing capped either the
// size of one returned entity or the whole response, so a single memory with
// many observations (157 observations, 58.8 KB of text, seen on a real
// graph) or many `file:*` tags (auto-captured, meant for pre-edit recall's
// own DB lookups — see scripts/hooks/pre-edit-recall.js and
// src/core/why.ts, neither of which goes through recall) could burn a large
// slice of the context window on one hit.
//
// This module is the ONE shared place that caps the agent-facing view. It is
// pure and DB-free — callers pass in the already-fetched result from
// `recallWithConflicts`. The HTTP API (`POST /v1/recall`, the dashboard's
// data source) calls `recallWithConflicts` directly and does NOT go through
// here — that is the decided scope of #494, not an oversight.
// =============================================================================

import type { Entity } from './types.js';
import type { RetrievalMeta } from './operations.js';

/** Per-entity budget: observations + tags, as UTF-8 bytes of their
 *  JSON-serialized form — the bytes the wire payload actually carries. */
export const RECALL_ENTITY_CONTENT_MAX_BYTES = 8 * 1024;

/** Whole-response budget, same accounting, for `entities` + `conflicts` +
 *  `retrieval` together. */
export const RECALL_RESPONSE_MAX_BYTES = 32 * 1024;

// Room left for the `truncated`/`entities_omitted` keys a caller adds AFTER
// the entity-count decision below (see capRecallForAgent). Keeping this
// fixed margin means "fits in RECALL_RESPONSE_MAX_BYTES" stays true once
// those keys are added, without having to know their exact final shape
// up front.
const RESPONSE_METADATA_RESERVE_BYTES = 128;

export interface RecallTruncationInfo {
  observations?: { shown: number; total: number };
  tags?: { shown: number; total: number };
}

export type AgentRecallEntity = Entity & { truncated?: RecallTruncationInfo; projects?: string[] };

/** What a project-scoped recall searched; `project` null: no project. */
export interface RecallScope {
  project: string | null;
  searched: string;
}

export interface RecallForAgentResult {
  entities: AgentRecallEntity[];
  /** Always present, possibly empty — same contract `recallWithConflicts`
   *  documents; omitting it when empty stays a transport (MCP/CLI) choice. */
  conflicts: string[];
  retrieval: RetrievalMeta;
  /** Present (true) iff anything was cut anywhere in this response: an
   *  entity's own `truncated`, or whole entities dropped below. Distinct
   *  from `retrieval.truncated`, which means "the search LIMIT window
   *  filled" and says nothing about response size. */
  truncated?: true;
  /** Present iff whole entities were dropped from the end to keep the
   *  response under RECALL_RESPONSE_MAX_BYTES. */
  entities_omitted?: { shown: number; total: number };
  /** Present iff the caller asked for project labels (a project-scoped
   *  recall): each entity then also carries `projects`. */
  scope?: RecallScope;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a
 *  multi-byte character in half. Returns how many bytes were cut. */
function truncateToBytes(text: string, maxBytes: number): { text: string; cutBytes: number } {
  if (maxBytes <= 0) return { text: '', cutBytes: byteLength(text) };
  const full = Buffer.from(text, 'utf8');
  if (full.byteLength <= maxBytes) return { text, cutBytes: 0 };
  let sliceLen = maxBytes;
  // A UTF-8 continuation byte has the top two bits `10`; back off until we
  // land on a lead byte (or an ASCII byte) so the kept text stays valid.
  while (sliceLen > 0 && (full[sliceLen] & 0xc0) === 0x80) sliceLen--;
  const kept = full.subarray(0, sliceLen).toString('utf8');
  return { text: kept, cutBytes: full.byteLength - byteLength(kept) };
}

/** Bytes a JSON array would need with `item` appended to the already-kept
 *  `kept` list — the one check both packers below need before adding one
 *  more whole item. */
function bytesWith(kept: string[], item: string): number {
  return byteLength(JSON.stringify([...kept, item]));
}

/** Cut one observation so that `[<it>]` fits in `budgetBytes` of JSON, with
 *  a marker saying how many bytes were cut. Measured as JSON, not raw UTF-8:
 *  a quote, backslash or newline costs 2 bytes once serialized, a control
 *  character 6. Null when not even the marker alone fits. */
function cutToFit(obs: string, budgetBytes: number): string | null {
  let limit = budgetBytes;
  for (;;) {
    const { text, cutBytes } = truncateToBytes(obs, limit);
    const marked = `${text}${text ? ' ' : ''}… (+${cutBytes} more bytes)`;
    const jsonBytes = bytesWith([], marked);
    if (jsonBytes <= budgetBytes) return marked;
    if (limit === 0) return null;
    // Shrink in proportion to the overshoot, and always by at least a byte.
    limit = Math.max(0, Math.min(limit - 1, Math.floor((limit * budgetBytes) / jsonBytes)));
  }
}

/** Pack `tags` (in order) into `budgetBytes` of JSON-array bytes, dropping
 *  whole tags from the end. Tags are short labels — never cut mid-string. */
function packTags(tags: string[], budgetBytes: number): { kept: string[]; total: number } {
  const kept: string[] = [];
  for (const tag of tags) {
    if (bytesWith(kept, tag) > budgetBytes) break;
    kept.push(tag);
  }
  return { kept, total: tags.length };
}

/**
 * Pack `observations` (in order) into `budgetBytes` of JSON-array bytes,
 * dropping whole observations from the end (keep the first ones) — except
 * when the very FIRST observation alone already exceeds the whole budget:
 * showing zero observations when at least one exists would hide the entity's
 * content entirely, so that one observation is cut mid-way and marked
 * instead of dropped. Only when the tags have left too little room for even
 * the marker does it show none (still reported as `shown: 0`).
 */
function packObservations(
  observations: string[],
  budgetBytes: number,
): { kept: string[]; total: number; cutMidway: boolean } {
  const total = observations.length;

  const kept: string[] = [];
  let cutMidway = false;
  for (const obs of observations) {
    if (bytesWith(kept, obs) <= budgetBytes) {
      kept.push(obs);
      continue;
    }
    if (kept.length === 0) {
      const cut = cutToFit(obs, budgetBytes);
      if (cut !== null) {
        kept.push(cut);
        cutMidway = true;
      }
    }
    break; // Everything from here on is dropped, whether we just cut the
           // first observation or hit budget on a later whole one.
  }
  return { kept, total, cutMidway };
}

/** Cap one entity's observations + tags to RECALL_ENTITY_CONTENT_MAX_BYTES,
 *  and always drop `file:*` tags (a fixed default, not size-driven — they
 *  exist for pre-edit recall's own DB lookups, not for an agent to read). */
function capEntityForAgent(entity: Entity, labelProject: boolean): AgentRecallEntity {
  const visibleTags = (entity.tags ?? []).filter((t) => !t.startsWith('file:'));
  const observations = entity.observations ?? [];

  const tagsResult = packTags(visibleTags, RECALL_ENTITY_CONTENT_MAX_BYTES);
  const tagsBytesUsed = byteLength(JSON.stringify(tagsResult.kept));
  const observationsBudget = Math.max(0, RECALL_ENTITY_CONTENT_MAX_BYTES - tagsBytesUsed);
  const obsResult = packObservations(observations, observationsBudget);

  const truncated: RecallTruncationInfo = {};
  if (obsResult.kept.length < obsResult.total || obsResult.cutMidway) {
    truncated.observations = { shown: obsResult.kept.length, total: obsResult.total };
  }
  if (tagsResult.kept.length < tagsResult.total) {
    truncated.tags = { shown: tagsResult.kept.length, total: tagsResult.total };
  }

  const capped: AgentRecallEntity = { ...entity, tags: tagsResult.kept, observations: obsResult.kept };
  // Every project the memory belongs to ([] for none), read from the uncapped
  // tags: the tag cap may drop a project tag itself, and a memory can carry several.
  if (labelProject) capped.projects = (entity.tags ?? []).filter((t) => t.startsWith('project:')).map((t) => t.slice('project:'.length)).sort();
  if (Object.keys(truncated).length > 0) capped.truncated = truncated;
  return capped;
}

/**
 * Cap a recall result for an agent-facing surface (MCP tool, CLI): each
 * entity's observations+tags to RECALL_ENTITY_CONTENT_MAX_BYTES, the whole
 * response to RECALL_RESPONSE_MAX_BYTES (dropping whole entities from the
 * end once every remaining one is already individually capped), and
 * `file:*` tags omitted throughout. With `scope`, each entity is labelled
 * with its project and the scope travels in the response, both counted in
 * the response budget. Pure and DB-free.
 */
export function capRecallForAgent(result: {
  entities: Entity[];
  conflicts: string[];
  retrieval: RetrievalMeta;
}, scope?: RecallScope): RecallForAgentResult {
  const cappedEntities = result.entities.map((e) => capEntityForAgent(e, scope !== undefined));
  const totalEntities = cappedEntities.length;
  const responseBudget = RECALL_RESPONSE_MAX_BYTES - RESPONSE_METADATA_RESERVE_BYTES;

  // Entities arrive already ranked (most relevant first, per rankEntities);
  // walk down from "keep everything" so we keep the longest relevant
  // prefix that fits, not an arbitrary subset.
  let shownCount = 0;
  for (let count = totalEntities; count >= 0; count--) {
    const candidateBytes = byteLength(JSON.stringify({
      entities: cappedEntities.slice(0, count),
      conflicts: result.conflicts,
      retrieval: result.retrieval,
      scope,
    }));
    if (candidateBytes <= responseBudget) {
      shownCount = count;
      break;
    }
  }

  const shownEntities = cappedEntities.slice(0, shownCount);
  const entitiesDropped = shownCount < totalEntities;
  const anyContentTruncated = shownEntities.some((e) => e.truncated !== undefined);

  const envelope: RecallForAgentResult = {
    entities: shownEntities,
    conflicts: result.conflicts,
    retrieval: result.retrieval,
  };
  if (anyContentTruncated || entitiesDropped) envelope.truncated = true;
  if (entitiesDropped) envelope.entities_omitted = { shown: shownCount, total: totalEntities };
  if (scope) envelope.scope = scope;
  return envelope;
}

/** The wire envelope MCP and CLI --json both emit: keys in this fixed order,
 *  optional ones present only when set. */
export function agentRecallEnvelope(r: RecallForAgentResult) {
  return {
    entities: r.entities,
    retrieval: r.retrieval,
    ...(r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}),
    ...(r.truncated ? { truncated: r.truncated } : {}),
    ...(r.entities_omitted ? { entities_omitted: r.entities_omitted } : {}),
    ...(r.scope ? { scope: r.scope } : {}),
  };
}
