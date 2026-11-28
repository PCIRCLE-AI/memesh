import { getDatabase } from '../db.js';
import { getProjectIds, getProjectName } from './paths.js';
import { readConfig } from './config.js';
import { continuationLines, continuationTaskKey } from './continuation.js';
import { resolveSessionLimit } from './session-limit.js';
import { readRepoState, repoStateLines } from './repo-state.js';
import { getTaskState, TaskStateUnreadableError } from './task-state-store.js';
import { taskStateLines } from './task-state.js';
import { handoffLines } from './session-handoff.js';
import { buildBriefingIndex } from './briefing-index.js';
import { buildRecentIndex } from './recent-index.js';
import { DEFAULT_TOPOLOGY_BUDGET, assembleTopologyBlock, buildOpeningContext, MAX_OPENING_CONTEXT_BYTES, jsonStringLiteral, projectLabel, } from './work-topology.js';
import { readIndexCandidates, readSnippets, selectBriefingPools, toTopologyEntity } from './briefing-pools.js';
import { briefingLevelPolicy, resolveBriefingLevel, } from './briefing-level.js';
function projectIdsFor(projectName) {
    return projectName === getProjectName() ? getProjectIds() : [projectName];
}
export function readBriefingIndex(db, projectName, now = Date.now(), projectIds) {
    const { candidates, truncated } = readIndexCandidates(db, projectName, projectIds ?? projectIdsFor(projectName));
    return buildBriefingIndex(candidates, projectName, now, { truncated });
}
export function assembleBriefing(project, _recipient, projectIds, continuationScope) {
    const projectName = project ?? getProjectName();
    const ids = projectIds ?? projectIdsFor(projectName);
    const db = getDatabase();
    const config = readConfig();
    const resolvedLevel = resolveBriefingLevel(process.env.MEMESH_BRIEFING, config.briefing);
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
    let taskKey;
    try {
        const task = getTaskState(projectName, ids).state;
        taskLines = taskStateLines(task, projectName);
        taskKey = continuationTaskKey(task);
    }
    catch (err) {
        if (!(err instanceof TaskStateUnreadableError))
            throw err;
        taskLines = [`task state for ${jsonStringLiteral(projectLabel(projectName))}: ${err.message}`];
    }
    const pools = selectBriefingPools(db, projectName, {
        projectIds: ids,
        projectLimit: resolveSessionLimit(process.env.MEMESH_SESSION_LIMIT, config.sessionLimit).value,
        global: policy.global,
        foreign: policy.foreign,
    });
    const handoff = pools.handoffs.flatMap((row) => handoffLines(row));
    const snippets = readSnippets(db, [...pools.lessons, ...pools.project, ...pools.noProject, ...pools.shared, ...pools.global, ...pools.recent].map((row) => row.id));
    const toEntities = (pool) => pool.map((row) => toTopologyEntity(row, snippets));
    const lines = assembleTopologyBlock([], [
        { entities: toEntities(pools.lessons), foreign: false },
        { entities: toEntities(pools.project), foreign: false },
        { entities: toEntities(pools.noProject), foreign: false, noProject: true },
        { entities: toEntities(pools.shared), foreign: false, shared: true },
        { entities: toEntities(pools.global), foreign: false, global: true },
        { entities: toEntities(pools.recent), foreign: true },
    ], projectName, { ...DEFAULT_TOPOLOGY_BUDGET, maxChars: MAX_OPENING_CONTEXT_BYTES });
    const withRepo = (lines.length > 0 || taskLines.length > 0 || handoff.length > 0) && repoLines.length > 0
        ? [...repoLines, '', ...lines]
        : lines;
    const now = Date.now();
    const { candidates: indexCandidates, truncated } = readIndexCandidates(db, projectName, ids);
    const index = buildBriefingIndex(indexCandidates, projectName, now, { truncated });
    const indexLines = buildRecentIndex(db, projectName, now, ids).lines;
    const block = withRepo.length > 0 && indexLines.length > 0
        ? [...withRepo, '', ...indexLines]
        : [...withRepo, ...indexLines];
    const continuationCwd = continuationScope ? continuationScope.workspace : process.cwd();
    const session = continuationScope ? continuationScope.session : process.env.CODEX_THREAD_ID;
    const continuation = continuationCwd && getProjectName(continuationCwd) === projectName
        ? continuationLines(projectName, continuationCwd, session, taskKey) : [];
    const opening = buildOpeningContext([...taskLines, ...continuation], handoff, block);
    const empty = opening.text === '';
    const renderedRankedEnd = Math.max(0, opening.remainingLines.length - (withRepo.length - lines.length));
    return {
        project: projectName,
        text: opening.text,
        entityCount: lines.slice(0, renderedRankedEnd).filter((l) => l.startsWith('- [')).length,
        hasTaskState: taskLines.length > 0,
        hasHandoff: opening.tailLines.length > 0,
        index,
        level,
        empty,
    };
}
//# sourceMappingURL=briefing.js.map