export function projectOwnershipRefusal(db, name, project) {
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name);
    if (!row)
        return undefined;
    const projects = db.prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%' ORDER BY tag").all(row.id)
        .map((t) => t.tag);
    if (project === null) {
        if (projects.length === 0)
            return undefined;
        return `a memory named ${JSON.stringify(name)} already exists and belongs to ${projects.join(', ')}; a write without a project cannot change it. `
            + 'Use a different name, or write it with that project';
    }
    if (projects.includes(`project:${project}`))
        return undefined;
    const owner = projects.length > 0 ? `it belongs to ${projects.join(', ')}` : 'it has no project tag';
    return `a memory named ${JSON.stringify(name)} already exists and ${owner}, not project ${project}. Use a different name`;
}
//# sourceMappingURL=memory-mutation.js.map