import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { remember, recallForAgent, forget, exportMemories, importMemories, learn } from '../../core/operations.js';
import { agentRecallEnvelope } from '../../core/recall-agent-view.js';
import { getDatabase } from '../../db.js';
import { executeWorkPackage } from '../../core/dreamer.js';
import { computePatterns } from '../../core/patterns.js';
import { assembleBriefing } from '../../core/briefing.js';
import { getTaskState, setTaskState } from '../../core/task-state-store.js';
import { getProductImprovementStatus, stageProductImprovement, } from '../../core/product-improvements.js';
import { executeAgentMessageAction } from '../agent-messaging.js';
import { hostSessionFromEnv } from '../../core/host-session.js';
import { McpRememberSchema, McpRecallSchema, ForgetSchema, BriefingSchema, ExportSchema, ImportSchema, McpLearnSchema, TaskStateSchema, UserPatternsSchema, ImprovementSchema, MessageSchema, WorkPackageSchema, } from '../schemas.js';
import { AGENT_MESSAGE_JSON_MAX_BYTES, AGENT_NATIVE_MESSAGE_MAX_BYTES } from '../../core/agent-messaging.js';
import { getProjectName, memeshDir } from '../../core/paths.js';
import { updateNoticeForEntryPoint, updateCheckEnabledIn } from '../../core/update-entrypoint.js';
import { staleRunningProcessNotice } from '../../core/update-notice.js';
const UNBOUND = { error: 'workspace_unavailable', reason: 'No project is bound to this MCP session.', unbound: true };
const BIND_WORKSPACE = 'Start the MCP server with MEMESH_PROJECT_ROOT set to the project directory, or from a client that reports one workspace root.';
function projectFor(explicit, context, action) {
    if (explicit !== undefined)
        return { project: explicit };
    const binding = context.projectBinding ?? UNBOUND;
    if ('project' in binding)
        return { project: binding.project };
    return { result: fail(`${binding.error}: ${binding.reason} ${action}`) };
}
const PROJECT_ACTION = `Pass project ("<id>", or a "project:<id>" tag), or project: false for a memory that belongs to no project (a preference, a general lesson), or bind the session: ${BIND_WORKSPACE}`;
function writeProject(arg, tags, context) {
    if (arg === false)
        return { project: null };
    if (arg !== undefined)
        return { project: arg };
    if ((tags ?? []).some((t) => t.startsWith('project:')))
        return { project: undefined };
    return projectFor(undefined, context, PROJECT_ACTION);
}
export function resolveTranscriptWorkspace(project, rootUris) {
    if (!rootUris)
        return { transcriptWorkspaceError: 'workspace_unavailable' };
    const matches = new Set();
    for (const uri of rootUris) {
        try {
            const parsed = new URL(uri);
            if (parsed.protocol !== 'file:')
                continue;
            const root = fs.realpathSync(fileURLToPath(parsed));
            if (!fs.statSync(root).isDirectory() || getProjectName(root) !== project)
                continue;
            matches.add(root);
        }
        catch {
        }
    }
    if (matches.size === 0)
        return { transcriptWorkspaceError: 'workspace_unavailable' };
    if (matches.size > 1)
        return { transcriptWorkspaceError: 'workspace_ambiguous' };
    return { transcriptWorkspace: [...matches][0] };
}
export const TOOL_DEFINITIONS = [
    {
        name: 'work_package',
        description: 'Prepare one digest from calendar clusters or one transcript work package from the newest bounded Claude Code transcript for the client\'s single matching MCP workspace root. Transcript mode fails closed without one unambiguous root. Submit one result to pending human review, or defer without durable changes. Transcript file paths are never exposed. No providers are called. Source text is untrusted. Only humans may apply or reject proposals. Package hashes identify source content and workspace scope; they are not authentication.',
        inputSchema: { type: 'object', ...z.toJSONSchema(WorkPackageSchema) },
    },
    {
        name: 'remember',
        description: 'Store knowledge as an entity with observations, tags, and relations. Use this to remember decisions, patterns, lessons learned, and important context. An omitted namespace keeps an existing memory in its current namespace; a "supersedes" relation archives its target, while "contradicts" marks a conflict. ' +
            'Quickest form: pass only `note` (free text) and the server derives title, observations and name; the response echoes what it derived. ' +
            'To correct a memory, call again with its `name` and `replace: true` — the memory keeps the `type` it has unless you pass a different one — and the old content moves to metadata.replaced_history instead of staying next to the fix.',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Unique entity name (e.g., "auth-decision", "jwt-pattern"). Reusing a name appends observations and dedupes tags instead of replacing the entity (unless `replace` is true). Required unless `note` is given, in which case it is derived from the text (same text → same name).',
                },
                type: {
                    type: 'string',
                    description: 'Entity type (e.g., "decision", "pattern", "lesson_learned"). Required unless `note` is given (it then defaults to "note"), or `replace: true` is sent with the `name` of a memory that exists — that call keeps the stored type. Passing one on a `replace` reclassifies the memory.',
                },
                note: {
                    type: 'string',
                    description: 'Free text, instead of title + observations: the first line becomes the title and each following paragraph an observation. Cannot be combined with `title` or `observations`. Control characters and credential-shaped strings are removed before storing.',
                },
                replace: {
                    type: 'boolean',
                    description: 'Rewrite the memory named by `name` instead of appending to it: its observations are replaced (and its tags when `tags` is given, its title when `title` or `note` is given). The previous version is kept in metadata.replaced_history with the time it was replaced. Default false (append).',
                },
                title: {
                    type: 'string',
                    description: 'Short human-readable label for this memory (e.g. "Use PKCE over implicit flow for auth"), distinct from name (which stays a stable machine key). Shown as the headline in the dashboard and in memory recalled by an agent, instead of the raw name. Reusing an existing name with a different title UPDATES the title; omit to leave an existing title untouched.',
                },
                observations: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Key facts or observations about this entity',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tags for filtering by subject (e.g. "topic:database"). A "project:<id>" tag is the same as passing `project` (<id> is the `project` field of the `briefing` result; CLI: `memesh briefing --json`); a plain repository name is a different project. At most one project.',
                },
                relations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            to: { type: 'string', description: 'Target entity name' },
                            type: {
                                type: 'string',
                                description: 'Relation type. Free-form label (e.g. "implements", "related-to"), except for two that change behaviour: ' +
                                    '"supersedes" archives the target entity — use it when this memory replaces an older one; ' +
                                    '"contradicts" flags both memories as a conflict every time either is recalled — use it when two memories cannot both be true. ' +
                                    'For causal links between decisions and outcomes, use "caused" or "influenced" (inert labels, but the shared vocabulary makes causal chains traversable): ' +
                                    'state causality explicitly when you KNOW it — MeMesh never infers it from timestamps or co-occurrence, so an unstated cause is an unrecorded one.',
                            },
                        },
                        required: ['to', 'type'],
                        additionalProperties: false,
                    },
                    description: 'Relations to other entities',
                },
                namespace: {
                    type: 'string',
                    enum: ['personal', 'team', 'global'],
                    description: 'Namespace for organizing the entity. Omit it to leave an existing memory where it is — supplying it MOVES a memory that already exists, and it drops out of every other scoped view. New memories default to "personal".',
                },
                project: {
                    anyOf: [{ type: 'string', minLength: 1 }, { const: false }],
                    description: 'The project this memory belongs to. Omit it to use a "project:<id>" tag if you gave one, else the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root). Pass false for a memory that belongs to no project — a preference, a general lesson, team knowledge; it needs no binding. With no project, no tag and no binding the call is refused with workspace_unavailable. A write may change only a memory of the same project (or, with false, one that has none).',
                },
            },
            additionalProperties: false,
            anyOf: [
                { required: ['note'] },
                { required: ['name', 'type'] },
                { required: ['name', 'replace'], properties: { replace: { const: true } } },
            ],
        },
    },
    {
        name: 'recall',
        description: 'Search and retrieve stored knowledge. Uses full-text search. Selectors: `project` (that project, memories with no project, and global ones; false = only memories with no project and global ones), `tag` (exactly that tag) or `cross_project` (every project; a `tag` given with it is ignored). `project` cannot be combined with `tag` or `cross_project`. With none, it uses the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root) the same way, or only memories with no project and global ones when nothing is bound; a launch or workspace root that is set but cannot be resolved is refused with the reason; the response says what it searched (`scope`) and each result carries its `projects` ([] for none). Call with no query to list recent memories. One- and two-term queries use OR matching; queries with three or more terms try strict all-term matching first and fall back to OR only when strict matching has no hits, with results ranked by relevance. Results are capped for size: each entity\'s observations+tags at 8 KB, the whole response at 32 KB; a capped entity carries `truncated` with the full shown/total counts, and the response carries `truncated`/`entities_omitted` when anything was cut. `file:*` tags are never included — they exist for pre-edit lookups, not for reading.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query. One- and two-term queries use OR matching; three or more terms use strict all-term matching first, then OR fallback if strict matching has no hits. Results are ranked by relevance (BM25); only the first 32 surviving terms are used, and words present in most of the corpus are ignored as noise. Leave empty to list recent.',
                },
                tag: {
                    type: 'string',
                    description: 'Filter by tag (e.g., "project:<id>", where <id> is the `project` field of the `briefing` result (CLI: `memesh briefing --json`))',
                },
                limit: {
                    type: 'number',
                    description: 'Max results (default: 20, max: 100)',
                },
                include_archived: {
                    type: 'boolean',
                    description: 'Include archived (forgotten) entities in results. Default: false.',
                },
                namespace: {
                    type: 'string',
                    enum: ['personal', 'team', 'global'],
                    description: 'Filter results by namespace. Omit to search all namespaces.',
                },
                cross_project: {
                    type: 'boolean',
                    description: 'Search every project; a `tag` given with it is ignored. Cannot be combined with `project`.',
                },
                project: {
                    anyOf: [{ type: 'string', minLength: 1 }, { const: false }],
                    description: 'Search this project plus memories with no project and global ones; false searches only memories with no project and global ones. Cannot be combined with `tag` or `cross_project`. Omit it to use the bound project.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'forget',
        description: 'Archive an entity (soft-delete) or remove a specific observation. Archived entities are hidden from recall but preserved in the database. To remove just one observation, pass the observation parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Entity name to archive or modify' },
                observation: {
                    type: 'string',
                    description: 'If provided, only this specific observation is removed (entity stays active). If omitted, the entire entity is archived.',
                },
            },
            required: ['name'],
            additionalProperties: false,
        },
    },
    {
        name: 'export',
        description: 'Export memories as portable JSON. The default limit of 1000 entities may return only a subset; check `truncated` and raise the limit before treating the result as a complete backup.',
        inputSchema: {
            type: 'object',
            properties: {
                tag: { type: 'string', description: 'Export only entities with this tag' },
                namespace: { type: 'string', enum: ['personal', 'team', 'global'], description: 'Export only from this namespace' },
                limit: { type: 'number', description: 'Max entities to export (default: 1000). The default is a SUBSET, not a backup — check `truncated` in the response, and for a full backup pass a limit above the graph size.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'import',
        description: 'Import memories from a JSON export snapshot. Supports skip, append, or overwrite strategies for existing entities; overwrite replaces their observations and tags, keeping the previous version in metadata.replaced_history. A local memory that was forgotten (archived) stays archived unless restore_archived is true; the result reports how many were left as they were in kept_archived.',
        inputSchema: {
            type: 'object',
            properties: {
                data: { type: 'object', description: 'Export JSON data (from the export tool)' },
                namespace: { type: 'string', enum: ['personal', 'team', 'global'], description: 'Override namespace for all imported entities' },
                merge_strategy: {
                    type: 'string',
                    enum: ['skip', 'overwrite', 'append'],
                    description: 'Required. How to handle an entity that already exists: skip = leave it untouched, append = add these observations to it, overwrite = REPLACE its observations and tags (the previous version is kept in metadata.replaced_history, up to the last 20)',
                },
                restore_archived: {
                    type: 'boolean',
                    description: 'Optional, default false. With append or overwrite, a local entity that is archived (forgotten) is left untouched and counted in kept_archived. Set true to bring it back to active and merge or overwrite it like any other; it requires merge_strategy append or overwrite (an error with skip). Only set it when the user asked for archived memories to return.',
                },
            },
            required: ['data', 'merge_strategy'],
            additionalProperties: false,
        },
    },
    {
        name: 'learn',
        description: 'Record a structured lesson from a mistake or discovery. Creates a lesson_learned entity with error, root cause, fix, and prevention. Use it when something went wrong and the cause and fix are known; for a choice between options, use `remember` with type decision. The lesson belongs to `project`, or to the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root); pass project false for a general lesson that belongs to no project. With no project and no binding the call is refused with workspace_unavailable. The project\'s lessons are shown at the start of later sessions.',
        inputSchema: {
            type: 'object',
            properties: {
                error: { type: 'string', description: 'What went wrong' },
                fix: { type: 'string', description: 'What fixed it' },
                root_cause: { type: 'string', description: 'Why it happened (optional)' },
                prevention: { type: 'string', description: 'How to prevent it next time (optional)' },
                severity: {
                    type: 'string',
                    enum: ['critical', 'major', 'minor'],
                    description: 'Severity level (default: minor)',
                },
                project: {
                    anyOf: [{ type: 'string', minLength: 1 }, { const: false }],
                    description: 'The project the lesson belongs to; false for a general lesson with no project. Omit it to use the bound project.',
                },
            },
            required: ['error', 'fix'],
            additionalProperties: false,
        },
    },
    {
        name: 'task_state',
        description: 'Read or update where the work stands on this project: the goal, what is next, what is blocked, what was just finished. Call with no arguments to read it. Fresh state is included in the next session\'s briefing when the `briefing` level is `standard` or `full` (not at the default, `minimal`); stale or unknown-age state becomes a one-line flag at every level. Record ONLY what the user actually stated — never infer a goal or a next step from files edited or commands run, and leave a field out if it was not said. Pass an empty string to clear a field (e.g. blocked: "" once a blocker is resolved).',
        inputSchema: {
            type: 'object',
            properties: {
                project: {
                    type: 'string',
                    description: 'Project name. Omit to use the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root); with no binding the call is refused with workspace_unavailable.',
                },
                goal: { type: 'string', description: 'What this work is FOR — the outcome being aimed at' },
                next: { type: 'string', description: 'The next concrete step' },
                blocked: { type: 'string', description: 'What is standing in the way, if anything' },
                done: { type: 'string', description: 'What was just finished' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'briefing',
        description: 'The work topology for a project, assembled and ready to use — assembled under the same rules as Claude Code’s session-start memory block (at `full`, the SessionStart hook additionally appends a work-package notice; that notice is a host-agent instruction, not memory, and is never part of this tool’s output). An eligible exact-project handoff precedes ranked memories at every level, after optional repository facts: fresh through 72 hours, marked stale through 14 days, omitted when older, undatable, or implausibly future-dated. Imported or archived handoffs are not auto-injected. Recent project decisions take priority over routine activity; up to five project lessons are selected separately. The handoff, displayed task state, ranked and global memories, and injected index share a 4000-character memory-block limit. How much else is assembled follows the `briefing` setting: `minimal` (the default) includes this project’s decisions and direction, lessons, known facts and recent activity, plus up to five memories that belong to no project, no fresh task state (a stale or unknown-age one still collapses to a one-line flag at every level) and no index, and may be empty; `standard` adds a fresh goal / next / blocked / done and closes with a capped index of durable memories; `full` additionally includes other projects and global memory. Whatever the level, the result’s `index` field carries the standalone index, which can show more than the index inside a crowded briefing. Call it at the start of a session only when the host has not already injected this block (the MeMesh SessionStart hook does under Claude Code, and under the Codex plugin once Codex runs its hooks; it runs again after context compaction), or when the user asks what is remembered; use recall for specific questions. Content is wrapped as untrusted background data.',
        inputSchema: {
            type: 'object',
            properties: {
                project: {
                    type: 'string',
                    description: 'Project name. Omit to use the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root); with no binding the call is refused with workspace_unavailable.',
                },
                recipient: {
                    type: 'string',
                    description: 'Exact logical recipient. Required to surface actionable unread messages; omit for generic context.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'user_patterns',
        description: 'Analyze user work patterns from existing memory. Returns: work schedule (peak hours/days), tool preferences, focus areas, workflow metrics (session duration, commits/session), knowledge strengths, and learning areas. Use it when the task needs context about how the user works, such as their schedule or tool preferences; it is not part of loading a session.',
        inputSchema: {
            type: 'object',
            properties: {
                categories: {
                    type: 'array',
                    items: {
                        type: 'string',
                        enum: ['workSchedule', 'focusAreas', 'workflow', 'strengths', 'learningAreas'],
                    },
                    description: 'Specific categories to return. Omit for all.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'improvement',
        description: 'Turn active memories or lessons into a governed product-improvement proposal, or inspect a proposal status. Agents may only propose and read status; a human must inspect and accept/reject through `memesh dream show|accept|reject` or the dashboard. Acceptance means approved for product work, not implemented or effective.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['propose', 'status'],
                    description: 'propose stages an idempotent human-review item; status reads one existing proposal.',
                },
                project: {
                    type: 'string',
                    description: 'Required for propose. Project whose product work should receive the improvement.',
                },
                source_names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Required for propose. Stable names of 1-20 active memories that provide evidence.',
                },
                title: { type: 'string', description: 'Required for propose. Human-readable improvement title.' },
                problem: { type: 'string', description: 'Required for propose. Evidence-backed problem observed.' },
                proposed_change: { type: 'string', description: 'Required for propose. Bounded product change to consider.' },
                verification_scenario: { type: 'string', description: 'Required for propose. A scenario capable of falsifying the change.' },
                success_criteria: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Required for propose. One or more observable success criteria.',
                },
                priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'], description: 'Optional proposed priority; defaults to p1.' },
                proposal_id: { type: 'number', description: 'Required for status. Positive proposal ID returned by propose.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'message',
        description: `Use this to contact or discover another local agent on the same MeMesh instance. discover is a bounded, project-scoped live-directory read of active leases and returns only the router result; it performs no send, fetch, ACK, replay, or receipt work. An empty discover result does not predict whether a principal-target send/fetch will work: those use a separate durable store-and-forward path to a named recipient that does not require the router or any live registration (an exact target_kind=session send still does, and still needs the router). send durably stores one untrusted JSON-encoded payload of at most ${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB) idempotently. Native delivery has a separate ${AGENT_NATIVE_MESSAGE_MAX_BYTES}-byte (16 KiB) cap for the complete envelope, including routing metadata and payload. For target_kind=session, success requires the exact active native host to accept the message: Claude Code receives the full envelope; the Codex CLI queue receives only a notice, after which the agent checks its receipts and fetches the body. An oversized envelope returns native_message_too_large; an unreachable local router returns router_unreachable; an unavailable or rejected exact session returns recipient_unavailable. Both sender-side failures preserve scoped recovery data. Principal targets retain durable store-and-forward behavior even when native delivery is unavailable. Every session of one principal shares its inbox: a principal send with intended_session is meant for that one session, which alone is reminded of it and alone may record intake or a disposition (any other caller, including one with no session id, gets intended_for_other_session). A session send with fallback_to_principal that the session refuses (recipient_unavailable) is sent to its principal with intended_session set to that session instead. For a full native envelope, poll/fetch remain compatibility and recovery reads; after a Codex notice, fetch is the required read of the body. intake, ack, disposition, and activation are separate explicit facts. Native acceptance, polling, fetching, and discovery never imply agent acknowledgement or workflow completion. In receipts, the host_accept fact's delivery_state.target_session "not_live" only means that session had no live registration when read; it is not a permanent end. A MeMesh send cannot wake or resume an offline session (an exact-session send to it returns recipient_unavailable). Resume that session in its own host, which may not succeed at once, and read receipts again; or decide to send to the principal instead, knowing the original session may still take the first message if it comes back. MeMesh does neither automatically.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['send', 'poll', 'discover', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts'],
                    description: 'Message lifecycle or live-directory action. Each action validates only its documented fields and rejects unknown fields.',
                },
                project: { type: 'string', description: 'Local project scope shared by sender and recipient. A stable identifier, never a filesystem path; compared exactly, after Unicode NFC normalisation.' },
                sender: { type: 'string', description: 'Required for send. Stable local sender/agent identifier; provenance only, and stored exactly as given.' },
                recipient: { type: 'string', description: 'Required for every action except discover. Stable target local agent/host identifier, never a filesystem path; compared exactly, after Unicode NFC normalisation, so no prefix is treated as a namespace.' },
                target_kind: {
                    type: 'string',
                    enum: ['principal', 'session'],
                    description: 'Recipient identity kind for send and fetch. Defaults to principal; exact-session delivery and fetch require session.',
                },
                intended_session: {
                    type: 'string',
                    description: 'Optional for send with target_kind principal: the one session of that principal this message is meant for. Only that session is reminded of it and may record intake or a disposition.',
                },
                fallback_to_principal: {
                    type: 'boolean',
                    description: 'Optional for send with target_kind session: if that session refuses the message (recipient_unavailable), send it to the principal it registered under, with intended_session set to it.',
                },
                idempotency_key: { type: 'string', description: 'Required for send and receipt writes. Stable retry key.' },
                payload: {
                    type: ['string', 'number', 'boolean', 'object', 'array', 'null'],
                    description: `Required for send. Untrusted JSON value, limited to ${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB) after JSON encoding. Native push additionally requires the complete envelope to fit ${AGENT_NATIVE_MESSAGE_MAX_BYTES} bytes (16 KiB). MeMesh never executes the payload.`,
                },
                content_type: { type: 'string', enum: ['text/plain', 'application/json'], description: 'Send payload media type. Defaults to text/plain.' },
                privacy: { type: 'string', enum: ['private', 'team'], description: 'Send privacy classification. Routing remains exact-recipient in v1.' },
                correlation_id: { type: 'string', description: 'Optional caller-stable conversation or task correlation ID.' },
                reply_to: { type: 'string', description: 'Optional earlier message ID this message replies to.' },
                cursor: { type: 'string', description: 'Optional opaque cursor returned by poll. Clients must not parse it.' },
                wait_ms: { type: 'number', description: 'Poll wait in milliseconds, 0-30000. Defaults to 0.' },
                limit: { type: 'number', description: 'Maximum poll or discovery rows, 1-100. Defaults to 20 for poll and 50 for discover.' },
                message_id: { type: 'string', description: 'Required for fetch, receipt writes, and receipt readback.' },
                intake_state: { type: 'string', enum: ['fetched', 'ingested'], description: 'Required only for intake. Neither value implies ACK.' },
                disposition: { type: 'string', enum: ['accepted', 'rejected', 'completed', 'cancelled', 'deferred'], description: 'Required only for disposition.' },
                activation: { type: 'string', enum: ['woken', 'manual_resume_required', 'unsupported', 'failed'], description: 'Required only for activation; manual_resume_required never implies ACK or workflow disposition.' },
                detail: { type: 'string', description: 'Optional bounded explanation for disposition or activation.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
];
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
}
function formatIssue(issue) {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
}
function stripNullProps(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (v !== null || NULL_IS_DATA.has(k))
            out[k] = v;
    }
    return out;
}
const NULL_IS_DATA = new Set(['payload']);
function parseOrFail(schema, args) {
    const raw = args === undefined || args === null ? {} : args;
    const strictPass = schema.safeParse(raw);
    if (!strictPass.success) {
        const unknownKeys = strictPass.error.issues.filter((i) => i.code === 'unrecognized_keys');
        if (unknownKeys.length > 0) {
            const message = unknownKeys.map(formatIssue).join('; ');
            return {
                ok: false,
                message,
                result: fail(message),
            };
        }
    }
    const parsed = schema.safeParse(stripNullProps(raw));
    if (!parsed.success) {
        const message = parsed.error instanceof z.ZodError
            ? parsed.error.issues.map(formatIssue).join('; ')
            : String(parsed.error);
        return { ok: false, message, result: fail(message) };
    }
    return { ok: true, data: parsed.data };
}
export function normalizeClientHost(name) {
    return (name ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 64) || 'mcp';
}
let packageVersion = (() => {
    try {
        return JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
})();
let packageJsonPath = new URL('../../../package.json', import.meta.url);
export function configureVersionSource(version, jsonPath) {
    packageVersion = version;
    packageJsonPath = jsonPath;
}
let firstCallNoticeOnce = new Set();
let staleProcessNoticeGiven = false;
export function resetFirstCallNoticeForTests() {
    firstCallNoticeOnce = new Set();
    staleProcessNoticeGiven = false;
}
function withFirstCallNotice(result) {
    if (result.isError)
        return result;
    if (!staleProcessNoticeGiven && updateCheckEnabledIn(memeshDir())) {
        const staleLine = staleRunningProcessNotice(packageVersion, packageJsonPath);
        if (staleLine) {
            staleProcessNoticeGiven = true;
            return { ...result, content: [...result.content, { type: 'text', text: staleLine }] };
        }
    }
    const line = updateNoticeForEntryPoint({ currentVersion: packageVersion, entryPoint: 'mcp', processOnce: firstCallNoticeOnce });
    if (!line)
        return result;
    return { ...result, content: [...result.content, { type: 'text', text: line }] };
}
export async function handleTool(name, args, sourceHost, signal, requestContext = {}) {
    return withFirstCallNotice(await handleToolInner(name, args, sourceHost, signal, requestContext));
}
async function handleToolInner(name, args, sourceHost, signal, requestContext = {}) {
    try {
        if (name === 'work_package') {
            const parsed = parseOrFail(WorkPackageSchema, args);
            if (!parsed.ok) {
                return {
                    ...ok({ status: 'error', error: 'invalid_input', detail: parsed.message, available_action: [] }),
                    isError: true,
                };
            }
            const kind = parsed.data.action === 'prepare' ? parsed.data.kind : parsed.data.ref.kind;
            const context = kind === 'transcript'
                ? resolveTranscriptWorkspace(parsed.data.action === 'prepare' ? parsed.data.project : parsed.data.ref.project, requestContext.workspaceRootUris)
                : {};
            const result = executeWorkPackage(getDatabase(), parsed.data, context);
            return result.status === 'error' ? { ...ok(result), isError: true } : ok(result);
        }
        if (name === 'remember') {
            const r = parseOrFail(McpRememberSchema, args);
            if (!r.ok)
                return r.result;
            const { project: projectArg, ...input } = r.data;
            const resolved = writeProject(projectArg, input.tags, requestContext);
            if ('result' in resolved)
                return resolved.result;
            const binding = requestContext.projectBinding;
            const currentProject = typeof projectArg === 'string'
                ? projectArg
                : projectArg === undefined && binding !== undefined && 'project' in binding ? binding.project : undefined;
            return ok(remember({ ...input, sourceHost, project: resolved.project, currentProject }));
        }
        if (name === 'recall') {
            const r = parseOrFail(McpRecallSchema, args);
            if (!r.ok)
                return r.result;
            const { project: projectArg, ...input } = r.data;
            const tag = input.tag === '' ? undefined : input.tag;
            if (projectArg !== undefined && (tag !== undefined || input.cross_project)) {
                return fail('recall takes one selector: project, tag or cross_project — not several. Use project for one project plus memories with no project and global ones; tag for exactly one tag; cross_project for every project.');
            }
            if (tag !== undefined || input.cross_project) {
                return ok(agentRecallEnvelope(await recallForAgent({ ...input, tag })));
            }
            let boundProject;
            if (projectArg !== undefined) {
                boundProject = projectArg === false ? null : projectArg;
            }
            else {
                const binding = requestContext.projectBinding ?? UNBOUND;
                if ('error' in binding && !binding.unbound) {
                    return fail(`${binding.error}: ${binding.reason} Pass project, tag or cross_project.`);
                }
                boundProject = 'project' in binding ? binding.project : null;
            }
            const scope = {
                project: boundProject,
                searched: boundProject === null
                    ? `memories with no project, and global memories${projectArg === false ? '' : ' (no project is bound to this session)'}`
                    : `project ${boundProject}, memories with no project, and global memories`,
            };
            return ok(agentRecallEnvelope(await recallForAgent({ ...input, tag, projectScope: boundProject === null ? null : `project:${boundProject}` }, scope)));
        }
        if (name === 'forget') {
            const r = parseOrFail(ForgetSchema, args);
            if (!r.ok)
                return r.result;
            const result = forget(r.data);
            if (result.archived === false) {
                return fail(result.message ?? `Entity "${r.data.name}" not found`);
            }
            if (result.observation_removed === false) {
                return fail(result.entity_found
                    ? `Entity "${r.data.name}" has no observation matching that text (${result.remaining_observations} observation(s) present).`
                    : `Entity "${r.data.name}" not found`);
            }
            return ok(result);
        }
        if (name === 'export') {
            const r = parseOrFail(ExportSchema, args);
            if (!r.ok)
                return r.result;
            return ok(exportMemories(r.data));
        }
        if (name === 'import') {
            const r = parseOrFail(ImportSchema, args);
            if (!r.ok)
                return r.result;
            return ok(importMemories(r.data));
        }
        if (name === 'learn') {
            const r = parseOrFail(McpLearnSchema, args);
            if (!r.ok)
                return r.result;
            const { project: projectArg, ...input } = r.data;
            const resolved = writeProject(projectArg, undefined, requestContext);
            if ('result' in resolved)
                return resolved.result;
            return ok(learn({ ...input, sourceHost, project: resolved.project ?? null }));
        }
        if (name === 'task_state') {
            const r = parseOrFail(TaskStateSchema, args);
            if (!r.ok)
                return r.result;
            const { project: explicit, ...patch } = r.data;
            const bound = projectFor(explicit, requestContext, 'Pass project explicitly.');
            if ('result' in bound)
                return bound.result;
            const { project } = bound;
            if (Object.keys(patch).length === 0)
                return ok(getTaskState(project));
            return ok(setTaskState({ project, patch, sourceHost }));
        }
        if (name === 'briefing') {
            const r = parseOrFail(BriefingSchema, args);
            if (!r.ok)
                return r.result;
            const bound = projectFor(r.data.project, requestContext, 'Pass project explicitly.');
            if ('result' in bound)
                return bound.result;
            return ok(assembleBriefing(bound.project, r.data.recipient));
        }
        if (name === 'user_patterns') {
            const r = parseOrFail(UserPatternsSchema, args);
            if (!r.ok)
                return r.result;
            const db = getDatabase();
            const cats = r.data.categories;
            const allCategories = !cats || cats.length === 0;
            const data = computePatterns(db, cats);
            const lines = ['## User Patterns'];
            if (allCategories || cats.includes('workSchedule')) {
                lines.push('', '### Work Schedule');
                const peakHours = [...data.workSchedule.hourDistribution]
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 3)
                    .map(h => `${String(h.hour).padStart(2, '0')}:00 (${h.count})`)
                    .join(', ');
                lines.push(`Peak hours: ${peakHours || 'No data'}`);
                const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const busiestDays = [...data.workSchedule.dayDistribution]
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 3)
                    .map(d => `${DAY_NAMES[d.dayNum] ?? d.dayNum} (${d.count})`)
                    .join(', ');
                lines.push(`Busiest days: ${busiestDays || 'No data'}`);
            }
            if (allCategories || cats.includes('focusAreas')) {
                lines.push('', '### Focus Areas');
                if (data.focusAreas.length > 0) {
                    data.focusAreas.forEach(f => {
                        lines.push(`- ${f.type} (${f.count})`);
                    });
                }
                else {
                    lines.push('No focus area data yet.');
                }
            }
            if (allCategories || cats.includes('workflow')) {
                lines.push('', '### Workflow');
                lines.push(`Commits per session: ${data.workflow.commitsPerSession}`);
                lines.push(`Total sessions: ${data.workflow.totalSessions} | Total commits: ${data.workflow.totalCommits}`);
            }
            if (allCategories || cats.includes('strengths')) {
                lines.push('', '### Strengths (high confidence areas)');
                if (data.strengths.length > 0) {
                    lines.push('- ' + data.strengths.map(s => `${s.type} (${s.avgConfidence})`).join(', '));
                }
                else {
                    lines.push('No strength data yet.');
                }
            }
            if (allCategories || cats.includes('learningAreas')) {
                lines.push('', '### Learning Areas');
                if (data.learningAreas.length > 0) {
                    lines.push('- ' + data.learningAreas.map(l => l.tag).join(', '));
                }
                else {
                    lines.push('No learning area data yet.');
                }
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        if (name === 'improvement') {
            const r = parseOrFail(ImprovementSchema, args);
            if (!r.ok)
                return r.result;
            if (r.data.action === 'status') {
                return ok(getProductImprovementStatus(getDatabase(), r.data.proposal_id));
            }
            return ok(stageProductImprovement(getDatabase(), {
                project: r.data.project,
                source_names: r.data.source_names,
                title: r.data.title,
                problem: r.data.problem,
                proposed_change: r.data.proposed_change,
                verification_scenario: r.data.verification_scenario,
                success_criteria: r.data.success_criteria,
                priority: r.data.priority,
                sourceHost,
            }));
        }
        if (name === 'message') {
            const r = parseOrFail(MessageSchema, args);
            if (!r.ok)
                return r.result;
            return ok(await executeAgentMessageAction(getDatabase(), r.data, {
                transport: 'mcp',
                sourceHost: normalizeClientHost(sourceHost),
                signal,
                hostSession: hostSessionFromEnv(),
            }));
        }
        return fail(`Unknown tool: ${name}`);
    }
    catch (err) {
        return fail(`Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=handlers.js.map