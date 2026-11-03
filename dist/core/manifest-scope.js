import fs from 'fs';
import path from 'path';
export const MANIFEST_WIRING_FILES = [
    'hooks/hooks.json',
    'hooks/native-memory.js',
    '.claude-plugin/mcp.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/mcp.json',
    '.codex-plugin/plugin.json',
];
export const MANIFEST_SKILLS_DIR = 'skills';
export const MANIFEST_HOOKS_DIR = 'scripts/hooks';
const PACK_IGNORED_VCS = new Set(['.git', '.svn', '.hg', 'CVS']);
const PACK_IGNORED_FILE = /^(\.npmignore|\.gitignore|\.npmrc|npm-debug\.log|\.DS_Store|\._.*|\..*\.swp|.*\.orig)$/;
const isPackIgnoredName = (name) => PACK_IGNORED_VCS.has(name) || PACK_IGNORED_FILE.test(name);
const isHookFile = (name) => /\.(js|mjs)$/i.test(name);
const posix = (relative) => relative.split(path.sep).join('/');
function firstLinkOnPath(root, segments) {
    let current = root;
    for (let i = 0; i < segments.length; i += 1) {
        current = path.join(current, segments[i]);
        let stat;
        try {
            stat = fs.lstatSync(current);
        }
        catch (err) {
            const code = err?.code;
            return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : null;
        }
        if (stat.isSymbolicLink())
            return posix(path.relative(root, current));
    }
    return null;
}
function walk(root, dir, keep, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return false;
        out.unreadable.push(`${posix(path.relative(root, dir))}/`);
        return true;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = posix(path.relative(root, full));
        if (entry.isSymbolicLink()) {
            out.symlinks.push(rel);
            continue;
        }
        if (entry.isDirectory()) {
            if (isPackIgnoredName(entry.name))
                out.strayFolders.push(`${rel}/`);
            else
                walk(root, full, keep, out);
        }
        else if (entry.isFile()) {
            if (!isPackIgnoredName(entry.name) && keep(entry.name))
                out.files.push(rel);
        }
        else {
            out.special.push(rel);
        }
    }
    return true;
}
function walkCovered(root, segments, keep, out) {
    const link = firstLinkOnPath(root, segments);
    if (link === 'absent')
        return false;
    if (link !== null) {
        out.symlinks.push(link);
        return true;
    }
    return walk(root, path.join(root, ...segments), keep, out);
}
export function manifestScope(packageRoot) {
    const found = { files: [], symlinks: [], unreadable: [], strayFolders: [], special: [] };
    const missingRequired = [];
    if (!walkCovered(packageRoot, MANIFEST_SKILLS_DIR.split('/'), () => true, found))
        missingRequired.push(`${MANIFEST_SKILLS_DIR}/`);
    if (!walkCovered(packageRoot, MANIFEST_HOOKS_DIR.split('/'), isHookFile, found))
        missingRequired.push(`${MANIFEST_HOOKS_DIR}/`);
    for (const rel of MANIFEST_WIRING_FILES) {
        const segments = rel.split('/');
        const linkAbove = firstLinkOnPath(packageRoot, segments.slice(0, -1));
        if (linkAbove !== null && linkAbove !== 'absent') {
            found.symlinks.push(linkAbove);
            continue;
        }
        let stat;
        try {
            stat = fs.lstatSync(path.join(packageRoot, rel));
        }
        catch { }
        if (stat?.isSymbolicLink())
            found.symlinks.push(rel);
        else if (stat?.isFile())
            found.files.push(rel);
        else
            missingRequired.push(rel);
    }
    const unique = (list) => [...new Set(list)].sort();
    return {
        files: unique(found.files),
        missingRequired,
        symlinks: unique(found.symlinks),
        unreadable: unique(found.unreadable),
        strayFolders: unique(found.strayFolders),
        special: unique(found.special),
    };
}
//# sourceMappingURL=manifest-scope.js.map