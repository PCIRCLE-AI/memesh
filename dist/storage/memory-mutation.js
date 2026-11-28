export function resolveProjectMemoryName(db, name, project, projectIds = [], create = false) {
    if (typeof project !== 'string')
        return name;
    const ids = [...new Set([project, ...(projectIds.includes(project) ? projectIds : [])])];
    const row = db.prepare('SELECT id FROM entities WHERE name = ?');
    const original = row.get(name);
    if (original && filedUnder(projectTagsOf(db, original.id), project, projectIds) !== undefined)
        return name;
    for (const id of ids) {
        const qualified = `${name}@${id}`;
        const candidates = db.prepare('SELECT id, name FROM entities WHERE name = ? OR (name >= ? AND name < ?)')
            .all(qualified, `${qualified}~`, `${qualified}\u007f`)
            .map(found => ({ ...found, suffix: found.name === qualified ? 1 : Number(found.name.slice(qualified.length + 1)) }))
            .filter(found => found.name === qualified || (Number.isSafeInteger(found.suffix) && found.suffix >= 2 && found.name === `${qualified}~${found.suffix}`))
            .sort((a, b) => a.suffix - b.suffix);
        for (const found of candidates) {
            if (filedUnder(projectTagsOf(db, found.id), project, projectIds) !== undefined)
                return found.name;
        }
    }
    if (!create || !original || projectTagsOf(db, original.id).length === 0)
        return name;
    const qualified = `${name}@${project}`;
    let available = qualified;
    for (let suffix = 2; row.get(available); suffix++)
        available = `${qualified}~${suffix}`;
    return available;
}
export function projectOwnershipRefusal(db, name, project, projectIds = []) {
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name);
    if (!row)
        return undefined;
    const projects = projectTagsOf(db, row.id);
    if (project === null) {
        if (projects.length === 0)
            return undefined;
        return `a memory named ${JSON.stringify(name)} already exists and belongs to ${projects.join(', ')}; a write without a project cannot change it. `
            + 'Use a different name, or write it with that project';
    }
    if (filedUnder(projects, project, projectIds) !== undefined)
        return undefined;
    const owner = projects.length > 0 ? `it belongs to ${projects.join(', ')}` : 'it has no project tag';
    return `a memory named ${JSON.stringify(name)} already exists and ${owner}, not project ${project}. Use a different name`;
}
export function projectTagsOf(db, entityId) {
    return db.prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%' ORDER BY tag").all(entityId)
        .map((t) => t.tag);
}
export function filedUnder(projectTags, project, projectIds = []) {
    return [project, ...projectIds.includes(project) ? projectIds : []].find((id) => projectTags.includes(`project:${id}`));
}
//# sourceMappingURL=memory-mutation.js.map