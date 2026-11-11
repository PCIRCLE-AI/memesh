import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDatabase } from '../db.js';
import { getMemeshDirFromDbPath } from './paths.js';
import { remember } from './operations.js';
import { sanitizeNoteText, splitObservations, NOTE_DEFAULT_TYPE, NOTE_MAX_OBSERVATIONS } from './note-derive.js';
import { truncateTitle } from './title.js';
import { decidePrivacy, PRIVATE_WINDOW_MS, sessionFileName, sessionLastWriteMs, uncheckedKind } from './private-session.js';
import { PRIVATE_STATE_BUSY, withPrivateStateLock } from './private-state-lock.js';
export const NOTE_FILE_TAG = 'source:note-file';
export const NOTE_FILE_MISSING_TAG = 'source:note-file:missing';
export const NOTE_FILE_MAX_BYTES = 256 * 1024;
export const NOTE_DIR_MAX_FILES = 500;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
function unquote(value) {
    const v = value.trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        try {
            return JSON.parse(v);
        }
        catch {
            return v.slice(1, -1);
        }
    }
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
        return v.slice(1, -1).replace(/''/g, "'");
    return v;
}
export function parseFrontmatter(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    if (lines[0]?.trim() !== '---')
        return null;
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
    if (end < 0)
        return null;
    const data = {};
    let nested = null;
    for (const line of lines.slice(1, end)) {
        if (!line.trim() || line.trim().startsWith('#'))
            continue;
        const indented = /^\s/.test(line);
        const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
        if (!m)
            continue;
        const [, key, rawValue] = m;
        if (indented) {
            if (nested)
                nested[key] = unquote(rawValue);
            continue;
        }
        if (rawValue.trim() === '') {
            nested = {};
            data[key] = nested;
        }
        else {
            nested = null;
            data[key] = unquote(rawValue);
        }
    }
    return { data, body: lines.slice(end + 1).join('\n') };
}
function stringField(data, key) {
    const v = data[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function discover(realDir) {
    const files = [];
    const symlinks = [];
    const walk = (abs) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const child = path.join(abs, entry.name);
            if (entry.isSymbolicLink()) {
                if (entry.name.toLowerCase().endsWith('.md'))
                    symlinks.push(child);
                continue;
            }
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name))
                    walk(child);
                continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
                files.push(child);
        }
    };
    walk(realDir);
    files.sort();
    symlinks.sort();
    return { files, symlinks };
}
const relPath = (realDir, abs) => path.relative(realDir, abs).split(path.sep).join('/');
function parseProvenance(raw) {
    if (!raw)
        return {};
    try {
        const meta = JSON.parse(raw);
        return meta?.provenance && typeof meta.provenance === 'object' ? meta.provenance : {};
    }
    catch {
        return {};
    }
}
const MARKERS_DIR = 'private-sessions';
const HOLDS_DIR = 'note-ingest-holds';
const markersDir = () => path.join(getMemeshDirFromDbPath(), MARKERS_DIR);
const holdsDir = () => path.join(getMemeshDirFromDbPath(), HOLDS_DIR);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const dirIdOf = (realDir) => sha256(realDir).slice(0, 16);
const codeOf = (err) => err?.code ?? 'error';
const DEFAULT_LOCK_WAIT_MS = 5_000;
const MARKER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const REDECIDE_PER_RUN = 10;
const MAX_PROJECT_FOLDERS = 200;
export const NOTE_MARKERS_UNREADABLE = 'MEMESH_NOTE_MARKERS_UNREADABLE';
export const NOTE_MARKERS_DIR_UNREADABLE = 'MEMESH_NOTE_MARKERS_DIR_UNREADABLE';
export const NOTE_MARKER_UNWRITABLE = 'MEMESH_NOTE_MARKER_UNWRITABLE';
export const NOTE_HOLDS_UNREADABLE = 'MEMESH_NOTE_HOLDS_UNREADABLE';
export const NOTE_HOLDS_DIR_UNREADABLE = 'MEMESH_NOTE_HOLDS_DIR_UNREADABLE';
export const NOTE_HOLDS_UNWRITABLE = 'MEMESH_NOTE_HOLDS_UNWRITABLE';
export { PRIVATE_STATE_BUSY };
const fail = (code, message) => Object.assign(new Error(message), { code });
export const NOTE_PRIVATE_HOLD_REASON = 'held out by a private session — not imported';
export const NOTE_UNCHECKED_HOLD_REASON = 'held while a session could not be checked — not imported yet';
function realPathOrExpected(dir) {
    try {
        return fs.realpathSync(dir);
    }
    catch (err) {
        if (codeOf(err) !== 'ENOENT')
            throw err;
        return path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
    }
}
export const projectsRootOf = (memoryDir) => path.dirname(path.dirname(memoryDir));
export function projectMemoryFolders(projectsRoot) {
    let entries;
    try {
        entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
    }
    catch {
        return { folders: [], complete: false };
    }
    const folders = [];
    let complete = true;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (folders.length >= MAX_PROJECT_FOLDERS) {
            complete = false;
            break;
        }
        const dir = path.join(projectsRoot, entry.name, 'memory');
        try {
            const st = fs.lstatSync(dir);
            if (st.isDirectory() && !st.isSymbolicLink())
                folders.push(fs.realpathSync(dir));
        }
        catch { }
    }
    return { folders, complete };
}
const touchedAt = (st) => Math.max(st.mtimeMs, st.ctimeMs);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function parseMarker(text) {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.session !== 'string' || !isNum(m.startedAt) || !isNum(m.updatedAt)
        || !isNum(m.holdsAt) || typeof m.projectsRoot !== 'string' || !Array.isArray(m.dirs) || !m.dirs.every((d) => typeof d === 'string')
        || (m.transcript !== undefined && typeof m.transcript !== 'string')
        || (m.endedAt !== undefined && !isNum(m.endedAt)) || (m.finalizedAt !== undefined && !isNum(m.finalizedAt))) {
        throw new Error('not a marker');
    }
    return m;
}
const markerFile = (sessionId) => path.join(markersDir(), sessionFileName(sessionId));
const markerUnreadable = (name, err) => fail(NOTE_MARKERS_UNREADABLE, `${MARKERS_DIR}/${name} cannot be read (${err.message}); notes are not imported until it is rebuilt by its session or, for a session that has ended, deleted`);
function readMarker(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        if (codeOf(err) === 'ENOENT')
            return undefined;
        throw markerUnreadable(path.basename(file), err);
    }
    try {
        return parseMarker(text);
    }
    catch (err) {
        throw markerUnreadable(path.basename(file), err);
    }
}
function writeMarker(file, marker) {
    try {
        fs.mkdirSync(markersDir(), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ v: 2, ...marker }), { mode: 0o600 });
        fs.renameSync(temp, file);
    }
    catch (err) {
        throw fail(NOTE_MARKER_UNWRITABLE, `${MARKERS_DIR}/${path.basename(file)} could not be written (${codeOf(err)})`);
    }
}
const lockDeadline = (deadlineAt) => deadlineAt ?? Date.now() + DEFAULT_LOCK_WAIT_MS;
export function markPrivateSession(opts) {
    const now = opts.now ?? Date.now();
    const file = markerFile(opts.sessionId);
    const dirs = (opts.dirs ?? []).map(realPathOrExpected);
    return withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(opts.deadlineAt), () => {
        let prior;
        try {
            prior = readMarker(file);
        }
        catch (err) {
            if (opts.rebuildFrom === undefined)
                throw err;
            prior = undefined;
        }
        const startedAt = Math.min(prior?.startedAt ?? now, opts.rebuildFrom ?? now);
        const transcript = opts.transcript ?? prior?.transcript;
        const projectsRoot = prior?.projectsRoot || opts.projectsRoot || (dirs[0] ? projectsRootOf(dirs[0]) : '');
        const marker = {
            session: opts.sessionId,
            dirs: [...new Set([...(prior?.dirs ?? []), ...dirs])],
            projectsRoot,
            ...(transcript === undefined ? {} : { transcript }),
            startedAt,
            updatedAt: Math.max(now, prior?.updatedAt ?? 0),
            holdsAt: opts.holdsAt ?? prior?.holdsAt ?? startedAt,
        };
        writeMarker(file, marker);
        return startedAt;
    });
}
export function renewPrivateSession(sessionId, now = Date.now(), deadlineAt) {
    return updateMarker(sessionId, deadlineAt, ({ endedAt: _e, finalizedAt: _f, ...live }) => ({ ...live, updatedAt: Math.max(now, live.updatedAt) }));
}
function updateMarker(sessionId, deadlineAt, change) {
    const file = markerFile(sessionId);
    return withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(deadlineAt), () => {
        const marker = readMarker(file);
        if (!marker)
            return false;
        writeMarker(file, change(marker));
        return true;
    });
}
export function endPrivateSession(sessionId, now = Date.now(), deadlineAt) {
    updateMarker(sessionId, deadlineAt, (marker) => ({ ...marker, endedAt: now }));
}
export function prunePrivateMarkers(now = Date.now(), max = 50, deadlineAt) {
    let names;
    try {
        names = fs.readdirSync(markersDir());
    }
    catch (err) {
        if (codeOf(err) === 'ENOENT')
            return 0;
        throw fail(NOTE_MARKERS_DIR_UNREADABLE, `${MARKERS_DIR} cannot be read (${codeOf(err)})`);
    }
    let removed = 0;
    for (const name of names.filter((n) => n.endsWith('.json'))) {
        if (removed >= max)
            break;
        const file = path.join(markersDir(), name);
        let marker;
        try {
            marker = readMarker(file);
        }
        catch {
            continue;
        }
        if (!marker || (marker.endedAt === undefined && marker.finalizedAt === undefined))
            continue;
        let gone;
        if (typeof marker.transcript === 'string' && marker.transcript !== '') {
            try {
                fs.statSync(marker.transcript);
                gone = false;
            }
            catch (err) {
                gone = codeOf(err) === 'ENOENT';
            }
        }
        else {
            gone = now - marker.updatedAt > MARKER_KEEP_MS;
        }
        if (!gone)
            continue;
        withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(deadlineAt), () => {
            const again = readMarker(file);
            if (again && (again.endedAt !== undefined || again.finalizedAt !== undefined))
                fs.rmSync(file, { force: true });
        });
        removed++;
    }
    removeStaleTemps(markersDir(), names, now);
    try {
        removeStaleTemps(holdsDir(), fs.readdirSync(holdsDir()), now);
    }
    catch { }
    return removed;
}
function removeStaleTemps(dir, names, now) {
    for (const name of names.filter((n) => n.endsWith('.tmp'))) {
        try {
            const p = path.join(dir, name);
            if (now - fs.statSync(p).mtimeMs > 60_000)
                fs.rmSync(p, { force: true });
        }
        catch { }
    }
}
const isUnreadableMark = (hash) => hash.startsWith('?');
const unreadableSince = (hash) => { const n = Number(hash.slice(1)); return Number.isFinite(n) ? n : 0; };
const isDirHolds = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Object.values(value).every((files) => !!files && typeof files === 'object' && !Array.isArray(files)
        && Object.values(files).every((hash) => typeof hash === 'string'));
};
function parseHoldFile(text) {
    const p = JSON.parse(text);
    if (!p || typeof p !== 'object' || Array.isArray(p) || !isDirHolds(p.firm) || typeof p.session !== 'string' || !isNum(p.rev)
        || (p.transcript !== undefined && typeof p.transcript !== 'string'))
        throw new Error('not a hold record');
    const t = p.tentative;
    if (t === undefined)
        return { rev: p.rev, session: p.session, ...(p.transcript === undefined ? {} : { transcript: p.transcript }), firm: p.firm };
    if (!t || typeof t !== 'object' || typeof t.reason !== 'string' || !isNum(t.since) || !isNum(t.updatedAt) || !isNum(t.holdsAt)
        || typeof t.projectsRoot !== 'string' || !isDirHolds(t.dirs) || (t.endedAt !== undefined && !isNum(t.endedAt)))
        throw new Error('not a hold record');
    return {
        rev: p.rev, session: p.session, ...(p.transcript === undefined ? {} : { transcript: p.transcript }), firm: p.firm,
        tentative: { reason: t.reason, since: t.since, updatedAt: t.updatedAt, holdsAt: t.holdsAt, projectsRoot: t.projectsRoot, dirs: t.dirs, ...(t.endedAt === undefined ? {} : { endedAt: t.endedAt }) },
    };
}
const holdsUnreadable = (what, err) => fail(NOTE_HOLDS_UNREADABLE, `${HOLDS_DIR}${what} cannot be read (${err.message}); notes are not imported until it is repaired; deleting it releases the notes it holds`);
const holdFile = (sessionId) => path.join(holdsDir(), sessionFileName(sessionId));
function readHoldFile(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        if (codeOf(err) === 'ENOENT')
            return undefined;
        throw holdsUnreadable(`/${path.basename(file)}`, err);
    }
    try {
        return parseHoldFile(text);
    }
    catch (err) {
        throw holdsUnreadable(`/${path.basename(file)}`, err);
    }
}
const holdCount = (dirs) => Object.values(dirs).reduce((sum, files) => sum + Object.keys(files).length, 0);
function writeHoldFile(file, rec) {
    try {
        if (holdCount(rec.firm) === 0 && rec.tentative === undefined) {
            fs.rmSync(file, { force: true });
            return;
        }
        fs.mkdirSync(holdsDir(), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ v: 2, ...rec, rev: rec.rev + 1 }), { mode: 0o600 });
        fs.renameSync(temp, file);
    }
    catch (err) {
        throw fail(NOTE_HOLDS_UNWRITABLE, `${HOLDS_DIR}/${path.basename(file)} could not be written (${codeOf(err)}); nothing was released`);
    }
}
const mergeDirHolds = (into, from) => {
    for (const [dirId, files] of Object.entries(from))
        into[dirId] = { ...(into[dirId] ?? {}), ...files };
};
function hashNotes(realDir, candidates, now) {
    const forDir = {};
    for (const real of candidates) {
        let st;
        try {
            st = fs.lstatSync(real);
        }
        catch {
            continue;
        }
        if (!st.isFile() || !real.toLowerCase().endsWith('.md') || !real.startsWith(realDir + path.sep))
            continue;
        if (st.size > NOTE_FILE_MAX_BYTES)
            continue;
        const rel = relPath(realDir, real);
        try {
            forDir[rel] = sha256(fs.readFileSync(real));
        }
        catch {
            forDir[rel] = `?${now}`;
        }
    }
    return forDir;
}
function notesTouchedBetween(realDir, sinceMs, untilMs = Number.POSITIVE_INFINITY) {
    let files;
    try {
        files = discover(realDir).files;
    }
    catch {
        return [];
    }
    return files.filter((abs) => { try {
        const t = touchedAt(fs.lstatSync(abs));
        return t >= sinceMs && t <= untilMs;
    }
    catch {
        return false;
    } });
}
export function holdOutNoteFiles(opts) {
    const now = opts.now ?? Date.now();
    const realDir = fs.realpathSync(opts.dir);
    const dirId = dirIdOf(realDir);
    const candidates = new Set();
    for (const candidate of opts.paths) {
        try {
            candidates.add(fs.realpathSync(candidate));
        }
        catch { }
    }
    if (opts.sinceMs !== undefined)
        for (const abs of notesTouchedBetween(realDir, opts.sinceMs, opts.untilMs))
            candidates.add(abs);
    const forDir = hashNotes(realDir, candidates, now);
    updateHold(holdFile(opts.sessionId), opts.deadlineAt, (found) => {
        const rec = found ?? { rev: 0, session: opts.sessionId, firm: {} };
        if (opts.transcript !== undefined)
            rec.transcript = opts.transcript;
        if (opts.tentative) {
            const prior = rec.tentative;
            const dirs = prior?.dirs ?? {};
            mergeDirHolds(dirs, { [dirId]: forDir });
            rec.tentative = {
                reason: opts.tentative.reason, since: prior?.since ?? now, updatedAt: now,
                holdsAt: opts.tentative.holdsAt ?? prior?.holdsAt ?? now,
                projectsRoot: opts.tentative.projectsRoot ?? prior?.projectsRoot ?? projectsRootOf(realDir), dirs,
            };
        }
        else {
            mergeDirHolds(rec.firm, { [dirId]: forDir });
        }
        return rec;
    });
    return Object.keys(forDir).length;
}
function updateHold(file, deadlineAt, change) {
    return withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(deadlineAt), () => {
        const next = change(readHoldFile(file));
        if (next === undefined)
            return false;
        writeHoldFile(file, next);
        return true;
    });
}
export function settleTentativeHolds(sessionId, verdict, opts = {}) {
    return updateHold(holdFile(sessionId), opts.deadlineAt, (rec) => {
        if (!rec?.tentative)
            return undefined;
        if (opts.expectRev !== undefined && rec.rev !== opts.expectRev)
            return undefined;
        if (verdict === 'yes')
            mergeDirHolds(rec.firm, rec.tentative.dirs);
        delete rec.tentative;
        return rec;
    });
}
export function endTentativeWait(sessionId, now = Date.now(), deadlineAt) {
    updateHold(holdFile(sessionId), deadlineAt, (rec) => {
        if (!rec?.tentative)
            return undefined;
        rec.tentative.endedAt = now;
        return rec;
    });
}
function readAllHolds() {
    let names;
    try {
        names = fs.readdirSync(holdsDir());
    }
    catch (err) {
        if (codeOf(err) === 'ENOENT')
            return [];
        throw fail(NOTE_HOLDS_DIR_UNREADABLE, `${HOLDS_DIR} cannot be read (${codeOf(err)}); notes are not imported until it can be`);
    }
    const out = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
        const rec = readHoldFile(path.join(holdsDir(), name));
        if (rec)
            out.push({ name, rec });
    }
    return out;
}
function readAllMarkers() {
    let names;
    try {
        names = fs.readdirSync(markersDir());
    }
    catch (err) {
        if (codeOf(err) === 'ENOENT')
            return [];
        throw fail(NOTE_MARKERS_DIR_UNREADABLE, `${MARKERS_DIR} cannot be read (${codeOf(err)}); notes are not imported until it can be`);
    }
    const out = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
        const file = path.join(markersDir(), name);
        const marker = readMarker(file);
        if (marker)
            out.push({ file, marker });
    }
    return out;
}
function lastActivity(updatedAt, transcript) {
    if (typeof transcript !== 'string' || transcript === '')
        return updatedAt;
    const written = sessionLastWriteMs(transcript);
    return written === undefined ? undefined : Math.max(updatedAt, written);
}
function finalizeIdleMarker(entry, now, deadlineAt) {
    const { marker } = entry;
    if (now - marker.updatedAt <= PRIVATE_WINDOW_MS)
        return 'live';
    const last = lastActivity(marker.updatedAt, marker.transcript);
    if (last === undefined || now - last <= PRIVATE_WINDOW_MS)
        return 'live';
    const reached = new Set(marker.dirs);
    const all = marker.projectsRoot ? projectMemoryFolders(marker.projectsRoot).folders : [];
    for (const dir of new Set([...reached, ...all])) {
        if (!fs.existsSync(dir))
            continue;
        holdOutNoteFiles({ dir, sessionId: marker.session, paths: [], sinceMs: reached.has(dir) ? marker.startedAt : marker.holdsAt, untilMs: last, deadlineAt, now });
    }
    withPrivateStateLock(getMemeshDirFromDbPath(), deadlineAt, () => {
        const again = readMarker(entry.file);
        if (again && again.finalizedAt === undefined && again.updatedAt === marker.updatedAt)
            writeMarker(entry.file, { ...again, finalizedAt: now });
    });
    return 'finalized';
}
function readPrivateState(realDir, now, deadlineAt, memeshDir) {
    const dirId = dirIdOf(realDir);
    const root = projectsRootOf(realDir);
    const out = { firm: new Set(), tentative: new Set(), redecideLeft: 0 };
    const wait = (since) => { out.waitSince = out.waitSince === undefined ? since : Math.min(out.waitSince, since); };
    for (const entry of readAllMarkers()) {
        const { marker } = entry;
        if (marker.endedAt !== undefined || marker.finalizedAt !== undefined)
            continue;
        const mine = marker.dirs.includes(realDir) || marker.projectsRoot === root;
        if (!mine)
            continue;
        if (finalizeIdleMarker(entry, now, deadlineAt) === 'finalized')
            continue;
        wait(marker.holdsAt);
    }
    let redecided = 0;
    for (const { name, rec } of readAllHolds()) {
        let current = rec;
        const t = current.tentative;
        if (t && (t.dirs[dirId] !== undefined || (t.endedAt === undefined && t.projectsRoot === root))) {
            const decidable = current.transcript !== undefined || t.reason === 'marker_unreadable';
            if (!decidable) {
            }
            else if (redecided < REDECIDE_PER_RUN && Date.now() < deadlineAt) {
                redecided++;
                const state = decidePrivacy({ sessionId: current.session, transcriptPath: current.transcript, memeshDir, deadlineAt, cacheDir: path.join(memeshDir, 'private-check-cache') });
                if (state.state !== 'unchecked' && settleTentativeHolds(current.session, state.state, { expectRev: current.rev, deadlineAt })) {
                    current = readHoldFile(path.join(holdsDir(), name)) ?? { ...current, firm: {}, tentative: undefined };
                }
            }
            else {
                out.redecideLeft++;
            }
        }
        const t2 = current.tentative;
        if (t2 && t2.endedAt === undefined && t2.projectsRoot === root) {
            const last = lastActivity(t2.updatedAt, current.transcript);
            if (last !== undefined && now - t2.updatedAt > PRIVATE_WINDOW_MS && now - last > PRIVATE_WINDOW_MS) {
                holdOutNoteFiles({ dir: realDir, sessionId: current.session, paths: [], sinceMs: t2.holdsAt, untilMs: last, tentative: { reason: t2.reason }, deadlineAt, now });
                endTentativeWait(current.session, now, deadlineAt);
                current = readHoldFile(path.join(holdsDir(), name)) ?? current;
            }
            else {
                wait(t2.holdsAt);
            }
        }
        for (const [kind, dirs] of [['firm', current.firm], ['tentative', current.tentative?.dirs ?? {}]]) {
            for (const [rel, hash] of Object.entries(dirs[dirId] ?? {})) {
                if (!isUnreadableMark(hash)) {
                    (kind === 'firm' ? out.firm : out.tentative).add(hash);
                    continue;
                }
                const since = unreadableSince(hash);
                let resolved;
                try {
                    resolved = { [rel]: sha256(fs.readFileSync(path.join(realDir, rel))) };
                }
                catch (err) {
                    if (codeOf(err) === 'ENOENT')
                        resolved = hashNotes(realDir, notesTouchedBetween(realDir, since), now);
                }
                if (resolved === undefined || Object.values(resolved).some(isUnreadableMark)) {
                    wait(since);
                    continue;
                }
                updateHold(path.join(holdsDir(), name), deadlineAt, (again) => {
                    const target = kind === 'firm' ? again?.firm : again?.tentative?.dirs;
                    if (!again || target?.[dirId]?.[rel] !== hash)
                        return undefined;
                    delete target[dirId][rel];
                    target[dirId] = { ...target[dirId], ...resolved };
                    return again;
                });
                for (const h of Object.values(resolved))
                    (kind === 'firm' ? out.firm : out.tentative).add(h);
            }
        }
    }
    return out;
}
const UNCHECKED_REASON_TEXT = Object.freeze({
    marker_unreadable: 'the session\'s private-session marker could not be read',
    unreadable: 'the session\'s transcript or a subagent transcript could not be read',
    timeout: 'the check ran out of time',
    parent_not_found: 'the parent rollout of the forked thread was not found',
    parent_unreadable: 'the parent rollout of the forked thread could not be read',
    too_large: 'the session\'s transcripts are too large to check, or a line that names the tool is longer than 64 MiB',
    parent_too_large: 'the parent rollout is too large to check',
    fork_too_deep: 'the thread is forked more than five levels deep',
    header_unreadable: 'the first line of a rollout is damaged',
    no_zstd: 'this Node cannot read the archived parent rollout (it needs Node 22.15 or later)',
    no_session_id: 'the host gave no session id',
});
const SAFE_FILE_NAME = /^[A-Za-z0-9_-]{1,128}\.json$/;
const shownName = (name) => (SAFE_FILE_NAME.test(name) ? name : '(a file name memesh did not write)');
export function summarizeNoteHolds(now = Date.now()) {
    const out = { sessions: 0, notes: 0, holdsFolder: holdsDir(), markersFolder: markersDir(), unsettled: [], waitingOnUnreadable: [], damaged: [], unreadableFolders: [] };
    const list = (dir, folder) => {
        try {
            return fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
        }
        catch (err) {
            if (codeOf(err) !== 'ENOENT')
                out.unreadableFolders.push(folder);
            return [];
        }
    };
    for (const name of list(holdsDir(), 'holds')) {
        let rec;
        try {
            rec = readHoldFile(path.join(holdsDir(), name));
        }
        catch {
            out.damaged.push({ folder: 'holds', file: shownName(name) });
            continue;
        }
        if (!rec)
            continue;
        out.sessions++;
        const firm = holdCount(rec.firm);
        out.notes += firm;
        const unread = [...Object.values(rec.firm), ...Object.values(rec.tentative?.dirs ?? {})].flatMap((files) => Object.values(files)).filter(isUnreadableMark);
        if (unread.length > 0)
            out.waitingOnUnreadable.push({ file: shownName(name), notes: unread.length, since: Math.min(...unread.map(unreadableSince)) });
        if (rec.tentative) {
            const n = holdCount(rec.tentative.dirs);
            out.notes += n;
            const reason = Object.prototype.hasOwnProperty.call(UNCHECKED_REASON_TEXT, rec.tentative.reason) ? rec.tentative.reason : 'unrecognised';
            out.unsettled.push({
                session: shownName(name), file: shownName(name), reason, reasonText: UNCHECKED_REASON_TEXT[reason] ?? 'an unrecognised reason',
                kind: reason === 'unrecognised' ? 'persistent' : uncheckedKind(reason, rec.tentative.since, now),
                since: rec.tentative.since, notes: n, ...(rec.transcript === undefined ? {} : { transcript: rec.transcript }),
            });
        }
    }
    for (const name of list(markersDir(), 'markers')) {
        try {
            readMarker(path.join(markersDir(), name));
        }
        catch {
            out.damaged.push({ folder: 'markers', file: shownName(name) });
        }
    }
    return out;
}
export function ingestNoteDirectory(opts) {
    const maxFiles = opts.maxFiles ?? NOTE_DIR_MAX_FILES;
    const maxBytes = opts.maxBytes ?? NOTE_FILE_MAX_BYTES;
    const realDir = fs.realpathSync(opts.dir);
    if (!fs.statSync(realDir).isDirectory())
        throw new Error(`not a directory: ${opts.dir}`);
    const dirId = createHash('sha256').update(realDir).digest('hex').slice(0, 16);
    const { files, symlinks } = discover(realDir);
    const presentRels = new Set(files.map((abs) => relPath(realDir, abs)));
    const result = {
        dirId,
        discovered: files.length,
        created: [],
        replaced: [],
        unchanged: 0,
        repathed: [],
        restored: [],
        markedMissing: [],
        skipped: [],
        refusedNow: 0,
        pendingPrivate: 0,
        held: { private: 0, unchecked: 0 },
        redecideLeft: 0,
        more: 0,
    };
    const now = opts.now ?? Date.now();
    const privacy = readPrivateState(realDir, now, opts.deadlineAt ?? Date.now() + DEFAULT_LOCK_WAIT_MS, getMemeshDirFromDbPath());
    const privateSince = privacy.waitSince;
    result.redecideLeft = privacy.redecideLeft;
    const db = getDatabase();
    const existingStmt = db.prepare(`SELECT e.id, e.metadata, e.status,
            EXISTS(SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?) AS is_note,
            EXISTS(SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?) AS is_missing
       FROM entities e WHERE e.name = ?`);
    const noteRows = db.prepare(`SELECT e.id, e.name, e.metadata,
            EXISTS(SELECT 1 FROM tags m WHERE m.entity_id = e.id AND m.tag = ?) AS is_missing
       FROM entities e
       JOIN tags t ON t.entity_id = e.id AND t.tag = ?`).all(NOTE_FILE_MISSING_TAG, NOTE_FILE_TAG);
    const known = new Map();
    for (const row of noteRows) {
        const prov = parseProvenance(row.metadata);
        if (prov.note_dir_id === dirId && typeof prov.note_path === 'string') {
            known.set(prov.note_path, { id: row.id, name: row.name, mtime: prov.note_mtime_ms, size: prov.note_size, ino: prov.note_ino, missing: row.is_missing === 1 });
        }
    }
    const skipKey = `note_ingest_skips:${dirId}`;
    const skipRow = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(skipKey);
    let priorSkips = {};
    try {
        const parsedSkips = skipRow ? JSON.parse(skipRow.value) : {};
        if (parsedSkips && typeof parsedSkips === 'object')
            priorSkips = parsedSkips;
    }
    catch {
        priorSkips = {};
    }
    const nextSkips = {};
    const counted = new Set();
    const report = (rel, reason) => {
        result.skipped.push({ path: rel, reason });
        if (priorSkips[rel]?.reason === reason || counted.has(rel))
            return;
        counted.add(rel);
        result.refusedNow++;
    };
    for (const abs of symlinks) {
        const rel = relPath(realDir, abs);
        const reason = 'symlink refused';
        report(rel, reason);
        let st;
        try {
            st = fs.lstatSync(abs);
        }
        catch {
            st = null;
        }
        nextSkips[rel] = st
            ? { mtime: st.mtimeMs, size: st.size, reason }
            : { mtime: 0, size: 0, reason };
    }
    const missingNames = new Set(noteRows.filter((r) => r.is_missing).map((r) => r.name));
    const declaredNameAt = new Map();
    const statOf = (rel) => {
        try {
            return fs.lstatSync(path.join(realDir, rel));
        }
        catch {
            return null;
        }
    };
    const ownerUnchanged = (print) => {
        if (!print.owner)
            return true;
        const st = statOf(print.owner.rel);
        return !!st && st.mtimeMs === print.owner.mtime && st.size === print.owner.size;
    };
    const heldAs = (hash) => (privacy.firm.has(hash) ? 'private' : privacy.tentative.has(hash) ? 'unchecked' : undefined);
    const countHeld = (rel, hash) => {
        if (heldAs(hash) === 'private') {
            result.held.private++;
            result.skipped.push({ path: rel, reason: NOTE_PRIVATE_HOLD_REASON });
        }
        else {
            result.held.unchecked++;
            result.skipped.push({ path: rel, reason: NOTE_UNCHECKED_HOLD_REASON });
        }
    };
    const claims = [];
    const readRels = new Set();
    let read = 0;
    let refunds = 0;
    for (const abs of files) {
        const rel = relPath(realDir, abs);
        const skip = (reason) => { report(rel, reason); };
        let raw;
        let stat;
        const contentSkip = (reason) => {
            skip(reason);
            nextSkips[rel] = { mtime: stat.mtimeMs, size: stat.size, reason };
            declaredNameAt.set(rel, '');
        };
        const unreachableSkip = (reason) => {
            skip(reason);
            declaredNameAt.set(rel, '');
            if (readRels.has(rel) && refunds < maxFiles) {
                read--;
                refunds++;
            }
        };
        try {
            stat = fs.lstatSync(abs);
        }
        catch (err) {
            skip(`unreadable: ${err.code ?? 'error'}`);
            declaredNameAt.set(rel, '');
            continue;
        }
        try {
            if (stat.isSymbolicLink()) {
                skip('symlink refused');
                continue;
            }
            if (privateSince !== undefined && touchedAt(stat) >= privateSince) {
                result.pendingPrivate++;
                continue;
            }
            const prior = known.get(rel);
            if (prior && !prior.missing && prior.mtime === stat.mtimeMs && prior.size === stat.size && prior.ino === stat.ino) {
                claims.push({ rel, name: prior.name, stat, unchanged: true });
                continue;
            }
            const priorSkip = priorSkips[rel];
            if (priorSkip?.held !== undefined && priorSkip.mtime === stat.mtimeMs && priorSkip.size === stat.size && heldAs(priorSkip.held)) {
                countHeld(rel, priorSkip.held);
                nextSkips[rel] = priorSkip;
                continue;
            }
            const nameIsFree = !!priorSkip?.name && missingNames.has(priorSkip.name);
            if (priorSkip && priorSkip.held === undefined && !priorSkip.reportOnly && !nameIsFree
                && priorSkip.mtime === stat.mtimeMs && priorSkip.size === stat.size && ownerUnchanged(priorSkip)) {
                skip(priorSkip.reason);
                nextSkips[rel] = priorSkip;
                continue;
            }
            if (read >= maxFiles) {
                result.more++;
                continue;
            }
            read++;
            readRels.add(rel);
            if (stat.size > maxBytes) {
                contentSkip(`larger than ${Math.round(maxBytes / 1024)} KB`);
                continue;
            }
            const real = fs.realpathSync(abs);
            if (!real.startsWith(realDir + path.sep)) {
                unreachableSkip('resolves outside the directory');
                continue;
            }
            raw = fs.readFileSync(real);
        }
        catch (err) {
            unreachableSkip(`unreadable: ${err.code ?? 'error'}`);
            continue;
        }
        const contentHash = sha256(raw);
        if (heldAs(contentHash)) {
            read--;
            countHeld(rel, contentHash);
            nextSkips[rel] = { mtime: stat.mtimeMs, size: stat.size, reason: heldAs(contentHash) === 'private' ? NOTE_PRIVATE_HOLD_REASON : NOTE_UNCHECKED_HOLD_REASON, held: contentHash };
            continue;
        }
        const parsed = parseFrontmatter(raw.toString('utf8'));
        if (!parsed) {
            contentSkip('no frontmatter — a note file needs a `---` block with a name');
            continue;
        }
        const rawName = stringField(parsed.data, 'name');
        const name = rawName ? sanitizeNoteText(rawName).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255) : '';
        if (!name) {
            contentSkip('frontmatter has no name');
            continue;
        }
        const metaBlock = parsed.data.metadata;
        const rawType = (typeof metaBlock === 'object' ? metaBlock.type : undefined) ?? stringField(parsed.data, 'type');
        const type = (rawType ? sanitizeNoteText(rawType).slice(0, 100) : '') || NOTE_DEFAULT_TYPE;
        const description = stringField(parsed.data, 'description');
        const cleanDescription = description ? sanitizeNoteText(description) : '';
        let observations = splitObservations(sanitizeNoteText(parsed.body));
        if (observations.length === 0 && cleanDescription)
            observations = [cleanDescription];
        if (observations.length === 0) {
            contentSkip('empty note — no description and no body');
            continue;
        }
        if (observations.length > NOTE_MAX_OBSERVATIONS) {
            contentSkip(`yields ${observations.length} observations; at most ${NOTE_MAX_OBSERVATIONS} are stored per memory`);
            continue;
        }
        claims.push({
            rel,
            name,
            stat,
            unchanged: false,
            contentHash: createHash('sha256').update(raw).digest('hex'),
            type,
            title: truncateTitle(cleanDescription || observations[0]),
            observations,
        });
    }
    const byName = new Map();
    for (const c of claims) {
        const list = byName.get(c.name);
        if (list)
            list.push(c);
        else
            byName.set(c.name, [c]);
    }
    const touchedIds = new Set();
    for (const c of claims)
        declaredNameAt.set(c.rel, c.name);
    for (const [name, claimants] of byName) {
        const existing = existingStmt.get(NOTE_FILE_TAG, NOTE_FILE_MISSING_TAG, name);
        const prov = existing ? parseProvenance(existing.metadata) : {};
        const skipAll = (reason) => {
            for (const c of claimants) {
                report(c.rel, reason);
                nextSkips[c.rel] = { mtime: c.stat.mtimeMs, size: c.stat.size, reason, name: c.name, reportOnly: true };
            }
        };
        if (existing) {
            if (!existing.is_note) {
                skipAll(`name "${name}" belongs to a memory that did not come from a note file`);
                continue;
            }
            if (prov.note_dir_id !== dirId) {
                skipAll(`name "${name}" was already ingested from another note directory`);
                continue;
            }
            if (existing.status === 'archived') {
                skipAll(`memory "${name}" was archived with forget; not re-ingested`);
                continue;
            }
        }
        const recordedRel = typeof prov.note_path === 'string' ? prov.note_path : undefined;
        if (recordedRel
            && existing && !existing.is_missing
            && presentRels.has(recordedRel)
            && !readRels.has(recordedRel)
            && !claimants.some((c) => c.rel === recordedRel)) {
            const reason = `name "${name}" belongs to ${recordedRel}, which was not read this run`;
            const ownerStat = statOf(recordedRel);
            for (const c of claimants) {
                report(c.rel, reason);
                if (ownerStat)
                    nextSkips[c.rel] = { mtime: c.stat.mtimeMs, size: c.stat.size, reason, name: c.name, owner: { rel: recordedRel, mtime: ownerStat.mtimeMs, size: ownerStat.size } };
            }
            continue;
        }
        const owner = claimants.find((c) => c.rel === recordedRel)
            ?? (typeof prov.content_hash === 'string' ? claimants.find((c) => c.contentHash === prov.content_hash) : undefined)
            ?? claimants[0];
        for (const c of claimants) {
            if (c === owner)
                continue;
            const reason = `name "${name}" already used by ${owner.rel} in this directory`;
            report(c.rel, reason);
            nextSkips[c.rel] = { mtime: c.stat.mtimeMs, size: c.stat.size, reason, name: c.name, owner: { rel: owner.rel, mtime: owner.stat.mtimeMs, size: owner.stat.size } };
        }
        if (owner.unchanged) {
            result.unchanged++;
            if (existing)
                touchedIds.add(existing.id);
            continue;
        }
        if (existing && prov.content_hash === owner.contentHash) {
            const moved = prov.note_path !== owner.rel;
            const meta = JSON.parse(existing.metadata ?? '{}');
            meta.provenance = { ...prov, note_path: owner.rel, note_mtime_ms: owner.stat.mtimeMs, note_size: owner.stat.size, note_ino: owner.stat.ino };
            db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), existing.id);
            if (existing.is_missing) {
                db.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?').run(existing.id, NOTE_FILE_MISSING_TAG);
                result.restored.push(name);
            }
            else if (moved)
                result.repathed.push(name);
            else
                result.unchanged++;
            touchedIds.add(existing.id);
            continue;
        }
        let project;
        if (existing) {
            const projects = db.prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%' ORDER BY tag").all(existing.id)
                .map((t) => t.tag.slice('project:'.length));
            if (projects.length === 1)
                project = projects[0];
            else if (projects.length > 1) {
                if (!opts.project || !projects.includes(opts.project)) {
                    const reason = `memory "${name}" belongs to several projects (${projects.join(', ')}); ${opts.project ? `this run's project ${opts.project} is not one of them` : 'this run names no project'}, so it was not updated`;
                    report(owner.rel, reason);
                    nextSkips[owner.rel] = { mtime: owner.stat.mtimeMs, size: owner.stat.size, reason, name: owner.name, reportOnly: true };
                    continue;
                }
                project = opts.project;
            }
        }
        const fields = {
            name,
            type: owner.type,
            title: owner.title,
            observations: owner.observations,
            ...(existing ? { project } : { tags: [NOTE_FILE_TAG, ...(opts.project ? [`project:${opts.project}`] : [])] }),
            replace: true,
            trustOverride: 'untrusted',
            provenanceOverride: {
                source: 'note-file',
                note_path: owner.rel,
                content_hash: owner.contentHash,
                note_dir_id: dirId,
                note_mtime_ms: owner.stat.mtimeMs,
                note_size: owner.stat.size,
                note_ino: owner.stat.ino,
            },
            sourceHost: 'note-file',
        };
        let written;
        try {
            written = db.transaction(() => {
                const stored = remember(fields);
                if (existing) {
                    db.prepare("DELETE FROM tags WHERE entity_id = ? AND tag LIKE 'source:%' AND tag <> ?").run(existing.id, NOTE_FILE_TAG);
                    db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(existing.id, NOTE_FILE_TAG);
                }
                return stored;
            }).immediate();
        }
        catch (err) {
            if (err instanceof Error && err.message.startsWith('MeMesh did not store this memory')) {
                report(owner.rel, err.message);
                nextSkips[owner.rel] = { mtime: owner.stat.mtimeMs, size: owner.stat.size, reason: err.message, name: owner.name, reportOnly: true };
                continue;
            }
            throw err;
        }
        touchedIds.add(written.entityId);
        (existing ? result.replaced : result.created).push(name);
    }
    if (Object.keys(nextSkips).length > 0) {
        db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(skipKey, JSON.stringify(nextSkips));
    }
    else {
        db.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(skipKey);
    }
    const tagMissing = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
    for (const row of noteRows) {
        if (row.is_missing || touchedIds.has(row.id))
            continue;
        const prov = parseProvenance(row.metadata);
        if (prov.note_dir_id !== dirId || typeof prov.note_path !== 'string')
            continue;
        const gone = !presentRels.has(prov.note_path);
        const declaresNow = declaredNameAt.get(prov.note_path);
        const renamedAway = declaresNow !== undefined && declaresNow !== row.name;
        if (!gone && !renamedAway)
            continue;
        tagMissing.run(row.id, NOTE_FILE_MISSING_TAG);
        result.markedMissing.push(row.name);
    }
    return result;
}
export function summarizeNoteIngest(r) {
    const parts = [
        `${r.created.length} created`,
        `${r.replaced.length} replaced`,
        `${r.unchanged} unchanged`,
        ...(r.repathed.length ? [`${r.repathed.length} moved`] : []),
        ...(r.restored.length ? [`${r.restored.length} restored`] : []),
        `${r.skipped.length} skipped`,
        ...(r.refusedNow ? [`${r.refusedNow} newly refused`] : []),
    ];
    if (r.markedMissing.length)
        parts.push(`${r.markedMissing.length} marked missing`);
    if (r.held.private)
        parts.push(`${r.held.private} held out by a private session`);
    if (r.held.unchecked)
        parts.push(`${r.held.unchecked} held while a session could not be checked`);
    if (r.pendingPrivate)
        parts.push(`${r.pendingPrivate} waiting for a private session's next Stop`);
    if (r.more)
        parts.push(`${r.more} more not processed (per-run cap)`);
    return parts.join(', ');
}
//# sourceMappingURL=note-ingest.js.map