import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { homeDir } from './paths.js';
export function noteDirId(realDir) {
    return createHash('sha256').update(realDir).digest('hex').slice(0, 16);
}
export function ownMemoryDirIds(env = process.env) {
    const claudeHome = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
        ? env.CLAUDE_CONFIG_DIR
        : path.join(homeDir(), '.claude');
    const projects = path.join(claudeHome, 'projects');
    const ids = new Set();
    let names;
    try {
        names = fs.readdirSync(projects);
    }
    catch {
        return ids;
    }
    for (const name of names) {
        const memory = path.join(projects, name, 'memory');
        try {
            if (!fs.lstatSync(memory).isDirectory())
                continue;
            ids.add(noteDirId(fs.realpathSync(memory)));
        }
        catch {
        }
    }
    return ids;
}
//# sourceMappingURL=note-dirs.js.map