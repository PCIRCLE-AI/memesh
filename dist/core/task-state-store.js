import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { getProjectName, redactSecretList } from './paths.js';
import { remember } from './operations.js';
import { projectLabel } from './work-topology.js';
import { TASK_STATE_TYPE, TASK_STATE_FIELDS, taskStateName, parseTaskState, mergeTaskState, } from './task-state.js';
function readState(name) {
    const row = getDatabase()
        .prepare('SELECT metadata FROM entities WHERE name = ?')
        .get(name);
    if (!row?.metadata)
        return { state: {}, corrupted: false };
    let parsed;
    try {
        parsed = JSON.parse(row.metadata);
    }
    catch {
        return { state: {}, corrupted: true };
    }
    return { state: parseTaskState(parsed), corrupted: false };
}
export class TaskStateUnreadableError extends Error {
    project;
    constructor(project) {
        super(`task state for project "${projectLabel(project)}" is not readable: the stored record is not valid JSON. Re-state it with \`memesh task --goal …\` (any write replaces the broken record).`);
        this.project = project;
        this.name = 'TaskStateUnreadableError';
    }
}
export function getTaskState(project) {
    const resolved = project ?? getProjectName();
    const { state, corrupted } = readState(taskStateName(resolved));
    if (corrupted)
        throw new TaskStateUnreadableError(resolved);
    return { project: resolved, state: redactedState(state) };
}
function redactedState(state) {
    const shown = { ...state };
    const fields = TASK_STATE_FIELDS.filter((field) => typeof shown[field] === 'string');
    const texts = redactSecretList(fields.map((field) => shown[field]));
    fields.forEach((field, i) => { shown[field] = texts[i]; });
    return shown;
}
export function setTaskState(input) {
    const project = input.project ?? getProjectName();
    const name = taskStateName(project);
    const { state: previous } = readState(name);
    const textFields = Object.entries(input.patch).filter(([, value]) => typeof value === 'string');
    const texts = redactSecretList(textFields.map(([, value]) => value));
    const patch = { ...input.patch, ...Object.fromEntries(textFields.map(([field], i) => [field, texts[i]])) };
    const { state, changed, observations } = mergeTaskState(previous, patch, new Date().toISOString());
    if (changed.length === 0)
        return { project, state: redactedState(state), changed };
    const title = state.goal ?? state.next ?? state.blocked ?? state.done ?? `Task state for ${project}`;
    remember({
        name,
        type: TASK_STATE_TYPE,
        observations,
        tags: [`project:${project}`],
        title,
        sourceHost: input.sourceHost,
    });
    new KnowledgeGraph(getDatabase()).updateEntityMetadata(name, (current) => ({
        ...current,
        task_state: state,
    }));
    return { project, state: redactedState(state), changed };
}
//# sourceMappingURL=task-state-store.js.map