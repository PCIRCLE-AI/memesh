import { projectLabel } from './work-topology.js';
export function findProjectIdentitySplits(db) {
    const rows = db.prepare(`SELECT t.tag AS tag,
            SUM(CASE WHEN e.status = 'active' AND NOT EXISTS (
                  SELECT 1 FROM tags own
                   WHERE own.entity_id = e.id
                     AND substr(own.tag, 1, length(t.tag) + 1) = t.tag || '~'
                ) THEN 1 ELSE 0 END) AS active
       FROM tags t JOIN entities e ON e.id = t.entity_id
      WHERE t.tag LIKE 'project:%'
      GROUP BY t.tag`).all();
    const projects = rows.map((row) => ({ project: row.tag.slice('project:'.length), active: Number(row.active) }));
    const idsByLabel = new Map();
    for (const { project } of projects) {
        const label = projectLabel(project);
        if (label === project)
            continue;
        const ids = idsByLabel.get(label);
        if (ids)
            ids.push(project);
        else
            idsByLabel.set(label, [project]);
    }
    const splits = [];
    for (const { project, active } of projects) {
        const ids = idsByLabel.get(project);
        if (ids === undefined || active === 0 || projectLabel(project) !== project)
            continue;
        splits.push({ plain: project, ids: [...ids].sort(), activeMemories: active });
    }
    return splits.sort((a, b) => b.activeMemories - a.activeMemories || a.plain.localeCompare(b.plain));
}
//# sourceMappingURL=project-identity-split.js.map