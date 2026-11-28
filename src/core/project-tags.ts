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
import { MemeshDatabase } from '../storage/sqlite.js';
import { getDatabase, openInitialisedDatabase } from '../db.js';
import { guardDatabaseFiles, hasPagesWaiting, immutableAddress } from './file-mode.js';

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
  /** Proposal rows moved with their project, so accepting one cannot revive the old scope. */
  proposalRows: number;
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

  const { affected, plan, merged, renamed } = planRename(conn, from, to);
  const proposalIds = proposalRowsForProject(conn, from);

  if (affected.length > 0 || proposalIds.length > 0) {
    const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
    const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
    const tx = conn.transaction(() => {
      for (const p of plan) {
        if (p.action === 'merge') del.run(p.id, fromTag);
        else upd.run(toTag, p.id, fromTag);
      }
      if (proposalIds.length > 0) {
        const move = conn.prepare('UPDATE dream_proposals SET project = ? WHERE id = ?');
        for (const id of proposalIds) move.run(to, id);
      }
      // Read the state back instead of trusting the statements: a trigger can
      // turn an UPDATE or DELETE into a silent no-op (RAISE(IGNORE)) or undo it
      // afterwards. Any mismatch throws and rolls the tags and proposals back.
      const hasTag = conn.prepare('SELECT 1 FROM tags WHERE entity_id = ? AND tag = ?');
      for (const p of plan) {
        if (hasTag.get(p.id, fromTag) || !hasTag.get(p.id, toTag)) {
          throw new Error(`entity ${p.id} does not carry ${toTag} in place of ${fromTag} after the rename (a trigger or constraint changed the result)`);
        }
      }
      if (proposalIds.length > 0) {
        const read = conn.prepare('SELECT project FROM dream_proposals WHERE id = ?');
        for (const id of proposalIds) {
          if ((read.get(id) as { project: string } | undefined)?.project !== to) {
            throw new Error(`proposal ${id} is not scoped to ${to} after the rename (a trigger or constraint changed the result)`);
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
    proposalRows: proposalIds.length,
  };
}

function proposalRowsForProject(conn: MemeshDatabase, project: string): number[] {
  try {
    return (conn.prepare('SELECT id FROM dream_proposals WHERE project = ?').all(project) as Array<{ id: number }>).map(row => row.id);
  } catch (err) {
    // Legacy databases may predate proposals. Other read errors must abort,
    // rather than moving tags while silently leaving proposals behind.
    if (/^no such table: (?:main\.)?dream_proposals$/i.test(err instanceof Error ? err.message : String(err))) return [];
    throw err;
  }
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

  return { affected, plan, merged, renamed };
}

/** Does anything carry project `from`: an entity tag or proposal? */
export function hasRenameWork(from: string, db?: MemeshDatabase): boolean {
  const conn = db ?? getDatabase();
  const { affected } = planRename(conn, from, from);
  return affected.length > 0 || proposalRowsForProject(conn, from).length > 0;
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
  // The guard every other open of the database runs (#520): files memesh
  // creates are owner-only, and a -wal/-shm whose owner permissions opening
  // would change is refused rather than widened.
  try { process.umask(0o077); } catch { /* non-POSIX */ }
  guardDatabaseFiles(dbPath);
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
    // Pages waiting in a -wal, or a rollback journal a crash left behind, would be skipped by an immutable read:
    // it would show changes that were never committed. Neither can be skipped, so the original error stands.
    if (hasPagesWaiting(dbPath) || !/readonly|unable to open/i.test(err instanceof Error ? err.message : String(err))) throw err;
    return open(immutableAddress(dbPath));
  }
}
