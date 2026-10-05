import { extractProjectFromEntity } from './project-attribution.js';
import { SESSION_HANDOFF_TYPE } from './session-handoff.js';
export { extractProjectFromName, extractProjectFromEntity } from './project-attribution.js';
export const NOT_A_PROJECT_MEMORY = { sql: 'e.type <> ?', param: SESSION_HANDOFF_TYPE };
export function computeProjects(db) {
    const rows = db.prepare(`
    SELECT e.id, e.name, e.type,
      (SELECT json_group_array(t.tag) FROM tags t WHERE t.entity_id = e.id) AS tags
    FROM entities e
    WHERE e.status = 'active'
      AND ${NOT_A_PROJECT_MEMORY.sql}
  `).all(NOT_A_PROJECT_MEMORY.param);
    const acc = new Map();
    for (const row of rows) {
        let tagList = [];
        if (row.tags) {
            try {
                const parsed = JSON.parse(row.tags);
                if (Array.isArray(parsed))
                    tagList = parsed.filter((t) => typeof t === 'string');
            }
            catch {
            }
        }
        const { project, source } = extractProjectFromEntity(tagList, row.name);
        if (!project || !source)
            continue;
        let bucket = acc.get(project);
        if (!bucket) {
            bucket = { count: 0, types: new Map(), sources: new Set() };
            acc.set(project, bucket);
        }
        bucket.count++;
        bucket.types.set(row.type, (bucket.types.get(row.type) ?? 0) + 1);
        bucket.sources.add(source);
    }
    return Array.from(acc.entries())
        .map(([name, bucket]) => ({
        name,
        count: bucket.count,
        types: Array.from(bucket.types.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([t]) => t),
        source: bucket.sources.size === 2 ? 'mixed' : (bucket.sources.has('tag') ? 'tag' : 'heuristic'),
    }))
        .sort((a, b) => b.count - a.count);
}
//# sourceMappingURL=projects.js.map