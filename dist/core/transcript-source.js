import fs from 'fs';
import path from 'path';
import { homeDir } from './paths.js';
export const MAX_TRANSCRIPT_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSCRIPT_CANDIDATES = 256;
export function readTranscriptSnapshot(transcriptPath, expected) {
    return readTranscriptSnapshotWithin(transcriptPath, expected, MAX_TRANSCRIPT_SOURCE_BYTES).snapshot;
}
function readTranscriptSnapshotWithin(transcriptPath, expected, aggregateBytesRemaining) {
    let fd;
    try {
        if (fs.lstatSync(transcriptPath).isSymbolicLink())
            return { snapshot: null, aggregateLimitExceeded: false };
        fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(fd, { bigint: true });
        const sizeBytes = Number(before.size);
        if (!before.isFile() || sizeBytes < 0 || sizeBytes > MAX_TRANSCRIPT_SOURCE_BYTES) {
            return { snapshot: null, aggregateLimitExceeded: false };
        }
        if (sizeBytes > aggregateBytesRemaining)
            return { snapshot: null, aggregateLimitExceeded: true };
        const identity = {
            modifiedAt: new Date(Number(before.mtimeNs / 1000000n)).toISOString(),
            sizeBytes,
            device: before.dev.toString(),
            inode: before.ino.toString(),
            modifiedAtNanoseconds: before.mtimeNs.toString(),
            changedAtNanoseconds: before.ctimeNs.toString(),
        };
        if (expected && Object.entries(identity).some(([key, value]) => expected[key] !== value))
            return { snapshot: null, aggregateLimitExceeded: false };
        const bytes = Buffer.allocUnsafe(sizeBytes);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count === 0)
                return { snapshot: null, aggregateLimitExceeded: false };
            offset += count;
        }
        const after = fs.fstatSync(fd, { bigint: true });
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            return { snapshot: null, aggregateLimitExceeded: false };
        }
        return { snapshot: { bytes, ...identity }, aggregateLimitExceeded: false };
    }
    catch {
        return { snapshot: null, aggregateLimitExceeded: false };
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
        const dirStat = fs.lstatSync(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
            return [];
        names = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort();
    }
    catch {
        return [];
    }
    if (names.length > MAX_TRANSCRIPT_CANDIDATES)
        return [];
    let plannedBytes = 0;
    const eligibleNames = [];
    try {
        for (const name of names) {
            const stat = fs.lstatSync(path.join(dir, name));
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRANSCRIPT_SOURCE_BYTES
                || stat.mtimeMs < cutoffMs)
                continue;
            plannedBytes += stat.size;
            if (plannedBytes > MAX_TRANSCRIPT_SCAN_BYTES)
                return [];
            eligibleNames.push(name);
        }
    }
    catch {
        return [];
    }
    const sessions = [];
    let bytesRead = 0;
    for (const name of eligibleNames) {
        const full = path.join(dir, name);
        const read = readTranscriptSnapshotWithin(full, undefined, MAX_TRANSCRIPT_SCAN_BYTES - bytesRead);
        if (read.aggregateLimitExceeded)
            return [];
        const snapshot = read.snapshot;
        if (!snapshot)
            continue;
        bytesRead += snapshot.sizeBytes;
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
                device: snapshot.device,
                inode: snapshot.inode,
                modifiedAtNanoseconds: snapshot.modifiedAtNanoseconds,
                changedAtNanoseconds: snapshot.changedAtNanoseconds,
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