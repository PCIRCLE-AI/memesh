import fs from 'fs';
function realOrNull(p) {
    if (!p)
        return null;
    try {
        return fs.realpathSync(p);
    }
    catch {
        return null;
    }
}
export function cwdIsMemeshOwnRoot(cwd, packageRoot, env = process.env) {
    const here = realOrNull(cwd);
    if (here === null)
        return false;
    return [packageRoot, env.CLAUDE_PLUGIN_ROOT, env.PLUGIN_ROOT].some((root) => realOrNull(root) === here);
}
//# sourceMappingURL=own-root.js.map