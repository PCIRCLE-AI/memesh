import { projectLabel } from './work-topology.js';
export function withFullProjectTag(tags, projectId) {
    if (tags === undefined)
        return { tags: undefined };
    if (projectId === undefined)
        return { tags: [...tags] };
    const label = projectLabel(projectId);
    if (label === projectId)
        return { tags: [...tags] };
    const plain = `project:${label}`;
    if (!tags.includes(plain))
        return { tags: [...tags] };
    const full = `project:${projectId}`;
    return { tags: [...new Set(tags.map((tag) => (tag === plain ? full : tag)))], retagged: { from: plain, to: full } };
}
//# sourceMappingURL=plain-project-tag.js.map