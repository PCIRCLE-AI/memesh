// =============================================================================
// entity-index — remove an entity from the contentless FTS index
// =============================================================================
//
// `entities_fts` is contentless, so deletion must use the exact indexed text.
// Keep that rule in one place for archive and hard-delete callers.

import type { MemeshDatabase } from './sqlite.js';
import { indexedObservationText, removeFromFts } from './fts-index.js';

/**
 * Remove an entity from the keyword index.
 *
 * `previousTitle` and the observation text are read from the database HERE, so
 * a caller cannot supply text that disagrees with what was indexed — which on
 * a contentless FTS5 table is the difference between a delete and a row that
 * survives every later rebuild. Callers that have already mutated the
 * observations must not use this function; they want `rebuildFts`, which takes
 * the previous text explicitly.
 *
 * Callers run it inside their own transaction alongside the status change, so
 * a partial archive cannot commit.
 */
export function dropEntityFromIndexes(
  db: MemeshDatabase,
  entityId: number,
  name: string,
): void {
  const titleRow = db
    .prepare('SELECT title FROM entities WHERE id = ?')
    .get(entityId) as { title: string | null } | undefined;
  removeFromFts(db, entityId, name, indexedObservationText(db, entityId), titleRow?.title ?? null);
}
