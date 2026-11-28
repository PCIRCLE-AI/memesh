import { getProjectIds, redactMemoryText } from './paths.js';
import { candidateIsAutoInjectable } from './briefing-index.js';
import { EVIDENCE_LAYER_TYPES, jsonStringLiteral, projectLabel, sliceWholeChars, utcEpoch } from './work-topology.js';
export const RECENT_INDEX_SIZE = 30;
export const RECENT_TITLE_CHARS = 120;
export const AUTO_CONTEXT_EXCLUDED_TYPES = [
    ...EVIDENCE_LAYER_TYPES,
    'task-state',
    'digest',
    'release-notice',
];
export const RECENT_INDEX_SKIP_TYPES = ['conversation', 'feedback', 'engineering_feedback'];
export function projectAliases(project, scope = null) {
    if (project === null)
        return [];
    const checkout = scope === null ? [] : typeof scope === 'string' ? getProjectIds(scope) : scope;
    const ids = checkout.includes(project) ? [project, ...checkout] : [project];
    return [...new Set([...ids, ...ids.map(projectLabel)])];
}
const NO_PROJECT_TAG = "NOT EXISTS (SELECT 1 FROM tags pt WHERE pt.entity_id = e.id AND pt.tag LIKE 'project:%')";
const HOST_SCOPED_TAG = "EXISTS (SELECT 1 FROM tags ht WHERE ht.entity_id = e.id AND (ht.tag LIKE 'platform:%' OR ht.tag LIKE 'agent:%'))";
export function autoContextScope(aliases, platform) {
    const hostScope = platform === 'hermes'
        ? "NOT EXISTS (SELECT 1 FROM tags ht WHERE ht.entity_id = e.id AND (ht.tag LIKE 'platform:%' OR ht.tag LIKE 'agent:%') AND ht.tag <> 'platform:hermes')"
        : `NOT ${HOST_SCOPED_TAG}`;
    const noProject = `(${NO_PROJECT_TAG} AND ${hostScope})`;
    return {
        sql: aliases.length === 0
            ? noProject
            : `(EXISTS (SELECT 1 FROM tags st WHERE st.entity_id = e.id AND st.tag IN (${aliases.map(() => '?').join(', ')})) OR ${noProject})`,
        params: aliases.map((id) => `project:${id}`),
    };
}
export function sqliteInstant(ms) {
    const iso = new Date(ms).toISOString();
    return iso.endsWith('.000Z') ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 23).replace('T', ' ');
}
const normTime = (column) => `replace(replace(${column}, 'T', ' '), 'Z', '')`;
export function tableColumns(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}
export const shownText = (row) => String(row.title ?? row.name);
export function readRecentPool(db, aliases, asOf) {
    const cols = tableColumns(db, 'entities');
    const T = sqliteInstant(asOf);
    const scope = autoContextScope(aliases);
    const excluded = [...AUTO_CONTEXT_EXCLUDED_TYPES, ...RECENT_INDEX_SKIP_TYPES];
    const page = db.prepare(`SELECT e.id, e.name, e.type, ${cols.has('title') ? 'e.title' : 'NULL AS title'}, e.metadata, e.created_at,
       (SELECT max(${normTime('o.created_at')}) FROM observations o WHERE o.entity_id = e.id AND ${normTime('o.created_at')} < ?) AS last
     FROM entities e
     WHERE ${cols.has('status') ? "e.status = 'active' AND " : ''}${normTime('e.created_at')} < ?
       AND e.type NOT IN (${excluded.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM tags ac WHERE ac.entity_id = e.id AND ac.tag = 'source:auto-capture')
       AND ${scope.sql}
       AND last IS NOT NULL
     ORDER BY last DESC, e.id DESC
     LIMIT ? OFFSET ?`);
    const rows = [];
    for (let offset = 0; rows.length < RECENT_INDEX_SIZE; offset += RECENT_INDEX_SIZE * 2) {
        const got = page.all(T, T, ...excluded, ...scope.params, RECENT_INDEX_SIZE * 2, offset);
        for (const r of got) {
            if (rows.length >= RECENT_INDEX_SIZE)
                break;
            if (!candidateIsAutoInjectable(r.metadata))
                continue;
            rows.push({ id: r.id, name: r.name, type: r.type, title: r.title, createdMs: utcEpoch(r.created_at), lastMs: utcEpoch(r.last) });
        }
        if (got.length < RECENT_INDEX_SIZE * 2)
            break;
    }
    const projects = rowProjects(db, rows.map((r) => r.id), aliases);
    return rows.map((r) => ({ ...r, projects: projects.get(r.id) ?? [] }));
}
function rowProjects(db, ids, aliases) {
    const out = new Map();
    if (ids.length === 0)
        return out;
    const rows = db.prepare(`SELECT entity_id, tag FROM tags WHERE tag LIKE 'project:%' AND entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(...ids);
    for (const r of rows) {
        const id = r.tag.slice('project:'.length);
        const list = out.get(r.entity_id) ?? [];
        list.push(aliases.includes(id) ? aliases[0] : id);
        out.set(r.entity_id, list);
    }
    return out;
}
export function recentTitle(row) {
    return sliceWholeChars(redactMemoryText(shownText(row)), RECENT_TITLE_CHARS);
}
export function recentLine(row) {
    return `- ${recentTitle(row)} [mem:${row.id}]`;
}
function heading(project) {
    const where = project === null ? '' : ` in ${jsonStringLiteral(projectLabel(project))}`;
    return `Recently written memories${where} (newest first; recall a [mem:id] to read one):`;
}
export function buildRecentIndex(db, project, asOf = Date.now(), scope = null) {
    const pool = readRecentPool(db, projectAliases(project, scope), asOf);
    const body = pool.map(recentLine);
    return { poolIds: pool.map((r) => r.id), shown: pool, lines: pool.length === 0 ? [] : [heading(project), ...body] };
}
//# sourceMappingURL=recent-index.js.map