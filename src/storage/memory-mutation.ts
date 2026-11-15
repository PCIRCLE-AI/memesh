import type { MemeshDatabase } from './sqlite.js';

/** Resolve a caller's original name without changing another project's row.
 * Names remain globally unique; qualified names use the full project id, not
 * its readable prefix. Existing checkout aliases are searched but never added
 * to a foreign row. Without a declared project, keep the literal name.
 */
export function resolveProjectMemoryName(db: MemeshDatabase, name: string, project: string | null | undefined, projectIds: readonly string[] = [], create = false): string {
  if (typeof project !== 'string') return name;
  const ids = [...new Set([project, ...(projectIds.includes(project) ? projectIds : [])])];
  const row = db.prepare('SELECT id FROM entities WHERE name = ?');
  const original = row.get(name) as { id: number } | undefined;
  if (original && filedUnder(projectTagsOf(db, original.id), project, projectIds) !== undefined) return name;
  for (const id of ids) {
    const qualified = `${name}@${id}`;
    const candidates = (db.prepare('SELECT id, name FROM entities WHERE name = ? OR substr(name, 1, length(?)) = ?')
      .all(qualified, `${qualified}~`, `${qualified}~`) as { id: number; name: string }[])
      .map(found => ({ ...found, suffix: found.name === qualified ? 1 : Number(found.name.slice(qualified.length + 1)) }))
      .filter(found => found.name === qualified || (Number.isSafeInteger(found.suffix) && found.suffix >= 2 && found.name === `${qualified}~${found.suffix}`))
      .sort((a, b) => a.suffix - b.suffix);
    for (const found of candidates) {
      if (filedUnder(projectTagsOf(db, found.id), project, projectIds) !== undefined) return found.name;
    }
  }
  // A shared legacy row keeps its name and ownership; the caller's existing
  // legacy-append policy decides whether that particular mutation is allowed.
  if (!create || !original || projectTagsOf(db, original.id).length === 0) return name;
  const qualified = `${name}@${project}`;
  let available = qualified;
  for (let suffix = 2; row.get(available); suffix++) available = `${qualified}~${suffix}`;
  return available;
}

/**
 * Why a write that declares its project may not touch the memory named
 * `name`, or undefined when it may. `project` is the write's project, or
 * null for a write that intentionally has none. A name is one row for every
 * project, so a write onto a row that belongs to another project would share
 * or move it silently: a project write may change only a row of the same
 * project (an untagged legacy row is not adopted), and a write without a
 * project only a row without one. The message names the memory and the
 * projects, never its content. Call it inside the write's transaction,
 * before anything is written. `projectIds` are every id the write's checkout
 * is filed under (getProjectIds): a row of the same checkout under an earlier
 * id is the same project's, as its reads already treat it.
 */
export function projectOwnershipRefusal(db: MemeshDatabase, name: string, project: string | null, projectIds: readonly string[] = []): string | undefined {
  const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) return undefined;
  const projects = projectTagsOf(db, row.id);
  if (project === null) {
    if (projects.length === 0) return undefined;
    return `a memory named ${JSON.stringify(name)} already exists and belongs to ${projects.join(', ')}; a write without a project cannot change it. `
      + 'Use a different name, or write it with that project';
  }
  if (filedUnder(projects, project, projectIds) !== undefined) return undefined;
  const owner = projects.length > 0 ? `it belongs to ${projects.join(', ')}` : 'it has no project tag';
  return `a memory named ${JSON.stringify(name)} already exists and ${owner}, not project ${project}. Use a different name`;
}

/** A memory's `project:` tags, sorted. */
export function projectTagsOf(db: MemeshDatabase, entityId: number): string[] {
  return (db.prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%' ORDER BY tag").all(entityId) as { tag: string }[])
    .map((t) => t.tag);
}

/**
 * The id of `project` (itself, or one of its checkout's `projectIds`) that the row with these
 * project tags is filed under; undefined when it is filed under none of them.
 */
export function filedUnder(projectTags: readonly string[], project: string, projectIds: readonly string[] = []): string | undefined {
  return [project, ...projectIds.includes(project) ? projectIds : []].find((id) => projectTags.includes(`project:${id}`));
}
