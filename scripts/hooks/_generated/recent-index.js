// ============================================================================
// AUTO-GENERATED from src/core/recent-index.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { getProjectIds, redactMemoryText } from './core-paths.js';
import { candidateIsAutoInjectable } from './briefing-index.js';
import { DECISION_TYPES, EVIDENCE_LAYER_TYPES, jsonStringLiteral, projectLabel, sliceWholeChars, utcEpoch } from './work-topology.js';
export const RECENT_INDEX_SIZE = 30;
export const STALE_SUPERSEDE_TAU = 0.2;
export const STALE_PENDING_MAX_DAYS = 0;
export const RECENT_TITLE_CHARS = 120;
export const AUTO_CONTEXT_EXCLUDED_TYPES = [
    ...EVIDENCE_LAYER_TYPES,
    'task-state',
    'session-handoff',
    'digest',
    'release-notice',
];
export const RECENT_INDEX_SKIP_TYPES = ['feedback', 'engineering_feedback'];
export const PENDING_TITLE = /等\s*KT|等待|待(辦|做|合併|裁決|審|確認|處理)|暫(時|停|緩|維持)|未解|尚未|pending|waiting|todo|\bwip\b|blocked/i;
const TOPIC_STOP_WORDS = ['kt', 'the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'is', 'are', 'be', 'by', 'with', 'not', 'no', 'it', 'as', 'from', 'only', 'per', 'via', 'vs'];
const DAY_MS = 86_400_000;
export function projectAliases(project, scope = null) {
    if (project === null)
        return [];
    const checkout = scope === null ? [] : typeof scope === 'string' ? getProjectIds(scope) : scope;
    const ids = checkout.includes(project) ? [project, ...checkout] : [project];
    return [...new Set([...ids, ...ids.map(projectLabel)])];
}
const NO_PROJECT_TAG = "NOT EXISTS (SELECT 1 FROM tags pt WHERE pt.entity_id = e.id AND pt.tag LIKE 'project:%')";
const HOST_SCOPED_TAG = "EXISTS (SELECT 1 FROM tags ht WHERE ht.entity_id = e.id AND (ht.tag LIKE 'platform:%' OR ht.tag LIKE 'agent:%'))";
export function autoContextScope(aliases) {
    const noProject = `(${NO_PROJECT_TAG} AND NOT ${HOST_SCOPED_TAG})`;
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
     ORDER BY last DESC, e.id ASC
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
export function readRecentRows(db, ids, asOf, aliases) {
    const unique = [...new Set(ids)];
    if (unique.length === 0)
        return [];
    const cols = tableColumns(db, 'entities');
    const T = sqliteInstant(asOf);
    const rows = db.prepare(`SELECT e.id, e.name, e.type, ${cols.has('title') ? 'e.title' : 'NULL AS title'}, e.created_at,
       (SELECT max(${normTime('o.created_at')}) FROM observations o WHERE o.entity_id = e.id AND ${normTime('o.created_at')} < ?) AS last
     FROM entities e WHERE e.id IN (${unique.map(() => '?').join(',')})`).all(T, ...unique);
    const projects = rowProjects(db, rows.map((r) => r.id), aliases);
    const byId = new Map(rows.map((r) => {
        const createdMs = utcEpoch(r.created_at);
        return [r.id, { id: r.id, name: r.name, type: r.type, title: r.title, createdMs, lastMs: r.last === null ? createdMs : utcEpoch(r.last), projects: projects.get(r.id) ?? [] }];
    }));
    return unique.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
}
function topicWords(row) {
    const stop = new Set(TOPIC_STOP_WORDS);
    for (const p of row.projects)
        for (const w of projectLabel(p).toLowerCase().split(/[^a-z0-9]+/))
            if (w)
                stop.add(w);
    const out = new Set();
    const text = shownText(row).toLowerCase().replace(/~[0-9a-f]{32}/g, '');
    for (const w of text.match(/[a-z0-9][a-z0-9]*/g) ?? [])
        if (!/^\d+$/.test(w) && !stop.has(w))
            out.add(w);
    for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
        if (run.length === 1)
            out.add(run);
        for (let i = 0; i < run.length - 1; i++)
            out.add(run.slice(i, i + 2));
    }
    for (const w of String(row.name).toLowerCase().replace(/~[0-9a-f]{32}/g, '').split(/[^a-z0-9]+/)) {
        if (w && !/^\d+$/.test(w) && !stop.has(w))
            out.add(w);
    }
    return out;
}
function jaccard(a, b) {
    let both = 0;
    for (const x of a)
        if (b.has(x))
            both++;
    return both / (a.size + b.size - both || 1);
}
const shareProject = (a, b) => (a.projects.length === 0 && b.projects.length === 0) || a.projects.some((p) => b.projects.includes(p));
export function staleReason(row, shownWith, asOf) {
    const words = topicWords(row);
    const superseded = shownWith.some((o) => o.id !== row.id
        && DECISION_TYPES.has(o.type)
        && o.createdMs > row.createdMs
        && o.createdMs < asOf
        && shareProject(row, o)
        && jaccard(words, topicWords(o)) >= STALE_SUPERSEDE_TAU);
    if (superseded)
        return 'superseded';
    if (PENDING_TITLE.test(shownText(row)) && (asOf - row.lastMs) / DAY_MS > STALE_PENDING_MAX_DAYS)
        return 'waiting';
    return null;
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
    const shown = [];
    const removed = [];
    for (const row of pool) {
        const reason = staleReason(row, pool, asOf);
        if (reason === null)
            shown.push(row);
        else
            removed.push({ id: row.id, reason });
    }
    const body = shown.length > 0
        ? shown.map(recentLine)
        : [`- The ${pool.length} most recent memories all look out of date (a newer decision on the same topic, or a waiting status) — recall to see them.`];
    return { poolIds: pool.map((r) => r.id), shown, removed, lines: pool.length === 0 ? [] : [heading(project), ...body] };
}
