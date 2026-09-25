# Using MeMesh — for AI agents

MeMesh is persistent memory shared by every MCP host on this machine — one
SQLite database at `~/.memesh/knowledge-graph.db`. A memory stored from one
host is recallable from all of them. Not installed yet? Follow
[llms-install.md](llms-install.md).

## The loop that pays for itself

1. **Session start — load, don't re-explore.** Call the `briefing` tool once
   (CLI: `memesh briefing`) unless your host already injected the MeMesh
   memory block (Claude Code does, and so does the Codex plugin once Codex
   runs its hooks; see below).
   It returns the current project's work topology; read it instead of
   re-reading the repository to reconstruct context. The project's latest
   eligible handoff comes first, after optional repository facts: check its
   age and verify its claims against the files before acting on it. The rest
   depends on the `briefing` setting (`memesh config set briefing <level>`):
   - `minimal` (**default**): this project only — its decisions, lessons,
     knowledge and recent activity, with the repository state in front
     whenever anything else is shown. No task state, no index, nothing from
     other projects. A project with nothing to show injects nothing at all.
   - `standard`: adds the stated goal / next / blocked / done when fresh, and
     a capped index of durable memories with `[mem:id]` handles
     (`memesh briefing --index` prints just the index).
   - `full`: adds other projects' recent activity and global memory. The
     SessionStart hook also appends a work-package notice at `full`; that
     notice is an instruction to the host agent, not memory, and `briefing`
     never includes it.

   A task state stated more than 72 hours ago, or with a missing or
   implausible timestamp, is never shown as current at any level — only one
   line pointing at `memesh task`. Recent project decisions take priority
   over routine activity, and up to five project lessons are selected
   separately. The handoff, task state, ranked memories, global memory and
   injected index share one 4000-character limit (repository facts are
   extra), so a crowded block shows fewer index lines than
   `memesh briefing --index`, which has its own 40-line / 3072-byte caps.
   The index is a recent, capped window: when it says there is more, call
   `recall` instead of assuming it is complete.
2. **When the user states a goal, a next step, or a blocker — record it.**
   Call the `task_state` tool (CLI: `memesh task --goal "…" --next "…"`).
   Fresh state is injected at the start of the next session at
   `standard`/`full` and acted on as fact — not at the default, `minimal`,
   which never shows a fresh state (`memesh config set briefing standard`
   turns it on); a stale or unknown-age one still gets a one-line flag at
   every level — `memesh task` always shows the complete stored state.
   - An empty string **clears** a field: pass `blocked: ""` (CLI:
     `memesh task --blocked ""`) once a blocker is resolved.
   - **Record only what the user actually said.** Never infer goal / next /
     done from files edited or commands run — a guessed value becomes a wrong
     instruction to a future session with nothing to contradict it. Leave a
     field out if it was not said.
3. **"What do you remember?"** — call `briefing` and relay its content. Do
   not answer from your own conversation context.
4. **When the SessionStart work-package notice appears (level `full`), or the
   user asks to condense memory** — when the host supports interactive
   prompts, offer concise choices in the
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
   not running. Generic `briefing` has no recipient identity and stays quiet;
   so do the SessionStart and prompt hooks, unless the session declared who it
   is by starting with `MEMESH_RECIPIENT=<id>`, in which case they can show how
   many messages wait for that recipient and in which project. A length-limited
   briefing can omit some project notices; those messages remain pending.
   Check a known inbox with the exact `project` and `recipient`; poll first,
   then fetch each returned `message_id`, then record `intake` for it: fetching alone does not
   acknowledge and does not end the reminder.

## All 12 MCP tools

| Tool | Purpose |
|---|---|
| `work_package` | Prepare one bounded untrusted digest (calendar-selected) or transcript package from the newest Claude Code session under the client's single matching MCP workspace root; submit one strictly validated result for pending human review or defer without durable change. Submission retains bounded redacted source turns for comparison; agents cannot apply or reject, and hashes identify freshness and workspace scope rather than authentication. |
| `remember` | Store knowledge as an entity with observations, tags, and relations; or pass only `note` (free text) and the title, observations and name are derived; `replace: true` rewrites a named memory, keeping the old version as history |
| `recall` | Search stored knowledge: one or two words match any of them; three or more must all match, falling back to any-word matching only when nothing matches all; ranked by relevance. Empty query lists recent |
| `forget` | Archive an entity (soft-delete), or remove one observation via the `observation` parameter |
| `export` | Export memories as portable JSON for sharing or backup |
| `import` | Import a JSON export; `merge_strategy` (required): skip / append / overwrite |
| `learn` | Record a structured lesson: error, root cause, fix, prevention |
| `task_state` | Read or update where the work stands: goal / next / blocked / done |
| `briefing` | The assembled work topology — an eligible exact-project handoff precedes ranked memories at every level, after optional repository facts; `minimal` then shows this project's decisions, lessons, knowledge and recent activity, `standard` adds fresh task state and a capped durable-memory index, and `full` adds other projects and global memory; exact `project` + `recipient` can surface only that recipient's unfetched deliveries |
| `user_patterns` | Analyze work schedule, tool preferences, and focus areas from memory |
| `improvement` | Propose an evidence-linked product improvement or read its status; only a human may accept/reject it |
| `message` | Discover live agents, then exchange exact-recipient untrusted messages: durable JSON payload max 64 KiB; complete native envelope max 16 KiB with distinct `native_message_too_large` and `recipient_unavailable` errors; delivery reads/acceptance never imply ACK or disposition |

## Memory hygiene

- **The cheapest write is `remember({ note: "…" })`.** First line → title,
  each following paragraph → one observation, name derived from the text
  (the same text twice is one memory). Optional `type` (default `note`),
  `tags`, `name`. The response echoes the derived shape under `derived`.
- **Tag project work with the exact project id.** Use `project:<id>`, where
  `<id>` is the `project` field of the `briefing` result (CLI:
  `memesh briefing --json`). The injected block shows only the readable name;
  a tag with the plain repository name is a different scope that this
  project's sessions never see.
- **A mistake with a known cause and fix is a `learn` call** (it creates a
  `lesson_learned`, which later sessions show as a lesson). A choice between
  options is a `remember` with type `decision`.
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
- Recall windows are bounded (the `limit` parameter, 20 by default), so do
  not infer graph-wide counts or "there is no memory about X" from the
  number of hits one query returns. Absence of results is absence of
  results, not evidence of absence — vary the wording or narrow by tag
  before concluding anything.
- When an injected or recalled memory actually changes what you do, cite it
  once as `[mem:id]` in the sentence it affected. Do not cite memories you
  only read past. Under Claude Code the Stop hook counts these citations,
  which is how MeMesh learns which memories are worth their tokens.
- Every recall answer carries a `retrieval` block that says how it was
  produced — read it instead of guessing: `truncated: true` means the
  window filled and more may exist. Recall is local FTS5 search; do not
  describe results as semantic, vector-ranked, or model-generated.

## What Claude Code already does — do not double-write

Under Claude Code with the MeMesh plugin, hooks capture automatically:

- **SessionStart** injects the work topology (the same memory block
  `briefing` returns, with an eligible exact-project handoff ahead of ranked memories after optional repository facts, plus a work-package notice at `full` that `briefing`
  never includes) at the top of the session, whenever the configured level
  has something to show; an empty project at `minimal` injects nothing.
- **PreToolUse (Edit|Write)** surfaces memories related to the file being
  edited.
- **PostToolUse (Bash)** records git commits with diff stats.
- **PostToolUse (ExitPlanMode|AskUserQuestion)** reminds you to `remember` a
  decision just made — once per tool per session. It only reminds; unlike
  the hooks above, it writes nothing to the graph itself.
- **Stop** captures bounded session evidence, including observed error/fix signals, and replaces the exact project's handoff with the latest sufficiently long cleaned assistant reply. A skipped capture leaves the old handoff unchanged; it may describe a side question, so verify it before acting.
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
(`codex plugin add memesh@pcircle-memesh`) it loads the same hook file; once
Codex is allowed to run the plugin's hooks, its SessionStart hook injects the
same memory block, so do not call `briefing`
again at session start unless that block is missing. On macOS or Linux, an
eligible ordinary Codex CLI startup or resume also registers that exact
active thread for native delivery. Do not assume the capture hooks run
there: record decisions, lessons and task state yourself as usual. Do not
assume Codex Desktop or an unattached task registered; confirm the exact live
session with `message discover`.
`memesh doctor` reports installation and local integration health, but it does
not prove host acceptance or model-visible delivery.
