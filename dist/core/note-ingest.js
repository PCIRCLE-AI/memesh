import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDatabase } from '../db.js';
import { remember } from './operations.js';
import { sanitizeNoteText, splitObservations, NOTE_DEFAULT_TYPE, NOTE_MAX_OBSERVATIONS } from './note-derive.js';
import { truncateTitle } from './title.js';
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
export function ingestNoteDirectory(opts) {
    const maxFiles = opts.maxFiles ?? NOTE_DIR_MAX_FILES;
    const maxBytes = opts.maxBytes ?? NOTE_FILE_MAX_BYTES;
    const realDir = fs.realpathSync(opts.dir);
    if (!fs.statSync(realDir).isDirectory())
        throw new Error(`not a directory: ${opts.dir}`);
    const dirId = createHash('sha256').update(realDir).digest('hex').slice(0, 16);
    const { files, symlinks } = discover(realDir);
    const result = {
        dirId,
        discovered: files.length,
        created: [],
        replaced: [],
        unchanged: 0,
        markedMissing: [],
        skipped: symlinks.map((abs) => ({ path: relPath(realDir, abs), reason: 'symlink refused' })),
        more: 0,
    };
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
            known.set(prov.note_path, { mtime: prov.note_mtime_ms, size: prov.note_size, missing: row.is_missing === 1 });
        }
    }
    let read = 0;
    for (const abs of files) {
        const rel = relPath(realDir, abs);
        const skip = (reason) => { result.skipped.push({ path: rel, reason }); };
        let raw;
        let stat;
        try {
            stat = fs.lstatSync(abs);
            if (stat.isSymbolicLink()) {
                skip('symlink refused');
                continue;
            }
            const prior = known.get(rel);
            if (prior && !prior.missing && prior.mtime === stat.mtimeMs && prior.size === stat.size) {
                result.unchanged++;
                continue;
            }
            if (read >= maxFiles) {
                result.more++;
                continue;
            }
            read++;
            if (stat.size > maxBytes) {
                skip(`larger than ${Math.round(maxBytes / 1024)} KB`);
                continue;
            }
            const real = fs.realpathSync(abs);
            if (!real.startsWith(realDir + path.sep)) {
                skip('resolves outside the directory');
                continue;
            }
            raw = fs.readFileSync(real);
        }
        catch (err) {
            skip(`unreadable: ${err.code ?? 'error'}`);
            continue;
        }
        const parsed = parseFrontmatter(raw.toString('utf8'));
        if (!parsed) {
            skip('no frontmatter — a note file needs a `---` block with a name');
            continue;
        }
        const name = stringField(parsed.data, 'name')?.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255);
        if (!name) {
            skip('frontmatter has no name');
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
            skip('empty note — no description and no body');
            continue;
        }
        observations = observations.slice(0, NOTE_MAX_OBSERVATIONS);
        const title = truncateTitle(cleanDescription || observations[0]);
        const contentHash = createHash('sha256').update(raw).digest('hex');
        const existing = existingStmt.get(NOTE_FILE_TAG, NOTE_FILE_MISSING_TAG, name);
        if (existing) {
            const prov = parseProvenance(existing.metadata);
            if (!existing.is_note) {
                skip(`name "${name}" belongs to a memory that did not come from a note file`);
                continue;
            }
            if (prov.note_dir_id !== dirId) {
                skip(`name "${name}" was already ingested from another note directory`);
                continue;
            }
            if (existing.status === 'archived') {
                skip(`memory "${name}" was archived with forget; not re-ingested`);
                continue;
            }
            if (prov.content_hash === contentHash && prov.note_path === rel && !existing.is_missing) {
                const meta = JSON.parse(existing.metadata ?? '{}');
                meta.provenance = { ...prov, note_mtime_ms: stat.mtimeMs, note_size: stat.size };
                db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), existing.id);
                result.unchanged++;
                continue;
            }
        }
        remember({
            name,
            type,
            title,
            observations,
            tags: [NOTE_FILE_TAG, ...(opts.project ? [`project:${opts.project}`] : [])],
            replace: true,
            trustOverride: 'untrusted',
            provenanceOverride: {
                source: 'note-file',
                note_path: rel,
                content_hash: contentHash,
                note_dir_id: dirId,
                note_mtime_ms: stat.mtimeMs,
                note_size: stat.size,
            },
            sourceHost: 'note-file',
        });
        (existing ? result.replaced : result.created).push(name);
    }
    const present = new Set(files.map((abs) => relPath(realDir, abs)));
    const tagMissing = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
    for (const row of noteRows) {
        if (row.is_missing)
            continue;
        const prov = parseProvenance(row.metadata);
        if (prov.note_dir_id !== dirId || typeof prov.note_path !== 'string')
            continue;
        if (present.has(prov.note_path))
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
        `${r.skipped.length} skipped`,
    ];
    if (r.markedMissing.length)
        parts.push(`${r.markedMissing.length} marked missing`);
    if (r.more)
        parts.push(`${r.more} more not processed (per-run cap)`);
    return parts.join(', ');
}
//# sourceMappingURL=note-ingest.js.map