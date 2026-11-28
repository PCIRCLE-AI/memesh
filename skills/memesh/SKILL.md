---
name: memesh
description: "Use MeMesh to remember, recall, and manage AI knowledge across sessions, and to exchange task-focused messages with local agents. Triggers when the user asks to remember something, recall past decisions, forget outdated info, learn from mistakes, analyze work patterns, contact another agent, or handle a memesh_message or memesh_message_notice notification. Also triggers when the user asks \"what do you remember\", \"where did we leave off\", or wants to catch up on a project; when a session starts and project context is needed; and proactively when you make decisions, learn user preferences, fix bugs, learn lessons, or owe another agent a requested result or disposition."
user-invocable: true
---

# MeMesh — AI Memory Management

Persistent memory for AI agents. Load the saved project context at session start so decisions and relevant work history need less rediscovery; verify any handoff against current files and the user's request.

## How to Access (auto-detect)

```
1. MCP tools available? (remember, recall, forget, learn in your tool list)
   → YES: use MCP tools directly (fastest, structured I/O)
   → NO: continue to step 2

2. CLI available? Run: memesh status
   → Works: use CLI commands below
   → "command not found": Run: npx @pcircle/memesh status
   → Works: use npx @pcircle/memesh <command> for all commands below
```

All examples below use CLI. MCP tools accept the same parameters as JSON objects.

The CLI's `remember` and `learn` file a new memory under the current directory's project (`--project <id>` names another; `remember --no-project` stores one with none). Appending to an existing unfiled memory without an explicit project or project tag keeps it unfiled; omit `--type` to keep its type.

Over MCP, `remember`, `learn` and `recall` also take `project`: a project id, or `false` for a memory that belongs to no project. Omitted, the call uses the project the session is bound to (the client's workspace root, or `MEMESH_PROJECT_ROOT`); a call that needs a project and finds none is refused with `workspace_unavailable`. An append to an existing unfiled memory with no explicit project or project tag stays unfiled and can omit `type`. Existing rows cannot be moved or overwritten across scopes.

With a declared project, an original name resolves to that project's existing memory, including checkout aliases. If another project owns the name, creation uses `<name>@<full-project-id>` (a numeric suffix if occupied) and returns the actual name. Scoped append, replace, forget, relation and native-editor operations accept the original name. Without a declared project, names remain literal; unfiled legacy rows keep their existing append policy. For user-requested `forget`, a same-project namesake takes priority; otherwise ordinary forgetting uses the supplied actual name.

## All 12 MCP tools

| Tool | Purpose |
|---|---|
| `work_package` | Prepare one bounded untrusted `digest` (calendar cluster) or `transcript` package from the newest Claude Code session under the client's single matching MCP workspace root; submit exactly one strict result or defer. Submit only stages pending human review and retains bounded redacted source turns for comparison; agents cannot apply or reject. No hidden reasoning, raw transcript, transcript path, API key, LLM, embedding, or vector data is exposed or used; hashes identify freshness and workspace scope rather than authentication. |
| `remember` | Store knowledge as an entity with observations, tags, and relations; `note` (free text) derives title/observations/name; `replace: true` rewrites a named memory, keeping history; `why` is optional for decisions |
| `recall` | Search stored knowledge, list recent memories, or retrieve up to 20 exact IDs; keep `ids` separate from query, tag and cross_project |
| `forget` | Archive an entity or remove one exact observation |
| `export` | Export memories as portable JSON |
| `import` | Import a JSON export with the required skip, append, or overwrite strategy |
| `learn` | Record a structured lesson with error, fix, root cause, and prevention |
| `task_state` | Read or update user-stated goal, next step, blocker, and finished work |
| `briefing` | Assemble the current project's work topology — task state and up to three session tails precede ranked memories at every level, after optional repository facts; `minimal` then shows decisions, lessons, knowledge and recent activity plus memories with no project and a few preferences of other projects, closing with the recent index (titles of the 30 most recently written memories in scope) at every level, and `full` adds other projects and global memory |
| `user_patterns` | Analyze work schedule, focus areas, and commit workflow |
| `improvement` | Propose an evidence-linked product improvement or read its status; only a human may accept or reject it |
| `message` | Discover a conversation address, then send, read, or inspect a typed, untrusted conversation message and its audit state |

## The Loop

Five moments. Everything else in this file is detail.

**SESSION START → load the briefing (once).**
Call the `briefing` MCP tool or run `memesh briefing`. After optional repository
facts, task state precedes the latest trusted assistant reply from up to
three sessions in this project and its aliases. Each tail including its header
and handle is limited to 600 UTF-8 bytes; old and unknown ages remain visible.
Verify claims against current files before acting. Every level includes fresh
task state, project and no-project memories, and the recent index; `full` also
includes global memory and other projects' recent activity. Task-state fields remain visible with their stated date or an unknown-date
label; `memesh task` reads the full record.

Opening context and briefing share an 8000 UTF-8 byte limit including the
escaped reference wrapper. Task state and up to three session tails take
priority; repository facts, titles, ranked memories and the recent index use
the remaining room. SessionStart also reserves its project line and full-level
work-package notice; briefing does not add that notice.
`memesh briefing --index` returns the standalone durable-memory
catalog with its own 40-line / 3072-byte caps; use `recall` for omitted memories.
Generic briefing has no conversation-recipient identity. Use `message`
`discover` and `status` for the new conversation store. Exact-project/recipient
briefing notices still refer to the legacy graph inbox. If such a notice
asks for retired actions, keep it pending and report the migration gap;
the current conversation tool cannot consume the legacy message id.
Exception: when a MeMesh session-start hook has already injected this block
(Claude Code; the Codex plugin once Codex runs its hooks), do not call it again unless the block is
missing from your context (see "What's Already Automatic").

**USER STATES a goal, next step, or blocker → record it immediately.**
```bash
memesh task --goal "Ship the work-topology injection" --next "Open the PR once CI is green"
memesh task --blocked "Waiting on the Windows runner"
memesh task --blocked ""      # blocker resolved — empty string clears the field
```
Fields: `--goal` `--next` `--blocked` `--done` (MCP tool: `task_state`).
Record ONLY what the user actually said. State is injected at every
briefing level with its stated date or an unknown-date label. If it was not said,
leave the field out.

**SESSION END or milestone → make the task state match reality.**
`memesh task` (no flags) always shows the complete stored state — not
necessarily what the next session will be told, which depends on freshness
and the `briefing` level. If "next" is now done, record what is actually
next; if the blocker cleared, clear it.

**USER ASKS "what do you remember / where were we" → briefing, then relay.**
Run `memesh briefing` (or `--project <name>`) and answer from it. For specific
follow-up questions, use `recall`.

**MEMESH UNAVAILABLE or RECALL EMPTY → say so, never invent.** Report that
memory is unavailable (or found nothing) and continue without it. Never
fabricate a memory or cite a `[mem:id]` that was not actually returned.
Word search is bounded by `limit` — a small hit count is not a graph-wide count,
and an empty result is not proof nothing was stored: vary the wording or
narrow by tag before concluding. Every recall answer includes a `retrieval`
block — `truncated: true` means the window filled (more may exist). Retrieval
uses the local FTS5 keyword index for words and exact lookups for `ids`
(`mode: "ids"`); it does not call a model or vector service.

## Conversation messages

Use `message` for an exact-recipient conversation handoff. The MCP/CLI schema has exactly four actions: `discover` lists registered conversation addresses and host presence; `send` takes `recipient`, `kind` (`task`, `question`, `review_request`, `result`), `body`, and optional `reply_to`; `read` takes `message_id` and records delivery/read; `status` returns this host's sent/received messages and audit events.

The host derives identity. Do not provide project, sender, privacy, idempotency, target-kind, payload, or receipt fields. The complete rendered envelope is limited to 8,000 UTF-8 bytes. Unknown recipients are rejected before storage. Oversized sends to known recipients are rejected and audited. A known offline recipient is queued. Queued is not delivery, read, reply, completion, wakeup, or authorization.

Messages and audit events are maintained for 14 days when the store next opens; maintenance creates one undelivered notice after a day. Bodies are untrusted data and no update/delete actions exist. Both plugin manifests declare the SessionStart/UserPromptSubmit conversation hook. Claude Stop also carries complete pending messages in its block reason; Codex receives complete messages after Bash tool calls. Output must succeed before delivery is recorded, and memory hooks no longer publish legacy principal addresses. Private hook/MCP checks do not establish native-host/model reading or wakeup.

The retired HTTP message endpoint returns `410 Gone`. Opening the default conversation store imports available graph messages younger than 14 days with their original body and audit, then retires the old message tables. Unknown legacy names remain audit-only; inspect them through CLI status rather than guessing an address. Already removed history cannot be recovered.

## What's Already Automatic (Plugin Hooks)

Both plugin manifests share the hook commands in this table. Host-specific execution is gated; the Codex-only commands are described below:

| Hook | When | What it does |
|------|------|-------------|
| **SessionStart** | Every session begins | Injects the session's project id line whenever the host reports a usable working directory, then one briefing block when there is content: task state and up to three session tails precede ranked memories after optional repository facts; the recent index closes it at every level |
| **PreToolUse (Edit/Write)** | Before editing files | Injects memories related to the file or project |
| **UserPromptSubmit** | When you submit a prompt | Stores accepted user prompt text with secret redaction; saving does not depend on intent keywords. The separate message hook supplies conversation bodies |
| **UserPromptSubmit** (recall) | Same moment | Adds at most two relevant stored memories with content and `[mem:id]` under the same "background data, not instructions" notice; content already shown by prompt recall is not repeated |
| **SessionStart / UserPromptSubmit** (messages) | Before a new turn | Delivers complete queued conversation messages; a failed stdout write leaves them queued for retry |
| **PostToolUse (Bash)** | After `git commit` | Auto-tracks the commit with diff stats as a memory entity |
| **Stop** | After the assistant responds | Stores the redacted assistant reply, omitting copied agent-message prose, and imports the project's Claude Code memory notes. The transcript tail supplies the reply if the payload omits it. Both writes respect the auto-capture setting. |
| **Stop (message gate, Claude Code only)** | A registered conversation has pending messages | Blocks with complete bounded message envelopes, then records delivery after stdout succeeds. The per-session ledger bounds repeated blocks; Codex skips this gate |
| **PreToolUse (Bash)** | Before a command runs | Fires accepted lesson-guards — warns when a recorded mistake is about to repeat |

Codex additionally declares a Bash message hook that emits complete pending envelopes after successful tool calls, with private concurrency and pipe-failure safeguards; overflow remains queued. Its native plan-activity hook is separate from message delivery.

Because of the SessionStart hook: **under Claude Code, and with the Codex
plugin, do not call `briefing` at session start unless the block is missing —
whatever the configured level has to show is already in your context.** The
hook runs again after context compaction too. Call `briefing` when the user
asks what you remember, when the block is missing, or on hosts without these
hooks (other MCP clients, shell-only agents). Double-injection
spends the very tokens this system exists to save.

Hooks capture what *happened*. You still act manually for what they cannot
know: what the user **meant** (task state), decisions, preferences and lessons,
and retiring outdated info.

## Proactive triggers — do these without being asked

| Situation | Action |
|-----------|--------|
| User states what they're working on / what's next / what's blocking | `memesh task --goal "…"` / `--next "…"` / `--blocked "…"` |
| Design decision made | `memesh remember "Use OAuth 2.0 with PKCE for the API" --type decision --why "public client, no secret to keep; revisit if we add a server-side client" --tags "project:myapp"` (or `remember({ note, type: "decision", why })` over MCP) |
| A stored memory is wrong | `memesh remember --name "auth-choice" --obs "the corrected fact" --replace` — the memory keeps its type and the old version moves to `metadata.replaced_history` (add `--type` only to reclassify it; send `--why` too when keeping its reason) |
| User states a preference or a fact about their work | `memesh remember "Indent with tabs" --type preference --tags "project:myapp"` (or `remember({ note, type: "preference" })` over MCP) |
| Bug fixed | `memesh learn --error "what broke" --fix "what fixed it" --root-cause "why" --severity major` |
| Starting work on a feature | `memesh recall "feature-name" --json` |
| User asks "what did we decide?" | `memesh recall "topic" --tag "project:myapp"` |
| User asks "where did we leave off?" | `memesh briefing` → relay it |
| Info is outdated | New memory with `--supersedes "old-name"`, or `memesh forget` |
| Context about the user's work habits needed | `user_patterns` MCP tool (MCP/HTTP only — no CLI command) |

### Removing a selected memory
- When the user asks to remove a specific stored memory, identify it with `recall`, then use `forget` with its name or the selected observation. Ordinary capture continues normally.

## Common Scenarios

### The user wants to view or edit a memory in the native interface

Use `recall` to identify and show the memory in the current project. If `remember` advertises
`interactive`, call it with only `name`, `interactive: true`, and optional `project`.
The human form supplies the edit; do not pass replacement text or resubmit after
cancellation. Report `saved`, `unchanged`, or `cancelled` as returned, showing the
actual stored result. If the host reports `native_form_unavailable`, explain the
limitation and use the existing conversation workflow under the user's instruction.
The form shows the original text and offers one optional replacement field per
paragraph plus a title field. The human fills only what should change; blank or
omitted fields keep their original values. Do not fill those fields for the human.
MeMesh 4.11.0 and later provide the `/memesh-memories` Mod entrypoint in Claude Code.
After updating the plugin, restart the host to load it; older releases may lack it.
Claude Desktop edits inside that pane; terminal Claude Code and Codex retain the
MCP form. If no form appeared, do not assume the person cancelled or automatically
save model-written text instead. The Desktop pane prepares a revision and submits
its inputs through the same guarded writer; the revision prevents stale edits
and does not prove human identity.

### You just fixed a bug
```bash
memesh learn \
  --error "SIGSEGV when running vitest with threads" \
  --fix "Use pool: 'forks' instead of 'threads' for native modules" \
  --root-cause "the native module is not thread-safe" \
  --prevention "Check if the test framework supports native modules before choosing pool" \
  --severity major
```
Creates a `lesson_learned` entity. Lessons are surfaced as **proactive warnings** at the next session start.

### A decision was just made
```bash
memesh remember \
  --name "db-choice" --type decision \
  --title "SQLite for local-first storage" \
  --obs "Use SQLite for local-first" \
  --why "PostgreSQL is too heavy to deploy for one user; revisit if we add a hosted tier" \
  --tags "project:myapp" "topic:database"
```
`--why` (MCP: `why`) is optional: it records the reason AND what would make
the decision stop holding. Without it the decision is stored and labelled "no reason recorded". It is stored as `Why: …` and shown next to the decision in
every briefing and in the memory index, so a later session can tell whether it still applies. A decision
shown as "unconfirmed N days" has not been read or added to for a month: recall
it and check the reason still holds before following it.
Use a **stable name** (`db-choice`, not `db-choice-2026-08-16`): reusing the
name appends to the same entity instead of scattering duplicates. `--title` is
the human-readable headline; the name stays the machine key. If this replaces
an older decision, add `--supersedes "old-db-choice"`. To correct it instead
of adding to it, repeat the call with `--replace` and a fresh `--why`.

Quicker when the text is all you have: `memesh remember "SQLite for local-first
storage"` (MCP: `remember({ note: "…" })`). The first line becomes the title,
each following paragraph an observation, and the name is derived from the text,
so repeating the same text does not create a duplicate.
Types: `decision` `pattern` `lesson_learned` `bug_fix` `architecture` `convention` `feature` `best_practice` `concept` `tool` `note`

### You need context on a specific topic
```bash
memesh recall "authentication" --json
memesh recall --tag "project:myapp" --limit 10
memesh recall --cross-project                # search across all projects
memesh recall --ids 301,302 --json            # read memories named by briefing IDs
```

For a `[mem:301]` handle, use `recall({ ids: [301] })` over MCP. Up to 20
positive IDs may be requested, within the caller's scope (the project, memories with no project, global ones that are not untrusted, the decisions, lessons and preferences of any project that are not untrusted and not from its memory folder, and a memory folder's trusted preferences and feedback); `query`, `tag` and
`cross_project` are separate search selectors. Results say `found`, `archived`,
`unavailable` or `omitted`. Archived content needs `include_archived`; an
unavailable ID reveals no content or existence outside scope. Retry omitted
IDs individually; an item still omitted on its own cannot fit the response limit. Found content keeps the normal redaction and size caps.

For session-injected memories, the Claude/Codex Stop hook credits assistant
`[mem:id]` citations or tool-result `[mem-fetched:id]` retrieval markers, once
per ID while the session is active, including resumes. An idle record can be
cleared after 24 hours; reinjection starts a new counting window without
replaying old transcript entries. Ordinary `[mem:id]` text in a tool
result does not count as an assistant citation.

One or two words match any of them. Three or more must all match, with an
any-word fallback only when nothing matches all — so search with a few
specific keywords rather than a whole sentence. Results are ranked by relevance.

### Old info needs updating
```bash
memesh forget --name "auth-approach" --observation "Use JWT"   # remove one fact only
memesh forget --name "old-auth-approach"                       # archive the whole entity
```
Archiving the whole entity is reversible (`recall --include-archived` still finds it, and `remember` with the same name makes it active again). Removing one observation deletes that text for good.

### Memories are getting verbose or stale
Use the **memesh-review** skill: it prepares bounded `work_package` evidence
for an already-running local agent, then leaves every proposal pending for
human review. Do not hand-compress memories yourself.

### Backup, share, health
```bash
memesh export --tag "project:myapp" > memories.json
memesh import memories.json --merge skip     # skip | overwrite | append
# a memory you archived (forgot) stays archived; add --restore-archived to bring it back (with skip it replaces nothing)
memesh status                                # version, install channel, update state
memesh reindex --fts                         # rebuild the local keyword index
```

## Memory hygiene

Record outcomes and reasons rather than process. Do not write again when a review
or retry only confirms the same fact. Make each observation
independently readable with relevant filenames and numbers. Exclude secrets
and passwords.

1. **Stable names append — unless you ask to replace.** Remembering under an
   existing name adds observations and dedupes tags by default. Pass
   `replace: true` (CLI: `--replace`) to rewrite the entity's observations,
   tags and title instead — the previous version moves to
   `metadata.replaced_history`, not lost. Reuse the name to grow or correct
   one memory; do not mint `-v2` / dated variants of it. A replace carries the
   `observations` (or `note`) the memory should now hold, and a replaced
   decision can include `why` again to retain its reason; a reason is optional.
2. **`supersedes` retires the loser.** When a new memory replaces an old one,
   record it with `--supersedes <old-name>` (MCP: a relation of type
   `supersedes`). The old entity is archived — recoverable, out of recall.
3. **`contradicts` flags real conflicts.** When two memories cannot both be
   true and neither is clearly wrong yet, link them with `--contradicts`
   (MCP: relation type `contradicts`). Both surface as a conflict on every
   recall until someone resolves it.
4. **Prefer observation-level forgetting.** `forget --observation "…"` removes
   one wrong fact and keeps the entity. Plain `forget` archives the whole
   entity out of visibility — use it only when everything in it is dead.
5. **Tag by project** and **be specific** — "Use OAuth 2.0 with PKCE", not
   "auth stuff decided". The project tag is `project:<id>`, where `<id>` is
   the `project` field of the `briefing` result, from the CLI `memesh briefing --json` (`myapp` in the
   examples above stands for it). `remember` stores a plain-name tag for
   your own project as the id and reports it in `retagged` — unless a memory
   the call updates or supersedes is already filed under the plain tag, which
   then stays as written (`memesh kg rename-project` moves those); otherwise a
   plain repository name is a different scope that this project's sessions
   never see.
