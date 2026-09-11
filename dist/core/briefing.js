import { getDatabase } from '../db.js';
import { getProjectName } from './paths.js';
import { readRepoState, repoStateLines } from './repo-state.js';
import { rankEntities } from './scoring.js';
import { getTaskState, TaskStateUnreadableError } from './task-state-store.js';
import { recipientEverSeen, unreadDeliveryCount, unreadInboxLines } from './agent-message-inbox.js';
import { canonicalAgentScopeId } from './agent-scope-id.js';
import { taskStateLines } from './task-state.js';
import { INDEX_CANDIDATE_CAP, INDEX_EXCLUDED_TYPES, INDEX_SNIPPET_FETCH_CHARS, buildBriefingIndex, } from './briefing-index.js';
import { GLOBAL_TOPOLOGY_LIMIT, SNIPPET_FETCH_CHARS, TOPOLOGY_CANDIDATE_CAP, assembleTopologyBlock, buildReferenceContext, isAutoInjectable, } from './work-topology.js';
const PROJECT_LIMIT = 30;
const RECENT_LIMIT = 5;
const CANDIDATE_COLUMNS = 'e.id, e.name, e.type, e.title, e.metadata, e.access_count, e.last_accessed_at, e.confidence, e.recall_hits, e.recall_misses';
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
function selectPool(rows, cap) {
    const withMeta = rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        title: row.title,
        meta: parseMetadata(row.metadata),
        access_count: row.access_count ?? undefined,
        last_accessed_at: row.last_accessed_at ?? undefined,
        confidence: row.confidence ?? undefined,
        recall_hits: row.recall_hits ?? undefined,
        recall_misses: row.recall_misses ?? undefined,
    }));
    return rankEntities(withMeta, new Map())
        .filter((row) => isAutoInjectable(row.meta))
        .slice(0, cap);
}
function toTopologyEntity(row, snippet) {
    const signal = row.meta?.signal_score;
    return {
        name: row.name,
        type: row.type || 'memory',
        id: row.id,
        title: row.title,
        snippet,
        signalScore: typeof signal === 'number' ? signal : null,
    };
}
export function readBriefingIndex(db, projectName, now = Date.now()) {
    const hasNamespace = db.prepare('PRAGMA table_info(entities)').all()
        .some((column) => column.name === 'namespace');
    const nonGlobal = hasNamespace ? " AND (e.namespace IS NULL OR e.namespace <> 'global')" : '';
    const excluded = INDEX_EXCLUDED_TYPES.map(() => '?').join(',');
    const rows = db.prepare(`SELECT e.id, e.type, e.title, e.metadata,
       (SELECT substr(o.content, 1, ${INDEX_SNIPPET_FETCH_CHARS}) FROM observations o
         WHERE o.entity_id = e.id ORDER BY o.id ASC LIMIT 1) AS snippet,
       max(e.created_at, COALESCE((SELECT MAX(o2.created_at) FROM observations o2
         WHERE o2.entity_id = e.id), e.created_at)) AS last_activity
     FROM entities e
     WHERE e.id IN (SELECT entity_id FROM tags WHERE tag = ?)
       AND e.status = 'active'${nonGlobal}
       AND e.type NOT IN (${excluded})
     ORDER BY last_activity DESC, e.id DESC
     LIMIT ?`).all(`project:${projectName}`, ...INDEX_EXCLUDED_TYPES, INDEX_CANDIDATE_CAP);
    const candidates = rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        snippet: row.snippet,
        lastActivity: row.last_activity,
        metadata: parseMetadata(row.metadata),
    }));
    return buildBriefingIndex(candidates, projectName, now, { truncated: rows.length >= INDEX_CANDIDATE_CAP });
}
export function assembleBriefing(project, recipient) {
    const projectName = project ?? getProjectName();
    const db = getDatabase();
    const repoLines = (project === undefined || project === getProjectName())
        ? repoStateLines(readRepoState())
        : [];
    let taskLines;
    try {
        taskLines = taskStateLines(getTaskState(projectName).state, projectName);
    }
    catch (err) {
        if (!(err instanceof TaskStateUnreadableError))
            throw err;
        taskLines = [`task state for ${projectName}: ${err.message}`];
    }
    const inboxRecipient = recipient === undefined ? undefined : canonicalAgentScopeId(recipient);
    const unreadCount = unreadDeliveryCount(db, canonicalAgentScopeId(projectName), inboxRecipient);
    const everSeen = inboxRecipient !== undefined && unreadCount === 0
        ? recipientEverSeen(db, canonicalAgentScopeId(projectName), inboxRecipient)
        : undefined;
    const stateLines = [
        ...taskLines,
        ...unreadInboxLines(unreadCount, canonicalAgentScopeId(projectName), inboxRecipient, everSeen),
    ];
    const hasNamespace = db.prepare('PRAGMA table_info(entities)').all()
        .some((column) => column.name === 'namespace');
    const nonGlobal = hasNamespace ? " AND (e.namespace IS NULL OR e.namespace <> 'global')" : '';
    const projectRows = db.prepare(`SELECT DISTINCT ${CANDIDATE_COLUMNS}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status = 'active'${nonGlobal}
     ORDER BY e.id DESC
     LIMIT ?`).all(`project:${projectName}`, TOPOLOGY_CANDIDATE_CAP);
    const projectPool = selectPool(projectRows, PROJECT_LIMIT);
    const globalRows = hasNamespace
        ? db.prepare(`SELECT ${CANDIDATE_COLUMNS}
       FROM entities e
       WHERE e.namespace = 'global' AND e.status = 'active'
       ORDER BY e.id DESC
       LIMIT ?`).all(TOPOLOGY_CANDIDATE_CAP)
        : [];
    const globalPool = selectPool(globalRows, GLOBAL_TOPOLOGY_LIMIT);
    const recentRows = db.prepare(`SELECT ${CANDIDATE_COLUMNS}
     FROM entities e
     WHERE e.status = 'active'${nonGlobal}
     ORDER BY e.id DESC
     LIMIT ?`).all(TOPOLOGY_CANDIDATE_CAP);
    const recentPool = selectPool(recentRows, RECENT_LIMIT);
    const survivorIds = [...new Set([...projectPool, ...globalPool, ...recentPool].map((row) => row.id))];
    const snippets = new Map();
    if (survivorIds.length > 0) {
        const placeholders = survivorIds.map(() => '?').join(',');
        const obsRows = db.prepare(`SELECT entity_id, substr(content, 1, ${SNIPPET_FETCH_CHARS}) AS content
       FROM observations WHERE entity_id IN (${placeholders})
       ORDER BY id ASC`).all(...survivorIds);
        for (const row of obsRows) {
            if (snippets.has(row.entity_id))
                continue;
            const text = String(row.content ?? '').trim();
            if (text)
                snippets.set(row.entity_id, text);
        }
    }
    const toEntities = (pool) => pool.map((row) => toTopologyEntity(row, snippets.get(row.id) ?? null));
    const lines = assembleTopologyBlock(stateLines, [
        { entities: toEntities(projectPool), foreign: false },
        { entities: toEntities(globalPool), foreign: false, global: true },
        { entities: toEntities(recentPool), foreign: true },
    ], projectName);
    const withRepo = lines.length > 0 && repoLines.length > 0
        ? [...repoLines, '', ...lines]
        : lines;
    const index = readBriefingIndex(db, projectName);
    const block = withRepo.length > 0 ? [...withRepo, '', ...index.lines] : index.lines;
    return {
        project: projectName,
        text: buildReferenceContext(block),
        entityCount: lines.filter((l) => l.startsWith('- [')).length,
        hasTaskState: stateLines.length > 0,
        index,
    };
}
//# sourceMappingURL=briefing.js.map