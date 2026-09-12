# MeMesh Plugin Architecture

**Version**: 4.10.0

> Looking for "which file do I change for X?" — see [CODEMAP.md](../CODEMAP.md).

---

## Overview

MeMesh is the local agentic-memory and governed-collaboration layer for individual AI coding agents, including Claude Code, Codex, Gemini, Cursor, and other MCP-compatible clients. It provides 12 MCP tools (`work_package`, `remember`, `recall`, `forget`, `export`, `import`, `learn`, `task_state`, `briefing`, `user_patterns`, `improvement`, `message`) backed by SQLite and FTS5 full-text search. Memory, bounded discovery of live project registrations, and durable exact-recipient messaging are available through CLI, HTTP REST, and MCP. `work_package` prepares either one bounded calendar-selected digest package or one bounded package from the newest Claude Code session associated with the client's single matching MCP workspace root. An already-running agent submits exactly one strict result or defers; submit stages the existing pending human-review proposal with bounded redacted source turns retained for comparison, and the MCP contract exposes no apply/reject action. The local Dashboard and CLI provide cooperative human review surfaces, not authenticated actor identity. Packages omit hidden reasoning, tool traffic, raw transcripts, and transcript file paths; recognized credential-shaped text is redacted, but this heuristic is not a guarantee that arbitrary secrets are absent. Missing or ambiguous MCP roots fail closed. No provider is called. The Dashboard only reviews proposals that are already staged; it cannot start or wake an agent. Package hashes identify freshness and workspace scope, not authentication. `improvement` stages proposals through MCP while the existing CLI/HTTP review surfaces retain human accept/reject authority. Generic briefing and SessionStart context has no recipient identity and stays quiet; `briefing(project, recipient)` reports only that exact recipient's unfetched deliveries and directs the caller to poll before fetching.

The package is intentionally local-first and inspectable:
- one SQLite database under the user's control
- no cloud service required
- Claude Code hook integration for session-start, pre-edit recall, user-prompt-intent detection, post-commit capture, session-summary learning, and pre-compact save
- deterministic capture rules and local FTS5 retrieval with no provider setup

This repository is the standalone local package. Hosted workspace and enterprise operating-system products are intentionally out of scope for this package architecture.

```
                     ┌─────────────┐
                     │  core/      │
                     │  operations │
                     └──────┬──────┘
            ┌───────────────┼───────────────┐
            │               │               │
     transports/cli   transports/http  transports/mcp
     (memesh CLI)     (memesh serve)   (memesh-mcp)
                             │
                     KnowledgeGraph
                             │
                     SQLite (FTS5)
```

## Package Entry Points

| Executable | Source entry point |
|---|---|
| `memesh` | `src/transports/cli/cli.ts` |
| `memesh-mcp` | `src/mcp/server.ts` |
| `memesh-http` | `src/transports/http/server.ts` |
| `memesh-router` | `src/host-runtime/router.ts` |
| `memesh-host-claude` | `src/host-runtime/claude.ts` |
| `memesh-host-codex` | `src/host-runtime/codex.ts` |
| `memesh-host-codex-session` | `src/host-runtime/codex-session.ts` |
| `memesh-host-acp` | `src/host-runtime/acp.ts` |

`memesh-host-acp` is experimental protocol-development code, not a release-gated native-wakeup provider.

---

## Core/Transport Architecture

MeMesh separates concerns into two layers:

**Core** (`src/core/`) — pure business logic with zero transport dependencies:
- `types.ts` — shared TypeScript interfaces (zero external deps)
- `operations.ts` — `remember`, `recall`, `forget`, `export`, `import` as pure functions called by all transports
- `agent-messaging.ts` — transactional exact-recipient messages, opaque cursors, bounded waits, payload fetch, a 64 KiB JSON-encoded durable payload cap, and independent receipt facts
- `agent-router.ts` — owner-private local routing from a durable message event to an eligible active host adapter, plus a bounded project-scoped directory of live registrations; native delivery carries one untrusted full envelope capped at 16 KiB, including routing metadata and payload
- `config.ts` — owner-local configuration reads and partial updates for the retained non-model settings
- `paths.ts` — centralised filesystem path resolution (HOME-first override; shared with hooks via a build-generated copy in `scripts/hooks/_generated/`)
- `scoring.ts` — multi-factor scoring engine: weights search relevance, recency, frequency, confidence, recall-impact; exports `rankEntities()` used by all recall paths
- `dreamer.ts` — work-package preparation plus the shared proposal list/detail/accept/reject lifecycle. Digest candidates use deterministic calendar buckets; transcript packages expose only bounded visible turns from the newest Claude Code session under the host-provided MCP workspace root. Submission retains those redacted turns for review, stages one proposal, and never applies it.
- `kg-backfill.ts` — deterministic relation backfill: 5 rules (tag co-occurrence, project clustering, session co-occurrence, name-token similarity, and evidence-to-work linking)
- `project-tags.ts` — list / merge / rename `project:<name>` tags AND the `project` scope column of the durable-message tables, in one transaction (heals tags mis-homed before git-based project identity, and the split inboxes that go with them); backs `memesh kg rename-project`
- `agent-scope-id.ts` — the canonical form (Unicode NFC + trim) and fail-closed validation for durable-message scope identifiers (`project`, `recipient`, `actor`), plus the one list of columns that hold them; imported by the transport boundary and core write path, and mirrored by the read-only `scripts/audit/memory-invariants.mjs` detector. Historical ambiguous identities are preserved until an owner supplies a mapping.
- `version-check.ts` — npm registry version check for update notifications
- `update-entrypoint.ts` — the same notice for the other doors: one `[memesh update]` line on the MCP server's first successful tool result per process (appended as a second content item) and on CLI commands (stderr, once a day), suppressed when a hook announced it in the last ten minutes; when the cache is missing or stale it starts the hook's detached `memesh status` refresh (throttled to one per five minutes) and stays quiet until a check has completed
- `update-notice.ts` — the update-status resolver the hooks read (`UP_TO_DATE` / `UPGRADE_AVAILABLE` / `SNOOZED` / `JUST_UPGRADED` / `CHECK_FAILED` / `DISABLED`), escalating snooze, the post-upgrade receipt and the two-TTL refresh policy; a runtime leaf shared with the hooks via `scripts/hooks/_generated/update-notice.js`
- `why.ts` — file attribution (`memesh why` / `POST /v1/why`): a git half (`resolveFileCommits`, CLI-only — the HTTP route never shells out) and a DB half (`explainCommits`) joining full SHAs to the abbreviated-hash `commit-*` entity names, walking `metadata.session_id` to session entities, and collecting `file:<basename>`-tagged memories; every gap is a typed abstention

**Transports** (`src/transports/`) — thin adapters that expose core operations:
- `cli/cli.ts` — Commander CLI (`memesh` command; `message`, `agent`, `config`, `kg`, and `dream` have subcommands)
- `http/server.ts` — Express server (`memesh serve`, default port 3737): 31 `/v1` endpoints including two retired 410 routes, plus `/dashboard` and `/favicon.ico`; bearer-auth gate when bound non-loopback
- `agent-messaging.ts` — shared MCP/HTTP/CLI dispatcher that records cooperative transport provenance (not authenticated human/model identity) and never turns a read into a receipt
- `src/mcp/server.ts` + `src/transports/mcp/handlers.ts` — stdio MCP server (`memesh-mcp`, 12 tools); `src/mcp/tools.ts` is a re-export shim

This separation means the same `remember`/`recall`/`forget` logic runs identically whether invoked from a terminal, an HTTP request, or an MCP tool call. Governed product-improvement proposals reuse the dream staging/review lifecycle: agents can propose over MCP, and humans apply or reject through the CLI or dashboard-backed HTTP endpoints.

---

## Source Structure

```
src/
├── core/
│   ├── types.ts           # Shared types (zero external deps)
│   ├── operations.ts      # remember/recall/forget/learn + re-exports export/import
│   ├── serializer.ts      # Export/import memory snapshots (extracted from operations)
│   ├── config.ts          # Owner-local reads and safe partial updates for retained non-model settings
│   ├── paths.ts           # Centralised path helpers (homeDir, memeshDir, getDbPath, getProjectName)
│   ├── scoring.ts         # Multi-factor scoring engine (rankEntities) + SESSION_START_WEIGHT_RATIO
│   ├── extractor.ts       # Deterministic session knowledge extraction
│   ├── lifecycle.ts       # Auto-decay + weekly noise compression
│   ├── lesson-engine.ts   # Structured lesson creation, upsert, project query
│   ├── dreamer.ts         # Work-package prepare/submit + human proposal review lifecycle
│   ├── product-improvements.ts # Idempotent evidence-linked proposals + status; human review remains in dreamer
│   ├── kg-backfill.ts     # Heuristic relation backfill (tag co-occurrence + project clustering)
│   ├── patterns.ts        # User work patterns computation (shared by MCP + HTTP)
│   ├── doctor.ts          # `memesh doctor` health check (runtime / install / hooks / DB / capabilities)
│   ├── demo.ts            # `memesh demo` 30-entity onboarding seed
│   ├── memory-tool.ts     # Anthropic memory_20250818 adapter over the knowledge graph
│   └── version-check.ts   # npm registry version check
├── db.ts                  # SQLite + FTS5 + migrations
├── knowledge-graph.ts     # Entity CRUD, relations, FTS5 search, findConflicts
├── index.ts               # Package exports
├── cli/
│   └── view-live.ts       # Legacy HTML dashboard generator
├── host-adapters/         # Native Claude/Codex adapters; ACP remains experimental and not release-gated
├── host-runtime/          # Private-router connection and managed host runtime
├── mcp/
│   ├── server.ts          # MCP stdio server (opens the database and registers tool handlers)
│   └── tools.ts           # Re-export shim → transports/mcp/handlers.ts
└── transports/
    ├── schemas.ts         # Shared Zod validation schemas (single source of truth)
    ├── mcp/
    │   └── handlers.ts    # MCP tool handlers (imports schemas, ToolResult wrapper, conflict detection)
    │                      # NOTE: server.ts lives in src/mcp/ (see below), NOT here
    ├── http/
    │   └── server.ts      # Express REST API server (imports schemas, 1MB body limit, rate limiting)
    └── cli/
        └── cli.ts         # Commander CLI (conflict warnings in recall output)
```

---

## Modules

### src/core/ -- Core Layer

**types.ts** — Shared TypeScript interfaces used across all transports. No external dependencies.

**operations.ts** — Pure functions implementing `remember`, `recall`, `forget`, `learn`, and others. All three transports delegate here — no transport-specific logic leaks into business logic.

**config.ts** — Owner-local configuration management for `autoCapture`, `sessionLimit`, `autoUpdate`, `updateCheck`, and `setupCompleted`. Reads select only those retained fields; partial updates preserve unknown or retired top-level data without reading or printing credential values, and refuse to overwrite an unreadable file. `autoUpdate` is a bump limit; npm-global installs request host-mediated per-session consent at SessionStart and Stop dispatches only after explicit approval, while other channels receive their channel-specific manual action. The on-disk config path is resolved lazily via `paths.ts:memeshDir()` so HOME-first override works in hermetic Windows tests.

**paths.ts** — Centralised filesystem path resolution. Exports `homeDir()` (HOME-env-first override for testability), `memeshDir()` (MEMESH_DIR > `<home>/.memesh`), `getDbPath()` (MEMESH_DB_PATH > `<memeshDir>/knowledge-graph.db`), `getMemeshDirFromDbPath()` (parent dir of active DB file, used for sibling state files), and `getProjectName(cwdInput?)`. Automatic project identity is `<readable repo label>~<32 hex>`: the suffix hashes a password-free remote locator when a network remote exists, otherwise the native real path of the primary Git root or non-Git directory. Standard GitHub HTTPS and `git@github.com` spellings converge; generic SSH locators retain the login, absolute-versus-home-relative path semantics, and literal `.git` suffix so distinct repositories do not collide. This keeps one repo stable across clones, subdirectories, symlinks, and linked worktrees while isolating unrelated same-basename repositories. Results are resolved once per cwd and cached. Replaces 10+ inline `process.env.MEMESH_DB_PATH ?? path.join(os.homedir(), …)` patterns that had subtly different fallbacks. Hooks run the always-on capture path even when `dist/` is absent or stale (plugin-marketplace `--ignore-scripts`; source pull before build), so they cannot import the main `dist/` tree at will. Because `paths.ts` and `src/storage/fts-index.ts` are runtime-leaf modules, `npm run build` copies their compiled output to `scripts/hooks/_generated/` (via `scripts/generate-hook-core.mjs`); `_shared.js` imports that committed, version-locked copy. This replaces the former hand-mirror (the source of the P0 FTS drift): the copy is byte-locked to core and gated three ways — a CI `git diff` on rebuild, `tests/hooks/mirror-parity.test.ts`, and the `memesh doctor` manifest.

**scoring.ts** — Multi-factor scoring engine. `scoreEntity()` combines five signals from `DEFAULT_WEIGHTS`: search relevance (0.30), recency via exponential decay (0.25), access frequency via log normalization (0.18), confidence (0.17), and recall-effectiveness impact via Laplace smoothing (0.10). `rankEntities()` sorts any entity list by score descending. Applied in all recall paths (`recall()` and `recallEnhanced()`).

Session-start hook ranking is a SQL-only subset (no FTS query, no impact pass) that uses three of the five factors. `SESSION_START_WEIGHT_RATIO` exports the renormalised weights so the hook's hard-coded SQL stays in sync; a drift-guard test in `tests/core/scoring.test.ts` asserts the magic numbers in `scripts/hooks/session-start.js` match. The hook SQL uses SQLite's `exp()`/`log()` (present in Node's bundled SQLite) to match the core math exactly, with a runtime probe + linear/rational fallback for stripped-down builds without `-DSQLITE_ENABLE_MATH_FUNCTIONS`.

Recall is intentionally one local FTS5 path. There is no provider, embedding,
vector supplement, or model-powered query expansion to configure or diagnose.

**lesson-engine.ts** — Structured lesson management. `createLesson()` stores a `StructuredLesson` as a `lesson_learned` entity with upsert-safe naming (`lesson-{project}-{errorPattern}`). Same error pattern in different sessions updates the existing lesson. `createExplicitLesson()` supports the `learn` MCP tool; an explicit lesson with no caller-supplied `errorPattern` is keyed on a human-readable prefix plus a short digest of its complete normalised error (`lesson-{project}-{readable-prefix}-{digest}`), so lessons that share their first eight significant words still remain distinct while a resubmitted lesson appends — the seven-value `inferErrorPattern()` set is a coarse classifier, and keying explicit lessons on it fused everything outside those categories into one `-other` bucket per project. `findProjectLessons()` queries lessons for proactive warnings.

**patterns.ts** — User work patterns computation (shared by MCP `user_patterns` tool and HTTP `GET /v1/patterns`). `computePatterns()` queries the database for work schedule (hour/day distribution), tool preferences, focus areas, workflow metrics, strengths, and learning areas. Accepts optional `categories` filter array.

**memory-tool.ts** — Executes Anthropic's `memory_20250818` tool against the knowledge graph. The tool is client-side: Claude requests file operations and the application performs them, and Anthropic's contract states that `/memories` is "a prefix that your handler maps onto real storage, such as a per-user directory or keys in a database". Here that storage is MeMesh, so a model using the plain Messages API gets search, ranking, decay, relations and namespaces underneath a file-shaped view. Each entity renders as one file whose lines are its observations, **ordered by observation id** — insertion order, never score, because `view` and the edit that follows it are separate turns and a hook writing in between would otherwise move the lines the model just read. Deliberately not an MCP tool: the MCP surface serves an agent that already speaks MeMesh, while this serves an application that speaks only the Messages API.

**version-check.ts** — Queries the npm registry for the latest `@pcircle/memesh` version and emits an update notification if the installed version is behind.

### db.ts -- Database Layer

Manages the SQLite connection lifecycle and schema initialization.

- `openDatabase(path?)` -- Opens (or reuses) a SQLite connection
- `closeDatabase()` -- Closes the connection
- `getDatabase()` -- Returns the active connection (throws if not opened)
- Schema: Creates tables (`entities`, `observations`, `relations`, `tags`) and FTS5 virtual table (`entities_fts`)
- Pragmas: WAL journal mode, foreign keys enabled

Default database path: `~/.memesh/knowledge-graph.db` (overridable via `MEMESH_DB_PATH`).

### knowledge-graph.ts -- Knowledge Graph

CRUD operations and full-text search over the entity graph.

**Entity operations**:
- `createEntity(name, type, opts?)` -- Insert or ignore, add observations/tags, rebuild FTS index
- `createEntitiesBatch(entities[])` -- Wraps multiple creates in a single SQLite transaction
- `getEntity(name)` -- Full entity with observations, tags, and relations
- `deleteEntity(name)` -- Cascading delete (observations, relations, tags, FTS entry)

**Relation operations**:
- `createRelation(from, to, type, metadata?)` -- Insert or ignore
- `getRelations(entityName)` -- All outgoing relations for an entity

**Search**:
- `search(query?, opts?)` -- FTS5 MATCH query with optional tag filtering; tracks access on returned entities. With `includeArchived`, archived rows are matched by `LIKE` because `archiveEntity()` removes them from FTS5. One- and two-term queries use OR matching; queries with three or more terms try strict all-term matching first and fall back to OR only when strict matching has no hits. Rows are ordered by BM25 rank before multi-factor scoring. Terms are bounded and ubiquitous terms are removed on larger corpora. Both indexed text and queries use the same NFC normalisation and unspaced-script segmentation, so CJK, kana, hangul, Thai, Lao and Khmer remain searchable without a second retrieval path.
- `listRecent(limit?)` -- Most recent entities by ID
- `findConflicts(entityNames[])` -- Returns conflict descriptions for any `contradicts` relations among the given entity names; surfaced as warnings by all three transports

FTS5 is configured as a contentless virtual table (`content=''`). The `rebuildFts()` method handles explicit insert/delete operations required by contentless FTS5.

### mcp/server.ts -- MCP Server

Entry point for the `memesh-mcp` binary and the MCP server itself. Creates the server with stdio transport, registers tool handlers from `handlers.ts`, opens the database on startup.

There used to be a `launcher.ts` in front of it whose whole job was to instantiate an in-memory better-sqlite3 database, detect a missing native binding, run `npm rebuild`, and re-exec the process for a clean module cache. `node:sqlite` has no binding to miss, so the guard and its re-exec are gone and the bin points straight at the server.

### transports/mcp/handlers.ts -- MCP Tool Handlers

Thin adapter: imports shared Zod schemas from `transports/schemas.ts`, validates input, delegates to `core/operations`, wraps result in MCP `ToolResult` format.

| Tool | Schema | Handler |
|------|--------|---------|
| `work_package` | WorkPackageSchema | Delegates to `core/dreamer.executeWorkPackage()` with the MCP client's bounded workspace-root context |
| `remember` | RememberSchema | Delegates to `operations.remember()` |
| `recall` | RecallSchema | Delegates to `operations.recallWithConflicts()` (backed by `recallEnhanced()`) |
| `forget` | ForgetSchema | Delegates to `operations.forget()` |
| `export` | ExportSchema | Delegates to `operations.exportMemories()` |
| `import` | ImportSchema | Delegates to `operations.importMemories()` |
| `learn` | LearnSchema | Delegates to `operations.learn()` |
| `task_state` | TaskStateSchema | Delegates to `core/task-state-store` (`getTaskState()` with no fields, `setTaskState()` otherwise) |
| `briefing` | BriefingSchema | Delegates to `core/briefing.assembleBriefing()` |
| `user_patterns` | UserPatternsSchema | Delegates to `core/patterns.computePatterns()` |
| `improvement` | ImprovementSchema | Delegates to `core/product-improvements` for proposal staging and status reads |
| `message` | MessageSchema | Delegates to `transports/agent-messaging.executeAgentMessageAction()` |

### transports/http/server.ts -- HTTP REST API Server

Express server exposed via `memesh serve` (default port 3737; the endpoint count is stated once, in the module list above, and checked against `server.ts` by `scripts/check-doc-claims.mjs`). Delegates product operations to the shared core modules. `GET /v1/analytics` returns the health score and factors, memory-loop metric, critical-lesson counts, citation compliance, 30-day timeline, age matrix, and knowledge radar. See [HTTP REST API](api/API_REFERENCE.md#http-rest-api) in the API Reference.

### transports/cli/cli.ts -- CLI

Commander-based CLI exposed via the `memesh` binary. The public command list is
derived from `cli.ts` and checked by `scripts/check-doc-claims.mjs`.

### dashboard/ -- Packaged Dashboard SPA

The primary dashboard is now the packaged Preact single-page app served by `GET /dashboard` from `dashboard/dist/index.html`.

- packaged with the npm artifact under `dashboard/dist/`
- preferred over the legacy HTML generator path
- used for live local inspection, proposal review, update preferences, and UI locale

**Dashboard tabs**:

| Tab | Feature |
|-----|---------|
| Home | Local memory status plus staged work-package review; the analytics stack — health score, 30-day timeline, **MemoryAgeMatrix** (type × age heat map), **KnowledgeRadar** (6-axis SVG), work patterns — remains read-only |
| Memories | The whole library behind one surface: instant client filter + Enter for server-ranked recall, work-layer / evidence / all / archived scope chips (`layerOf()` over the shared `WORK_LAYER_TYPES` whitelist), cluster composition bar, per-row expandable detail (structured lesson bodies via `LessonCards`), inline archive/restore |
| Project | One project behind a project selector: the owner-stated task state (`memesh task` — goal / next / blocked / done, with its timestamp and a provenance line) above the retrospective **Project History** (capture-density phases, key lessons). Absent state renders as "not stated", never as a guess |
| Settings | Package update preferences and browser-local interface locale |

The dashboard is a client of the ordinary HTTP API — no private endpoints — so the endpoint list lives in exactly one place: the route table in [API_REFERENCE.md](api/API_REFERENCE.md#http-rest-api), which `scripts/check-doc-claims.mjs` checks against `server.ts`'s registrations. A copy of it used to sit here and had already rotted: it named seven endpoints and missed two routes the dashboard called (one of them `/v1/projects`). A second list nothing gates is a list that goes quietly wrong. When the packaged build is unavailable, the HTTP server falls back to the legacy `cli/view-live.ts` HTML generator for compatibility.

---

## Data Flow

### Store knowledge (remember)

```
Tool call: remember({name, type, observations, tags, relations})
       or: remember({note})                      # free text, #324
  -> Zod validation (RememberSchema)
  -> resolveRememberInput()
     -> deriveNote() when `note` was given
        -> title from the first line, one observation per paragraph
        -> name from a slug of the title + a digest of the text
  -> replace: true only:
     -> refuse when the memory was archived with forget
     -> snapshot the previous title/observations/tags FIRST
     -> KnowledgeGraph.clearEntityData(name)   # the snapshot must precede this
     -> stored type is kept unless a different `type` was passed
  -> KnowledgeGraph.createEntity(name, type, {observations, tags})
  -> replace: true only: the snapshot -> metadata.replaced_history (after the write)
     -> INSERT OR IGNORE into entities
     -> INSERT observations
     -> Rebuild FTS5 index
     -> INSERT OR IGNORE tags
     -> Preserve original type on duplicate entity names (append path)
  -> KnowledgeGraph.createRelation() for each relation
  -> Return {stored: true, entityId, ...}
```

### Wake an eligible local message recipient (optional)

```
message send (MCP / HTTP / CLI)
  -> durable exact-recipient message + notification event in SQLite
  -> owner-private local agent router
  -> eligible active supported host adapter (for example, configured Codex)
  -> bounded untrusted full message through the native host channel
     (64 KiB JSON-encoded durable payload; 16 KiB complete native envelope)
  -> exact-session send returns only after native host acceptance
```

Implementation anchors: `src/core/agent-messaging.ts`, `src/core/agent-router.ts`,
`src/transports/agent-messaging.ts`, `src/host-adapters/`, `src/host-runtime/`, and
`docs/platforms/agent-messaging.md`.

This branch is optional and local-only: an oversized full envelope returns `native_message_too_large`; unavailable, stopped, disconnected, or unsupported exact sessions return `recipient_unavailable` and are not resumed or replaced. A host queue acceptance is a host receipt, not recipient acknowledgement or workflow disposition. See the [`message` API contract](api/API_REFERENCE.md#message) and the [Local Agent Messaging Guide](platforms/agent-messaging.md) for the lifecycle and supported-host limits.

Before sending, `message discover` can read the router's live registrations for
one exact project. It returns session/principal routing identity, host kind,
declared model and work summary, generation, and authoritative lease expiry.
The directory is in-memory presence joined to the current connection row; it is
not a second durable registry, and the read creates no message or receipt facts.

### Search knowledge (recall)

```
Tool call: recall({query, tag, limit})
  -> Zod validation (RecallSchema)
  -> recallWithConflicts() in core/operations
     -> recallEnhanced()
        -> KnowledgeGraph.search() — FTS5 keyword match
        -> rankEntities() applies multi-factor scoring (relevance, recency, frequency, confidence, impact)
     -> KnowledgeGraph.findConflicts() checks for contradicts relations among results
  -> Return {entities, retrieval}; add conflicts only when non-empty (never a bare array)
```

### Prepare agent-assisted memory (`work_package`)

```
Agent calls work_package.prepare(project, kind)
  -> digest: select one bounded deterministic calendar cluster
  -> transcript: request MCP roots, require one matching canonical workspace,
     then select bounded visible user/assistant turns from its newest Claude Code session
  -> agent submits one strict result bound to package_id + ref, or defers
  -> submit stages one pending proposal plus bounded redacted review evidence
     (nothing enters the graph yet)
  -> human review: memesh dream show <id> / accept <id> / reject <id>
     -> Dashboard exposes the same list/detail/accept/reject surface
```

The interactive suggestion belongs to an already-running host session. Where
the host supports choices, it may offer **Dispatch agent task**, **Later**, or
**Don't suggest again**. The Dashboard cannot wake or dispatch an agent; it
only reviews proposals that are already staged.

### Archive knowledge or remove one observation (`forget`)

```
Tool call: forget({name, observation?})
  -> Zod validation (ForgetSchema)
  -> with observation: KnowledgeGraph.removeObservation(name, observation)
     -> Remove only the matching observation and rebuild that entity's FTS entry
     -> Return {observation_removed, remaining_observations, entity_found}
  -> without observation: KnowledgeGraph.archiveEntity(name)
     -> Mark the entity archived and remove it from the active FTS index
     -> Return {archived: true/false}
```

`forget` never permanently deletes the entity. Archived rows remain recoverable
and can still be included by the explicit archived-search path.

---

## Database Schema

```sql
-- Core tables
entities (id PK, name UNIQUE, type, created_at, metadata JSON, status, access_count, last_accessed_at, confidence, valid_from, valid_until, namespace DEFAULT 'personal')
observations (id PK, entity_id FK, content, created_at)
relations (id PK, from_entity_id FK, to_entity_id FK, relation_type, metadata JSON, created_at, UNIQUE constraint)
tags (id PK, entity_id FK, tag)

-- Indexes
idx_tags_entity (entity_id)
idx_tags_tag (tag)
idx_observations_entity (entity_id)
idx_relations_from (from_entity_id)
idx_relations_to (to_entity_id)

-- FTS5 virtual table (contentless)
entities_fts USING fts5(name, observations, content='', tokenize='unicode61 remove_diacritics 1')
```

Foreign key cascades: deleting an entity automatically deletes its observations, relations, and tags.

---

## Hook Architecture

Hook commands are defined in `hooks/hooks.json`: eight run at Claude Code lifecycle events, while the separate Codex SessionStart/SessionEnd lifecycle registers and retires eligible ordinary Codex CLI sessions.

### Hook Commands (9 hooks)

| Hook | Event | Purpose |
|------|-------|---------|
| pre-edit-recall.js | PreToolUse (Edit/Write) | Continuous recall: inject relevant memories when editing files |
| session-start.js | SessionStart | Auto-recall + record injected IDs + noise compression |
| post-commit.js | PostToolUse (Bash) | Record git commits with diff stats |
| decision-nudge.js | PostToolUse (ExitPlanMode/AskUserQuestion) | Remind the model to `remember` a decision just made — once per tool per session |
| session-summary.js | Stop | Auto-capture session knowledge + recall effectiveness tracking |
| pre-compact.js | PreCompact | Save knowledge before compaction |
| user-prompt-intent.js | UserPromptSubmit | Detect "remember" intent (5 languages: en, es, fr, pt, zh-TW) and remind Claude to use mcp__memesh__remember |
| guard-check.js | PreToolUse (Bash) | Fire accepted lesson-guards against the command about to run (warn-only; fires counted) |
| codex-session.js | Codex SessionStart (startup/resume) + SessionEnd | Launch an owner-private detached registration companion, retain a bounded 45-second idle queue window after SessionEnd, replace the exact generation on resume, and retire it at expiry; a matching owner-private config optionally overrides project/principal |

### Pre-Edit Recall (`scripts/hooks/pre-edit-recall.js`)

- **Trigger**: `PreToolUse` event on `Edit` and `Write` tools
- **Matcher**: `Edit|Write`
- **Behavior**: Reads the file path from tool input, queries MeMesh for entities tagged with the file name or matching via FTS5 search. Returns relevant memories as additional context. Throttled to max 1 recall per file per session via temp file (`~/.memesh/session-recalled-files.json`). Timeout: 5 seconds.

### Session Start (`scripts/hooks/session-start.js`)

- **Trigger**: `SessionStart` event (every new Claude Code session)
- **Matcher**: `*` (all sessions)
- **Behavior**: Opens the database, ranks entities tagged with the current project (plus recently-active entities across projects and active `lesson_learned` entities), and emits **two separate channels**:
  - `systemMessage` — a one-line count banner (`◉ MeMesh · 4 project + 5 recent memories · 1 active lesson`) plus any deprecation / update-available banner. Claude Code renders this to the **human only**; `normalizeAttachmentForAPI` strips the `hook_system_message` attachment from the model's context.
  - `hookSpecificOutput.additionalContext` (`hookEventName: "SessionStart"`) — the **model-facing** payload: the ranked entities with a first-observation snippet each, lessons first. Capped at 4000 characters (Claude Code's own limit is 10000) so session start primes the model without eating its working context.

  Splitting the channels is load-bearing, not cosmetic. Before v4.2.7 the hook emitted **only** `systemMessage`, so nothing it recalled ever reached the model even though the banner reported a memory count — and the Stop hook then charged each of those entities a `recall_miss` for not appearing in a transcript they were never shown in, permanently depressing their `impactScore`. Regression tests in `tests/hooks/session-start.test.ts` assert the model-facing payload directly.

- Records the injected entity IDs, names, and the **exact injected text** to `~/.memesh/sessions/<pid>-<timestamp>.json` for recall-effectiveness tracking. `session-summary.js` subtracts that text from the transcript before hit/miss matching so memesh's own injection is never mistaken for the user referencing a memory. Files older than 24h are pruned on each run.
- After output, runs `compressWeeklyNoise()` (throttled to once per 24h) to archive old auto-tracked noise into weekly summaries

### Post Commit (`scripts/hooks/post-commit.js`)

- **Trigger**: `PostToolUse` event on `Bash` tool
- **Matcher**: `Bash` (filters for git commit commands)
- **Behavior**: Detects git commit messages from tool output, creates a `commit` entity with the commit message as an observation, tags with the project name; includes diff stats (files changed, insertions, deletions)

### Decision Nudge (`scripts/hooks/decision-nudge.js`)

- **Trigger**: `PostToolUse` event on `ExitPlanMode` and `AskUserQuestion` tools
- **Matcher**: `ExitPlanMode|AskUserQuestion`
- **Behavior**: The read side of MeMesh is automatic; the write side was not (#277) — an agent could make several decisions in a session and store none of them until the user asked. This hook fires at the two tool calls where a decision most likely just happened (a plan got approved, a question got answered) and emits a one-line `additionalContext` reminder to call `remember` if the decision is worth keeping. Rate-limited to once per tool per session via a private flag file under `~/.memesh/decision-nudge-flags/`. Never opens the database — it only reminds, it does not capture — so it stays fast and cannot be slowed by lock contention. Fails silently (exit 0, no output) on malformed input or a missing/unsafe `session_id`.

### Session Summary (`scripts/hooks/session-summary.js`)

- **Trigger**: `Stop` event (when Claude finishes responding)
- **Matcher**: `*` (all sessions)
- **Behavior**: Extracts session knowledge (files edited, errors fixed, decisions made) with deterministic rules and stores it as entities in the knowledge graph. It reads the newest exact-project injection record under the database directory's `sessions/` folder, strips hook-output echoes, and increments `recall_hits` only for explicit `[mem:id]` citations that match entities injected into that session. `recall_misses` stays unchanged because absence of a citation is not proof that the memory was unused. Opt-out via `MEMESH_AUTO_CAPTURE=false`
- **On the same Stop (#324)**, `scripts/hooks/_stop-notes.js` also ingests the project's memory directory as note files and, separately, prints a remember nudge. Only the ingestion is a write, and only it is gated on `MEMESH_AUTO_CAPTURE=false`; the nudge sits outside that check.

### Pre-Compact (`scripts/hooks/pre-compact.js`)

- **Trigger**: `PreCompact` event (before context compaction)
- **Matcher**: `*` (all sessions)
- **Behavior**: Saves a snapshot of session knowledge before context is compacted, ensuring memories are not lost during long sessions; opt-out via `MEMESH_AUTO_CAPTURE=false`

### User Prompt Intent (`scripts/hooks/user-prompt-intent.js`)

- **Trigger**: `UserPromptSubmit` event (every user prompt)
- **Matcher**: `*` (all sessions)
- **Behavior**: Detects explicit "remember/save/memorize" intent in the user's prompt via conservative regex. Supported languages: English ("remember this", "save to memesh"), Spanish ("recordar esto", "guardar en memesh"), French ("rappeler ceci", "sauvegarder dans memesh"), Portuguese ("lembrar isto", "salvar em memesh"), Traditional Chinese ("記下來", "存到 memesh"). On match, emits `additionalContext` JSON reminding the agent to call `mcp__memesh__remember` for cross-project recall. Polite-reminder design (not autonomous extraction): the user's intent is clear, but *what* to remember depends on conversation context the calling agent already has. Defensive: never blocks the prompt; malformed stdin and other errors surface to stderr without affecting submission. Opt-out via `MEMESH_AUTO_CAPTURE=false`

### Hook outcome records (capture liveness)

A heartbeat (`hook_runs`) proves a hook ran; it cannot tell a hook that decided
there was nothing to save from a hook whose capture path is broken. So the eight
capture hooks (`post-commit`, `session-summary`, `pre-compact`,
`pre-edit-recall`, `user-prompt-intent`, `decision-nudge`, `guard-check`,
`session-start`) also append one outcome record per run to
`hook-outcomes.jsonl` beside the database, through `recordHookOutcome` in
`scripts/hooks/_shared.js`:

- **Every exit path records** `wrote`, `notified`, `skipped` + reason, or
  `error`. The line between the first two is the point of the record: `wrote`
  means a memory was stored and nothing else, because it is the numerator of the
  signal doctor uses to answer "is capture alive"; `notified` is for a hook whose
  effect is text a person or a model sees — an injected context, a printed
  warning, a nudge. Six hooks recorded those as `wrote` until #324, each with its
  own comment saying it was not a memory. Skip
  reasons are `SKIP_REASONS` constants (the gate below rejects a literal), and
  doctor quotes only those; anything else shows as `unrecognised reason`. An outer
  catch records only `uncaught <code or name>`; the exception text goes to
  stderr, never to the file.
- **Append-only JSONL**, one `O_APPEND` write per record, opened with
  `O_NOFOLLOW` where the platform has it — hooks that fire in the same second
  cannot overwrite each other, and a planted symlink is not followed.
- **Rotation** starts when the file passes 64 KiB: each hook keeps its last 20
  triggered records plus its last 5 not-triggered ones (so a loud hook cannot
  push a quiet one out, and post-commit's skip on every non-commit Bash call
  cannot push out the commits), and if that is still too large only the
  newest lines that fit in half the budget are kept. The reader applies the
  same window. The
  rewrite goes through a randomly named temp file and a rename.

The verdict lives in `src/core/capture-liveness.ts`, a leaf module that
`scripts/generate-hook-core.mjs` copies next to the hooks, so `memesh doctor`
and the SessionStart banner reach the same verdict from the same code. Doctor
adds the database side (auto-capture entities per type, week over week, and the
`hook_runs` heartbeats); the banner reads only the JSONL. Only post-commit,
session-summary and pre-compact can be "silent", because only their triggers
imply a write is due; only session-summary can FAIL, because only its trigger
(a session ending) is guaranteed. The `--json` shape is in
[API_REFERENCE.md](api/API_REFERENCE.md#memesh-doctor--capture-liveness).

Two gates keep this honest. `npm run audit:hook-outcomes`
(`scripts/audit/hook-outcome-gate.mjs`, part of `verify:release`) fails when any
exit in a capture hook has no outcome record before it, or when session-start
writes to stdout anywhere but its single `output()` funnel. `npm run
qa:post-release` runs the shipped hooks against a throwaway graph after a
release and requires one captured commit and one captured session insight.

---

## Knowledge Evolution

MeMesh supports knowledge lifecycle management through soft-delete and supersedes semantics:

- **Archive (soft-delete):** `forget` sets entity status to 'archived', removing it from FTS5 search but preserving all data (observations, relations, tags)
- **Observation-level forget:** Remove specific observations without archiving the entity
- **Supersedes relations:** `remember` with `relations: [{type: "supersedes"}]` auto-archives the old entity, creating a knowledge evolution chain
- **Reactivation:** `remember` on an archived entity automatically reactivates it (status → 'active', FTS5 rebuilt)
- **Include archived:** `recall` with `include_archived: true` shows all entities including archived ones, marked with `archived: true`

Data lifecycle: `active` → `archived` (never deleted). Archived entities can be reactivated by calling `remember` with the same name.

---

## Ecosystem Compatibility

MeMesh supports three integration tiers:

| Tier | Client | Integration Method |
|------|--------|--------------------|
| **Native plugin** | Claude Code | Plugin (`.claude-plugin/plugin.json` + 8 lifecycle hooks) |
| | Hermes Agent | Native `MemoryProvider` plugin (Python ABC, convention-based discovery) |
| | OpenClaw | Source-only native memory-capability plugin (TypeScript, `api.registerMemoryCapability()`); not published or runtime-verified |
| **MCP server** | Claude Managed Agents | MCP connector (beta, via session config) |
| | Claude Desktop | MCP server config |
| | Codex CLI | Plugin-managed MCP server (`dist/mcp/server.js`), or manual `memesh-mcp` client config |
| | Gemini CLI | MCP server (`memesh-mcp` in client config) |
| | Cursor | MCP server (`memesh-mcp` in client config) |
| | Custom apps | Direct stdio MCP connection |
| **HTTP API** | Custom apps/scripts | `memesh serve`: documented `/v1` routes, plus `/dashboard` and `/favicon.ico` |

See [docs/platforms/](platforms/) for platform-specific integration guides.

### Anthropic API Feature Alignment

| Feature | Relevance to MeMesh |
|---------|---------------------|
| Prompt Caching | Session-start memories benefit from automatic caching |
| Compaction | MeMesh memories survive compaction (external DB) |
| Memory Tool | MeMesh offers local-first structured alternative |
| Agent Skills | MeMesh can be loaded as a custom Agent Skill |

---

## Testing

The automated test suite covers:

- database lifecycle and schema setup
- knowledge graph CRUD, relations, FTS search, and tag filtering
- MCP tool validation and dispatch
- hook behavior for session start and post-commit flows
- dashboard HTML generation and XSS escaping
- repository/package structure checks

Framework: vitest (forks pool mode to avoid SIGSEGV with native modules).

For release safety, `npm run test:packaged` creates a real npm tarball, extracts it, and verifies the published artifact still contains the required runtime files, hook scripts, bundled D3 asset, and package exports.

---

## Memory Lifecycle (v3.0.0)

### Auto-Decay
- Runs on openDatabase() when last decay was 24h+ ago
- Entities not accessed in 30+ days: confidence *= 0.9
- Floor: confidence never below 0.01
- Never deletes — only affects search ranking

### Agent-assisted digest and transcript review
- `work_package` prepares one bounded calendar digest or visible-turn transcript package.
- The already-running agent may submit one strict result or defer without durable change.
- Submission only stages a proposal. A human reviews full detail and accepts or rejects it through the existing CLI or Dashboard review surface.
- The Dashboard does not prepare packages and cannot start or wake an agent.

### Smart Session-Start
- Session-start hook loads top-N entities by weighted score
- Score = recency (~42%) + frequency (30%) + confidence (~28%) — the `SESSION_START_WEIGHT_RATIO` constants in `src/core/scoring.ts`, derived from `DEFAULT_WEIGHTS`; this line previously said 40/30/30 with confidence first, which matched no version of the code
- Default N=10, configurable via MEMESH_SESSION_LIMIT
- Concise format: "• name (type): first observation"

---

## Cross-Project Collaboration (v3.0.0)

### Namespaces

Entities carry a `namespace` field (`personal` | `team` | `global`, default: `personal`). SessionStart injection reads `global` as cross-project: after the project's own window it adds up to three trusted, active global-namespace entities, so a memory stored in `global` reaches a project it was never tagged with. Namespaces allow:

- **personal** — private to the individual user / current project
- **team** — shared across a team; visible when `--cross-project` or namespace filter is applied
- **global** — available in all recall contexts regardless of project tag

### Export / Import

`operations.exportMemories(opts)` serialises matching entities (filtered by namespace, tags, or names) to a structured JSON bundle. `operations.importMemories(bundle, mergeStrategy)` deserialises and inserts entities with one of three merge strategies:

| Strategy | Behaviour on conflict |
|----------|-----------------------|
| `skip` (default) | Keep existing entity, discard imported copy |
| `overwrite` | Replace existing entity's observations and tags |
| `append` | Append imported observations, dedup tags |

### Cross-Project Recall

`recall` accepts a `cross_project: true` flag. When set, the project-tag filter is lifted and FTS5 search spans all namespaces. The same multi-factor scoring applies.

### Personal Backup and Cross-Agent Transfer

```bash
# Export from the personal namespace
memesh export --namespace personal --output memesh-backup.json

# Import on another machine or through another compatible agent
memesh import memesh-backup.json --merge skip
```

---

## Rule-Guided Memory (v3.1.0)

MeMesh captures structured session evidence with deterministic rules and warns about accepted lessons on later matching commands.

### Architecture

```
Session with errors
  → Stop hook detects errors + files edited
  → deterministic extraction records bounded session evidence
  → an explicit `learn` call may store a reviewed structured lesson
  → Next session: session-start queries lessons → proactive warnings
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Lesson Engine | `src/core/lesson-engine.ts` | Structured lesson CRUD + upsert dedup |
| Stop Hook Integration | `scripts/hooks/session-summary.js` | Captures bounded session evidence with deterministic rules |
| Proactive Warnings | `scripts/hooks/session-start.js` | Shows known lessons at session start |
| Learn Tool | All transports | Explicit lesson creation (MCP tool) |

### Lesson Entity Structure

```
type: "lesson_learned"
name: "lesson-{project}-{errorPattern}" (upsert-safe; explicit `learn` without errorPattern → "lesson-{project}-{readable-prefix}-{digest}")
observations:
  - "Error: <what went wrong>"
  - "Root cause: <why>"
  - "Fix: <what fixed it>"
  - "Prevention: <how to avoid>"
tags:
  - "project:{name}"
  - "error-pattern:{category}"
  - "severity:{level}"
  - "source:auto-learned" | "source:explicit"
```

### Feedback Loop

- **Positive signal**: `recall()` increments `access_count` — frequently recalled lessons rank higher
- **Negative signal**: Auto-decay reduces confidence of unused lessons (30+ days → `confidence *= 0.9`)
- **Recurrence**: Same error pattern upserts existing lesson, appending observations as recurrence evidence

---

## References

- [API Reference](./api/API_REFERENCE.md)
- [Model Context Protocol](https://modelcontextprotocol.io)
