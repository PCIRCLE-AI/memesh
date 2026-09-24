import { getDatabase } from '../db.js';
import { getProjectName } from './paths.js';
import { readConfig } from './config.js';
import { readRepoState, repoStateLines } from './repo-state.js';
import { rankEntities } from './scoring.js';
import { getTaskState, TaskStateUnreadableError } from './task-state-store.js';
import { recipientEverSeen, unreadDeliveryCount, unreadInboxLines } from './agent-message-inbox.js';
import { canonicalAgentScopeId } from './agent-scope-id.js';
import { briefingTaskStateLines } from './task-state.js';
import { handoffLines, SESSION_HANDOFF_TYPE, sessionHandoffName } from './session-handoff.js';
import { INDEX_CANDIDATE_CAP, INDEX_EXCLUDED_TYPES, INDEX_SNIPPET_FETCH_CHARS, buildBriefingIndex, injectedIndexReserve, } from './briefing-index.js';
import { DECISION_LAYER_TYPES, DEFAULT_TOPOLOGY_BUDGET, GLOBAL_TOPOLOGY_LIMIT, SNIPPET_FETCH_CHARS, TOPOLOGY_CANDIDATE_CAP, assembleTopologyBlock, boundTaskStateLines, buildReferenceContext, hasBriefingContent, isAutoInjectable, joinedLength, prioritizeDecisions, projectLabel, } from './work-topology.js';
import { briefingLevelPolicy, resolveBriefingLevel, } from './briefing-level.js';
const PROJECT_LIMIT = 30;
const RECENT_LIMIT = 5;
const LESSON_LIMIT = 5;
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
const RECENCY_SQL = `COALESCE(
  (SELECT MAX(replace(o.created_at, 'T', ' ')) FROM observations o
    WHERE o.entity_id = e.id
      AND replace(o.created_at, 'T', ' ') = strftime('%Y-%m-%d %H:%M:%S', o.created_at)
      AND replace(o.created_at, 'T', ' ') <= strftime('%Y-%m-%d %H:%M:%S', 'now', '+5 minutes')),
  CASE WHEN replace(e.created_at, 'T', ' ') = strftime('%Y-%m-%d %H:%M:%S', e.created_at)
        AND replace(e.created_at, 'T', ' ') <= strftime('%Y-%m-%d %H:%M:%S', 'now', '+5 minutes')
       THEN replace(e.created_at, 'T', ' ') END)`;
function toPoolRow(row) {
    const meta = parseMetadata(row.metadata);
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        title: row.title,
        meta,
        autoInjectable: (row.metadata == null || meta !== null) && isAutoInjectable(meta),
        access_count: row.access_count ?? undefined,
        last_accessed_at: row.last_accessed_at ?? undefined,
        confidence: row.confidence ?? undefined,
        recall_hits: row.recall_hits ?? undefined,
        recall_misses: row.recall_misses ?? undefined,
        recency: row.recency ?? null,
    };
}
function selectPool(rows, cap) {
    const withMeta = rows.map(toPoolRow);
    return rankEntities(withMeta, new Map())
        .filter((row) => row.autoInjectable)
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
        recency: row.recency ?? null,
    };
}
export function readBriefingIndex(db, projectName, now = Date.now()) {
    const { candidates, truncated } = readIndexCandidates(db, projectName);
    return buildBriefingIndex(candidates, projectName, now, { truncated });
}
function readIndexCandidates(db, projectName) {
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
        metadata: row.metadata,
    }));
    return { candidates, truncated: rows.length >= INDEX_CANDIDATE_CAP };
}
export function assembleBriefing(project, recipient) {
    const projectName = project ?? getProjectName();
    const db = getDatabase();
    const resolvedLevel = resolveBriefingLevel(process.env.MEMESH_BRIEFING, readConfig().briefing);
    if (resolvedLevel.invalid) {
        const { source, value } = resolvedLevel.invalid;
        try {
            process.stderr.write(`[memesh briefing] invalid ${source} briefing level ${value} — using "${resolvedLevel.level}"\n`);
        }
        catch { }
    }
    const level = resolvedLevel.level;
    const policy = briefingLevelPolicy(level);
    const repoLines = (project === undefined || project === getProjectName())
        ? repoStateLines(readRepoState())
        : [];
    let taskLines;
    try {
        taskLines = boundTaskStateLines(briefingTaskStateLines(getTaskState(projectName).state, projectName, new Date(), {
            includeFresh: policy.taskState,
        }));
    }
    catch (err) {
        if (!(err instanceof TaskStateUnreadableError))
            throw err;
        taskLines = [`task state for ${projectLabel(projectName)}: ${err.message}`];
    }
    const inboxRecipient = recipient === undefined ? undefined : canonicalAgentScopeId(recipient);
    const unreadCount = unreadDeliveryCount(db, canonicalAgentScopeId(projectName), inboxRecipient);
    const everSeen = inboxRecipient !== undefined && unreadCount === 0
        ? recipientEverSeen(db, canonicalAgentScopeId(projectName), inboxRecipient)
        : undefined;
    const handoffRow = db.prepare(`SELECT e.id, e.metadata, o.content AS text, o.created_at AS observedAt
     FROM entities e JOIN observations o ON o.entity_id = e.id
     WHERE e.name = ? AND e.type = ? AND e.status = 'active'
     ORDER BY o.id DESC
     LIMIT 1`).get(sessionHandoffName(projectName), SESSION_HANDOFF_TYPE);
    const handoffMeta = handoffRow ? parseMetadata(handoffRow.metadata) : null;
    const handoffTrusted = !!handoffRow && (handoffRow.metadata === null || handoffMeta !== null) && isAutoInjectable(handoffMeta);
    const handoff = handoffTrusted ? handoffLines(handoffRow) : [];
    const stateLines = [
        ...handoff,
        ...taskLines,
        ...unreadInboxLines(unreadCount, canonicalAgentScopeId(projectName), inboxRecipient, everSeen),
    ];
    const hasNamespace = db.prepare('PRAGMA table_info(entities)').all()
        .some((column) => column.name === 'namespace');
    const nonGlobal = hasNamespace ? " AND (e.namespace IS NULL OR e.namespace <> 'global')" : '';
    const projectRows = db.prepare(`SELECT DISTINCT ${CANDIDATE_COLUMNS}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status = 'active' AND e.type <> ?${nonGlobal}
     ORDER BY e.id DESC
     LIMIT ?`).all(`project:${projectName}`, SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP);
    const decisionRows = db.prepare(`SELECT DISTINCT ${CANDIDATE_COLUMNS}, ${RECENCY_SQL} AS recency
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status = 'active' AND e.type IN (${DECISION_LAYER_TYPES.map(() => '?').join(',')})${nonGlobal}
     ORDER BY recency IS NULL, recency DESC, e.id DESC
     LIMIT ?`).all(`project:${projectName}`, ...DECISION_LAYER_TYPES, TOPOLOGY_CANDIDATE_CAP);
    const decisionPool = decisionRows.map(toPoolRow).filter((row) => row.autoInjectable);
    const projectPool = prioritizeDecisions(decisionPool, selectPool(projectRows, TOPOLOGY_CANDIDATE_CAP), PROJECT_LIMIT);
    const lessonPool = db.prepare(`SELECT DISTINCT ${CANDIDATE_COLUMNS}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE e.type = 'lesson_learned' AND e.status = 'active'${nonGlobal} AND t.tag = ?
     ORDER BY e.id DESC
     LIMIT 50`).all(`project:${projectName}`)
        .map(toPoolRow).filter((row) => row.autoInjectable).slice(0, LESSON_LIMIT);
    const globalRows = policy.global && hasNamespace
        ? db.prepare(`SELECT ${CANDIDATE_COLUMNS}
       FROM entities e
       WHERE e.namespace = 'global' AND e.status = 'active'
       ORDER BY e.id DESC
       LIMIT ?`).all(TOPOLOGY_CANDIDATE_CAP)
        : [];
    const globalPool = selectPool(globalRows, GLOBAL_TOPOLOGY_LIMIT);
    const recentRows = policy.foreign
        ? db.prepare(`SELECT ${CANDIDATE_COLUMNS}
       FROM entities e
       WHERE e.status = 'active' AND e.type <> ?${nonGlobal}
       ORDER BY e.id DESC
       LIMIT ?`).all(SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP)
        : [];
    const recentPool = selectPool(recentRows, RECENT_LIMIT);
    const survivorIds = [...new Set([...lessonPool, ...projectPool, ...globalPool, ...recentPool].map((row) => row.id))];
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
    const indexReserve = policy.index ? injectedIndexReserve(projectName) + 2 : 0;
    const lines = assembleTopologyBlock(stateLines, [
        { entities: toEntities(lessonPool), foreign: false },
        { entities: toEntities(projectPool), foreign: false },
        { entities: toEntities(globalPool), foreign: false, global: true },
        { entities: toEntities(recentPool), foreign: true },
    ], projectName, DEFAULT_TOPOLOGY_BUDGET, { reserve: indexReserve });
    const withRepo = lines.length > 0 && repoLines.length > 0
        ? [...repoLines, '', ...lines]
        : lines;
    const now = Date.now();
    const { candidates: indexCandidates, truncated } = readIndexCandidates(db, projectName);
    const index = buildBriefingIndex(indexCandidates, projectName, now, { truncated });
    const used = lines.length === 0 ? 0 : joinedLength(lines) + 2;
    const indexLines = policy.index
        ? buildBriefingIndex(indexCandidates, projectName, now, { truncated, maxChars: DEFAULT_TOPOLOGY_BUDGET.maxChars - used }).lines
        : [];
    const block = withRepo.length > 0 && indexLines.length > 0
        ? [...withRepo, '', ...indexLines]
        : [...withRepo, ...indexLines];
    const empty = !hasBriefingContent(block);
    return {
        project: projectName,
        text: empty ? '' : buildReferenceContext(block),
        entityCount: lines.slice(stateLines.length).filter((l) => l.startsWith('- [')).length,
        hasTaskState: taskLines.length > 0,
        hasHandoff: handoff.length > 0,
        index,
        level,
        empty,
    };
}
//# sourceMappingURL=briefing.js.map