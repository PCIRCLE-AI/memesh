import { getDatabase } from '../db.js';
import { getProjectName } from './paths.js';
import { readConfig } from './config.js';
import { readRepoState, repoStateLines } from './repo-state.js';
import { getTaskState, TaskStateUnreadableError } from './task-state-store.js';
import { recipientEverSeen, unreadDeliveryCount, unreadInboxLines } from './agent-message-inbox.js';
import { hostSessionFromEnv } from './host-session.js';
import { canonicalAgentScopeId } from './agent-scope-id.js';
import { briefingTaskStateLines } from './task-state.js';
import { handoffLines } from './session-handoff.js';
import { buildBriefingIndex, injectedIndexReserve, } from './briefing-index.js';
import { DEFAULT_TOPOLOGY_BUDGET, assembleTopologyBlock, boundTaskStateLines, buildReferenceContext, hasBriefingContent, joinedLength, jsonStringLiteral, projectLabel, } from './work-topology.js';
import { readIndexCandidates, readSnippets, selectBriefingPools, toTopologyEntity } from './briefing-pools.js';
import { briefingLevelPolicy, resolveBriefingLevel, } from './briefing-level.js';
const PROJECT_LIMIT = 30;
export function readBriefingIndex(db, projectName, now = Date.now()) {
    const { candidates, truncated } = readIndexCandidates(db, projectName);
    return buildBriefingIndex(candidates, projectName, now, { truncated });
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
        taskLines = [`task state for ${jsonStringLiteral(projectLabel(projectName))}: ${err.message}`];
    }
    const inboxRecipient = recipient === undefined ? undefined : canonicalAgentScopeId(recipient);
    const unreadCount = unreadDeliveryCount(db, canonicalAgentScopeId(projectName), inboxRecipient, hostSessionFromEnv());
    const everSeen = inboxRecipient !== undefined && unreadCount === 0
        ? recipientEverSeen(db, canonicalAgentScopeId(projectName), inboxRecipient)
        : undefined;
    const pools = selectBriefingPools(db, projectName, {
        projectLimit: PROJECT_LIMIT,
        global: policy.global,
        foreign: policy.foreign,
    });
    const handoff = pools.handoff ? handoffLines(pools.handoff) : [];
    const stateLines = [
        ...handoff,
        ...taskLines,
        ...unreadInboxLines(unreadCount, canonicalAgentScopeId(projectName), inboxRecipient, everSeen),
    ];
    const snippets = readSnippets(db, [...pools.lessons, ...pools.project, ...pools.noProject, ...pools.global, ...pools.recent].map((row) => row.id));
    const toEntities = (pool) => pool.map((row) => toTopologyEntity(row, snippets));
    const indexReserve = policy.index ? injectedIndexReserve(projectName) + 2 : 0;
    const lines = assembleTopologyBlock(stateLines, [
        { entities: toEntities(pools.lessons), foreign: false },
        { entities: toEntities(pools.project), foreign: false },
        { entities: toEntities(pools.noProject), foreign: false, noProject: true },
        { entities: toEntities(pools.global), foreign: false, global: true },
        { entities: toEntities(pools.recent), foreign: true },
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