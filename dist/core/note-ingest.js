import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { noteDirId } from './note-dirs.js';
import { getDatabase } from '../db.js';
import { getMemeshDirFromDbPath } from './paths.js';
import { remember } from './operations.js';
import { DECISION_TYPES, NOTE_FILE_MISSING_TAG, NOTE_FILE_PROVENANCE, WHY_PREFIX } from './work-topology.js';
import { copyDatabaseBefore } from './db-copy.js';
import { sanitizeNoteText, splitObservations, NOTE_DEFAULT_TYPE, NOTE_MAX_OBSERVATIONS } from './note-derive.js';
import { truncateTitle } from './title.js';
import { decidePrivacy, privateCheckCacheDir, PRIVATE_WINDOW_MS, removeStaleTemps, sessionFileName, sessionLastWriteMs, uncheckedKind, writeFileAtomic } from './private-session.js';
import { PRIVATE_STATE_BUSY, withPrivateStateLock } from './private-state-lock.js';
import { isCodexRollout } from './host-transcript.js';
export const NOTE_FILE_TAG = 'source:note-file';
export { NOTE_FILE_MISSING_TAG };
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
const dirIdOf = noteDirId;
const codeOf = (err) => err?.code ?? 'error';
const DEFAULT_LOCK_WAIT_MS = 5_000;
const REDECIDE_PER_RUN = 10;
export const NOTE_MARKERS_UNREADABLE = 'MEMESH_NOTE_MARKERS_UNREADABLE';
export const NOTE_MARKERS_DIR_UNREADABLE = 'MEMESH_NOTE_MARKERS_DIR_UNREADABLE';
export const NOTE_MARKER_UNWRITABLE = 'MEMESH_NOTE_MARKER_UNWRITABLE';
export const NOTE_HOLDS_UNREADABLE = 'MEMESH_NOTE_HOLDS_UNREADABLE';
export const NOTE_HOLDS_DIR_UNREADABLE = 'MEMESH_NOTE_HOLDS_DIR_UNREADABLE';
export const NOTE_HOLDS_UNWRITABLE = 'MEMESH_NOTE_HOLDS_UNWRITABLE';
export const NOTE_FOLDER_UNREADABLE = 'MEMESH_NOTE_FOLDER_UNREADABLE';
export { PRIVATE_STATE_BUSY };
const fail = (code, message) => Object.assign(new Error(message), { code });
const folderUnreadable = (err) => fail(NOTE_FOLDER_UNREADABLE, `a notes folder cannot be read (${codeOf(err)}); nothing is released until it can be`);
const notThere = (err) => codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR';
export const NOTE_PRIVATE_HOLD_REASON = 'held out by a private session — not imported';
export const NOTE_UNCHECKED_HOLD_REASON = 'held while a session could not be checked — not imported yet';
export function realPathOrExpected(dir) {
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
    catch (err) {
        if (notThere(err))
            return [];
        throw folderUnreadable(err);
    }
    const folders = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = path.join(projectsRoot, entry.name, 'memory');
        let st;
        try {
            st = fs.lstatSync(dir);
        }
        catch (err) {
            if (notThere(err))
                continue;
            throw folderUnreadable(err);
        }
        if (st.isDirectory())
            folders.push(fs.realpathSync(dir));
    }
    return folders;
}
const touchedAt = (st) => Math.max(st.mtimeMs, st.ctimeMs);
const writtenAt = (st) => Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
function parseMarker(text) {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.session !== 'string' || !isTime(m.startedAt) || !isTime(m.updatedAt)
        || !isTime(m.holdsAt) || typeof m.projectsRoot !== 'string' || !Array.isArray(m.dirs) || !m.dirs.every((d) => typeof d === 'string')
        || (m.transcript !== undefined && typeof m.transcript !== 'string')
        || (m.endedAt !== undefined && !isTime(m.endedAt)) || (m.finalizedAt !== undefined && !isTime(m.finalizedAt))) {
        throw new Error('not a marker');
    }
    return m;
}
const markerFile = (sessionId) => path.join(markersDir(), sessionFileName(sessionId));
const causeOf = (err) => (['EACCES', 'EPERM'].includes(codeOf(err)) ? 'permission' : 'damaged');
const markerUnreadable = (name, err) => Object.assign(fail(NOTE_MARKERS_UNREADABLE, `${MARKERS_DIR}/${name} cannot be read (${err.message}); notes are not imported until its session writes it again`), { cause: causeOf(err) });
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
        writeFileAtomic(file, JSON.stringify({ v: 2, ...marker }));
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
export function removeStalePrivateStateTemps(now = Date.now()) {
    removeStaleTemps(markersDir(), now);
    removeStaleTemps(holdsDir(), now);
}
const HOLDS_VERSION = 3;
const HASH_KEY = /^[0-9a-f]{64}$/;
const isUnreadableKey = (key) => key.startsWith('?');
function parseUnreadable(value) {
    const [since, ino, size, mtime] = value.split(':').map(Number);
    return isTime(since) && [ino, size, mtime].every((n) => Number.isFinite(n)) ? { since, ino, size, mtime } : undefined;
}
const unreadableEntry = (rel, st, now) => [`?${rel}`, `${now}:${st.ino}:${st.size}:${st.mtimeMs}`];
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isDirHolds = (value) => isRecord(value) && Object.values(value).every((files) => isRecord(files)
    && Object.entries(files).every(([key, v]) => typeof v === 'string' && (HASH_KEY.test(key) || (isUnreadableKey(key) && parseUnreadable(v) !== undefined))));
function parseHoldFile(text) {
    const p = JSON.parse(text);
    if (!isRecord(p) || p.v !== HOLDS_VERSION || !isDirHolds(p.firm) || typeof p.session !== 'string' || !Number.isInteger(p.rev)
        || (p.transcript !== undefined && typeof p.transcript !== 'string'))
        throw new Error('not a hold record');
    const t = p.tentative;
    if (t !== undefined && (!isRecord(t) || typeof t.reason !== 'string' || !isTime(t.since) || !isTime(t.updatedAt) || !isTime(t.holdsAt)
        || typeof t.projectsRoot !== 'string' || !isDirHolds(t.dirs) || (t.endedAt !== undefined && !isTime(t.endedAt))))
        throw new Error('not a hold record');
    const { v: _v, ...rec } = p;
    return rec;
}
const holdsUnreadable = (what, err) => Object.assign(fail(NOTE_HOLDS_UNREADABLE, `${HOLDS_DIR}${what} cannot be read (${err.message}); notes are not imported until it can be read`), { cause: causeOf(err) });
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
        writeFileAtomic(file, JSON.stringify({ v: HOLDS_VERSION, ...rec, rev: rec.rev + 1 }));
    }
    catch (err) {
        throw fail(NOTE_HOLDS_UNWRITABLE, `${HOLDS_DIR}/${path.basename(file)} could not be written (${codeOf(err)}); nothing was released`);
    }
}
const mergeDirHolds = (into, from) => {
    for (const [dirId, files] of Object.entries(from))
        into[dirId] = { ...files, ...(into[dirId] ?? {}) };
};
function hashNotes(realDir, candidates, now) {
    const forDir = {};
    for (const real of candidates) {
        let st;
        try {
            st = fs.lstatSync(real);
        }
        catch (err) {
            if (notThere(err))
                continue;
            throw folderUnreadable(err);
        }
        if (!st.isFile() || !real.toLowerCase().endsWith('.md') || !real.startsWith(realDir + path.sep))
            continue;
        if (st.size > NOTE_FILE_MAX_BYTES)
            continue;
        const rel = relPath(realDir, real);
        try {
            forDir[sha256(fs.readFileSync(real))] = rel;
        }
        catch {
            const [key, value] = unreadableEntry(rel, st, now);
            forDir[key] = value;
        }
    }
    return forDir;
}
function notesTouchedBetween(realDir, sinceMs, untilMs = Number.POSITIVE_INFINITY) {
    let files;
    try {
        files = discover(realDir).files;
    }
    catch (err) {
        if (notThere(err))
            return [];
        throw folderUnreadable(err);
    }
    return files.filter((abs) => {
        let st;
        try {
            st = fs.lstatSync(abs);
        }
        catch (err) {
            if (notThere(err))
                return false;
            throw folderUnreadable(err);
        }
        return touchedAt(st) >= sinceMs && writtenAt(st) <= untilMs;
    });
}
export function holdOutNoteFiles(opts) {
    const now = opts.now ?? Date.now();
    const realDir = opts.dir === undefined ? undefined : fs.realpathSync(opts.dir);
    const forDir = {};
    if (realDir !== undefined) {
        const candidates = new Set();
        for (const candidate of opts.paths) {
            try {
                candidates.add(fs.realpathSync(candidate));
            }
            catch (err) {
                if (!notThere(err))
                    throw folderUnreadable(err);
            }
        }
        if (opts.sinceMs !== undefined)
            for (const abs of notesTouchedBetween(realDir, opts.sinceMs, opts.untilMs))
                candidates.add(abs);
        Object.assign(forDir, hashNotes(realDir, candidates, now));
    }
    const held = realDir === undefined ? {} : { [dirIdOf(realDir)]: forDir };
    updateHold(holdFile(opts.sessionId), opts.deadlineAt, (found) => {
        const rec = found ?? { rev: 0, session: opts.sessionId, firm: {} };
        if (opts.transcript !== undefined)
            rec.transcript = opts.transcript;
        if (opts.tentative) {
            const prior = rec.tentative;
            const dirs = prior?.dirs ?? {};
            mergeDirHolds(dirs, held);
            rec.tentative = {
                reason: opts.tentative.reason, since: prior?.since ?? now, updatedAt: now,
                holdsAt: opts.tentative.holdsAt ?? prior?.holdsAt ?? now,
                projectsRoot: opts.tentative.projectsRoot ?? prior?.projectsRoot ?? (realDir === undefined ? '' : projectsRootOf(realDir)), dirs,
            };
        }
        else {
            mergeDirHolds(rec.firm, held);
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
function lastActivity(updatedAt, transcript, deadlineAt) {
    if (typeof transcript !== 'string' || transcript === '')
        return updatedAt;
    const written = sessionLastWriteMs(transcript, deadlineAt);
    return written === undefined ? undefined : Math.max(updatedAt, written);
}
const isIdle = (now, ...times) => times.every((t) => now - t > PRIVATE_WINDOW_MS);
function holdIdleSession(s) {
    const reached = new Set(s.reached);
    for (const dir of new Set([...reached, ...s.roots.filter(Boolean).flatMap(projectMemoryFolders)])) {
        try {
            fs.lstatSync(dir);
        }
        catch (err) {
            if (notThere(err))
                continue;
            throw folderUnreadable(err);
        }
        holdOutNoteFiles({
            dir, sessionId: s.sessionId, paths: [], sinceMs: Math.max(reached.has(dir) ? s.startedAt : s.holdsAt, s.floor ?? 0), untilMs: s.last,
            ...(s.tentative === undefined ? {} : { tentative: { reason: s.tentative } }), deadlineAt: s.deadlineAt, now: s.now,
        });
    }
}
function privateSessionWait(entry, root, now, deadlineAt) {
    const { marker } = entry;
    const live = marker.finalizedAt ?? marker.holdsAt;
    if (marker.finalizedAt === undefined && !isIdle(now, marker.updatedAt))
        return live;
    const last = lastActivity(marker.updatedAt, marker.transcript, deadlineAt);
    if (marker.finalizedAt !== undefined && last !== undefined && last <= marker.finalizedAt)
        return undefined;
    if (last === undefined || !isIdle(now, marker.updatedAt, last))
        return live;
    holdIdleSession({
        sessionId: marker.session, roots: [marker.projectsRoot, ...(isCodexRollout(marker.transcript) ? [root] : [])], reached: marker.dirs, startedAt: marker.startedAt, holdsAt: marker.holdsAt,
        last, floor: marker.finalizedAt, now, deadlineAt,
    });
    const finalized = withPrivateStateLock(getMemeshDirFromDbPath(), deadlineAt, () => {
        const again = readMarker(entry.file);
        if (!again || again.endedAt !== undefined || again.updatedAt !== marker.updatedAt || again.finalizedAt !== marker.finalizedAt)
            return false;
        writeMarker(entry.file, { ...again, finalizedAt: last });
        return true;
    });
    return finalized ? undefined : live;
}
function readPrivateState(realDir, now, deadlineAt, memeshDir) {
    const dirId = dirIdOf(realDir);
    const root = projectsRootOf(realDir);
    const out = { firm: new Set(), tentative: new Set(), redecideLeft: 0 };
    const wait = (since) => { out.waitSince = out.waitSince === undefined ? since : Math.min(out.waitSince, since); };
    const ofThisRoot = (projectsRoot, transcript) => projectsRoot === root || isCodexRollout(transcript);
    for (const entry of readAllMarkers()) {
        const { marker } = entry;
        if (marker.endedAt !== undefined || (!marker.dirs.includes(realDir) && !ofThisRoot(marker.projectsRoot, marker.transcript)))
            continue;
        const since = privateSessionWait(entry, root, now, deadlineAt);
        if (since !== undefined)
            wait(since);
    }
    let redecided = 0;
    for (const { name, rec } of readAllHolds()) {
        let current = rec;
        const reread = () => { current = readHoldFile(path.join(holdsDir(), name)) ?? { ...current, firm: {}, tentative: undefined }; };
        const t = current.tentative;
        if (t && (t.dirs[dirId] !== undefined || (t.endedAt === undefined && ofThisRoot(t.projectsRoot, current.transcript)))) {
            const decidable = current.transcript !== undefined || t.reason === 'marker_unreadable';
            if (!decidable) {
            }
            else if (redecided < REDECIDE_PER_RUN && Date.now() < deadlineAt) {
                redecided++;
                const state = decidePrivacy({ sessionId: current.session, transcriptPath: current.transcript, memeshDir, deadlineAt, cacheDir: privateCheckCacheDir(memeshDir) });
                if (state.state !== 'unchecked' && settleTentativeHolds(current.session, state.state, { expectRev: current.rev, deadlineAt }))
                    reread();
            }
            else {
                out.redecideLeft++;
            }
        }
        const t2 = current.tentative;
        if (t2 && t2.endedAt === undefined && ofThisRoot(t2.projectsRoot, current.transcript)) {
            const last = isIdle(now, t2.updatedAt) ? lastActivity(t2.updatedAt, current.transcript, deadlineAt) : undefined;
            if (last !== undefined && isIdle(now, last)) {
                holdIdleSession({ sessionId: current.session, roots: [root], reached: [], startedAt: t2.holdsAt, holdsAt: t2.holdsAt, last, tentative: t2.reason, now, deadlineAt });
                endTentativeWait(current.session, now, deadlineAt);
                reread();
            }
            else {
                wait(t2.holdsAt);
            }
        }
        for (const [kind, dirs] of [['firm', current.firm], ['tentative', current.tentative?.dirs ?? {}]]) {
            const into = kind === 'firm' ? out.firm : out.tentative;
            for (const [id, entries] of Object.entries(dirs)) {
                for (const [key, value] of Object.entries(entries)) {
                    if (!isUnreadableKey(key)) {
                        into.add(key);
                        continue;
                    }
                    if (id !== dirId)
                        continue;
                    const mark = parseUnreadable(value);
                    const resolved = resolveUnreadable(realDir, key.slice(1), mark, now);
                    if (resolved === undefined) {
                        wait(mark.since);
                        continue;
                    }
                    updateHold(path.join(holdsDir(), name), deadlineAt, (again) => {
                        const holds = kind === 'firm' ? again?.firm : again?.tentative?.dirs;
                        if (!holds || holds[dirId]?.[key] !== value)
                            return undefined;
                        delete holds[dirId][key];
                        mergeDirHolds(holds, { [dirId]: resolved });
                        return again;
                    });
                    for (const h of Object.keys(resolved))
                        into.add(h);
                }
            }
        }
    }
    return out;
}
function resolveUnreadable(realDir, rel, mark, now) {
    const file = path.join(realDir, rel);
    let st;
    try {
        st = fs.lstatSync(file);
    }
    catch (err) {
        if (!notThere(err))
            return undefined;
    }
    if (st && st.ino === mark.ino && st.size === mark.size && st.mtimeMs === mark.mtime) {
        try {
            return { [sha256(fs.readFileSync(file))]: rel };
        }
        catch {
            return undefined;
        }
    }
    const instead = hashNotes(realDir, notesTouchedBetween(realDir, mark.since), now);
    if (Object.keys(instead).some(isUnreadableKey))
        return undefined;
    return Object.fromEntries(Object.entries(instead).map(([hash, p]) => [hash, `!${p}`]));
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
    const out = { sessions: 0, notes: 0, holdsFolder: holdsDir(), markersFolder: markersDir(), unsettled: [], waitingOnUnreadable: [], heldInPlaceOfUnreadable: [], damaged: [], unreadableFolders: [] };
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
        catch (err) {
            out.damaged.push({ folder: 'holds', file: shownName(name), cause: err.cause });
            continue;
        }
        if (!rec)
            continue;
        out.sessions++;
        const firm = holdCount(rec.firm);
        out.notes += firm;
        const entries = [...Object.values(rec.firm), ...Object.values(rec.tentative?.dirs ?? {})].flatMap((files) => Object.entries(files));
        const unread = entries.filter(([key]) => isUnreadableKey(key)).map(([, value]) => parseUnreadable(value).since);
        if (unread.length > 0)
            out.waitingOnUnreadable.push({ file: shownName(name), notes: unread.length, since: Math.min(...unread) });
        const instead = entries.filter(([key, value]) => !isUnreadableKey(key) && value.startsWith('!')).length;
        if (instead > 0)
            out.heldInPlaceOfUnreadable.push({ file: shownName(name), notes: instead });
        if (rec.tentative) {
            const n = holdCount(rec.tentative.dirs);
            out.notes += n;
            const reason = Object.prototype.hasOwnProperty.call(UNCHECKED_REASON_TEXT, rec.tentative.reason) ? rec.tentative.reason : 'unrecognised';
            out.unsettled.push({
                session: shownName(name).replace(/\.json$/, ''), file: shownName(name), reason, reasonText: UNCHECKED_REASON_TEXT[reason] ?? 'an unrecognised reason',
                kind: reason === 'unrecognised' ? 'persistent' : uncheckedKind(reason, rec.tentative.since, now),
                since: rec.tentative.since, notes: n, ...(rec.transcript === undefined ? {} : { transcript: rec.transcript }),
                ...(rec.tentative.endedAt === undefined ? { waitSince: rec.tentative.holdsAt } : {}), lastHeard: rec.tentative.updatedAt,
            });
        }
    }
    for (const name of list(markersDir(), 'markers')) {
        try {
            readMarker(path.join(markersDir(), name));
        }
        catch (err) {
            out.damaged.push({ folder: 'markers', file: shownName(name), cause: err.cause });
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
    const dirId = noteDirId(realDir);
    const { files, symlinks } = discover(realDir);
    const presentRels = new Set(files.map((abs) => relPath(realDir, abs)));
    const result = {
        dirId,
        discovered: files.length,
        created: [],
        replaced: [],
        unchanged: 0,
        retrusted: [],
        retrustBackup: null,
        retrustFailed: null,
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
    const privacy = readPrivateState(realDir, now, lockDeadline(opts.deadlineAt), getMemeshDirFromDbPath());
    const privateSince = privacy.waitSince;
    result.redecideLeft = privacy.redecideLeft;
    const db = getDatabase();
    const trustFor = (type, observations) => opts.trusted && !(type !== undefined && DECISION_TYPES.has(type) && !observations.some((o) => o.startsWith(WHY_PREFIX))) ? 'trusted' : 'untrusted';
    const existingStmt = db.prepare(`SELECT e.id, e.metadata, e.status, e.type,
            json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata END, '$.trust') AS trust,
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
            skip(`unreadable: ${codeOf(err)}`);
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
            unreachableSkip(`unreadable: ${codeOf(err)}`);
            continue;
        }
        const contentHash = sha256(raw);
        const heldKind = heldAs(contentHash);
        if (heldKind) {
            read--;
            countHeld(rel, contentHash);
            nextSkips[rel] = { mtime: stat.mtimeMs, size: stat.size, reason: heldKind === 'private' ? NOTE_PRIVATE_HOLD_REASON : NOTE_UNCHECKED_HOLD_REASON, held: contentHash };
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
            contentHash,
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
            trustOverride: existing && existing.trust !== 'trusted' ? 'untrusted' : trustFor(owner.type, owner.observations),
            reinforceConfidence: false,
            reasonOptional: true,
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
    if (opts.trusted)
        liftFolderTrust(db, dirId, result);
    return result;
}
function liftFolderTrust(db, dirId, result) {
    const decisionTypes = [...DECISION_TYPES];
    const liftedKey = `note_trust_lifted:${dirId}`;
    const meta = "CASE WHEN json_valid(e.metadata) THEN e.metadata END";
    const rows = db.prepare(`SELECT e.id, e.name FROM entities e
      WHERE json_extract(${meta}, '$.provenance.source') = ?
        AND json_extract(${meta}, '$.provenance.note_dir_id') = ?
        AND json_extract(${meta}, '$.trust') = 'untrusted'
        AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?)
        AND (e.type NOT IN (${decisionTypes.map(() => '?').join(',')})
             OR EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id AND substr(o.content, 1, ?) = ?))
        AND e.id NOT IN (SELECT value FROM json_each((SELECT value FROM memesh_metadata WHERE key = ? AND json_valid(value))))
      ORDER BY e.id`).all(NOTE_FILE_PROVENANCE, dirId, NOTE_FILE_MISSING_TAG, ...decisionTypes, WHY_PREFIX.length, WHY_PREFIX, liftedKey);
    if (rows.length === 0)
        return;
    const failed = (why) => `${rows.length} note(s) of this folder should become trusted, but ${why}; none of them was made trusted`;
    const prior = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(liftedKey)?.value;
    const setLifted = db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
    const unsetLifted = () => (prior === undefined
        ? db.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(liftedKey)
        : setLifted.run(liftedKey, prior));
    let priorIds = [];
    try {
        priorIds = JSON.parse(prior ?? '[]');
    }
    catch { }
    setLifted.run(liftedKey, JSON.stringify([...(Array.isArray(priorIds) ? priorIds : []), ...rows.map((r) => r.id)]));
    const copy = copyDatabaseBefore(db, 'knowledge-graph-before-note-trust');
    if (copy.kind === 'failed') {
        unsetLifted();
        result.retrustFailed = failed(copy.reason);
        return;
    }
    try {
        fs.writeFileSync(`${copy.path}.json`, JSON.stringify({
            at: new Date().toISOString(),
            change: 'note files of the project\'s own memory folder: metadata.trust untrusted -> trusted',
            count: rows.length,
            ids: rows.map((r) => r.id),
            names: rows.map((r) => r.name),
            backup: copy.path,
            undo: `Restore the database from the backup file, or set metadata.trust back to 'untrusted' on the ids listed here (either way they stay untrusted: a memory is made trusted this way only once): UPDATE entities SET metadata = json_set(metadata, '$.trust', 'untrusted') WHERE id IN (<ids>);`,
        }, null, 2), { mode: 0o600 });
    }
    catch (error) {
        unsetLifted();
        result.retrustFailed = failed(`the record of the change could not be written (${error instanceof Error ? error.message : String(error)})`);
        return;
    }
    const lift = db.prepare("UPDATE entities SET metadata = json_set(metadata, '$.trust', 'trusted') WHERE id = ?");
    db.transaction(() => { for (const row of rows)
        lift.run(row.id); })();
    result.retrusted = rows.map((r) => r.name);
    result.retrustBackup = copy.path;
}
export function summarizeNoteIngest(r) {
    const parts = [
        `${r.created.length} created`,
        `${r.replaced.length} replaced`,
        `${r.unchanged} unchanged`,
        ...(r.repathed.length ? [`${r.repathed.length} moved`] : []),
        ...(r.restored.length ? [`${r.restored.length} restored`] : []),
        ...(r.retrusted.length ? [`${r.retrusted.length} made trusted (copy of the database: ${path.basename(r.retrustBackup ?? '')})`] : []),
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