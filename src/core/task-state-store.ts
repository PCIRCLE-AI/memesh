// =============================================================================
// task-state store — reading and writing the one "where we are" per project
// =============================================================================
//
// The pure half (field rules, name convention, rendering) lives in
// `task-state.ts`, which is a runtime leaf so the hooks can copy it. This file
// is the half that needs a database.
//
// It deliberately writes THROUGH `remember()` rather than touching the tables
// itself. That is not indirection for its own sake: `remember()` is where
// FTS indexing, project tagging and signal scoring happen, and a second write
// path that skipped them is exactly how this
// repository shipped the P0 where session memories were unrecallable.

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { getProjectName, redactSecretList } from './paths.js';
import { remember } from './operations.js';
import { truncateTitle } from './title.js';
import {
  TASK_STATE_TYPE,
  TASK_STATE_FIELDS,
  taskStateName,
  taskStateUnreadableMessage,
  parseTaskState,
  mergeTaskState,
  type TaskState,
  type TaskStateField,
} from './task-state.js';

export interface SetTaskStateInput {
  /** Defaults to the current working directory's project. */
  project?: string;
  patch: Partial<Record<TaskStateField, string>>;
  sourceHost?: string;
}

export interface SetTaskStateResult {
  project: string;
  state: TaskState;
  /** Fields that actually changed. Empty means nothing was written. */
  changed: TaskStateField[];
}

/**
 * What is on disk for a project: the parsed state, or `corrupted` when the
 * stored metadata is not JSON. Tri-state on purpose — "{}" and "unreadable"
 * are different facts and each caller decides what to do with the second.
 */
function readState(name: string): { state: TaskState; corrupted: boolean } {
  const row = getDatabase()
    .prepare("SELECT metadata FROM entities WHERE name = ? AND status = 'active'")
    .get(name) as { metadata: string | null } | undefined;
  if (!row?.metadata) return { state: {}, corrupted: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return { state: {}, corrupted: true };
  }
  // A well-formed value of the wrong SHAPE is parseTaskState's call: it keeps
  // the fields it can use and drops the rest.
  return { state: parseTaskState(parsed), corrupted: false };
}

/** Thrown when unreadable metadata cannot be read or verified as a no-op. */
export class TaskStateUnreadableError extends Error {
  constructor(public readonly project: string) {
    super(taskStateUnreadableMessage(project));
    this.name = 'TaskStateUnreadableError';
  }
}

/** The state currently recorded for a project. Empty object when there is none. */
export function getTaskState(project?: string): { project: string; state: TaskState } {
  const resolved = project ?? getProjectName();
  const { state, corrupted } = readState(taskStateName(resolved));
  // Corrupted JSON is a failure the reader must see. Returning {} here
  // rendered it as "nothing stated" on every surface — indistinguishable
  // from a project nobody has described.
  if (corrupted) throw new TaskStateUnreadableError(resolved);
  return { project: resolved, state: redactedState(state) };
}

/**
 * #523: the state as it is handed to a caller. The read surfaces (MCP
 * `task_state` with no fields, `GET /v1/task-state`, `memesh task --json`)
 * and the write's own answer (MCP `task_state` with fields, `memesh task
 * --goal … --json`) show a state stored before the write-time redaction, so
 * it is redacted here. The write path reads the stored record through
 * `readState` directly, so a restatement still compares against — and
 * overwrites — the raw row.
 */
function redactedState(state: TaskState): TaskState {
  const shown: TaskState = { ...state };
  // The fields are one set: a key split across them is masked as a whole.
  const fields = TASK_STATE_FIELDS.filter((field) => typeof shown[field] === 'string');
  const texts = redactSecretList(fields.map((field) => shown[field] as string));
  fields.forEach((field, i) => { shown[field] = texts[i]; });
  return shown;
}

/**
 * Record where the work stands.
 *
 * Writes only what changed. A caller re-stating the same goal every session
 * produces no row and no new observation — that is what keeps this entity from
 * becoming the fastest-growing row in the database, and what keeps its
 * `updated_at` an honest answer to "how old is this thinking".
 */
export function setTaskState(input: SetTaskStateInput): SetTaskStateResult {
  const project = input.project ?? getProjectName();
  const name = taskStateName(project);
  // #523: redacted at the ONE entry point, so the title, the observations
  // (via `remember`, which redacts again — harmless) and `metadata.task_state`
  // below all hold the same redacted text. The metadata copy is what the
  // briefing and the SessionStart hook inject, and it did not pass through
  // `remember`'s redaction.
  // The patch's text fields are one set: a key split across them is masked as a whole.
  const textFields = Object.entries(input.patch).filter(([, value]) => typeof value === 'string');
  const texts = redactSecretList(textFields.map(([, value]) => value as string));
  const patch = { ...input.patch, ...Object.fromEntries(textFields.map(([field], i) => [field, texts[i]])) } as SetTaskStateInput['patch'];
  const db = getDatabase();
  // Read and merge under the write lock so a peer's committed fields cannot
  // be replaced by a snapshot taken before this transaction began.
  // Observations and metadata roll back together if the final write fails.
  const write = db.transaction(() => {
    // A corrupted record still merges as "nothing stated before": a changed
    // write is the existing in-product recovery path.
    const { state: previous, corrupted } = readState(name);
    const { state, changed, observations } = mergeTaskState(
      previous,
      patch,
      new Date().toISOString(),
    );
    if (changed.length === 0) {
      if (corrupted) throw new TaskStateUnreadableError(project);
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

    // Metadata is the state's home; the observations above are its history.
    // Written after `remember()` because `updateEntityMetadata` is a no-op on a
    // row that does not exist yet, and on a first call it does not.
    new KnowledgeGraph(db).updateEntityMetadata(name, (current) => ({
      ...current,
      task_state: state,
    }));
    return { project, state: redactedState(state), changed };
  });
  try {
    return write.immediate();
  } catch (error) {
    // A read-only connection can reject BEGIN IMMEDIATE even when the patch
    // changes nothing. Preserve that read-only operation, but never bypass
    // the write lock for a normal writer or disguise a rejected change.
    const message = error instanceof Error ? error.message : String(error);
    if (!/readonly database|SQLITE_READONLY/i.test(message)) throw error;
    return db.transaction(() => {
      const { state: previous, corrupted } = readState(name);
      const { state, changed } = mergeTaskState(previous, patch, new Date().toISOString());
      if (changed.length !== 0) throw error;
      if (corrupted) throw new TaskStateUnreadableError(project);
      return { project, state: redactedState(state), changed };
    })();
  }
}
