# Using MeMesh — for AI agents

MeMesh is persistent memory shared by every MCP host on this machine — one
SQLite database at `~/.memesh/knowledge-graph.db`. A memory stored from one
host is recallable from all of them. Not installed yet? Follow
[llms-install.md](llms-install.md).

## The loop that pays for itself

1. **Session start — load, don't re-explore.** Call the `briefing` tool once
   (CLI: `memesh briefing`). It returns the assembled work topology for the
   current project: goal / next / blocked / done, decisions, lessons,
   knowledge, recent activity, and — closing the block — a capped index of
   recent durable memories, one line each with its `[mem:id]` handle
   (`memesh briefing --index` prints just that). The index is a recent
   window, not everything: it holds at most 40 lines / 3072 bytes, memories
   untouched for 180 days collapse into a single count line with no
   `[mem:id]`, and whatever else is cut past those caps becomes an
   `N more — memesh recall --tag "project:…"` line, also with no
   `[mem:id]`. Treat the index as "recent, capped" — when it says there is
   more, call `recall` rather than assuming the index already covers it.
   Read the index instead of re-reading the repo to reconstruct context.
2. **When the user states a goal, a next step, or a blocker — record it.**
   Call the `task_state` tool (CLI: `memesh task --goal "…" --next "…"`). It
   is injected at the start of the next session and acted on as fact.
   - An empty string **clears** a field: pass `blocked: ""` (CLI:
     `memesh task --blocked ""`) once a blocker is resolved.
   - **Record only what the user actually said.** Never infer goal / next /
     done from files edited or commands run — a guessed value becomes a wrong
     instruction to a future session with nothing to contradict it. Leave a
     field out if it was not said.
3. **"What do you remember?"** — call `briefing` and relay its content. Do
   not answer from your own conversation context.
4. **When memory could be condensed from a calendar cluster or a recent Claude Code session** —
   when the host supports interactive prompts, offer concise choices in the
   user's conversation language, such as **Dispatch agent task**, **Later**, or
   **Don't suggest again this session**.
   The last choice suppresses only this session's prompt; it does not create a
   durable opt-out. Dispatch means
   using `work_package` in this already-running agent session; it does not mean
   the Dashboard can start or wake an agent. Prepare either one calendar-selected
   digest package or, when the MCP client supplies one unambiguous matching
   workspace root, one package from its newest Claude Code session's visible
   turns. Submit one bounded result for human review or defer without writing.
5. **When you need another agent** — to hand off, to ask, to report back —
   first use `message discover` with the exact project when you do not already
   know the recipient. It lists only live registrations and their routing IDs,
   host kind, declared model/current work, generation, and lease; missing
   declarations remain unknown. Then send a `message`. The host's own push tool (Claude
   Code's `SendMessage`, a Codex queue) delivers a wakeup; it is not the
   record, and it cannot reach an agent on a different host or one that is
   not running. Generic `briefing` and SessionStart context has no recipient
   identity and stays quiet. Check an inbox with the exact `project` and
   `recipient`; poll first, then fetch each returned `message_id`. Fetching
   does not acknowledge.

## All 12 MCP tools

| Tool | Purpose |
|---|---|
| `work_package` | Prepare one bounded untrusted digest (calendar-selected) or transcript package from the newest Claude Code session under the client's single matching MCP workspace root; submit one strictly validated result for pending human review or defer without durable change. Submission retains bounded redacted source turns for comparison; agents cannot apply or reject, and hashes identify freshness and workspace scope rather than authentication. |
| `remember` | Store knowledge as an entity with observations, tags, and relations; or pass only `note` (free text) and the title, observations and name are derived; `replace: true` rewrites a named memory, keeping the old version as history |
| `recall` | Search stored knowledge (words are OR-ed, ranked by relevance); empty query lists recent |
| `forget` | Archive an entity (soft-delete), or remove one observation via the `observation` parameter |
| `export` | Export memories as portable JSON for sharing or backup |
| `import` | Import a JSON export; `merge_strategy` (required): skip / append / overwrite |
| `learn` | Record a structured lesson: error, root cause, fix, prevention |
| `task_state` | Read or update where the work stands: goal / next / blocked / done |
| `briefing` | The assembled work topology, closing with a capped index of the project's durable memories; exact `project` + `recipient` can surface only that recipient's unfetched deliveries |
| `user_patterns` | Analyze work schedule, tool preferences, and focus areas from memory |
| `improvement` | Propose an evidence-linked product improvement or read its status; only a human may accept/reject it |
| `message` | Discover live agents, then exchange exact-recipient untrusted messages: durable JSON payload max 64 KiB; complete native envelope max 16 KiB with distinct `native_message_too_large` and `recipient_unavailable` errors; delivery reads/acceptance never imply ACK or disposition |

## Memory hygiene

- **The cheapest write is `remember({ note: "…" })`.** First line → title,
  each following paragraph → one observation, name derived from the text
  (the same text twice is one memory). Optional `type` (default `note`),
  `tags`, `name`. The response echoes the derived shape under `derived`.
- **Reuse a stable `name` to append.** Calling `remember` with an existing
  name appends observations and dedupes tags. A fresh name for every update
  creates duplicates that recall must wade through.
- **Correct a memory in one call**: `remember` it again with its `name` and
  `replace: true`. `type` is not needed — the memory keeps the one it has.
  Pass a `type` only to reclassify: one that differs from what is stored
  rewrites it. (`type` is still required on a call with no `note` that is
  not a `replace`, and on a `replace` whose `name` does not exist yet.) Observations are rewritten (tags too
  when you pass them, the title when you pass `title` or `note`); what was
  there moves to `metadata.replaced_history` with the time it was replaced,
  so the wrong line stops showing up in recall but is not lost (recall shows
  only `replaced_history_count`; `export` has the versions).
- **Replacing a decision**: `remember` the new one with a relation of type
  `supersedes` pointing at the old — the old entity is archived (recoverable),
  not left active to contradict the new one.
- **Two memories that cannot both be true**: relation type `contradicts` —
  both then surface as a conflict every time either is recalled.
- **One wrong fact in an otherwise good entity**: `forget` with the
  `observation` parameter removes just that fact and keeps the entity active.
  Prefer it over archiving the whole entity.

## What you must never invent

- If MeMesh is unavailable or a recall returns nothing, **say so and work
  without it** — never fabricate a memory, and never cite a `[mem:id]`
  handle that was not actually shown to you. A wrong "remembered" fact is
  worse than no memory: it arrives wearing the authority of the graph.
- Recall windows are bounded (the `limit` parameter, 30 by default), so do
  not infer graph-wide counts or "there is no memory about X" from the
  number of hits one query returns. Absence of results is absence of
  results, not evidence of absence — vary the wording or narrow by tag
  before concluding anything.
- Every recall answer carries a `retrieval` block that says how it was
  produced — read it instead of guessing: `truncated: true` means the
  window filled and more may exist. Recall is local FTS5 search; do not
  describe results as semantic, vector-ranked, or model-generated.

## What Claude Code already does — do not double-write

Under Claude Code with the MeMesh plugin, hooks capture automatically:

- **SessionStart** injects the work topology (the same block `briefing`
  returns) at the top of the session.
- **PreToolUse (Edit|Write)** surfaces memories related to the file being
  edited.
- **PostToolUse (Bash)** records git commits with diff stats.
- **PostToolUse (ExitPlanMode|AskUserQuestion)** reminds you to `remember` a
  decision just made — once per tool per session. It only reminds; unlike
  the hooks above, it writes nothing to the graph itself.
- **Stop** captures bounded session evidence, including observed error/fix signals.
  It also ingests the project's Claude Code memory directory
  (`~/.claude/projects/<slug>/memory/*.md` — one memory per file with
  `name`/`description`/`metadata.type` frontmatter, tagged `source:note-file`;
  a file that disappears is tagged `source:note-file:missing`, never deleted),
  and when the turn since the last Stop approved a plan, answered a question,
  committed, or turned a test red then green — with no `remember`/`learn` call
  and no note-file change — it shows one line suggesting a `remember`. Both
  the session capture and the note-directory ingestion are writes, so both
  stop when auto-capture is off (`memesh config set autoCapture false`, or
  `MEMESH_AUTO_CAPTURE=false`); the reminder line still runs either way.
- **PreCompact** saves important knowledge before history is compressed.
- **UserPromptSubmit** detects "remember this" intent in the prompt.
- **PreToolUse (Bash)** fires accepted lesson-guards: a fenced warning
  citing the source lesson (`[mem:id]`) when a command matches a mistake
  the graph has recorded. Heed it, and cite the lesson if it changes what
  you do.

So under Claude Code: skip step 1 of the loop (the topology is already
injected), and do not `remember` commits or session summaries by hand. A
decision made via `ExitPlanMode`/`AskUserQuestion` gets a reminder, not a
write — act on it with a real `remember` call. Manual calls are still how
decisions, their rationale, lessons worth keeping, and user-stated task state
actually get stored.

On a host with no hooks (Gemini CLI, Cursor, an MCP-only setup, …) the loop is
fully manual, and it is worth running.

Codex CLI can be either. Wired only as an MCP server it has no hooks, so call
`briefing` yourself. Installed as a plugin
(`codex plugin add memesh@pcircle-memesh`) it wires the MCP server and the
separate SessionStart companion. On macOS or Linux, an eligible ordinary Codex
CLI startup or resume registers that exact active thread for native delivery.
The companion does not run Claude Code's eight capture/recall hooks or prove
that topology was injected. Do not assume Codex Desktop or an unattached task
registered; confirm the exact live session with `message discover`.
`memesh doctor` reports installation and local integration health, but it does
not prove host acceptance or model-visible delivery.
