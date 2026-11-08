import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectIds } from '../../core/paths.js';
function existingDirectory(candidate) {
    try {
        const real = fs.realpathSync(candidate);
        return fs.statSync(real).isDirectory() ? real : null;
    }
    catch {
        return null;
    }
}
function rootDirectory(uri) {
    if (/^file:(\/\/)?$/i.test(uri))
        return null;
    try {
        const parsed = new URL(uri);
        return parsed.protocol === 'file:' ? existingDirectory(fileURLToPath(parsed)) : null;
    }
    catch {
        return null;
    }
}
export function resolveMcpProject(launchRoot, rootUris) {
    if (rootUris === null) {
        return {
            error: 'workspace_unavailable',
            reason: 'The client advertises workspace roots but did not return them.',
        };
    }
    const fromRoots = new Map();
    for (const uri of rootUris) {
        const directory = rootDirectory(uri);
        if (!directory) {
            return {
                error: 'workspace_unavailable',
                reason: `A workspace root from the client is not an existing local directory: ${JSON.stringify(uri)}.`,
            };
        }
        const ids = getProjectIds(directory);
        fromRoots.set(ids[0], ids);
    }
    if (launchRoot !== undefined) {
        const directory = path.isAbsolute(launchRoot) ? existingDirectory(launchRoot) : null;
        if (!directory) {
            return {
                error: 'workspace_unavailable',
                reason: `MEMESH_PROJECT_ROOT is not an existing absolute directory: ${JSON.stringify(launchRoot)}.`,
            };
        }
        const ids = getProjectIds(directory);
        const project = ids[0];
        if ([...fromRoots.keys()].some(other => other !== project)) {
            return {
                error: 'workspace_ambiguous',
                reason: 'MEMESH_PROJECT_ROOT and the client\'s workspace root name different projects.',
            };
        }
        return { project, ids };
    }
    if (fromRoots.size === 1) {
        const [[project, ids]] = [...fromRoots];
        return { project, ids };
    }
    if (fromRoots.size > 1) {
        return {
            error: 'workspace_ambiguous',
            reason: 'The client\'s workspace roots name more than one project.',
        };
    }
    return {
        error: 'workspace_unavailable',
        reason: 'No project is bound to this MCP session (no workspace root and no MEMESH_PROJECT_ROOT).',
        unbound: true,
    };
}
//# sourceMappingURL=project-context.js.map