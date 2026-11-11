import { BUSY_TIMEOUT_MS, MemeshDatabase } from './storage/sqlite.js';
import path from 'path';
import fs from 'fs';
import { backfillCompressionMarkers, runAutoDecay } from './core/lifecycle.js';
import { computeSignalScore } from './core/signal-scorer.js';
import { getDbPath } from './core/paths.js';
import { belongsToAnotherUser, databaseFiles, guardDatabaseFiles, holdsBytes, immutableAddress, isWritable, ownerWriteCommand, removeGroupAndOtherAccess, shellQuote } from './core/file-mode.js';
import { insertFtsRow, joinIndexedObservations, removeFromFts } from './storage/fts-index.js';
import { canonicalizeLessonTypes, dedupeObservations, dropArchivedIndexRows, removeJunkFileTags, repairFusedLessonShellHistory, repairOwnNoteFolderTrust, retractZeroEditClaims, splitFusedLessons } from './storage/graph-repairs.js';
import { ownMemoryDirIds } from './core/note-dirs.js';
import { createSchema, FTS_SQL, safeAlter, migrateEntitiesSchema, ensureTagsUniqueIndex, ensureHookRunsSince, ensureFtsSegmentation, ftsIndexIsCurrent, rebuildFtsIndex, runOnceMigration, isTransientDbError, retryWhileLocked, FTS_SEGMENTATION_VERSION, } from './storage/schema.js';
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
import { truncateTitle, isBoilerplateObservation } from './core/title.js';
let db = null;
let readOnlyFolder = null;
const retiredHandles = [];
function folderWriteFix(dir) {
    const notYours = belongsToAnotherUser(fs.statSync(dir));
    return { notYours, fix: notYours ? 'Point MEMESH_DB_PATH at a database you own, in a folder you own.' : `chmod u+w ${shellQuote(dir)}` };
}
export function openDatabase(dbPath, opts = {}) {
    if (db)
        return db;
    const resolvedPath = dbPath ?? getDbPath();
    if (resolvedPath === ':memory:') {
        db = openInitialisedDatabase(resolvedPath, opts);
        return db;
    }
    const dir = path.dirname(resolvedPath);
    if (!opts.readOnly)
        fs.mkdirSync(dir, { recursive: true });
    try {
        process.umask(0o077);
    }
    catch { }
    const [realPath, ...sidecars] = databaseFiles(resolvedPath);
    const realDir = path.dirname(realPath);
    removeGroupAndOtherAccess(dir);
    guardDatabaseFiles(resolvedPath);
    const missing = sidecars.filter((file) => !fs.existsSync(file)).map((file) => file.slice(realPath.length));
    const folderWritable = isWritable(realDir);
    if (!folderWritable && !fs.existsSync(realPath) && !opts.readOnly) {
        const { notYours, fix } = folderWriteFix(realDir);
        throw Object.assign(new Error(`MeMesh: ${realDir} is read-only and holds no database yet, so one cannot be created there. ` +
            (notYours ? `${realDir} belongs to another user, so you cannot make it writable. ${fix}` : `Make the folder writable: ${fix}`)), { fix });
    }
    if (missing.length > 0 && !folderWritable && fs.existsSync(realPath)) {
        const wal = `${realPath}-wal`;
        const journal = `${realPath}-journal`;
        const walHoldsPages = holdsBytes(wal);
        const hotJournal = holdsBytes(journal);
        const { notYours, fix } = folderWriteFix(realDir);
        if (walHoldsPages || hotJournal) {
            const why = hotJournal
                ? `${path.basename(realPath)} has an unfinished transaction (${path.basename(journal)}) that can only be rolled back by writing to the folder`
                : `${path.basename(realPath)} has no ${missing.join(' or ')} file there, so it cannot be opened without writing to the folder`;
            throw Object.assign(new Error(`MeMesh: ${realDir} is read-only and ${why}. ` +
                (notYours
                    ? `${realDir} belongs to another user, so you cannot make it writable. ${fix}`
                    : `Copy the database to a writable folder and point MEMESH_DB_PATH at the copy, or make the folder writable: ${fix}`)), { fix });
        }
        db = openInitialisedDatabase(resolvedPath, opts, { immutableFile: realPath, readOnly: opts.readOnly });
        const reason = `${realDir} is read-only, so ${path.basename(realPath)} is open for reads only and writes are refused`;
        readOnlyFolder = {
            note: `${reason}. ${notYours ? fix : `To write to it again, run: ${fix}`}`,
            reason,
            fix,
            dir: realDir,
            dbPath: resolvedPath,
            requested: opts.readOnly === true,
        };
        if (!opts.readOnly) {
            try {
                process.stderr.write(`MeMesh: ${readOnlyFolder.note}\n`);
            }
            catch { }
        }
        return db;
    }
    db = openInitialisedDatabase(resolvedPath, { ...opts, maintenance: opts.busyTimeoutMs === undefined }, { readOnly: opts.readOnly });
    const writeBack = opts.readOnly ? undefined : ownerWriteCommand(resolvedPath);
    if (writeBack) {
        try {
            process.stderr.write(`MeMesh: ${resolvedPath} is read-only, so it is open for reads only and writes will be refused. ` +
                `To write to it again, ${writeBack}\n`);
        }
        catch { }
    }
    return db;
}
export function openInitialisedDatabase(resolvedPath, opts = {}, mode = {}) {
    const opening = mode.immutableFile
        ? new MemeshDatabase(immutableAddress(mode.immutableFile), { readOnly: true })
        : new MemeshDatabase(resolvedPath, mode.readOnly ? { readOnly: true } : undefined);
    if (mode.readOnly)
        return opening;
    try {
        if (opts.busyTimeoutMs !== undefined) {
            opening.pragma(`busy_timeout = ${opts.busyTimeoutMs}`);
            giveUpIfWriteLocked(opening);
        }
        retryWhileLocked(() => initialiseDatabase(opening, { maintenance: opts.maintenance === true }), opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS, `${resolvedPath} (data folder ${path.dirname(resolvedPath)})`);
    }
    catch (err) {
        try {
            opening.close();
        }
        catch { }
        throw err;
    }
    return opening;
}
function giveUpIfWriteLocked(db) {
    try {
        db.exec('BEGIN IMMEDIATE');
    }
    catch (err) {
        if (isTransientDbError(err))
            throw err;
        return;
    }
    db.exec('COMMIT');
}
function isReadonlyDbError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /readonly database|SQLITE_READONLY/i.test(msg);
}
function initialiseDatabase(db, opts) {
    try {
        db.pragma('journal_mode = WAL');
    }
    catch (err) {
        if (!isReadonlyDbError(err))
            throw err;
    }
    db.pragma('foreign_keys = ON');
    try {
        migrateToCurrentSchema(db, opts);
    }
    catch (err) {
        if (!isReadonlyDbError(err))
            throw err;
        try {
            process.stderr.write('MeMesh: the database file is read-only, so schema migration was skipped — ' +
                'opened for reads only. Capture and migrations resume when the file is writable.\n');
        }
        catch { }
    }
    return db;
}
function migrateToCurrentSchema(db, opts) {
    createSchema(db);
    db.exec(FTS_SQL);
    ensureTagsUniqueIndex(db);
    ensureHookRunsSince(db);
    migrateEntitiesSchema(db);
    runAutoDecay(db);
    backfillSignalScores(db);
    ensureFtsSegmentation(db);
    if (ftsIndexIsCurrent(db)) {
        backfillTitles(db);
    }
    else {
        try {
            process.stderr.write('MeMesh: adding titles to older memories waits until the search index is rebuilt.\n');
        }
        catch { }
    }
    backfillAcceptedProposalTrust(db);
    repairOwnNoteFolderTrust(db, ownMemoryDirIds());
    dedupeObservations(db);
    retractZeroEditClaims(db);
    removeJunkFileTags(db);
    canonicalizeLessonTypes(db);
    splitFusedLessons(db, { deriveTitle: deriveHeuristicTitle });
    repairFusedLessonShellHistory(db);
    ensureDreamProposalsTable(db);
    dropArchivedIndexRows(db);
    if (opts.maintenance)
        backfillCompressionMarkers(db);
}
export function reindexFts() {
    const database = getDatabase();
    database.transaction(() => {
        rebuildFtsIndex(database);
        database
            .prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
            .run('fts_segmentation_version', String(FTS_SEGMENTATION_VERSION));
        database.prepare('DELETE FROM memesh_metadata WHERE key = ?').run('fts_segmentation_version_last_attempt');
    }).immediate();
    const { c } = database
        .prepare("SELECT count(*) AS c FROM entities WHERE status = 'active'")
        .get();
    return { entities: c };
}
function ensureDreamProposalsTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS dream_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      proposed_digest TEXT NOT NULL,
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_status ON dream_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_project ON dream_proposals(project);
  `);
    const dpCols = db.prepare("PRAGMA table_info(dream_proposals)").all();
    if (!dpCols.some((c) => c.name === 'source_kind')) {
        safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'entities'");
    }
    if (!dpCols.some((c) => c.name === 'kind')) {
        safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'digest'");
    }
}
function backfillSignalScores(db) {
    const MARKER = 'signal_score_backfill_v2';
    const done = db.prepare("SELECT value FROM memesh_metadata WHERE key = ?").get(MARKER);
    if (done)
        return;
    const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ?');
    const tagStmt = db.prepare('SELECT tag FROM tags WHERE entity_id = ?');
    const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
    runOnceMigration(db, { key: `${MARKER}_migration`, version: 1, describe: 'signal-score backfill', migrate: () => {
            if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER))
                return;
            const rows = db.prepare('SELECT id, name, type, metadata FROM entities').all();
            let scored = 0;
            let skipped = 0;
            for (const row of rows) {
                let metadata;
                if (row.metadata) {
                    try {
                        metadata = JSON.parse(row.metadata);
                    }
                    catch {
                        skipped++;
                        continue;
                    }
                    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
                        skipped++;
                        continue;
                    }
                }
                else {
                    metadata = {};
                }
                if (typeof metadata.signal_score === 'number') {
                    skipped++;
                    continue;
                }
                const observations = obsStmt.all(row.id).map(o => o.content);
                const tags = tagStmt.all(row.id).map(t => t.tag);
                metadata.signal_score = computeSignalScore({
                    type: row.type,
                    name: row.name,
                    observations,
                    tags,
                });
                updateStmt.run(JSON.stringify(metadata), row.id);
                scored++;
            }
            db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)").run(MARKER, JSON.stringify({ at: new Date().toISOString(), scored, skipped }));
        } });
}
function deriveHeuristicTitle(type, observations) {
    if (observations.length === 0)
        return null;
    if (type === 'lesson_learned' || type === 'lesson' || type === 'mistake') {
        const errObs = observations.find((o) => /^Error:\s*/.test(o.trim()));
        if (errObs) {
            const firstLine = errObs.trim().replace(/^Error:\s*/, '').split('\n')[0].trim();
            if (firstLine)
                return truncateTitle(firstLine);
        }
    }
    if (type === 'commit') {
        const first = observations[0]?.split('\n')[0].trim();
        if (first && !/^(Branch|Diff stats):/.test(first))
            return truncateTitle(first);
    }
    const nonTrivial = observations.filter((o) => o.length > 30 && !isBoilerplateObservation(o));
    const pool = nonTrivial.length > 0 ? nonTrivial : observations;
    const best = pool.slice(0, 3).reduce((a, b) => (b.length > a.length ? b : a), pool[0]);
    const firstLine = best?.split('\n')[0].trim();
    return firstLine ? truncateTitle(firstLine) : null;
}
function backfillAcceptedProposalTrust(db) {
    const MARKER = 'accepted_proposal_trust_v1';
    if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER))
        return;
    const stamp = (cleared, skipped) => db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
        .run(MARKER, JSON.stringify({ at: new Date().toISOString(), cleared, skipped }));
    const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
    runOnceMigration(db, { key: `${MARKER}_migration`, version: 1, describe: 'accepted-proposal trust backfill', migrate: () => {
            if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER))
                return;
            const rows = db.prepare(`SELECT id, metadata FROM entities
          WHERE metadata IS NOT NULL
            AND json_valid(metadata)
            AND json_extract(metadata, '$.trust') = 'untrusted'
            AND json_extract(metadata, '$.proposal_id') IS NOT NULL`).all();
            let cleared = 0;
            let skipped = 0;
            for (const row of rows) {
                let metadata;
                try {
                    const parsed = JSON.parse(row.metadata ?? '{}');
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                        skipped++;
                        continue;
                    }
                    metadata = parsed;
                }
                catch {
                    skipped++;
                    continue;
                }
                delete metadata.trust;
                updateStmt.run(JSON.stringify(metadata), row.id);
                cleared++;
            }
            stamp(cleared, skipped);
        } });
}
function backfillTitles(db) {
    const MARKER = 'title_backfill_v1';
    const done = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER);
    if (done)
        return;
    const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id');
    const updateStmt = db.prepare('UPDATE entities SET title = ?, metadata = ? WHERE id = ?');
    runOnceMigration(db, { key: `${MARKER}_migration`, version: 1, describe: 'title backfill', migrate: () => {
            if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER))
                return;
            const rows = db.prepare('SELECT id, name, type, status, metadata FROM entities WHERE title IS NULL').all();
            let titled = 0;
            let skipped = 0;
            for (const row of rows) {
                let metadata;
                if (row.metadata) {
                    try {
                        metadata = JSON.parse(row.metadata);
                    }
                    catch {
                        skipped++;
                        continue;
                    }
                    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
                        skipped++;
                        continue;
                    }
                }
                else {
                    metadata = {};
                }
                const observations = obsStmt.all(row.id).map(o => o.content);
                const title = deriveHeuristicTitle(row.type, observations);
                if (!title) {
                    skipped++;
                    continue;
                }
                metadata.title_source = 'heuristic';
                updateStmt.run(title, JSON.stringify(metadata), row.id);
                if (row.status === 'active') {
                    const obsText = joinIndexedObservations(observations);
                    removeFromFts(db, row.id, row.name, obsText);
                    insertFtsRow(db, row.id, row.name, obsText, title);
                }
                titled++;
            }
            db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(MARKER, JSON.stringify({ at: new Date().toISOString(), titled, skipped }));
        } });
}
export function closeDatabase() {
    for (const retired of retiredHandles.splice(0)) {
        try {
            retired.close();
        }
        catch { }
    }
    if (db) {
        db.close();
        db = null;
    }
    readOnlyFolder = null;
}
export function explainReadOnlyRefusal(err) {
    if (readOnlyFolder === null)
        return null;
    return /readonly database|SQLITE_READONLY/i.test(err instanceof Error ? err.message : String(err)) ? readOnlyFolder.note : null;
}
export function failureMessage(err) {
    return explainReadOnlyRefusal(err) ?? (err instanceof Error ? err.message : String(err));
}
export function readOnlyFolderState() {
    return readOnlyFolder;
}
function reopenIfFolderWritable() {
    const state = readOnlyFolder;
    if (!state || state.requested || !db)
        return;
    if (!isWritable(state.dir))
        return;
    const old = db;
    db = null;
    readOnlyFolder = null;
    try {
        openDatabase(state.dbPath);
        retiredHandles.push(old);
        try {
            process.stderr.write(`MeMesh: ${state.dir} is writable again, so the database was reopened for reading and writing.\n`);
        }
        catch { }
    }
    catch (err) {
        db = old;
        readOnlyFolder = state;
        try {
            process.stderr.write(`MeMesh: ${state.dir} is writable again but the database could not be reopened (${err instanceof Error ? err.message : String(err)}); still read-only.\n`);
        }
        catch { }
    }
}
export function getDatabase() {
    if (!db)
        throw new Error('Database not opened');
    if (readOnlyFolder)
        reopenIfFolderWritable();
    return db;
}
export function isDatabaseOpen() {
    return db !== null;
}
//# sourceMappingURL=db.js.map