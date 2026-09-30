import { MemeshDatabase } from '../storage/sqlite.js';
import { SCHEMA_SQL } from '../storage/schema.js';
import { getDatabase } from '../db.js';
import { AGENT_MESSAGE_PROJECT_TABLES } from './agent-scope-id.js';
export function listProjectTags(db) {
    const conn = db ?? getDatabase();
    const rows = conn.prepare("SELECT tag, COUNT(*) c FROM tags WHERE tag LIKE 'project:%' GROUP BY tag ORDER BY c DESC, tag ASC").all();
    return rows.map((r) => ({ project: r.tag.slice('project:'.length), count: r.c }));
}
export function renameProjectTag(from, to, opts) {
    const conn = opts?.db ?? getDatabase();
    const fromTag = `project:${from}`;
    const toTag = `project:${to}`;
    if (fromTag === toTag) {
        throw new Error(`--from and --to name the same project (${from}); nothing to rename, and applying it would remove the project from every memory.`);
    }
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
    const currentSchema = new MemeshDatabase(':memory:');
    let messageRowsBlocked;
    try {
        currentSchema.exec(SCHEMA_SQL);
        messageRowsBlocked = messagePlan.reduce((n, { table, rowIds }) => n + (rowIds.length === 0 ? 0 : countScopeCollisions(conn, currentSchema, table, from, to)), 0);
    }
    finally {
        currentSchema.close();
    }
    if (opts?.apply && (affected.length > 0 || messageRows > 0)) {
        messageRowsBlocked = 0;
        const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
        const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
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
                    }
                    catch (err) {
                        if (!isUniqueViolation(err))
                            throw err;
                        messageRowsBlocked += 1;
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
    };
}
function isUniqueViolation(err) {
    const code = err?.errcode;
    return code === 2067 || code === 1555 || /UNIQUE constraint failed/.test(err instanceof Error ? err.message : String(err));
}
function countScopeCollisions(conn, currentSchema, table, from, to) {
    const uniqueKeys = (source) => source.prepare(`SELECT name FROM pragma_index_list('${table}') WHERE "unique" = 1`).all()
        .map(({ name }) => source.prepare(`SELECT name FROM pragma_index_info('${name.replace(/'/g, "''")}')`).all().map((c) => c.name))
        .filter((cols) => cols.includes('project'));
    const seen = new Set();
    const indexes = [...uniqueKeys(conn), ...uniqueKeys(currentSchema)].filter((cols) => {
        const key = cols.join(',');
        return seen.has(key) ? false : (seen.add(key), true);
    });
    if (indexes.length === 0)
        return 0;
    const collides = indexes.map((cols) => {
        const same = cols.filter((c) => c !== 'project').map((c) => `b."${c}" = a."${c}"`);
        return `EXISTS (SELECT 1 FROM ${table} b WHERE b.project = ?${same.map((x) => ` AND ${x}`).join('')})`;
    });
    const row = conn.prepare(`SELECT count(*) AS n FROM ${table} a WHERE a.project = ? AND (${collides.join(' OR ')})`)
        .get(from, ...indexes.map(() => to));
    return row.n;
}
//# sourceMappingURL=project-tags.js.map