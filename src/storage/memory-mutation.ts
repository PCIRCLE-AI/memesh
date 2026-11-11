import type { MemeshDatabase } from './sqlite.js';

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
