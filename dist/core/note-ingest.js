import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDatabase } from '../db.js';
import { remember } from './operations.js';
import { DECISION_TYPES, NOTE_FILE_MISSING_TAG, NOTE_FILE_PROVENANCE, WHY_PREFIX } from './work-topology.js';
import { copyDatabaseBefore } from './db-copy.js';
import { sanitizeNoteText, splitObservations, NOTE_DEFAULT_TYPE, NOTE_MAX_OBSERVATIONS } from './note-derive.js';
import { truncateTitle } from './title.js';
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
        retrusted: [],
        retrustBackup: null,
        retrustFailed: null,
        repathed: [],
        restored: [],
        markedMissing: [],
        skipped: [],
        refusedNow: 0,
        more: 0,
    };
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
            const prior = known.get(rel);
            if (prior && !prior.missing && prior.mtime === stat.mtimeMs && prior.size === stat.size && prior.ino === stat.ino) {
                claims.push({ rel, name: prior.name, stat, unchanged: true });
                continue;
            }
            const priorSkip = priorSkips[rel];
            const nameIsFree = !!priorSkip?.name && missingNames.has(priorSkip.name);
            if (priorSkip && !priorSkip.reportOnly && !nameIsFree
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
            trustOverride: existing && existing.trust !== 'trusted' ? 'untrusted' : trustFor(owner.type, owner.observations),
            reinforceConfidence: false,
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
    if (r.more)
        parts.push(`${r.more} more not processed (per-run cap)`);
    return parts.join(', ');
}
//# sourceMappingURL=note-ingest.js.map