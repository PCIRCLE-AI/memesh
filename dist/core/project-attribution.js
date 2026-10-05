export const PROJECT_TAG_PREFIX = 'project:';
export const MIN_NAME_PROJECT_LENGTH = 2;
export const KNOWN_ERROR_PATTERNS = [
    'null-reference',
    'type-error',
    'import-missing',
    'config-error',
    'test-failure',
    'build-error',
    'other',
];
export function extractProjectFromName(name) {
    if (!name.startsWith('lesson-'))
        return null;
    const rest = name.slice('lesson-'.length);
    for (const pattern of KNOWN_ERROR_PATTERNS) {
        const suffix = `-${pattern}`;
        if (rest.endsWith(suffix)) {
            const project = rest.slice(0, rest.length - suffix.length);
            if (project.length >= MIN_NAME_PROJECT_LENGTH)
                return project;
        }
    }
    return null;
}
export function extractProjectFromEntity(tags, name) {
    if (tags) {
        const tagged = tags.find((t) => t.startsWith(PROJECT_TAG_PREFIX));
        if (tagged)
            return { project: tagged.slice(PROJECT_TAG_PREFIX.length), source: 'tag' };
    }
    const fromName = extractProjectFromName(name);
    if (fromName)
        return { project: fromName, source: 'heuristic' };
    return { project: null, source: null };
}
//# sourceMappingURL=project-attribution.js.map