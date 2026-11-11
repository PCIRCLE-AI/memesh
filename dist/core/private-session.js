import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
export const PRIVATE_SESSION_TOOL = 'private_session';
export const PRIVATE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const PARENT_NOT_FOUND_PERSISTENT_MS = 7 * 24 * 60 * 60 * 1000;
export const PRIVATE_CHECK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_CALL_LINE_BYTES = 64 * 1024 * 1024;
const HEADER_MAX_BYTES = 4 * 1024 * 1024;
const NEEDLE = Buffer.from(PRIVATE_SESSION_TOOL);
const CALL_RECORD_TYPES = ['"tool_use"', '"McpToolCall"', '"function_call"', '"compacted"'].map((s) => Buffer.from(s));
const MAX_FORK_DEPTH = 5;
const MAX_PARENTS = 8;
const PARENT_MAX_BYTES = 1024 * 1024 * 1024;
const PARENT_ZST_MAX_BYTES = 128 * 1024 * 1024;
const PARENT_ZST_MAX_OUTPUT = 512 * 1024 * 1024;
const ZST_MIN_TIME_MS = 1000;
const SUBAGENT_MAX_DEPTH = 3;
const STALE_TEMP_MS = 60_000;
export const UNCHECKED_KIND = Object.freeze({
    marker_unreadable: 'transient',
    unreadable: 'transient',
    timeout: 'transient',
    parent_not_found: 'transient',
    parent_unreadable: 'transient',
    too_large: 'persistent',
    parent_too_large: 'persistent',
    fork_too_deep: 'persistent',
    header_unreadable: 'persistent',
    no_zstd: 'persistent',
    no_session_id: 'persistent',
});
export function uncheckedKind(reason, since, now = Date.now()) {
    if (reason === 'parent_not_found' && typeof since === 'number' && now - since >= PARENT_NOT_FOUND_PERSISTENT_MS)
        return 'persistent';
    return UNCHECKED_KIND[reason] ?? 'transient';
}
const unchecked = (reason, detail) => ({ state: 'unchecked', reason, kind: UNCHECKED_KIND[reason], detail });
class CheckFailure extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
    }
}
const errCode = (err) => err?.code ?? 'error';
const MCP_TOOL_NAME = new RegExp(`^mcp__.+__${PRIVATE_SESSION_TOOL}$`);
export function isPrivateToolName(name) {
    return name === PRIVATE_SESSION_TOOL || MCP_TOOL_NAME.test(name);
}
export function sessionFileName(sessionId) {
    return `${/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`;
}
export const privateCheckCacheDir = (memeshDir) => path.join(memeshDir, 'private-check-cache');
export function privateMarkerPath(memeshDir, sessionId) {
    return path.join(memeshDir, 'private-sessions', sessionFileName(sessionId));
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function hasToolUse(node, depth = 0) {
    if (depth > 16 || node === null || typeof node !== 'object')
        return false;
    if (Array.isArray(node))
        return node.some((item) => hasToolUse(item, depth + 1));
    const obj = node;
    if (obj.type === 'tool_use')
        return typeof obj.name === 'string' && isPrivateToolName(obj.name);
    if (obj.type === 'tool_result')
        return false;
    return Object.values(obj).some((value) => hasToolUse(value, depth + 1));
}
function isToolCall(entry) {
    const payload = record(entry.payload);
    if (entry.type === 'event_msg') {
        const item = record(payload?.item);
        return payload?.type === 'item_completed' && item?.type === 'McpToolCall' && item.tool === PRIVATE_SESSION_TOOL;
    }
    if (entry.type === 'response_item') {
        return payload?.type === 'function_call' && typeof payload.namespace === 'string' && payload.namespace.startsWith('mcp__') && payload.name === PRIVATE_SESSION_TOOL;
    }
    if (entry.type === 'compacted') {
        const history = payload?.replacement_history_metadata;
        return Array.isArray(history) && history.some((meta) => {
            const sources = record(record(meta)?.mcp_attribution)?.sources;
            return Array.isArray(sources) && sources.some((source) => record(source)?.tool_name === PRIVATE_SESSION_TOOL);
        });
    }
    return hasToolUse(entry);
}
export function chatCallsPrivateTool(messages) {
    return Array.isArray(messages) && messages.some((message) => {
        const calls = record(message)?.tool_calls;
        return record(message)?.role === 'assistant' && Array.isArray(calls) && calls.some((call) => {
            const name = record(record(call)?.function)?.name;
            return name === PRIVATE_SESSION_TOOL || name === `memesh_${PRIVATE_SESSION_TOOL}`;
        });
    });
}
class Scan {
    deadlineAt;
    found = false;
    forks = [];
    headerBroken = false;
    constructor(deadlineAt = Number.POSITIVE_INFINITY) {
        this.deadlineAt = deadlineAt;
    }
    header(line) {
        if (!line.includes('"session_meta"'))
            return;
        if (line.length > HEADER_MAX_BYTES) {
            this.headerBroken = true;
            return;
        }
        try {
            const payload = record(record(JSON.parse(line.toString('utf8')))?.payload);
            for (const field of [payload?.forked_from_id, payload?.parent_thread_id]) {
                if (field === undefined || field === null)
                    continue;
                if (typeof field !== 'string' || field === '') {
                    this.headerBroken = true;
                    continue;
                }
                if (!this.forks.includes(field))
                    this.forks.push(field);
            }
        }
        catch {
            this.headerBroken = true;
        }
    }
    line(line) {
        if (!CALL_RECORD_TYPES.some((type) => line.includes(type)))
            return;
        if (Date.now() > this.deadlineAt)
            throw new CheckFailure('timeout', 'the check ran out of time');
        try {
            const entry = record(JSON.parse(line.toString('utf8')));
            if (entry !== null && isToolCall(entry))
                this.found = true;
        }
        catch {
        }
    }
    feed(buf) {
        let from = 0;
        while (!this.found) {
            const hit = buf.indexOf(NEEDLE, from);
            if (hit === -1)
                return;
            const start = buf.lastIndexOf(10, hit) + 1;
            let end = buf.indexOf(10, hit);
            if (end === -1)
                end = buf.length;
            from = end + 1;
            if (end - start > MAX_CALL_LINE_BYTES)
                throw new CheckFailure('too_large', 'a line that names the tool is too long to read');
            this.line(buf.subarray(start, end));
        }
    }
    verdict() { return { found: this.found, forks: this.forks, headerBroken: this.headerBroken }; }
}
const asBuffer = (bytes) => (typeof bytes === 'string'
    ? Buffer.from(bytes)
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
function scanBytes(bytes, deadlineAt) {
    const scan = new Scan(deadlineAt);
    const nl = bytes.indexOf(10);
    scan.header(nl === -1 ? bytes : bytes.subarray(0, nl));
    scan.feed(bytes);
    return scan.verdict();
}
export function forEachTranscriptLine(filePath, deadlineAt, onLine) {
    const fd = fs.openSync(filePath, 'r');
    try {
        if (fs.fstatSync(fd).isDirectory())
            throw Object.assign(new Error('transcript path is a directory'), { code: 'EISDIR' });
        const chunk = Buffer.alloc(CHUNK_BYTES);
        let pieces = [];
        let pending = 0;
        let longLines = 0;
        const endLine = (last) => {
            if (pending + last.length <= MAX_CALL_LINE_BYTES)
                onLine(pieces.length === 0 ? last : Buffer.concat([...pieces, last]));
            else
                longLines++;
            pieces = [];
            pending = 0;
        };
        for (;;) {
            if (Date.now() > deadlineAt)
                return { timedOut: true, longLines };
            const n = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (n === 0)
                break;
            const data = chunk.subarray(0, n);
            let from = 0;
            for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, from)) {
                endLine(data.subarray(from, nl));
                from = nl + 1;
            }
            const rest = n - from;
            if (rest > 0) {
                if (pending + rest <= MAX_CALL_LINE_BYTES)
                    pieces.push(Buffer.from(data.subarray(from)));
                else
                    pieces = [];
                pending += rest;
            }
        }
        if (pending > 0)
            endLine(Buffer.alloc(0));
        return { timedOut: false, longLines };
    }
    finally {
        fs.closeSync(fd);
    }
}
function scanPlain(filePath, deadlineAt) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    }
    catch (err) {
        throw new CheckFailure('unreadable', `a transcript cannot be read (${errCode(err)})`);
    }
    const scan = new Scan(deadlineAt);
    try {
        if (fs.fstatSync(fd).isDirectory())
            throw new CheckFailure('unreadable', 'a transcript path is a directory');
        const chunk = Buffer.alloc(CHUNK_BYTES);
        let tail = Buffer.alloc(0);
        let tailDropped = false;
        let tailHasNeedle = false;
        let first = true;
        const overlap = NEEDLE.length - 1;
        const endLine = (rest) => {
            if (tailDropped) {
                if (tailHasNeedle || Buffer.concat([tail.subarray(Math.max(0, tail.length - overlap)), rest]).includes(NEEDLE)) {
                    throw new CheckFailure('too_large', 'a line that names the tool is too long to read');
                }
                if (first) {
                    scan.headerBroken = scan.headerBroken || tail.includes('"session_meta"');
                    first = false;
                }
            }
            else {
                const line = tail.length === 0 ? rest : Buffer.concat([tail, rest]);
                if (first) {
                    scan.header(line);
                    first = false;
                }
                if (line.includes(NEEDLE)) {
                    if (line.length > MAX_CALL_LINE_BYTES)
                        throw new CheckFailure('too_large', 'a line that names the tool is too long to read');
                    scan.line(line);
                }
            }
            tail = Buffer.alloc(0);
            tailDropped = false;
            tailHasNeedle = false;
        };
        for (;;) {
            if (scan.found)
                break;
            if (Date.now() > deadlineAt)
                throw new CheckFailure('timeout', 'the check ran out of time');
            let n;
            try {
                n = fs.readSync(fd, chunk, 0, chunk.length, null);
            }
            catch (err) {
                throw new CheckFailure('unreadable', `a transcript cannot be read (${errCode(err)})`);
            }
            if (n === 0)
                break;
            const data = chunk.subarray(0, n);
            const firstNl = data.indexOf(10);
            if (firstNl === -1) {
                if (!tailDropped && tail.length + n <= MAX_CALL_LINE_BYTES) {
                    tail = Buffer.concat([tail, data]);
                }
                else {
                    const joined = Buffer.concat([tail.subarray(Math.max(0, tail.length - overlap)), data]);
                    tailHasNeedle = tailHasNeedle || joined.includes(NEEDLE) || (!tailDropped && tail.includes(NEEDLE));
                    if (first && !tailDropped)
                        scan.headerBroken = scan.headerBroken || Buffer.concat([tail, data]).subarray(0, HEADER_MAX_BYTES).includes('"session_meta"');
                    tailDropped = true;
                    tail = Buffer.from(data.subarray(Math.max(0, n - overlap)));
                }
                continue;
            }
            endLine(data.subarray(0, firstNl));
            const lastNl = data.lastIndexOf(10);
            if (lastNl > firstNl)
                scan.feed(data.subarray(firstNl + 1, lastNl + 1));
            tail = Buffer.from(data.subarray(lastNl + 1));
        }
        if (!scan.found && (tail.length > 0 || tailDropped))
            endLine(Buffer.alloc(0));
    }
    finally {
        fs.closeSync(fd);
    }
    return scan.verdict();
}
function scanZst(filePath, deadlineAt) {
    if (typeof zlib.zstdDecompressSync !== 'function')
        throw new CheckFailure('no_zstd', 'this Node cannot read an archived (.zst) rollout');
    if (deadlineAt - Date.now() < ZST_MIN_TIME_MS)
        throw new CheckFailure('timeout', 'too little time is left to expand an archived rollout');
    let bytes;
    try {
        bytes = zlib.zstdDecompressSync(fs.readFileSync(filePath), { maxOutputLength: PARENT_ZST_MAX_OUTPUT });
    }
    catch (err) {
        const code = errCode(err);
        throw new CheckFailure(code === 'ERR_BUFFER_TOO_LARGE' ? 'parent_too_large' : 'parent_unreadable', `an archived rollout cannot be read (${code})`);
    }
    return scanBytes(bytes, deadlineAt);
}
export function writeFileAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
}
export function removeStaleTemps(dir, now = Date.now()) {
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return 0;
    }
    let removed = 0;
    for (const name of names.filter((n) => n.endsWith('.tmp'))) {
        try {
            const p = path.join(dir, name);
            if (now - fs.statSync(p).mtimeMs > STALE_TEMP_MS) {
                fs.rmSync(p, { force: true });
                removed++;
            }
        }
        catch { }
    }
    return removed;
}
const remembered = new Map();
function fileVerdict(file, stat, zst, cacheDir, deadlineAt) {
    const key = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
    const hit = remembered.get(file);
    if (hit?.key === key)
        return hit.verdict;
    const cacheFile = cacheDir === undefined ? undefined : path.join(cacheDir, `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 40)}.json`);
    if (cacheFile !== undefined) {
        try {
            const saved = record(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
            if (saved?.key === key && typeof saved.found === 'boolean' && typeof saved.headerBroken === 'boolean'
                && Array.isArray(saved.forks) && saved.forks.every((f) => typeof f === 'string')) {
                const verdict = { found: saved.found, forks: saved.forks, headerBroken: saved.headerBroken };
                remembered.set(file, { key, verdict });
                return verdict;
            }
        }
        catch { }
    }
    const verdict = zst ? scanZst(file, deadlineAt) : scanPlain(file, deadlineAt);
    remembered.set(file, { key, verdict });
    if (cacheFile !== undefined) {
        try {
            writeFileAtomic(cacheFile, JSON.stringify({ key, ...verdict }));
        }
        catch { }
    }
    return verdict;
}
const CACHE_PRUNE_LOOK = 200;
const CACHE_PRUNE_MAX = 50;
export function prunePrivateCheckCache(cacheDir, now = Date.now()) {
    let names;
    try {
        names = fs.readdirSync(cacheDir);
    }
    catch {
        return 0;
    }
    let removed = removeStaleTemps(cacheDir, now);
    const start = names.length === 0 ? 0 : Math.floor(Math.random() * names.length);
    for (let i = 0; i < Math.min(names.length, CACHE_PRUNE_LOOK) && removed < CACHE_PRUNE_MAX; i++) {
        const name = names[(start + i) % names.length];
        const entry = path.join(cacheDir, name);
        try {
            if (!name.endsWith('.json'))
                continue;
            const key = record(JSON.parse(fs.readFileSync(entry, 'utf8')))?.key;
            const file = typeof key === 'string' ? key.split('\0')[0] : '';
            let gone = file === '';
            if (!gone) {
                try {
                    fs.statSync(file);
                }
                catch (err) {
                    gone = errCode(err) === 'ENOENT';
                }
            }
            if (gone) {
                fs.rmSync(entry, { force: true });
                removed++;
            }
        }
        catch { }
    }
    return removed;
}
export function sessionTranscriptFiles(transcriptPath, deadlineAt = Number.POSITIVE_INFINITY) {
    const files = [transcriptPath];
    const walk = (dir, depth) => {
        if (Date.now() > deadlineAt)
            throw new CheckFailure('timeout', 'the check ran out of time listing the subagents folder');
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch (err) {
            if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR')
                return;
            throw new CheckFailure('unreadable', `the subagents folder cannot be read (${errCode(err)})`);
        }
        for (const entry of entries) {
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth >= SUBAGENT_MAX_DEPTH)
                    throw new CheckFailure('too_large', 'the subagents folder is nested deeper than can be checked');
                walk(child, depth + 1);
                continue;
            }
            if (entry.isFile() && entry.name.endsWith('.jsonl'))
                files.push(child);
        }
    };
    walk(`${transcriptPath.replace(/\.jsonl$/, '')}/subagents`, 0);
    return files;
}
export function sessionLastWriteMs(transcriptPath, deadlineAt = Number.POSITIVE_INFINITY) {
    let files;
    try {
        files = sessionTranscriptFiles(transcriptPath, deadlineAt);
    }
    catch {
        return undefined;
    }
    let newest = 0;
    for (const file of files) {
        try {
            newest = Math.max(newest, fs.statSync(file).mtimeMs);
        }
        catch (err) {
            if (errCode(err) !== 'ENOENT')
                return undefined;
        }
    }
    return newest;
}
export function findCodexRollout(codexHome, id, deadlineAt = Number.POSITIVE_INFINITY) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
        return undefined;
    const plain = `-${id}.jsonl`;
    const zst = `${plain}.zst`;
    const walk = (dir, depth, found) => {
        if (Date.now() > deadlineAt)
            throw new CheckFailure('timeout', 'the check ran out of time looking for a parent rollout');
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch (err) {
            if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR')
                return;
            throw new CheckFailure('parent_unreadable', `a folder that may hold the parent rollout cannot be read (${errCode(err)})`);
        }
        for (const entry of entries) {
            if (found.plain)
                return;
            const child = path.join(dir, entry.name);
            let isFile = entry.isFile();
            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    const st = fs.statSync(child);
                    isFile = st.isFile();
                    isDir = st.isDirectory();
                }
                catch {
                    continue;
                }
            }
            if (isFile && entry.name.startsWith('rollout-')) {
                if (entry.name.endsWith(plain))
                    found.plain = child;
                else if (entry.name.endsWith(zst))
                    found.zst ??= child;
            }
            else if (isDir && depth < 3) {
                walk(child, depth + 1, found);
            }
        }
    };
    const roots = ['sessions', 'archived_sessions'].map((d) => path.join(codexHome, d));
    const found = {};
    for (const root of roots) {
        walk(root, 0, found);
        if (found.plain)
            return { file: found.plain, zst: false };
    }
    return found.zst ? { file: found.zst, zst: true } : undefined;
}
function codexHomeOf(file) {
    let dir = path.dirname(file);
    for (;;) {
        const base = path.basename(dir);
        if (base === 'sessions' || base === 'archived_sessions')
            return path.dirname(dir);
        const up = path.dirname(dir);
        if (up === dir)
            return undefined;
        dir = up;
    }
}
export function decidePrivacy(input) {
    let candidate;
    const note = (reason, detail) => {
        if (candidate === undefined || (candidate.kind === 'transient' && UNCHECKED_KIND[reason] === 'persistent'))
            candidate = unchecked(reason, detail);
    };
    const noteFailure = (err, fallback) => {
        if (err instanceof CheckFailure)
            note(err.reason, err.message);
        else
            note(fallback, `a transcript cannot be read (${errCode(err)})`);
    };
    const settled = () => candidate ?? { state: 'no' };
    if (input.messages !== undefined && chatCallsPrivateTool(input.messages))
        return { state: 'yes', evidence: 'messages' };
    if (typeof input.sessionId === 'string' && input.sessionId !== '') {
        try {
            fs.statSync(privateMarkerPath(input.memeshDir, input.sessionId));
            return { state: 'yes', evidence: 'marker' };
        }
        catch (err) {
            if (errCode(err) !== 'ENOENT')
                note('marker_unreadable', `the private-session marker cannot be read (${errCode(err)})`);
        }
    }
    const transcriptPath = input.transcriptPath;
    const snapshot = input.snapshot === undefined ? undefined : asBuffer(input.snapshot);
    if (typeof transcriptPath !== 'string' || transcriptPath === '') {
        if (snapshot === undefined)
            return settled();
        let alone;
        try {
            alone = scanBytes(snapshot, input.deadlineAt);
        }
        catch (err) {
            noteFailure(err, 'unreadable');
        }
        if (alone?.found)
            return { state: 'yes', evidence: 'transcript' };
        if (alone?.headerBroken)
            note('header_unreadable', 'the first line of the rollout is damaged, so whether it is a fork cannot be told');
        else if (alone && alone.forks.length > 0)
            note('parent_not_found', 'the parent rollout of this forked thread cannot be looked for without the transcript\'s path');
        return settled();
    }
    const stats = [];
    if (snapshot === undefined) {
        let mainStat;
        try {
            mainStat = fs.statSync(transcriptPath);
        }
        catch (err) {
            if (errCode(err) === 'ENOENT')
                return settled();
            note('unreadable', `the transcript cannot be read (${errCode(err)})`);
            return settled();
        }
        if (!mainStat.isFile()) {
            note('unreadable', 'the transcript path is not a file');
            return settled();
        }
        stats.push({ file: transcriptPath, stat: mainStat });
    }
    let files;
    try {
        files = sessionTranscriptFiles(transcriptPath, input.deadlineAt);
    }
    catch (err) {
        noteFailure(err, 'unreadable');
        files = [transcriptPath];
    }
    for (const file of files.slice(1)) {
        try {
            stats.push({ file, stat: fs.statSync(file) });
        }
        catch (err) {
            note('unreadable', `a subagent transcript cannot be read (${errCode(err)})`);
        }
    }
    const total = stats.reduce((sum, s) => sum + s.stat.size, snapshot?.length ?? 0);
    if (total > PRIVATE_CHECK_MAX_BYTES) {
        note('too_large', 'the session\'s transcripts are too large to check');
        return settled();
    }
    let main;
    if (snapshot !== undefined) {
        try {
            main = scanBytes(snapshot, input.deadlineAt);
        }
        catch (err) {
            noteFailure(err, 'unreadable');
        }
        if (main?.found)
            return { state: 'yes', evidence: 'transcript' };
    }
    for (const { file, stat } of stats) {
        let verdict;
        try {
            verdict = fileVerdict(file, stat, false, input.cacheDir, input.deadlineAt);
        }
        catch (err) {
            noteFailure(err, 'unreadable');
            continue;
        }
        if (verdict.found)
            return { state: 'yes', evidence: file === transcriptPath ? 'transcript' : 'subagent' };
        if (file === transcriptPath)
            main = verdict;
    }
    if (main === undefined)
        return settled();
    if (main.headerBroken) {
        note('header_unreadable', 'the first line of the rollout is damaged, so whether it is a fork cannot be told');
        return settled();
    }
    const queue = main.forks.map((id) => ({ id, from: transcriptPath, depth: 0 }));
    const seen = new Set();
    let parents = 0;
    while (queue.length > 0) {
        const { id, from, depth } = queue.shift();
        if (seen.has(id))
            continue;
        seen.add(id);
        if (depth >= MAX_FORK_DEPTH || ++parents > MAX_PARENTS) {
            note('fork_too_deep', `the thread is forked more than ${MAX_FORK_DEPTH} levels deep, or from more than ${MAX_PARENTS} rollouts`);
            continue;
        }
        const home = codexHomeOf(from);
        let parent;
        try {
            parent = home === undefined ? undefined : findCodexRollout(home, id, input.deadlineAt);
        }
        catch (err) {
            noteFailure(err, 'parent_unreadable');
            continue;
        }
        if (parent === undefined) {
            note('parent_not_found', 'the parent rollout of this forked thread was not found');
            continue;
        }
        let stat;
        try {
            stat = fs.statSync(parent.file);
        }
        catch (err) {
            note('parent_unreadable', `the parent rollout cannot be read (${errCode(err)})`);
            continue;
        }
        if (stat.size > (parent.zst ? PARENT_ZST_MAX_BYTES : PARENT_MAX_BYTES)) {
            note('parent_too_large', 'the parent rollout is too large to check');
            continue;
        }
        let verdict;
        try {
            verdict = fileVerdict(parent.file, stat, parent.zst, input.cacheDir, input.deadlineAt);
        }
        catch (err) {
            if (err instanceof CheckFailure && err.reason === 'unreadable')
                note('parent_unreadable', err.message.replace('a transcript', 'the parent rollout'));
            else
                noteFailure(err, 'parent_unreadable');
            continue;
        }
        if (verdict.found)
            return { state: 'yes', evidence: 'fork_parent' };
        if (verdict.headerBroken) {
            note('header_unreadable', 'the first line of a parent rollout is damaged, so whether it is a fork cannot be told');
            continue;
        }
        for (const next of verdict.forks)
            queue.push({ id: next, from: parent.file, depth: depth + 1 });
    }
    return settled();
}
//# sourceMappingURL=private-session.js.map