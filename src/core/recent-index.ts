// =============================================================================
// recent-index — the memories brought into context without being asked for
// =============================================================================
//
// Two moments, one rule set, both measured (on prompts held out from tuning):
//
//   - Session start: the titles of the RECENT_INDEX_SIZE most recently
//     written memories of the session's project, once.
//   - Each prompt: at most two titles the prompt is strongly about
//     (prompt-recall.ts picks them).
//
// Scope is this project (the ids proven to be its repository: projectAliases)
// and memories with no project and no host; never another project's, even a
// global one, nor one of another folder with the same name. Trusted
// rows only; no bookkeeping types, no feedback (index only), no automatic
// captures.
//
// A runtime leaf, mirrored next to the hooks (scripts/generate-hook-core.mjs):
// the session-start hook, the prompt hook and `briefing` run this file.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { getProjectIds, redactMemoryText } from './paths.js';
import { candidateIsAutoInjectable } from './briefing-index.js';
import { EVIDENCE_LAYER_TYPES, jsonStringLiteral, projectLabel, sliceWholeChars, utcEpoch } from './work-topology.js';

/** Titles in the session-start index. */
export const RECENT_INDEX_SIZE = 30;
/** Characters of a title shown (title, else name), cut after redaction. */
export const RECENT_TITLE_CHARS = 120;

/** Memories that are bookkeeping about work, not knowledge: never brought along unasked. */
export const AUTO_CONTEXT_EXCLUDED_TYPES: readonly string[] = [
  ...EVIDENCE_LAYER_TYPES,
  'task-state',
  'digest',
  'release-notice',
];
/** Rows with dedicated opening sections, or working-style notes already carried elsewhere. */
export const RECENT_INDEX_SKIP_TYPES: readonly string[] = ['conversation', 'feedback', 'engineering_feedback'];


/**
 * The ids proven to name `project`'s repository (it first): the ids the
 * checkout is known by (`getProjectIds` of a folder, or the ids themselves),
 * when `project` is one of them, else `project` alone;
 * plus each one's hash-less form from before ids carried a hash. A same-name
 * id with another hash is another repository (two folders called `api`), and
 * case counts.
 */
export function projectAliases(project: string | null, scope: string | readonly string[] | null = null): string[] {
  if (project === null) return [];
  const checkout = scope === null ? [] : typeof scope === 'string' ? getProjectIds(scope) : scope;
  const ids = checkout.includes(project) ? [project, ...checkout] : [project];
  return [...new Set([...ids, ...ids.map(projectLabel)])];
}

const NO_PROJECT_TAG = "NOT EXISTS (SELECT 1 FROM tags pt WHERE pt.entity_id = e.id AND pt.tag LIKE 'project:%')";
const HOST_SCOPED_TAG = "EXISTS (SELECT 1 FROM tags ht WHERE ht.entity_id = e.id AND (ht.tag LIKE 'platform:%' OR ht.tag LIKE 'agent:%'))";

/**
 * The WHERE fragment both moments search: one of these projects, or no
 * project and no host. Its parameters are `project:<id>` for each alias, in
 * order.
 */
export function autoContextScope(aliases: readonly string[], platform?: 'hermes'): { sql: string; params: string[] } {
  // Hermes gateway captures have no project. Its provider may read those
  // belonging to Hermes, while other hosts keep excluding host-scoped rows.
  const hostScope = platform === 'hermes'
    ? "NOT EXISTS (SELECT 1 FROM tags ht WHERE ht.entity_id = e.id AND (ht.tag LIKE 'platform:%' OR ht.tag LIKE 'agent:%') AND ht.tag <> 'platform:hermes')"
    : `NOT ${HOST_SCOPED_TAG}`;
  const noProject = `(${NO_PROJECT_TAG} AND ${hostScope})`;
  return {
    sql: aliases.length === 0
      ? noProject
      : `(EXISTS (SELECT 1 FROM tags st WHERE st.entity_id = e.id AND st.tag IN (${aliases.map(() => '?').join(', ')})) OR ${noProject})`,
    params: aliases.map((id) => `project:${id}`),
  };
}

/**
 * An instant as SQLite UTC text that compares as a string the way the instant
 * compares as a time against stored `YYYY-MM-DD HH:MM:SS` values: whole
 * seconds stay whole, so a row written in that second is not "before" it.
 */
export function sqliteInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.endsWith('.000Z') ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 23).replace('T', ' ');
}

const normTime = (column: string) => `replace(replace(${column}, 'T', ' '), 'Z', '')`;

export function tableColumns(db: MemeshDatabase, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

/** One memory as the filter and the renderer read it. */
export interface RecentRow {
  id: number;
  name: string;
  type: string;
  title: string | null;
  /** When it was created, epoch ms. */
  createdMs: number;
  /** Its newest observation before the moment asked about (else its creation), epoch ms. */
  lastMs: number;
  /** Its `project:` tag values, each alias of the asked project written as the first alias. */
  projects: string[];
}

/** The text a memory is shown by and judged on: its title, else its name. */
export const shownText = (row: Pick<RecentRow, 'title' | 'name'>): string => String(row.title ?? row.name);

/**
 * The session's unfiltered index: the RECENT_INDEX_SIZE in-scope memories
 * most recently written to before `asOf` (newest observation, else creation;
 * ties by descending id so the last write wins), each with at least one observation by then.
 */
export function readRecentPool(db: MemeshDatabase, aliases: readonly string[], asOf: number): RecentRow[] {
  const cols = tableColumns(db, 'entities');
  const T = sqliteInstant(asOf);
  const scope = autoContextScope(aliases);
  const excluded = [...AUTO_CONTEXT_EXCLUDED_TYPES, ...RECENT_INDEX_SKIP_TYPES];
  const page = db.prepare(
    `SELECT e.id, e.name, e.type, ${cols.has('title') ? 'e.title' : 'NULL AS title'}, e.metadata, e.created_at,
       (SELECT max(${normTime('o.created_at')}) FROM observations o WHERE o.entity_id = e.id AND ${normTime('o.created_at')} < ?) AS last
     FROM entities e
     WHERE ${cols.has('status') ? "e.status = 'active' AND " : ''}${normTime('e.created_at')} < ?
       AND e.type NOT IN (${excluded.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM tags ac WHERE ac.entity_id = e.id AND ac.tag = 'source:auto-capture')
       AND ${scope.sql}
       AND last IS NOT NULL
     ORDER BY last DESC, e.id DESC
     LIMIT ? OFFSET ?`,
  );
  const rows: Array<Omit<RecentRow, 'projects'>> = [];
  // The trust gate reads JSON, so it runs here; a page of untrusted rows must not shrink the index.
  for (let offset = 0; rows.length < RECENT_INDEX_SIZE; offset += RECENT_INDEX_SIZE * 2) {
    const got = page.all(T, T, ...excluded, ...scope.params, RECENT_INDEX_SIZE * 2, offset) as Array<{
      id: number; name: string; type: string; title: string | null; metadata: string | null; created_at: string; last: string;
    }>;
    for (const r of got) {
      if (rows.length >= RECENT_INDEX_SIZE) break;
      if (!candidateIsAutoInjectable(r.metadata)) continue;
      rows.push({ id: r.id, name: r.name, type: r.type, title: r.title, createdMs: utcEpoch(r.created_at), lastMs: utcEpoch(r.last) });
    }
    if (got.length < RECENT_INDEX_SIZE * 2) break;
  }
  const projects = rowProjects(db, rows.map((r) => r.id), aliases);
  return rows.map((r) => ({ ...r, projects: projects.get(r.id) ?? [] }));
}

function rowProjects(db: MemeshDatabase, ids: readonly number[], aliases: readonly string[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (ids.length === 0) return out;
  const rows = db.prepare(
    `SELECT entity_id, tag FROM tags WHERE tag LIKE 'project:%' AND entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`,
  ).all(...ids) as Array<{ entity_id: number; tag: string }>;
  for (const r of rows) {
    const id = r.tag.slice('project:'.length);
    const list = out.get(r.entity_id) ?? [];
    list.push(aliases.includes(id) ? aliases[0] : id);
    out.set(r.entity_id, list);
  }
  return out;
}

/** The title as shown: redacted, then cut (a secret cut in half would no longer match its pattern). */
export function recentTitle(row: Pick<RecentRow, 'title' | 'name'>): string {
  return sliceWholeChars(redactMemoryText(shownText(row)), RECENT_TITLE_CHARS);
}

/** One line: `- <title> [mem:<id>]`. */
export function recentLine(row: Pick<RecentRow, 'id' | 'title' | 'name'>): string {
  return `- ${recentTitle(row)} [mem:${row.id}]`;
}

export interface RecentIndex {
  /** The pool, newest first. */
  poolIds: number[];
  /** What is shown, in order. */
  shown: RecentRow[];
  /**
   * The section: heading, then one line per shown memory, or one line saying
   * every one of them looks out of date. Empty when the scope holds no memory
   * yet: a block that says nothing is not injected at all.
   */
  lines: string[];
}

function heading(project: string | null): string {
  const where = project === null ? '' : ` in ${jsonStringLiteral(projectLabel(project))}`;
  return `Recently written memories${where} (newest first; recall a [mem:id] to read one):`;
}

/** The session-start index for `project` as of `asOf` (now, unless replaying); `scope` is the session's folder or the ids its checkout is filed under, when known. */
export function buildRecentIndex(db: MemeshDatabase, project: string | null, asOf: number = Date.now(), scope: string | readonly string[] | null = null): RecentIndex {
  const pool = readRecentPool(db, projectAliases(project, scope), asOf);
  const body = pool.map(recentLine);
  return { poolIds: pool.map((r) => r.id), shown: pool, lines: pool.length === 0 ? [] : [heading(project), ...body] };
}
