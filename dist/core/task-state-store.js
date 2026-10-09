import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { getProjectName, redactSecretList } from './paths.js';
import { remember } from './operations.js';
import { truncateTitle } from './title.js';
import { TASK_STATE_TYPE, TASK_STATE_FIELDS, taskStateName, taskStateUnreadableMessage, parseTaskState, mergeTaskState, } from './task-state.js';
function readState(name) {
    const row = getDatabase()
        .prepare("SELECT metadata FROM entities WHERE name = ? AND status = 'active'")
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
        super(taskStateUnreadableMessage(project));
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
    const textFields = Object.entries(input.patch).filter(([, value]) => typeof value === 'string');
    const texts = redactSecretList(textFields.map(([, value]) => value));
    const patch = { ...input.patch, ...Object.fromEntries(textFields.map(([field], i) => [field, texts[i]])) };
    const db = getDatabase();
    const write = db.transaction(() => {
        const { state: previous, corrupted } = readState(name);
        const { state, changed, observations } = mergeTaskState(previous, patch, new Date().toISOString());
        if (changed.length === 0) {
            if (corrupted)
                throw new TaskStateUnreadableError(project);
            return { project, state: redactedState(state), changed };
        }
        const title = truncateTitle(state.goal ?? state.next ?? state.blocked ?? state.done ?? `Task state for ${project}`);
        remember({
            name,
            type: TASK_STATE_TYPE,
            observations,
            tags: [`project:${project}`],
            title,
            sourceHost: input.sourceHost,
        });
        new KnowledgeGraph(db).updateEntityMetadata(name, (current) => ({
            ...current,
            task_state: state,
        }));
        return { project, state: redactedState(state), changed };
    });
    try {
        return write.immediate();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/readonly database|SQLITE_READONLY/i.test(message))
            throw error;
        return db.transaction(() => {
            const { state: previous, corrupted } = readState(name);
            const { state, changed } = mergeTaskState(previous, patch, new Date().toISOString());
            if (changed.length !== 0)
                throw error;
            if (corrupted)
                throw new TaskStateUnreadableError(project);
            return { project, state: redactedState(state), changed };
        })();
    }
}
//# sourceMappingURL=task-state-store.js.map