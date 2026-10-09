import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemeshDatabase } from '../storage/sqlite.js';
import { getDatabase, openInitialisedDatabase } from '../db.js';
import { AGENT_MESSAGE_PROJECT_TABLES } from './agent-scope-id.js';
import { guardDatabaseFiles } from './file-mode.js';
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
    const { affected, plan, merged, renamed, messagePlan, messageRows } = planRename(conn, from, to);
    const proposalIds = proposalRowsForProject(conn, from);
    let messageRowsBlocked = 0;
    if (affected.length > 0 || messageRows > 0 || proposalIds.length > 0) {
        const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
        const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
        const movedRows = [];
        const tx = conn.transaction(() => {
            for (const p of plan) {
                if (p.action === 'merge')
                    del.run(p.id, fromTag);
                else
                    upd.run(toTag, p.id, fromTag);
            }
            for (const { table, rowIds } of messagePlan) {
                if (rowIds.length === 0)
                    continue;
                const move = conn.prepare(`UPDATE ${table} SET project = ? WHERE rowid = ?`);
                for (const rid of rowIds) {
                    try {
                        move.run(to, rid);
                        movedRows.push({ table, rid });
                    }
                    catch (err) {
                        const code = err?.errcode;
                        if ((code !== 2067 && code !== 1555) || !destinationHolds(conn, table, rid, to))
                            throw err;
                        messageRowsBlocked += 1;
                    }
                }
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
            for (const { table, rid } of movedRows) {
                const row = conn.prepare(`SELECT project FROM ${table} WHERE rowid = ?`).get(rid);
                if (row?.project !== to) {
                    throw new Error(`${table} row ${rid} is not scoped to ${to} after the rename (a trigger or constraint changed the result)`);
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
        messageRows,
        messageRowsBlocked,
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
    const messagePlan = AGENT_MESSAGE_PROJECT_TABLES.map((table) => {
        try {
            const rows = conn.prepare(`SELECT rowid AS rid FROM ${table} WHERE project = ?`)
                .all(from);
            return { table, rowIds: rows.map((r) => r.rid) };
        }
        catch (err) {
            if (!/no such table/i.test(err instanceof Error ? err.message : String(err)))
                throw err;
            return { table, rowIds: [] };
        }
    });
    const messageRows = messagePlan.reduce((n, t) => n + t.rowIds.length, 0);
    return { affected, plan, merged, renamed, messagePlan, messageRows };
}
export function hasRenameWork(from, db) {
    const { affected, messageRows } = planRename(db ?? getDatabase(), from, from);
    return affected.length > 0 || messageRows > 0 || proposalRowsForProject(db ?? getDatabase(), from).length > 0;
}
function destinationHolds(conn, table, rid, to) {
    const quote = (name) => `"${name.replace(/"/g, '""')}"`;
    const indexes = conn.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND partial = 0')
        .all(table);
    for (const { name } of indexes) {
        const cols = conn.prepare('SELECT name, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno')
            .all(name);
        if (!cols.some((c) => c.name === 'project') || cols.some((c) => c.name === null || !/^\w+$/.test(c.coll)))
            continue;
        const match = cols.map((c) => (c.name === 'project'
            ? `d.project = ? COLLATE ${c.coll}`
            : `d.${quote(c.name)} = s.${quote(c.name)} COLLATE ${c.coll}`)).join(' AND ');
        if (conn.prepare(`SELECT 1 FROM ${table} s, ${table} d WHERE s.rowid = ? AND d.rowid <> s.rowid AND ${match} LIMIT 1`).get(rid, to))
            return true;
    }
    return false;
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
        let realPath = dbPath;
        try {
            realPath = fs.realpathSync(dbPath);
        }
        catch { }
        const wal = `${realPath}-wal`;
        const hasWal = fs.existsSync(wal) && fs.statSync(wal).size > 0;
        if (hasWal || !/readonly|unable to open/i.test(err instanceof Error ? err.message : String(err)))
            throw err;
        return open(`${pathToFileURL(dbPath).href}?immutable=1`);
    }
}
//# sourceMappingURL=project-tags.js.map