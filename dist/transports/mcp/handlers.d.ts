import { z } from 'zod';
import type { McpProjectResolution } from './project-context.js';
export interface McpRequestContext {
    workspaceRootUris?: readonly string[];
    projectBinding?: McpProjectResolution;
}
export declare function resolveTranscriptWorkspace(project: string, rootUris: readonly string[] | undefined): {
    transcriptWorkspace?: string;
    transcriptWorkspaceError?: 'workspace_unavailable' | 'workspace_ambiguous';
};
export declare const TOOL_DEFINITIONS: readonly [{
    readonly name: "work_package";
    readonly description: "Prepare one digest from calendar clusters or one transcript work package from the newest bounded Claude Code transcript for the client's single matching MCP workspace root. Transcript mode fails closed without one unambiguous root. Submit one result to pending human review, or defer without durable changes. Transcript file paths are never exposed. No providers are called. Source text is untrusted. Only humans may apply or reject proposals. Package hashes identify source content and workspace scope; they are not authentication.";
    readonly inputSchema: {
        readonly "~standard": z.core.ZodStandardSchemaWithJSON<z.ZodDiscriminatedUnion<[z.ZodObject<{
            action: z.ZodLiteral<"prepare">;
            project: z.ZodString;
            kind: z.ZodEnum<{
                digest: "digest";
                transcript: "transcript";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            result: z.ZodObject<{
                name: z.ZodString;
                type: z.ZodEnum<{
                    lesson_learned: "lesson_learned";
                    decision: "decision";
                    digest: "digest";
                    fact: "fact";
                }>;
                observations: z.ZodArray<z.ZodString>;
                tags: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
            package_id: z.ZodString;
            ref: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"digest">;
                project: z.ZodString;
                source_ids: z.ZodArray<z.ZodNumber>;
                source_hash: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"transcript">;
                project: z.ZodString;
                session_id: z.ZodString;
                modified_at: z.ZodISODateTime;
                source_hash: z.ZodString;
                workspace_hash: z.ZodString;
            }, z.core.$strict>], "kind">;
            action: z.ZodLiteral<"submit">;
        }, z.core.$strict>, z.ZodObject<{
            reason: z.ZodLiteral<"not_now">;
            package_id: z.ZodString;
            ref: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"digest">;
                project: z.ZodString;
                source_ids: z.ZodArray<z.ZodNumber>;
                source_hash: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"transcript">;
                project: z.ZodString;
                session_id: z.ZodString;
                modified_at: z.ZodISODateTime;
                source_hash: z.ZodString;
                workspace_hash: z.ZodString;
            }, z.core.$strict>], "kind">;
            action: z.ZodLiteral<"defer">;
        }, z.core.$strict>], "action">>;
        readonly $schema?: "https://json-schema.org/draft/2020-12/schema" | "http://json-schema.org/draft-07/schema#" | "http://json-schema.org/draft-04/schema#";
        readonly $id?: string;
        readonly $anchor?: string;
        readonly $ref?: string;
        readonly $dynamicRef?: string;
        readonly $dynamicAnchor?: string;
        readonly $vocabulary?: Record<string, boolean>;
        readonly $comment?: string;
        readonly $defs?: Record<string, z.core.JSONSchema.JSONSchema>;
        type: "object" | "array" | "string" | "number" | "boolean" | "null" | "integer";
        readonly additionalItems?: z.core.JSONSchema._JSONSchema;
        readonly unevaluatedItems?: z.core.JSONSchema._JSONSchema;
        readonly prefixItems?: z.core.JSONSchema._JSONSchema[];
        readonly items?: z.core.JSONSchema._JSONSchema | z.core.JSONSchema._JSONSchema[];
        readonly contains?: z.core.JSONSchema._JSONSchema;
        readonly additionalProperties?: z.core.JSONSchema._JSONSchema;
        readonly unevaluatedProperties?: z.core.JSONSchema._JSONSchema;
        readonly properties?: Record<string, z.core.JSONSchema._JSONSchema>;
        readonly patternProperties?: Record<string, z.core.JSONSchema._JSONSchema>;
        readonly dependentSchemas?: Record<string, z.core.JSONSchema._JSONSchema>;
        readonly propertyNames?: z.core.JSONSchema._JSONSchema;
        readonly if?: z.core.JSONSchema._JSONSchema;
        readonly then?: z.core.JSONSchema._JSONSchema;
        readonly else?: z.core.JSONSchema._JSONSchema;
        readonly allOf?: z.core.JSONSchema.JSONSchema[];
        readonly anyOf?: z.core.JSONSchema.JSONSchema[];
        readonly oneOf?: z.core.JSONSchema.JSONSchema[];
        readonly not?: z.core.JSONSchema._JSONSchema;
        readonly multipleOf?: number;
        readonly maximum?: number;
        readonly exclusiveMaximum?: number | boolean;
        readonly minimum?: number;
        readonly exclusiveMinimum?: number | boolean;
        readonly maxLength?: number;
        readonly minLength?: number;
        readonly pattern?: string;
        readonly maxItems?: number;
        readonly minItems?: number;
        readonly uniqueItems?: boolean;
        readonly maxContains?: number;
        readonly minContains?: number;
        readonly maxProperties?: number;
        readonly minProperties?: number;
        readonly required?: string[];
        readonly dependentRequired?: Record<string, string[]>;
        readonly enum?: Array<string | number | boolean | null>;
        readonly const?: string | number | boolean | null;
        readonly id?: string;
        readonly title?: string;
        readonly description?: string;
        readonly default?: unknown;
        readonly deprecated?: boolean;
        readonly readOnly?: boolean;
        readonly writeOnly?: boolean;
        readonly nullable?: boolean;
        readonly examples?: unknown[];
        readonly format?: string;
        readonly contentMediaType?: string;
        readonly contentEncoding?: string;
        readonly contentSchema?: z.core.JSONSchema.JSONSchema;
        readonly _prefault?: unknown;
    };
}, {
    readonly name: "remember";
    readonly description: string;
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Unique entity name (e.g., \"auth-decision\", \"jwt-pattern\"). Reusing a name appends observations and dedupes tags instead of replacing the entity (unless `replace` is true). Required unless `note` is given, in which case it is derived from the text (same text → same name).";
            };
            readonly type: {
                readonly type: "string";
                readonly description: "Entity type (e.g., \"decision\", \"pattern\", \"lesson_learned\"). Required unless `note` is given (it then defaults to \"note\"), or `replace: true` is sent with the `name` of a memory that exists — that call keeps the stored type. Passing one on a `replace` reclassifies the memory.";
            };
            readonly note: {
                readonly type: "string";
                readonly description: "Free text, instead of title + observations: the first line becomes the title and each following paragraph an observation. Cannot be combined with `title` or `observations`. Control characters and credential-shaped strings are removed before storing.";
            };
            readonly replace: {
                readonly type: "boolean";
                readonly description: "Rewrite the memory named by `name` instead of appending to it: its observations are replaced (and its tags when `tags` is given, its title when `title` or `note` is given). The previous version is kept in metadata.replaced_history with the time it was replaced. Default false (append).";
            };
            readonly title: {
                readonly type: "string";
                readonly description: "Short human-readable label for this memory (e.g. \"Use PKCE over implicit flow for auth\"), distinct from name (which stays a stable machine key). Shown as the headline in the dashboard and in memory recalled by an agent, instead of the raw name. Reusing an existing name with a different title UPDATES the title; omit to leave an existing title untouched.";
            };
            readonly observations: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Key facts or observations about this entity";
            };
            readonly why: {
                readonly type: "string";
                readonly description: "For a decision: why it was made AND what would make it stop holding (e.g. \"Postgres is too heavy to deploy for one user; revisit if we add a hosted tier\"). Stored as the observation \"Why: …\" and shown next to the decision wherever it is recalled or briefed. Required to create or `replace` a memory of type decision, architecture_decision or design_decision, unless an observation already starts with \"Why: \".";
            };
            readonly tags: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Tags for filtering by subject (e.g. \"topic:database\"). A \"project:<id>\" tag is the same as passing `project` (<id> is the `project` field of the `briefing` result; CLI: `memesh briefing --json`); a plain repository name is a different project, except your own project's plain name, which is stored as the id and reported in `retagged` — unless a memory the call updates or supersedes is already filed under the plain tag, which then stays as written. At most one project.";
            };
            readonly relations: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly to: {
                            readonly type: "string";
                            readonly description: "Target entity name";
                        };
                        readonly type: {
                            readonly type: "string";
                            readonly description: string;
                        };
                    };
                    readonly required: readonly ["to", "type"];
                    readonly additionalProperties: false;
                };
                readonly description: "Relations to other entities";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Namespace for organizing the entity. Omit it to leave an existing memory where it is — supplying it MOVES a memory that already exists, and it drops out of every other scoped view. New memories default to \"personal\".";
            };
            readonly project: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly minLength: 1;
                }, {
                    readonly const: false;
                }];
                readonly description: "The project this memory belongs to. Omit it to use a \"project:<id>\" tag if you gave one, else the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root). Pass false for a memory that belongs to no project — a preference, a general lesson, team knowledge; it needs no binding. With no project, no tag and no binding the call is refused with workspace_unavailable. A write may change only a memory of the same project (or, with false, one that has none).";
            };
        };
        readonly additionalProperties: false;
        readonly anyOf: readonly [{
            readonly required: readonly ["note"];
        }, {
            readonly required: readonly ["name", "type"];
        }, {
            readonly required: readonly ["name", "replace"];
            readonly properties: {
                readonly replace: {
                    readonly const: true;
                };
            };
        }];
    };
}, {
    readonly name: "recall";
    readonly description: "Search and retrieve stored knowledge. Uses full-text search. Selectors: `project` (that project, memories with no project, and global ones; false = only memories with no project and global ones), `tag` (exactly that tag) or `cross_project` (every project; a `tag` given with it is ignored). `project` cannot be combined with `tag` or `cross_project`. With none, it uses the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root) the same way, or only memories with no project and global ones when nothing is bound; a launch or workspace root that is set but cannot be resolved is refused with the reason; the response says what it searched (`scope`) and each result carries its `projects` ([] for none). Call with no query to list recent memories. One- and two-term queries use OR matching; queries with three or more terms try strict all-term matching first and fall back to OR only when strict matching has no hits, with results ranked by relevance. Results are capped for size: each entity's observations+tags at 8 KB, the whole response at 32 KB; a capped entity carries `truncated` with the full shown/total counts, and the response carries `truncated`/`entities_omitted` when anything was cut. `file:*` tags are never included — they exist for pre-edit lookups, not for reading.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Search query. One- and two-term queries use OR matching; three or more terms use strict all-term matching first, then OR fallback if strict matching has no hits. Results are ranked by relevance (BM25); only the first 32 surviving terms are used, and words present in most of the corpus are ignored as noise. Leave empty to list recent.";
            };
            readonly tag: {
                readonly type: "string";
                readonly description: "Filter by tag (e.g., \"project:<id>\", where <id> is the `project` field of the `briefing` result (CLI: `memesh briefing --json`))";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Max results (default: 20, max: 100)";
            };
            readonly include_archived: {
                readonly type: "boolean";
                readonly description: "Include archived (forgotten) entities in results. Default: false.";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Filter results by namespace. Omit to search all namespaces.";
            };
            readonly cross_project: {
                readonly type: "boolean";
                readonly description: "Search every project; a `tag` given with it is ignored. Cannot be combined with `project`.";
            };
            readonly project: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly minLength: 1;
                }, {
                    readonly const: false;
                }];
                readonly description: "Search this project plus memories with no project and global ones; false searches only memories with no project and global ones. Cannot be combined with `tag` or `cross_project`. Omit it to use the bound project.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "forget";
    readonly description: "Archive an entity (soft-delete) or remove a specific observation. Archived entities are hidden from recall but preserved in the database. To remove just one observation, pass the observation parameter.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Entity name to archive or modify";
            };
            readonly observation: {
                readonly type: "string";
                readonly description: "If provided, only this specific observation is removed (entity stays active). If omitted, the entire entity is archived.";
            };
        };
        readonly required: readonly ["name"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "export";
    readonly description: "Export memories as portable JSON. The default limit of 1000 entities may return only a subset; check `truncated` and raise the limit before treating the result as a complete backup.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly tag: {
                readonly type: "string";
                readonly description: "Export only entities with this tag";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Export only from this namespace";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Max entities to export (default: 1000). The default is a SUBSET, not a backup — check `truncated` in the response, and for a full backup pass a limit above the graph size.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "import";
    readonly description: "Import memories from a JSON export snapshot. Supports skip, append, or overwrite strategies for existing entities; overwrite replaces their observations and tags, keeping the previous version in metadata.replaced_history. A local memory that was forgotten (archived) stays archived unless restore_archived is true; the result reports how many were left as they were in kept_archived.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly data: {
                readonly type: "object";
                readonly description: "Export JSON data (from the export tool)";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Override namespace for all imported entities";
            };
            readonly merge_strategy: {
                readonly type: "string";
                readonly enum: readonly ["skip", "overwrite", "append"];
                readonly description: "Required. How to handle an entity that already exists: skip = leave it untouched, append = add these observations to it, overwrite = REPLACE its observations and tags (the previous version is kept in metadata.replaced_history, up to the last 20)";
            };
            readonly restore_archived: {
                readonly type: "boolean";
                readonly description: "Optional, default false. With append or overwrite, a local entity that is archived (forgotten) is left untouched and counted in kept_archived. Set true to bring it back to active and merge or overwrite it like any other; it requires merge_strategy append or overwrite (an error with skip). Only set it when the user asked for archived memories to return.";
            };
        };
        readonly required: readonly ["data", "merge_strategy"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "learn";
    readonly description: "Record a structured lesson from a mistake or discovery. Creates a lesson_learned entity with error, root cause, fix, and prevention. Use it when something went wrong and the cause and fix are known; for a choice between options, use `remember` with type decision. The lesson belongs to `project`, or to the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root); pass project false for a general lesson that belongs to no project. With no project and no binding the call is refused with workspace_unavailable. The project's lessons are shown at the start of later sessions.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly error: {
                readonly type: "string";
                readonly description: "What went wrong";
            };
            readonly fix: {
                readonly type: "string";
                readonly description: "What fixed it";
            };
            readonly root_cause: {
                readonly type: "string";
                readonly description: "Why it happened (optional)";
            };
            readonly prevention: {
                readonly type: "string";
                readonly description: "How to prevent it next time (optional)";
            };
            readonly severity: {
                readonly type: "string";
                readonly enum: readonly ["critical", "major", "minor"];
                readonly description: "Severity level (default: minor)";
            };
            readonly project: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly minLength: 1;
                }, {
                    readonly const: false;
                }];
                readonly description: "The project the lesson belongs to; false for a general lesson with no project. Omit it to use the bound project.";
            };
        };
        readonly required: readonly ["error", "fix"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "task_state";
    readonly description: "Read or update where the work stands on this project: the goal, what is next, what is blocked, what was just finished. Call with no arguments to read it. Fresh state is included in the next session's briefing when the `briefing` level is `standard` or `full` (not at the default, `minimal`); stale or unknown-age state becomes a one-line flag at every level. Record ONLY what the user actually stated — never infer a goal or a next step from files edited or commands run, and leave a field out if it was not said. Pass an empty string to clear a field (e.g. blocked: \"\" once a blocker is resolved).";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly project: {
                readonly type: "string";
                readonly description: "Project name. Omit to use the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root); with no binding the call is refused with workspace_unavailable.";
            };
            readonly goal: {
                readonly type: "string";
                readonly description: "What this work is FOR — the outcome being aimed at";
            };
            readonly next: {
                readonly type: "string";
                readonly description: "The next concrete step";
            };
            readonly blocked: {
                readonly type: "string";
                readonly description: "What is standing in the way, if anything";
            };
            readonly done: {
                readonly type: "string";
                readonly description: "What was just finished";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "briefing";
    readonly description: "The work topology for a project, assembled and ready to use — assembled under the same rules as Claude Code’s session-start memory block (at `full`, the SessionStart hook additionally appends a work-package notice; that notice is a host-agent instruction, not memory, and is never part of this tool’s output). An eligible exact-project handoff precedes ranked memories at every level, after optional repository facts: fresh through 72 hours, marked stale through 14 days, omitted when older, undatable, or implausibly future-dated. Imported or archived handoffs are not auto-injected. Recent project decisions take priority over routine activity; up to five project lessons are selected separately. The handoff, displayed task state, ranked and global memories, and injected index share a 4000-character memory-block limit. How much else is assembled follows the `briefing` setting: `minimal` (the default) includes this project’s decisions and direction, lessons, known facts and recent activity, plus up to five memories that belong to no project, no fresh task state (a stale or unknown-age one still collapses to a one-line flag at every level) and no index, and may be empty; `standard` adds a fresh goal / next / blocked / done and closes with a capped index of durable memories; `full` additionally includes other projects and global memory. Whatever the level, the result’s `index` field carries the standalone index, which can show more than the index inside a crowded briefing. Call it at the start of a session only when the host has not already injected this block (the MeMesh SessionStart hook does under Claude Code, and under the Codex plugin once Codex runs its hooks; it runs again after context compaction), or when the user asks what is remembered; use recall for specific questions. Content is wrapped as untrusted background data.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly project: {
                readonly type: "string";
                readonly description: "Project name. Omit to use the project this session is bound to (MEMESH_PROJECT_ROOT, or the client’s workspace root); with no binding the call is refused with workspace_unavailable.";
            };
            readonly recipient: {
                readonly type: "string";
                readonly description: "Exact logical recipient. Required to surface actionable unread messages; omit for generic context.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "user_patterns";
    readonly description: "Analyze user work patterns from existing memory. Returns: work schedule (peak hours/days), tool preferences, focus areas, workflow metrics (session duration, commits/session), knowledge strengths, and learning areas. Use it when the task needs context about how the user works, such as their schedule or tool preferences; it is not part of loading a session.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly categories: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly enum: readonly ["workSchedule", "focusAreas", "workflow", "strengths", "learningAreas"];
                };
                readonly description: "Specific categories to return. Omit for all.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "improvement";
    readonly description: "Turn active memories or lessons into a governed product-improvement proposal, or inspect a proposal status. Agents may only propose and read status; a human must inspect and accept/reject through `memesh dream show|accept|reject` or the dashboard. Acceptance means approved for product work, not implemented or effective.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["propose", "status"];
                readonly description: "propose stages an idempotent human-review item; status reads one existing proposal.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Required for propose. Project whose product work should receive the improvement.";
            };
            readonly source_names: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Required for propose. Stable names of 1-20 active memories that provide evidence.";
            };
            readonly title: {
                readonly type: "string";
                readonly description: "Required for propose. Human-readable improvement title.";
            };
            readonly problem: {
                readonly type: "string";
                readonly description: "Required for propose. Evidence-backed problem observed.";
            };
            readonly proposed_change: {
                readonly type: "string";
                readonly description: "Required for propose. Bounded product change to consider.";
            };
            readonly verification_scenario: {
                readonly type: "string";
                readonly description: "Required for propose. A scenario capable of falsifying the change.";
            };
            readonly success_criteria: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Required for propose. One or more observable success criteria.";
            };
            readonly priority: {
                readonly type: "string";
                readonly enum: readonly ["p0", "p1", "p2", "p3"];
                readonly description: "Optional proposed priority; defaults to p1.";
            };
            readonly proposal_id: {
                readonly type: "number";
                readonly description: "Required for status. Positive proposal ID returned by propose.";
            };
        };
        readonly required: readonly ["action"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "message";
    readonly description: "Use this to contact or discover another local agent on the same MeMesh instance. discover is a bounded, project-scoped live-directory read of active leases and returns only the router result; it performs no send, fetch, ACK, replay, or receipt work. An empty discover result does not predict whether a principal-target send/fetch will work: those use a separate durable store-and-forward path to a named recipient that does not require the router or any live registration (an exact target_kind=session send still does, and still needs the router). send durably stores one untrusted JSON-encoded payload of at most 65536 UTF-8 bytes (64 KiB) idempotently. Native delivery has a separate 16384-byte (16 KiB) cap for the complete envelope, including routing metadata and payload. For target_kind=session, success requires the exact active native host to accept the message: Claude Code receives the full envelope; the Codex CLI queue receives only a notice, after which the agent checks its receipts and fetches the body. An oversized envelope returns native_message_too_large; an unreachable local router returns router_unreachable; an unavailable or rejected exact session returns recipient_unavailable. Both sender-side failures preserve scoped recovery data. Principal targets retain durable store-and-forward behavior even when native delivery is unavailable. Every session of one principal shares its inbox: a principal send with intended_session is meant for that one session, which alone is reminded of it and alone may record intake or a disposition (any other caller, including one with no session id, gets intended_for_other_session). A session send with fallback_to_principal that the session refuses (recipient_unavailable) is sent to its principal with intended_session set to that session instead. For a full native envelope, poll/fetch remain compatibility and recovery reads; after a Codex notice, fetch is the required read of the body. intake, ack, disposition, and activation are separate explicit facts. Native acceptance, polling, fetching, and discovery never imply agent acknowledgement or workflow completion. In receipts, the host_accept fact's delivery_state.target_session \"not_live\" only means that session had no live registration when read; it is not a permanent end. A MeMesh send cannot wake or resume an offline session (an exact-session send to it returns recipient_unavailable). Resume that session in its own host, which may not succeed at once, and read receipts again; or decide to send to the principal instead, knowing the original session may still take the first message if it comes back. MeMesh does neither automatically.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["send", "poll", "discover", "fetch", "intake", "ack", "disposition", "activation", "receipts"];
                readonly description: "Message lifecycle or live-directory action. Each action validates only its documented fields and rejects unknown fields.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Local project scope shared by sender and recipient. A stable identifier, never a filesystem path; compared exactly, after Unicode NFC normalisation.";
            };
            readonly sender: {
                readonly type: "string";
                readonly description: "Required for send. Stable local sender/agent identifier; provenance only, and stored exactly as given.";
            };
            readonly recipient: {
                readonly type: "string";
                readonly description: "Required for every action except discover. Stable target local agent/host identifier, never a filesystem path; compared exactly, after Unicode NFC normalisation, so no prefix is treated as a namespace.";
            };
            readonly target_kind: {
                readonly type: "string";
                readonly enum: readonly ["principal", "session"];
                readonly description: "Recipient identity kind for send and fetch. Defaults to principal; exact-session delivery and fetch require session.";
            };
            readonly intended_session: {
                readonly type: "string";
                readonly description: "Optional for send with target_kind principal: the one session of that principal this message is meant for. Only that session is reminded of it and may record intake or a disposition.";
            };
            readonly fallback_to_principal: {
                readonly type: "boolean";
                readonly description: "Optional for send with target_kind session: if that session refuses the message (recipient_unavailable), send it to the principal it registered under, with intended_session set to it.";
            };
            readonly idempotency_key: {
                readonly type: "string";
                readonly description: "Required for send and receipt writes. Stable retry key.";
            };
            readonly payload: {
                readonly type: readonly ["string", "number", "boolean", "object", "array", "null"];
                readonly description: "Required for send. Untrusted JSON value, limited to 65536 UTF-8 bytes (64 KiB) after JSON encoding. Native push additionally requires the complete envelope to fit 16384 bytes (16 KiB). MeMesh never executes the payload.";
            };
            readonly content_type: {
                readonly type: "string";
                readonly enum: readonly ["text/plain", "application/json"];
                readonly description: "Send payload media type. Defaults to text/plain.";
            };
            readonly privacy: {
                readonly type: "string";
                readonly enum: readonly ["private", "team"];
                readonly description: "Send privacy classification. Routing remains exact-recipient in v1.";
            };
            readonly correlation_id: {
                readonly type: "string";
                readonly description: "Optional caller-stable conversation or task correlation ID.";
            };
            readonly reply_to: {
                readonly type: "string";
                readonly description: "Optional earlier message ID this message replies to.";
            };
            readonly cursor: {
                readonly type: "string";
                readonly description: "Optional opaque cursor returned by poll. Clients must not parse it.";
            };
            readonly wait_ms: {
                readonly type: "number";
                readonly description: "Poll wait in milliseconds, 0-30000. Defaults to 0.";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum poll or discovery rows, 1-100. Defaults to 20 for poll and 50 for discover.";
            };
            readonly message_id: {
                readonly type: "string";
                readonly description: "Required for fetch, receipt writes, and receipt readback.";
            };
            readonly intake_state: {
                readonly type: "string";
                readonly enum: readonly ["fetched", "ingested"];
                readonly description: "Required only for intake. Neither value implies ACK.";
            };
            readonly disposition: {
                readonly type: "string";
                readonly enum: readonly ["accepted", "rejected", "completed", "cancelled", "deferred"];
                readonly description: "Required only for disposition.";
            };
            readonly activation: {
                readonly type: "string";
                readonly enum: readonly ["woken", "manual_resume_required", "unsupported", "failed"];
                readonly description: "Required only for activation; manual_resume_required never implies ACK or workflow disposition.";
            };
            readonly detail: {
                readonly type: "string";
                readonly description: "Optional bounded explanation for disposition or activation.";
            };
        };
        readonly required: readonly ["action"];
        readonly additionalProperties: false;
    };
}];
type ToolResult = {
    content: Array<{
        type: string;
        text: string;
    }>;
    isError?: boolean;
};
export declare function normalizeClientHost(name: string | undefined): string;
export declare function configureVersionSource(version: string, jsonPath: string | URL): void;
export declare function resetFirstCallNoticeForTests(): void;
export declare function handleTool(name: string, args: Record<string, unknown> | undefined, sourceHost?: string, signal?: AbortSignal, requestContext?: McpRequestContext): Promise<ToolResult>;
export {};
//# sourceMappingURL=handlers.d.ts.map