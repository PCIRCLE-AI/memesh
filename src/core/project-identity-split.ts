import type { MemeshDatabase } from '../storage/sqlite.js';
import { projectLabel } from './work-topology.js';

/**
 * #408: a plain project (`project:<name>`) whose name is the readable part of
 * one or more project ids (`project:<name>~<hash>`) in the same graph. A
 * session resolves the id, so the memories under the plain name never reach
 * it. `memesh kg rename-project` moves them.
 */
export interface ProjectIdentitySplit {
  /** The plain project, e.g. `memesh`. */
  plain: string;
  /** The project ids with that readable name, sorted. */
  ids: string[];
  /**
   * Active memories filed under the plain project and under none of its ids —
   * one that also carries an id is already visible to that project.
   */
  activeMemories: number;
}

/** Every split in the graph, the largest first. Read-only. */
export function findProjectIdentitySplits(db: MemeshDatabase): ProjectIdentitySplit[] {
  const rows = db.prepare(
    `SELECT t.tag AS tag,
            SUM(CASE WHEN e.status = 'active' AND NOT EXISTS (
                  SELECT 1 FROM tags own
                   WHERE own.entity_id = e.id
                     AND substr(own.tag, 1, length(t.tag) + 1) = t.tag || '~'
                ) THEN 1 ELSE 0 END) AS active
       FROM tags t JOIN entities e ON e.id = t.entity_id
      WHERE t.tag LIKE 'project:%'
      GROUP BY t.tag`,
  ).all() as Array<{ tag: string; active: number }>;
  const projects = rows.map((row) => ({ project: row.tag.slice('project:'.length), active: Number(row.active) }));

  const idsByLabel = new Map<string, string[]>();
  for (const { project } of projects) {
    const label = projectLabel(project);
    if (label === project) continue;
    const ids = idsByLabel.get(label);
    if (ids) ids.push(project);
    else idsByLabel.set(label, [project]);
  }

  const splits: ProjectIdentitySplit[] = [];
  for (const { project, active } of projects) {
    const ids = idsByLabel.get(project);
    if (ids === undefined || active === 0 || projectLabel(project) !== project) continue;
    splits.push({ plain: project, ids: [...ids].sort(), activeMemories: active });
  }
  return splits.sort((a, b) => b.activeMemories - a.activeMemories || a.plain.localeCompare(b.plain));
}
