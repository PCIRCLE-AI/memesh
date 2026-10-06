// =============================================================================
// entity-write — the one write mechanism behind both entity writers
// =============================================================================
//
// Two writers store an entity: `KnowledgeGraph.createEntity` (every MCP, CLI,
// HTTP, import and dreamer write) and the hooks' `captureEntity`
// (scripts/hooks/_shared.js, through the generated copy of this file). They
// used to hold two copies of the same mechanism — the entity row, its
// observations, its tags and the contentless-FTS delete + insert — and each
// copy was maintained by hand against the other.
//
// This module is that mechanism, once. It decides nothing: which type is
// stored, whether a title is user-provided or heuristic, what an archived row
// means, whether a repeated sentence is kept, who is trusted — all of that
// stays with each writer, because the two answer those questions differently
// on purpose. What is here is only how a write is performed.
//
// Runtime leaf: it imports nothing but `./fts-index.js` (itself a leaf) and a
// type, so the hooks can load a verbatim copy without `dist/`.

import type { MemeshDatabase } from './sqlite.js';
import { indexedObservationText, insertFtsRow, removeFromFts } from './fts-index.js';

/** The stored state of the entity a write is about, read once after the upsert. */
export interface EntityRowState {
  id: number;
  isNew: boolean;
  type: string;
  title: string | null;
  status: string;
  namespace: string | null;
  metadata: string | null;
}

/**
 * Run one entity write as a single transaction.
 *
 * Every step of a write — row, observations, tags, FTS delete, FTS insert —
 * only means anything together: a throw in the middle must leave the source
 * rows and the index exactly as they were. Deferred, like both writers have
 * always been; `MemeshDatabase` turns a nested call into a SAVEPOINT, so a
 * batch or an `.immediate()` caller keeps its own transaction.
 */
export function runEntityWrite<T>(db: MemeshDatabase, write: () => T): T {
  return db.transaction(write)();
}

/**
 * Insert the entity if its name is new, then read the stored row.
 *
 * `INSERT OR IGNORE`: an existing name keeps its row untouched — type,
 * metadata, title and namespace are first-writer-wins here, and any update to
 * an existing row is the caller's decision. `namespace` is written only when
 * the caller passes one; otherwise the column default applies.
 *
 * Returns null when the row cannot be read back (the caller decides what that
 * means).
 */
export function insertOrGetEntity(
  db: MemeshDatabase,
  entity: { name: string; type: string; metadataJson: string; title: string | null; namespace?: string },
): EntityRowState | null {
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
    .get(entity.name) as Omit<EntityRowState, 'isNew'> | undefined;
  if (!row) return null;
  return { ...row, isNew };
}

/**
 * #561: the text as the database stores it. SQLite stores text as UTF-8, so a
 * lone UTF-16 surrogate (half of a pair) comes back as U+FFFD. A dedupe that
 * compares incoming text with stored text has to compare this form, or the
 * same observation never matches and is written again on every run.
 */
export function storedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * Append observations to an entity, in the order given, and return the ones
 * actually stored.
 *
 * - `dedupe: false` stores every observation as given, repeats included.
 * - `dedupe: true` skips a sentence the entity already holds, and a sentence
 *   repeated within this call. `readExisting` says whether the entity's stored
 *   observations count as "already held" (false for a new entity, or one whose
 *   observations were just deleted — the read would only come back empty).
 * - `exclude` drops an observation before anything else is considered.
 */
export function appendObservations(
  db: MemeshDatabase,
  entityId: number,
  observations: readonly string[],
  options: { dedupe: boolean; readExisting: boolean; exclude?: (observation: string) => boolean },
): string[] {
  const seen = new Set<string>(
    options.dedupe && options.readExisting
      ? (db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(entityId) as { content: string }[]).map((o) => o.content)
      : [],
  );
  const written: string[] = [];
  for (const given of observations) {
    if (options.exclude?.(given)) continue;
    const observation = storedText(given);
    if (options.dedupe) {
      if (seen.has(observation)) continue;
      seen.add(observation);
    }
    written.push(observation);
  }
  const insertObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
  for (const observation of written) insertObs.run(entityId, observation);
  return written;
}

/** Attach tags to an entity; a tag it already has is left as it is. */
export function addTags(db: MemeshDatabase, entityId: number, tags: readonly string[]): void {
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
  for (const tag of tags) insertTag.run(entityId, tag);
}

/**
 * Bring an entity's row in the contentless FTS index up to date.
 *
 * `previous` is what is currently indexed — the observation text and the title
 * as they stood BEFORE this write changed either. When it is absent there is
 * nothing to delete (a new entity). A contentless FTS5 delete must repeat the
 * indexed values exactly, which is why the old title has to be captured before
 * any title UPDATE, never read back afterwards.
 *
 * `current` is what to index now. A caller that already knows the new text or
 * title passes it (the hooks do: re-reading every observation on each capture
 * grew with the entity); a field it leaves out is read from the database. An
 * empty string and a null title are real values here, not "unknown".
 */
export function reindexEntityFts(
  db: MemeshDatabase,
  entityId: number,
  name: string,
  previous: { observationsText: string; title: string | null | undefined } | undefined,
  current: { observationsText?: string; title?: string | null } = {},
): void {
  if (previous !== undefined) {
    removeFromFts(db, entityId, name, previous.observationsText, previous.title);
  }
  const observationsText = 'observationsText' in current && current.observationsText !== undefined
    ? current.observationsText
    : indexedObservationText(db, entityId);
  const title = 'title' in current
    ? (current.title ?? null)
    : ((db.prepare('SELECT title FROM entities WHERE id = ?').get(entityId) as { title: string | null } | undefined)?.title ?? null);
  insertFtsRow(db, entityId, name, observationsText, title);
}
