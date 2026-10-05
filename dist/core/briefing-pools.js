import { redactMemoryText, redactShownTogether } from './paths.js';
import { rankEntities } from './scoring.js';
import { SESSION_HANDOFF_TYPE, sessionHandoffName } from './session-handoff.js';
import { INDEX_CANDIDATE_CAP, INDEX_EXCLUDED_TYPES, INDEX_SNIPPET_FETCH_CHARS } from './briefing-index.js';
import { DECISION_LAYER_TYPES, DECISION_TYPES, GLOBAL_TOPOLOGY_LIMIT, LESSON_TYPE_LIST, SNIPPET_FETCH_CHARS, TOPOLOGY_CANDIDATE_CAP, WHY_PREFIX, isAutoInjectable, prioritizeDecisions, unconfirmedDaysSince, } from './work-topology.js';
const LESSON_POOL_LIMIT = 50;
const LESSON_LIMIT = 5;
const RECENT_LIMIT = 5;
const NO_PROJECT_LIMIT = 5;
const SCORING_COLUMNS = ['access_count', 'last_accessed_at', 'confidence', 'recall_hits', 'recall_misses'];
function entityColumns(db) {
    const names = new Set(db.prepare('PRAGMA table_info(entities)').all().map((c) => c.name));
    return {
        status: names.has('status'),
        title: names.has('title'),
        namespace: names.has('namespace'),
        scoring: new Set(SCORING_COLUMNS.filter((c) => names.has(c))),
    };
}
function trustedForAutoContext(rawMetadata) {
    if (rawMetadata == null)
        return true;
    const parsed = parseMetadata(rawMetadata);
    return parsed !== null && isAutoInjectable(parsed);
}
function parseMetadata(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
const active = (cols) => (cols.status ? " AND e.status = 'active'" : '');
const nonGlobal = (cols) => (cols.namespace ? " AND (e.namespace IS NULL OR e.namespace <> 'global')" : '');
const NO_PROJECT_TAG = "NOT EXISTS (SELECT 1 FROM tags pt WHERE pt.entity_id = e.id AND pt.tag LIKE 'project:%')";
const titleCol = (cols) => (cols.title ? 'e.title' : 'NULL AS title');
const candidateColumns = (cols) => [
    'e.id', 'e.name', 'e.type', titleCol(cols), 'e.metadata', 'e.created_at',
    ...SCORING_COLUMNS.map((c) => (cols.scoring.has(c) ? `e.${c}` : `NULL AS ${c}`)),
].join(', ');
const toPoolRow = (row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    title: row.title,
    metadata: row.metadata,
    access_count: row.access_count ?? undefined,
    last_accessed_at: row.last_accessed_at ?? undefined,
    confidence: row.confidence ?? undefined,
    recall_hits: row.recall_hits ?? undefined,
    recall_misses: row.recall_misses ?? undefined,
    created_at: row.created_at ?? undefined,
    recency: row.recency ?? null,
});
function selectPool(rows, cap) {
    return rankEntities(rows.map(toPoolRow), new Map())
        .filter((row) => trustedForAutoContext(row.metadata))
        .slice(0, cap);
}
const validUtc = (column) => `replace(${column}, 'T', ' ') = strftime('%Y-%m-%d %H:%M:%S', ${column})
      AND replace(${column}, 'T', ' ') <= strftime('%Y-%m-%d %H:%M:%S', 'now', '+5 minutes')`;
const RECENCY_SQL = `COALESCE(
  (SELECT MAX(replace(o.created_at, 'T', ' ')) FROM observations o
    WHERE o.entity_id = e.id
      AND ${validUtc('o.created_at')}),
  CASE WHEN ${validUtc('e.created_at')}
       THEN replace(e.created_at, 'T', ' ') END)`;
function guarded(label, fallback, read, onError) {
    if (!onError)
        return read();
    try {
        return read();
    }
    catch (err) {
        onError(label, err);
        return fallback;
    }
}
export function selectBriefingPools(db, projectName, options) {
    const cols = entityColumns(db);
    const projectTag = `project:${projectName}`;
    const columns = candidateColumns(cols);
    const handoffRead = guarded('handoff', undefined, () => db.prepare(`SELECT e.id, e.name, e.metadata, o.content AS text, o.created_at AS observedAt
     FROM entities e JOIN observations o ON o.entity_id = e.id
     WHERE e.name = ? AND e.type = ?${active(cols)}
     ORDER BY o.id DESC
     LIMIT 1`).get(sessionHandoffName(projectName), SESSION_HANDOFF_TYPE), options.onError);
    const handoffTrusted = !!handoffRead && trustedForAutoContext(handoffRead.metadata);
    const projectRows = db.prepare(`SELECT DISTINCT ${columns}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ?${active(cols)} AND e.type <> ?${nonGlobal(cols)}
     ORDER BY e.id DESC
     LIMIT ?`).all(projectTag, SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP);
    const decisions = guarded('decisions', [], () => db.prepare(`SELECT DISTINCT ${columns}, ${RECENCY_SQL} AS recency
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ?${active(cols)}${nonGlobal(cols)}
       AND e.type IN (${DECISION_LAYER_TYPES.map(() => '?').join(',')})
     ORDER BY recency IS NULL, recency DESC, e.id DESC
     LIMIT ?`).all(projectTag, ...DECISION_LAYER_TYPES, TOPOLOGY_CANDIDATE_CAP)
        .map(toPoolRow).filter((row) => trustedForAutoContext(row.metadata)), options.onError);
    const project = prioritizeDecisions(decisions, selectPool(projectRows, TOPOLOGY_CANDIDATE_CAP), options.projectLimit);
    const lessonRows = guarded('lessons', [], () => db.prepare(`SELECT DISTINCT ${columns}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE e.type IN (${LESSON_TYPE_LIST.map(() => '?').join(', ')})${active(cols)}${nonGlobal(cols)} AND t.tag = ?
     ORDER BY e.id DESC
     LIMIT ${LESSON_POOL_LIMIT}`).all(...LESSON_TYPE_LIST, projectTag)
        .map(toPoolRow).filter((row) => trustedForAutoContext(row.metadata)), options.onError);
    const noProject = selectPool(db.prepare(`SELECT ${columns} FROM entities e
     WHERE ${NO_PROJECT_TAG} AND e.type <> ?${active(cols)}${nonGlobal(cols)}
     ORDER BY e.id DESC
     LIMIT ?`).all(SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP), NO_PROJECT_LIMIT);
    const global = options.global && cols.namespace
        ? selectPool(db.prepare(`SELECT ${columns} FROM entities e
       WHERE e.namespace = 'global'${active(cols)}
       ORDER BY e.id DESC
       LIMIT ?`).all(TOPOLOGY_CANDIDATE_CAP), GLOBAL_TOPOLOGY_LIMIT)
        : [];
    const recent = options.foreign
        ? selectPool(db.prepare(`SELECT ${columns} FROM entities e
       WHERE NOT ${NO_PROJECT_TAG} AND e.type <> ?${active(cols)}${nonGlobal(cols)}
       ORDER BY e.id DESC
       LIMIT ?`).all(SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP), RECENT_LIMIT)
        : [];
    return {
        handoff: handoffTrusted ? handoffRead : undefined,
        handoffHidden: handoffRead && !handoffTrusted ? 'untrusted' : undefined,
        lessonCount: lessonRows.length,
        lessons: lessonRows.slice(0, LESSON_LIMIT),
        project,
        noProject,
        global,
        recent,
    };
}
export function readSnippets(db, ids) {
    const unique = [...new Set(ids)];
    const snippets = new Map();
    if (unique.length === 0)
        return snippets;
    const timed = db.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'created_at');
    const rows = db.prepare(`SELECT entity_id, content,
       ${timed ? `CASE WHEN ${validUtc('created_at')} THEN replace(created_at, 'T', ' ') END` : 'NULL'} AS added_at
     FROM observations
     WHERE entity_id IN (${unique.map(() => '?').join(',')})
     ORDER BY id ASC`).all(...unique);
    const shown = (content) => redactMemoryText(content).slice(0, SNIPPET_FETCH_CHARS).replace(/\s+/g, ' ').trim() || null;
    for (const row of rows) {
        const content = String(row.content ?? '');
        const entry = snippets.get(row.entity_id) ?? { first: null, fix: null, why: null, lastAddedAt: null };
        if (entry.first === null)
            entry.first = shown(content);
        if (content.startsWith('Fix: '))
            entry.fix = shown(content);
        if (content.startsWith(WHY_PREFIX))
            entry.why = shown(content.slice(WHY_PREFIX.length));
        if (row.added_at && (entry.lastAddedAt == null || row.added_at > entry.lastAddedAt))
            entry.lastAddedAt = row.added_at;
        snippets.set(row.entity_id, entry);
    }
    return snippets;
}
export function toTopologyEntity(row, snippets, now = Date.now()) {
    const signal = parseMetadata(row.metadata)?.signal_score;
    const snippet = snippets.get(row.id);
    const decision = row.type !== null && DECISION_TYPES.has(row.type);
    const [title, first, fix, why] = redactShownTogether([
        row.title ?? null,
        snippet?.first ?? null,
        row.type && LESSON_TYPE_LIST.includes(row.type) ? snippet?.fix ?? null : null,
        decision ? snippet?.why ?? null : null,
    ]);
    const background = title || first;
    const after = background === fix ? null : background;
    return {
        name: row.name,
        type: row.type || 'memory',
        id: row.id,
        title: fix ? (after ? `${fix} — ${after}` : fix) : title,
        snippet: first,
        signalScore: typeof signal === 'number' ? signal : null,
        recency: row.recency ?? null,
        ...(decision ? { why, unconfirmedDays: unconfirmedDaysSince([row.last_accessed_at, snippet?.lastAddedAt, row.recency, row.created_at], now) } : {}),
    };
}
export function readIndexCandidates(db, projectName) {
    const cols = entityColumns(db);
    const excluded = INDEX_EXCLUDED_TYPES.map(() => '?').join(',');
    const decisionTypes = [...DECISION_TYPES];
    const decisionOnly = `e.type IN (${decisionTypes.map(() => '?').join(',')})`;
    const rows = db.prepare(`SELECT e.id, e.name, e.type, ${titleCol(cols)}, e.metadata,
       ${cols.scoring.has('last_accessed_at') ? 'e.last_accessed_at' : 'NULL AS last_accessed_at'},
       (SELECT o.content FROM observations o
         WHERE o.entity_id = e.id ORDER BY o.id ASC LIMIT 1) AS snippet,
       max(e.created_at, COALESCE((SELECT MAX(o2.created_at) FROM observations o2
         WHERE o2.entity_id = e.id), e.created_at)) AS last_activity,
       CASE WHEN ${decisionOnly} THEN
         (SELECT o3.content FROM observations o3
           WHERE o3.entity_id = e.id AND substr(o3.content, 1, ${WHY_PREFIX.length}) = '${WHY_PREFIX}'
           ORDER BY o3.id DESC LIMIT 1) END AS why_content,
       CASE WHEN ${decisionOnly} THEN ${RECENCY_SQL} END AS recency
     FROM entities e
     WHERE e.id IN (SELECT entity_id FROM tags WHERE tag = ?)${active(cols)}${nonGlobal(cols)}
       AND e.type NOT IN (${excluded})
     ORDER BY last_activity DESC, e.id DESC
     LIMIT ?`).all(...decisionTypes, ...decisionTypes, `project:${projectName}`, ...INDEX_EXCLUDED_TYPES, INDEX_CANDIDATE_CAP);
    const candidates = rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        title: row.title,
        snippet: row.snippet == null ? null : redactMemoryText(row.snippet).slice(0, INDEX_SNIPPET_FETCH_CHARS),
        lastActivity: row.last_activity,
        ...(row.type !== null && DECISION_TYPES.has(row.type) ? {
            why: row.why_content == null ? null : redactMemoryText(row.why_content.slice(WHY_PREFIX.length)).slice(0, INDEX_SNIPPET_FETCH_CHARS),
            recency: row.recency,
            lastAccessedAt: row.last_accessed_at,
        } : {}),
        metadata: row.metadata,
    }));
    return { candidates, truncated: rows.length >= INDEX_CANDIDATE_CAP };
}
//# sourceMappingURL=briefing-pools.js.map