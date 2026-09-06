import fs from 'fs';
import path from 'path';
import { homeDir } from './paths.js';
export const MAX_TRANSCRIPT_SOURCE_BYTES = 8 * 1024 * 1024;
export function readTranscriptSnapshot(transcriptPath, expected) {
    let fd;
    try {
        if (fs.lstatSync(transcriptPath).isSymbolicLink())
            return null;
        fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.size < 0 || before.size > MAX_TRANSCRIPT_SOURCE_BYTES)
            return null;
        const modifiedAt = new Date(before.mtimeMs).toISOString();
        if (expected && (before.size !== expected.sizeBytes || modifiedAt !== expected.modifiedAt))
            return null;
        const bytes = Buffer.allocUnsafe(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count === 0)
                return null;
            offset += count;
        }
        const after = fs.fstatSync(fd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
            return null;
        return { bytes, modifiedAt, sizeBytes: before.size };
    }
    catch {
        return null;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
}
export function claudeProjectsDir() {
    const override = process.env.CLAUDE_PROJECTS_DIR;
    if (override && override.trim() !== '')
        return override;
    return path.join(homeDir(), '.claude', 'projects');
}
export function projectTranscriptSlug(cwd) {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
export function recordedCwd(text) {
    let seen = 0;
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        if (++seen > 40)
            break;
        try {
            const entry = JSON.parse(line);
            if (typeof entry.cwd === 'string' && entry.cwd.length > 0)
                return entry.cwd;
        }
        catch {
        }
    }
    return null;
}
function sameProjectPath(a, b) {
    if (path.normalize(a) === path.normalize(b))
        return true;
    try {
        if (fs.realpathSync(a) === fs.realpathSync(b))
            return true;
    }
    catch { }
    return false;
}
export function transcriptMatchesProject(bytes, cwd) {
    const sessionCwd = recordedCwd(bytes.subarray(0, 65536).toString('utf8'));
    return sessionCwd !== null && sameProjectPath(sessionCwd, cwd);
}
export function scanTranscripts(opts = {}) {
    const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : process.cwd();
    const windowDays = opts.windowDays ?? 3;
    const now = opts.now ?? new Date();
    const cutoffMs = now.getTime() - windowDays * 86400_000;
    const dir = path.join(claudeProjectsDir(), projectTranscriptSlug(cwd));
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const name of names) {
        if (!name.endsWith('.jsonl'))
            continue;
        const full = path.join(dir, name);
        const snapshot = readTranscriptSnapshot(full);
        if (!snapshot)
            continue;
        try {
            if (Date.parse(snapshot.modifiedAt) < cutoffMs)
                continue;
            const buf = snapshot.bytes;
            let lineCount = 0;
            for (let i = 0; i < buf.length; i++)
                if (buf[i] === 0x0a)
                    lineCount++;
            if (!transcriptMatchesProject(buf, cwd))
                continue;
            sessions.push({
                sessionId: name.replace(/\.jsonl$/, ''),
                path: full,
                modifiedAt: snapshot.modifiedAt,
                lineCount,
                sizeBytes: snapshot.sizeBytes,
            });
        }
        catch {
            continue;
        }
    }
    sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return sessions;
}
//# sourceMappingURL=transcript-source.js.map