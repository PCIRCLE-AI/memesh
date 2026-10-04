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
 * before anything is written.
 */
export function projectOwnershipRefusal(db: MemeshDatabase, name: string, project: string | null): string | undefined {
  const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) return undefined;
  const projects = (db.prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%' ORDER BY tag").all(row.id) as { tag: string }[])
    .map((t) => t.tag);
  if (project === null) {
    if (projects.length === 0) return undefined;
    return `a memory named ${JSON.stringify(name)} already exists and belongs to ${projects.join(', ')}; a write without a project cannot change it. `
      + 'Use a different name, or write it with that project';
  }
  if (projects.includes(`project:${project}`)) return undefined;
  const owner = projects.length > 0 ? `it belongs to ${projects.join(', ')}` : 'it has no project tag';
  return `a memory named ${JSON.stringify(name)} already exists and ${owner}, not project ${project}. Use a different name`;
}
