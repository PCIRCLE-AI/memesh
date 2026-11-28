import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDbPath, gitRepoRoot } from './paths.js';
import { isValidCodexThreadId } from './codex-session-principal.js';
const MAX_RECORD_BYTES = 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES_READ = 64;
const RECORD_NAME = /^[0-9a-f]{64}\.json$/;
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validRevision = (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
export function continuationTaskKey(state) {
    if (!state.goal)
        return undefined;
    return sha([state.goal, state.stated_at?.goal ?? state.updated_at ?? null]);
}
function scopeFor(project, cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd))
        return null;
    try {
        const repo = gitRepoRoot(cwd);
        const workspace = fs.realpathSync.native(repo ?? cwd);
        const stat = fs.statSync(workspace, { bigint: true });
        if (!stat.isDirectory())
            return null;
        const database = getDbPath();
        const key = sha([project, os.hostname(), workspace, String(stat.dev), String(stat.ino), String(stat.birthtimeNs), path.basename(database)]);
        return { directory: path.join(path.dirname(database), 'codex-plan-activity', key), workspace, git: repo !== null };
    }
    catch {
        return null;
    }
}
function cleanRevision(scope) {
    if (!scope.git)
        return null;
    const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', scope.workspace, ...args], {
        encoding: 'utf8', timeout: 650, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    try {
        const head = git('rev-parse', '--verify', 'HEAD');
        return validRevision(head) && git('status', '--porcelain') === '' ? head : null;
    }
    catch {
        return null;
    }
}
function readOperation(file, now) {
    try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        let data;
        try {
            const opened = fs.fstatSync(fd, { bigint: true });
            if (!opened.isFile() || opened.size > BigInt(MAX_RECORD_BYTES))
                return null;
            const entry = fs.lstatSync(file, { bigint: true });
            if (!entry.isFile() || entry.dev !== opened.dev || entry.ino !== opened.ino)
                return null;
            const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
            const size = fs.readSync(fd, buf, 0, buf.length, 0);
            if (size > MAX_RECORD_BYTES)
                return null;
            data = JSON.parse(buf.toString('utf8', 0, size));
        }
        finally {
            fs.closeSync(fd);
        }
        if (!data || !isValidCodexThreadId(data.session) || !Number.isSafeInteger(data.since)
            || data.since > now || data.since < now - MAX_AGE_MS
            || (data.revision !== null && !validRevision(data.revision))
            || (data.task !== undefined && (typeof data.task !== 'string' || !/^[0-9a-f]{64}$/.test(data.task)))
            || (data.returned !== undefined && (!Number.isSafeInteger(data.returned) || data.returned < data.since || data.returned > now)))
            return null;
        return { session: data.session, since: data.since, revision: data.revision, task: data.task, returned: data.returned };
    }
    catch {
        return null;
    }
}
export function continuationWrite(project, cwd, session, turn, invocation, returned, task, now = Date.now()) {
    if (!isValidCodexThreadId(session) || !turn || turn.length > 128 || !invocation || invocation.length > 256)
        return null;
    const scope = scopeFor(project, cwd);
    if (!scope)
        return null;
    const file = path.join(scope.directory, `${sha([session, turn, invocation])}.json`);
    const existing = readOperation(file, now);
    if (existing && existing.session !== session)
        return null;
    if (returned) {
        if (!existing || existing.returned !== undefined)
            return null;
        return { directory: scope.directory, file, record: { ...existing, returned: now } };
    }
    if (existing)
        return null;
    return { directory: scope.directory, file, record: { since: now, session, revision: cleanRevision(scope), task } };
}
export function pruneContinuation(directory, keptFile, keptSince, now = Date.now()) {
    try {
        const files = fs.opendirSync(directory);
        try {
            for (let count = 0; count < MAX_FILES_READ; count++) {
                const entry = files.readSync();
                if (!entry)
                    break;
                if (!entry.isFile() || !RECORD_NAME.test(entry.name))
                    continue;
                const file = path.join(directory, entry.name);
                if (file === keptFile)
                    continue;
                const record = readOperation(file, now);
                const expired = !record && fs.lstatSync(file).mtimeMs < now - MAX_AGE_MS;
                if (expired || (record?.returned !== undefined && record.since < keptSince))
                    fs.unlinkSync(file);
            }
        }
        finally {
            files.closeSync();
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
export function continuationLines(project, cwd, currentSession, task, now = Date.now()) {
    const scope = scopeFor(project, cwd);
    if (!scope)
        return [];
    try {
        if (!fs.lstatSync(scope.directory).isDirectory())
            return [];
        const files = fs.opendirSync(scope.directory);
        const operations = [];
        try {
            for (let count = 0;; count++) {
                const entry = files.readSync();
                if (!entry)
                    break;
                if (count === MAX_FILES_READ)
                    return ['Previous shell activity is ambiguous in this worktree. Confirm the intended operation before continuing.'];
                if (!entry.isFile() || !RECORD_NAME.test(entry.name))
                    continue;
                const operation = readOperation(path.join(scope.directory, entry.name), now);
                if (operation && operation.session !== currentSession)
                    operations.push(operation);
            }
        }
        finally {
            files.closeSync();
        }
        const relevant = operations.filter(op => op.task === undefined || op.task === task);
        const open = relevant.filter(op => op.returned === undefined);
        if (open.length > 1)
            return ['More than one earlier shell request in this worktree has an unknown result. Confirm the intended operation before continuing.'];
        const operation = open[0] ?? relevant.sort((a, b) => b.since - a.since)[0];
        if (!operation)
            return [];
        const revision = cleanRevision(scope);
        const where = `Previous Codex shell request in this worktree (${new Date(operation.since).toISOString()})`;
        if (operation.revision !== null && revision !== null && operation.revision !== revision) {
            return [`${where} belongs to an older revision (${operation.revision.slice(0, 12)}). Confirm the current task and candidate.`];
        }
        const validity = (operation.task === undefined ? ' Task association is unknown.' : '')
            + (operation.revision !== null && revision === operation.revision ? '' : ' Candidate match is unknown.');
        if (operation.returned === undefined) {
            return [`${where} has no observed return. Result and process liveness are unknown.${validity} Confirm the operation and its effects before deciding whether to rerun.`];
        }
        return [`${where} returned to the host.${validity} Check its result or effects before treating the task as complete or repeating it.`];
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=continuation.js.map