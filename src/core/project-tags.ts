// Project-tag maintenance — heal `project:<name>` tags that were mis-homed
// before project identity became git-based (see paths.ts getProjectName).
//
// The system cannot auto-infer the correct project for an old `basename(cwd)`
// value (entities don't record their originating cwd/repo), so the mapping is
// user-driven: `memesh kg rename-project --from <old> --to <new>`. This is a
// deliberate, opt-in, dry-run-by-default operation — it rewrites real user data.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemeshDatabase } from '../storage/sqlite.js';
import { getDatabase, openInitialisedDatabase } from '../db.js';
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
 * The refusal for renaming a project to itself, or null. Every carrier of
 * `from` already "has" `to` when they are the same tag, so the plan would mark
 * each one a merge and delete its only project tag (#519). It needs no
 * database, so the CLI asks it before opening one.
 */
export function sameProjectRefusal(from: string, to: string): string | null {
  return `project:${from}` === `project:${to}`
    ? `--from and --to name the same project (${from}); nothing to rename, and applying it would remove the project from every memory.`
    : null;
}

/**
 * Rewrite `project:<from>` → `project:<to>` across all entities.
 *
 * Dry-run by default (`apply` false): runs the real apply on a throwaway copy
 * of the database and reports its counts, so the numbers are the ones `apply`
 * produces by construction and the database itself is not written. With
 * `apply: true`, runs in a single transaction. The tags table has
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
  const refusal = sameProjectRefusal(from, to);
  if (refusal) throw new Error(refusal);
  if (!opts?.apply) return previewOnCopy(conn, from, to);

  const { affected, plan, merged, renamed, messagePlan, messageRows } = planRename(conn, from, to);
  let messageRowsBlocked = 0;

  if (affected.length > 0 || messageRows > 0) {
    const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
    const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
    const movedRows: Array<{ table: string; rid: number }> = [];
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
            movedRows.push({ table, rid });
          } catch (err) {
            if (!isUniqueCollisionIn(table, err)) throw err;
            messageRowsBlocked += 1;
          }
        }
      }
      // Read the state back instead of trusting the statements: a trigger can
      // turn an UPDATE or DELETE into a silent no-op (RAISE(IGNORE)) or undo it
      // afterwards, which would leave a memory in `from` while its messages move
      // to `to`, or the reverse. Any mismatch throws and rolls everything back.
      const hasTag = conn.prepare('SELECT 1 FROM tags WHERE entity_id = ? AND tag = ?');
      for (const p of plan) {
        if (hasTag.get(p.id, fromTag) || !hasTag.get(p.id, toTag)) {
          throw new Error(`entity ${p.id} does not carry ${toTag} in place of ${fromTag} after the rename (a trigger or constraint changed the result), so the rename was not kept.`);
        }
      }
      for (const { table, rid } of movedRows) {
        const row = conn.prepare(`SELECT project FROM ${table} WHERE rowid = ?`).get(rid) as { project: string } | undefined;
        if (row?.project !== to) {
          throw new Error(`${table} row ${rid} is not scoped to ${to} after the rename (a trigger or constraint changed the result), so the rename was not kept.`);
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

/** What a rename of `from` to `to` would touch. Reads only. */
function planRename(conn: MemeshDatabase, from: string, to: string) {
  const fromTag = `project:${from}`;
  const toTag = `project:${to}`;
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
    } catch (err) {
      // Only a schema older than the durable-message tables has nothing to
      // move. Any other read failure (an I/O error) must abort: treating it as
      // "no rows" would move the message and strand its delivery (#519).
      if (!/no such table/i.test(err instanceof Error ? err.message : String(err))) throw err;
      return { table, rowIds: [] as number[] };
    }
  });
  const messageRows = messagePlan.reduce((n, t) => n + t.rowIds.length, 0);
  return { affected, plan, merged, renamed, messagePlan, messageRows };
}

/** Does anything carry project `from`: an entity tag or a durable-message row? */
export function hasRenameWork(from: string, db?: MemeshDatabase): boolean {
  const { affected, messageRows } = planRename(db ?? getDatabase(), from, from);
  return affected.length > 0 || messageRows > 0;
}

function isUniqueCollisionIn(table: string, err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown } | null;
  // 2067: a UNIQUE index; 1555: a composite PRIMARY KEY (agent_message_idempotency).
  // A trigger's RAISE(ABORT, ...) is 1811, so its text, which can quote any
  // name, never gets this far. For these two codes the message is SQLite's own
  // ("UNIQUE constraint failed: <table>.<column>, ..."), and it must name the
  // table being updated: a trigger's write that collides in another table is
  // not "the destination already holds this row".
  if (e?.errcode !== 2067 && e?.errcode !== 1555) return false;
  return typeof e.message === 'string' && e.message.startsWith(`UNIQUE constraint failed: ${table}.`);
}

/**
 * The preview: the real apply, run on a throwaway copy made with VACUUM INTO
 * (a read of the source) in the OS temp folder and opened the way `apply` opens
 * the database, so pending migrations, indexes, triggers and collations behave
 * exactly as they will. The copy is deleted when the preview ends, however it ends,
 * except when the process is killed or interrupted (SIGINT, SIGTERM, SIGKILL) first:
 * then it stays in the temp folder, owner-only. It costs one
 * database-sized temporary file and one open-time migration pass.
 */
function previewOnCopy(source: MemeshDatabase, from: string, to: string): RenameProjectResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-rename-preview-'));
  try {
    const file = path.join(dir, 'copy.db');
    try {
      source.prepare('VACUUM INTO ?').run(file);
    } catch (err) {
      throw new Error(`could not write the preview copy under ${dir}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const copy = openInitialisedDatabase(file);
    try {
      return { ...renameProjectTag(from, to, { apply: true, db: copy }), applied: false };
    } finally {
      copy.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A read-only handle that has proved it can read. In a directory the process
 * cannot write to, a WAL-mode database cannot create its -shm file, so the
 * first query fails with "attempt to write a readonly database" (or "unable
 * to open" when an empty -wal is there). With no write-ahead log, or an empty
 * one, there are no unread changes to miss, so the file is then opened as
 * immutable instead; with a non-empty one, or for any other error, the error
 * stands. `openHandle` is a seam for tests.
 */
export function openReadOnlyForPreview(
  dbPath: string,
  openHandle: (target: string) => MemeshDatabase = (target) => new MemeshDatabase(target, { readOnly: true }),
): MemeshDatabase {
  const open = (target: string): MemeshDatabase => {
    const handle = openHandle(target);
    try {
      handle.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    } catch (err) {
      handle.close();
      throw err;
    }
    return handle;
  };
  try {
    return open(dbPath);
  } catch (err) {
    // SQLite keeps the -wal beside the real file, not beside a symlink to it.
    let realPath = dbPath;
    try { realPath = fs.realpathSync(dbPath); } catch { /* keep the given path */ }
    const wal = `${realPath}-wal`;
    const hasWal = fs.existsSync(wal) && fs.statSync(wal).size > 0;
    if (hasWal || !/readonly|unable to open/i.test(err instanceof Error ? err.message : String(err))) throw err;
    return open(`${pathToFileURL(dbPath).href}?immutable=1`);
  }
}
