// ============================================================================
// AUTO-GENERATED from src/core/bash-edited-paths.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export function isPathShapedFileName(name) {
    if (!name)
        return false;
    if (name.startsWith('-') || name.startsWith('~'))
        return false;
    if (/^\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])$/.test(name) || /\$[{(]/.test(name))
        return false;
    if (/\{[^{}]*,[^{}]*\}/.test(name))
        return false;
    if (/[#^*?`]/.test(name))
        return false;
    return true;
}
export function basename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] ?? '';
}
const SCRATCH_PREFIXES = ['/dev/', '/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];
export function isScratchPath(path) {
    return SCRATCH_PREFIXES.some(prefix => path.startsWith(prefix));
}
export function bashEditedPaths(cmd) {
    if (typeof cmd !== 'string')
        return [];
    const found = new Set();
    for (const re of [
        /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/g,
        /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/g,
        /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/g,
        /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/g,
        /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/g,
        /writeFileSync\(\s*['"]([^'"]+)['"]/g,
    ]) {
        let m;
        while ((m = re.exec(cmd)) !== null) {
            const target = m[1];
            if (target && !isScratchPath(target))
                found.add(target);
        }
    }
    return [...found];
}
export function bashEditedFileNames(cmd) {
    const names = new Set();
    for (const p of bashEditedPaths(cmd)) {
        const name = basename(p);
        if (isPathShapedFileName(name))
            names.add(name);
    }
    return [...names];
}
export function editedFileName(filePath) {
    const name = typeof filePath === 'string' ? basename(filePath) : '';
    return isPathShapedFileName(name) ? name : null;
}
export const MAX_LISTED_FILES = 30;
export function listEditedFiles(files) {
    if (files.length <= MAX_LISTED_FILES)
        return files.join(', ');
    return `${files.slice(0, MAX_LISTED_FILES).join(', ')} and ${files.length - MAX_LISTED_FILES} more`;
}
