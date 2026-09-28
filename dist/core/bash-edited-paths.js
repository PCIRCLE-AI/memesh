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
            if (m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/'))
                found.add(m[1]);
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
//# sourceMappingURL=bash-edited-paths.js.map