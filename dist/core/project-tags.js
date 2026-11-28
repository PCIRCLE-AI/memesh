import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemeshDatabase } from '../storage/sqlite.js';
import { getDatabase, openInitialisedDatabase } from '../db.js';
import { guardDatabaseFiles, hasPagesWaiting, immutableAddress } from './file-mode.js';
export function listProjectTags(db) {
    const conn = db ?? getDatabase();
    const rows = conn.prepare("SELECT tag, COUNT(*) c FROM tags WHERE tag LIKE 'project:%' GROUP BY tag ORDER BY c DESC, tag ASC").all();
    return rows.map((r) => ({ project: r.tag.slice('project:'.length), count: r.c }));
}
export function sameProjectRefusal(from, to) {
    return `project:${from}` === `project:${to}`
        ? `--from and --to name the same project (${from}); nothing to rename, and applying it would remove the project from every memory.`
        : null;
}
export function renameProjectTag(from, to, opts) {
    const conn = opts?.db ?? getDatabase();
    const fromTag = `project:${from}`;
    const toTag = `project:${to}`;
    const refusal = sameProjectRefusal(from, to);
    if (refusal)
        throw new Error(refusal);
    if (!opts?.apply)
        return previewOnCopy(conn, from, to);
    const { affected, plan, merged, renamed } = planRename(conn, from, to);
    const proposalIds = proposalRowsForProject(conn, from);
    if (affected.length > 0 || proposalIds.length > 0) {
        const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
        const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
        const tx = conn.transaction(() => {
            for (const p of plan) {
                if (p.action === 'merge')
                    del.run(p.id, fromTag);
                else
                    upd.run(toTag, p.id, fromTag);
            }
            if (proposalIds.length > 0) {
                const move = conn.prepare('UPDATE dream_proposals SET project = ? WHERE id = ?');
                for (const id of proposalIds)
                    move.run(to, id);
            }
            const hasTag = conn.prepare('SELECT 1 FROM tags WHERE entity_id = ? AND tag = ?');
            for (const p of plan) {
                if (hasTag.get(p.id, fromTag) || !hasTag.get(p.id, toTag)) {
                    throw new Error(`entity ${p.id} does not carry ${toTag} in place of ${fromTag} after the rename (a trigger or constraint changed the result)`);
                }
            }
            if (proposalIds.length > 0) {
                const read = conn.prepare('SELECT project FROM dream_proposals WHERE id = ?');
                for (const id of proposalIds) {
                    if (read.get(id)?.project !== to) {
                        throw new Error(`proposal ${id} is not scoped to ${to} after the rename (a trigger or constraint changed the result)`);
                    }
                }
            }
        });
        tx();
    }
    return {
        fromTag,
        toTag,
        affectedEntities: affected.length,
        merged,
        renamed,
        applied: !!opts?.apply,
        affectedNames: affected.map((e) => e.name),
        proposalRows: proposalIds.length,
    };
}
function proposalRowsForProject(conn, project) {
    try {
        return conn.prepare('SELECT id FROM dream_proposals WHERE project = ?').all(project).map(row => row.id);
    }
    catch (err) {
        if (/^no such table: (?:main\.)?dream_proposals$/i.test(err instanceof Error ? err.message : String(err)))
            return [];
        throw err;
    }
}
function planRename(conn, from, to) {
    const fromTag = `project:${from}`;
    const toTag = `project:${to}`;
    const affected = conn.prepare('SELECT DISTINCT e.id, e.name FROM entities e JOIN tags t ON t.entity_id = e.id WHERE t.tag = ? ORDER BY e.name').all(fromTag);
    const hasTo = conn.prepare('SELECT 1 FROM tags WHERE entity_id = ? AND tag = ?');
    const plan = affected.map((e) => ({
        id: e.id,
        action: hasTo.get(e.id, toTag) ? 'merge' : 'rename',
    }));
    const merged = plan.filter((p) => p.action === 'merge').length;
    const renamed = plan.filter((p) => p.action === 'rename').length;
    return { affected, plan, merged, renamed };
}
export function hasRenameWork(from, db) {
    const conn = db ?? getDatabase();
    const { affected } = planRename(conn, from, from);
    return affected.length > 0 || proposalRowsForProject(conn, from).length > 0;
}
function previewOnCopy(source, from, to) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-rename-preview-'));
    try {
        const file = path.join(dir, 'copy.db');
        try {
            source.prepare('VACUUM INTO ?').run(file);
        }
        catch (err) {
            throw new Error(`could not write the preview copy under ${dir}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
        const copy = openInitialisedDatabase(file);
        try {
            return { ...renameProjectTag(from, to, { apply: true, db: copy }), applied: false };
        }
        finally {
            copy.close();
        }
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
export function openReadOnlyForPreview(dbPath, openHandle = (target) => new MemeshDatabase(target, { readOnly: true })) {
    try {
        process.umask(0o077);
    }
    catch { }
    guardDatabaseFiles(dbPath);
    const open = (target) => {
        const handle = openHandle(target);
        try {
            handle.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
        }
        catch (err) {
            handle.close();
            throw err;
        }
        return handle;
    };
    try {
        return open(dbPath);
    }
    catch (err) {
        if (hasPagesWaiting(dbPath) || !/readonly|unable to open/i.test(err instanceof Error ? err.message : String(err)))
            throw err;
        return open(immutableAddress(dbPath));
    }
}
//# sourceMappingURL=project-tags.js.map