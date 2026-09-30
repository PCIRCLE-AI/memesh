// Project-tag maintenance — heal `project:<name>` tags that were mis-homed
// before project identity became git-based (see paths.ts getProjectName).
//
// The system cannot auto-infer the correct project for an old `basename(cwd)`
// value (entities don't record their originating cwd/repo), so the mapping is
// user-driven: `memesh kg rename-project --from <old> --to <new>`. This is a
// deliberate, opt-in, dry-run-by-default operation — it rewrites real user data.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { getDatabase } from '../db.js';
import { AGENT_MESSAGE_PROJECT_TABLES } from './agent-scope-id.js';

export interface ProjectTagCount {
  project: string;
  count: number;
}

export interface RenameProjectResult {
  fromTag: string;
  toTag: string;
  /** Entities carrying the `from` tag. */
  affectedEntities: number;
  /** Of those, entities that ALREADY had the `to` tag → the `from` row is deleted (merge). */
  merged: number;
  /** Of those, entities that get the tag rewritten `from` → `to` (rename). */
  renamed: number;
  applied: boolean;
  affectedNames: string[];
  /**
   * Durable-message rows whose `project` scope carries the `from` name.
   *
   * A project identity lives in two places, not one: `project:<name>` tags on
   * entities, and the `project` column of the durable-message tables, which is
   * half the key of an inbox. Renaming only the tags left the messages behind
   * — on the maintainer's own graph, `memesh` and `memesh-llm-memory` (the same
   * repository before and after a GitHub rename; the old name still redirects)
   * held 38 and 28 messages in two separate scopes, and a recipient polling
   * under one never saw the other. So the rename moves both, in one
   * transaction, under the same dry-run-by-default discipline.
   */
  messageRows: number;
  /**
   * Message rows left in place because moving them would violate a UNIQUE
   * constraint — the destination project already holds an equivalent row.
   * Reported rather than forced: deleting a caller's rows to satisfy a rename
   * is the owner's decision, not this function's.
   */
  messageRowsBlocked: number;
}

/** All `project:*` tag values with entity counts, most-used first. */
export function listProjectTags(db?: MemeshDatabase): ProjectTagCount[] {
  const conn = db ?? getDatabase();
  const rows = conn.prepare(
    "SELECT tag, COUNT(*) c FROM tags WHERE tag LIKE 'project:%' GROUP BY tag ORDER BY c DESC, tag ASC",
  ).all() as Array<{ tag: string; c: number }>;
  return rows.map((r) => ({ project: r.tag.slice('project:'.length), count: r.c }));
}

/**
 * Rewrite `project:<from>` → `project:<to>` across all entities.
 *
 * Dry-run by default (`apply` false) — computes what WOULD change and writes
 * nothing. With `apply: true`, runs in a single transaction. The tags table has
 * a UNIQUE(entity_id, tag) constraint, so an entity that already carries the
 * `to` tag cannot receive a second copy — for those the `from` row is deleted
 * (a merge) rather than renamed.
 */
export function renameProjectTag(
  from: string,
  to: string,
  opts?: { apply?: boolean; db?: MemeshDatabase },
): RenameProjectResult {
  const conn = opts?.db ?? getDatabase();
  const fromTag = `project:${from}`;
  const toTag = `project:${to}`;
  // Every carrier of `from` already "has" `to` when they are the same tag, so
  // the plan below would mark each one a merge and delete its only project
  // tag (#519). Renaming a project to itself is never what was meant.
  if (fromTag === toTag) {
    throw new Error(`--from and --to name the same project (${from}); nothing to rename, and applying it would remove the project from every memory.`);
  }

  const affected = conn.prepare(
    'SELECT DISTINCT e.id, e.name FROM entities e JOIN tags t ON t.entity_id = e.id WHERE t.tag = ? ORDER BY e.name',
  ).all(fromTag) as Array<{ id: number; name: string }>;

  const hasTo = conn.prepare('SELECT 1 FROM tags WHERE entity_id = ? AND tag = ?');
  const plan = affected.map((e) => ({
    id: e.id,
    action: hasTo.get(e.id, toTag) ? ('merge' as const) : ('rename' as const),
  }));
  const merged = plan.filter((p) => p.action === 'merge').length;
  const renamed = plan.filter((p) => p.action === 'rename').length;

  // Table names come from a hardcoded list, never from caller input.
  const messagePlan = AGENT_MESSAGE_PROJECT_TABLES.map((table) => {
    try {
      const rows = conn.prepare(`SELECT rowid AS rid FROM ${table} WHERE project = ?`)
        .all(from) as Array<{ rid: number }>;
      return { table, rowIds: rows.map((r) => r.rid) };
    } catch {
      // A schema older than the durable-message tables has nothing to move.
      return { table, rowIds: [] as number[] };
    }
  });
  const messageRows = messagePlan.reduce((n, t) => n + t.rowIds.length, 0);
  // Counted, not tried: a dry run must work on a read-only database and must
  // not take the write lock, and the apply below leaves exactly these rows.
  let messageRowsBlocked = messagePlan.reduce(
    (n, { table, rowIds }) => n + (rowIds.length === 0 ? 0 : countScopeCollisions(conn, table, from, to)), 0);

  if (opts?.apply && (affected.length > 0 || messageRows > 0)) {
    messageRowsBlocked = 0;
    const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
    const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
    const tx = conn.transaction(() => {
      for (const p of plan) {
        if (p.action === 'merge') del.run(p.id, fromTag);
        else upd.run(toTag, p.id, fromTag);
      }
      for (const { table, rowIds } of messagePlan) {
        if (rowIds.length === 0) continue;
        const move = conn.prepare(`UPDATE ${table} SET project = ? WHERE rowid = ?`);
        for (const rid of rowIds) {
          // Row by row, not one bulk UPDATE: a single unique collision would
          // otherwise abort the statement and silently move nothing. Only a
          // unique collision means "the destination already holds this row";
          // any other failure (a read-only file, a full disk) aborts the whole
          // rename instead of being reported as left in place (#519).
          try {
            move.run(to, rid);
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            messageRowsBlocked += 1;
          }
        }
      }
    });
    tx();
  }

  return {
    fromTag,
    toTag,
    affectedEntities: affected.length,
    merged,
    renamed,
    applied: !!opts?.apply,
    affectedNames: affected.map((e) => e.name),
    messageRows,
    messageRowsBlocked,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  // 2067: a UNIQUE index; 1555: a composite PRIMARY KEY (agent_message_idempotency).
  return code === 2067 || code === 1555 || /UNIQUE constraint failed/.test(err instanceof Error ? err.message : String(err));
}

/**
 * How many `from`-scoped rows of `table` would collide with a `to`-scoped row
 * on one of the table's unique indexes that include `project` — the rows the
 * apply leaves in place. NULLs never collide, as in SQLite's own uniqueness.
 * Table and column names come from a hardcoded list and the schema, never
 * from caller input.
 */
function countScopeCollisions(conn: MemeshDatabase, table: string, from: string, to: string): number {
  const indexes = (conn.prepare(`SELECT name FROM pragma_index_list('${table}') WHERE "unique" = 1`).all() as Array<{ name: string }>)
    .map(({ name }) => (conn.prepare(`SELECT name FROM pragma_index_info('${name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>).map((c) => c.name))
    .filter((cols) => cols.includes('project'));
  if (indexes.length === 0) return 0;
  const collides = indexes.map((cols) => {
    const same = cols.filter((c) => c !== 'project').map((c) => `b."${c}" = a."${c}"`);
    return `EXISTS (SELECT 1 FROM ${table} b WHERE b.project = ?${same.map((x) => ` AND ${x}`).join('')})`;
  });
  const row = conn.prepare(`SELECT count(*) AS n FROM ${table} a WHERE a.project = ? AND (${collides.join(' OR ')})`)
    .get(from, ...indexes.map(() => to)) as { n: number };
  return row.n;
}
