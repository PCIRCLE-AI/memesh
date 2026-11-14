🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Tiếng Việt](README.vi.md)

# MeMesh

**Local collaboration layer for AI coding agents.**

MeMesh helps AI coding agents share context, exchange tasks and review results, and leave clear handoffs across sessions. Shared memory keeps your preferences, project decisions, and lessons available without explaining them again each time.

- **Coordinate registered conversations.** Exchange tasks, questions, review requests and results. The current conversation hook is wired for Claude; the corresponding Codex integration remains in development.
- **Share project context.** Agents on the same computer can reuse project decisions and lessons instead of starting from scratch.
- **Leave a clear handoff.** Record the goal, next step, and blockers for the next session to check before continuing.
- **Keep useful memory.** Save preferences, decisions, and lessons so they remain available across sessions and tools. Decisions, lessons and preferences are found in every project, labelled with the project they came from; each project's commits and session notes stay in that project.

By default, memories live in one file on your computer: `~/.memesh/knowledge-graph.db`. MeMesh needs no separate AI model. Automatic reminders depend on the host integration; a handoff is context, not a guarantee that a task will restart itself.

## Install

**Claude Code** — run these inside Claude Code, then restart it:

```text
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

**Codex** — run these in your terminal, then restart Codex:

```bash
codex plugin marketplace add PCIRCLE-AI/memesh
codex plugin add memesh@pcircle-memesh
```

**Hermes Agent** — follow the [MeMesh memory provider guide](docs/platforms/hermes-agent.md) to connect Hermes for memory recall and capture.

To use the command-line tools too, install [Node.js](https://nodejs.org) 26.13.1 or later in the 26.x line (recommended), 24.22.3 or later in 24.x, or 22.23.5 or later in 22.x, then run:

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[Installation and update guide](llms-install.md) · [Other integrations](docs/platforms/README.md)

If `memesh doctor` reports database damage, stop your AI tools and run `memesh repair`. It preserves a verified damaged copy, salvages readable memories, and checks the replacement first. A built-in Node recovery path works without a usable system `sqlite3`; `memesh repair --from-backup` uses the newest verified memory backup instead. Restart your AI tools afterwards.

**Updates are automatic.** MeMesh installs new releases by itself (every version) after checking the release's provenance and backing up your database, and waits until your running sessions have ended. It is on by default when HOME matches the system account home (or no account-home entry exists), including containers and other database locations. CI and a different test/sandbox HOME default to off; an explicit setting in that environment can enable it, while an account-level off always wins. Turn it off with `memesh config set autoUpdate off`; update right now with `memesh update`; repair a damaged plugin with `memesh update --reinstall`; `memesh doctor` shows what it did.

`PCIRCLE-AI/memesh` is the GitHub repository that supplies the marketplace. `memesh@pcircle-memesh` selects the `memesh` plugin from the `pcircle-memesh` marketplace.

## Conversation messaging (source candidate)

Use one session to implement a change and another to review it, ask questions, or report results. MeMesh conversation messages use four actions: discover an address, send a typed body, read one addressed message, and inspect status/audit. The body is untrusted data.

1. Use registered conversations with matching MeMesh database settings. Both plugin manifests declare the SessionStart/UserPromptSubmit message hook. Its Codex-shaped private wire flow is checked; actual native-host/model delivery still requires separate verification.
2. Run `memesh message discover` and choose an address actually listed; do not guess one.
3. Send text only through stdin: `printf '%s' 'Please review this.' | memesh message send --recipient <address> --kind review_request --payload-stdin`. The recipient uses `memesh message read --message-id <id>` and can reply with `--reply-to <id>`.

`queued` does not mean delivered, read, replied, accepted, or completed. Native wakeup and cross-machine conversation delivery remain under development.

[Setup, routing, and receipt details](docs/platforms/agent-messaging.md)

## Keep context between sessions

Ask your agent in plain language:

> Remember that this project uses SQLite.
>
> What did we decide about login last time?
>
> Save where we left off so the next session can pick it up.

MeMesh remembers by default. To remove a specific stored memory, ask the agent to find it and use `forget`; ordinary conversation capture continues normally.

Claude Code's plugin provides automatic capture and reminders. The Codex plugin can provide context at session start once its hooks are allowed to run; other capture behavior varies by host. You can also ask the agent to store or look up memories directly.

SessionStart/UserPromptSubmit hooks render complete pending conversation messages. Claude Stop and Codex Bash-tool hooks also carry whole messages; delivery is recorded only after successful output. Memory hooks no longer publish legacy principal addresses or inbox-action instructions. These private hook checks do not prove native wakeup or model reading.

MeMesh 4.11.0 and later add `/memesh-memories` in Claude Code to view and edit project memories. Claude Desktop edits inside the pane; terminal Claude Code and Codex use a native form. In Codex, ask `$memesh` to find and edit a memory. Fill only the title or paragraphs you want to change, leaving other fields blank. Save reads back the stored result; Cancel saves nothing. Unsupported hosts keep the existing conversation workflow.

[Full tool and command reference](docs/api/API_REFERENCE.md) · [Agent messaging](docs/platforms/agent-messaging.md) · [How it works](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

<details>
<summary>Tools and integration details</summary>

## All 12 Memory and Coordination Tools

| Tool | What it does |
|------|-------------|
| `remember` | Save a memory (on by default, no need to ask); a decision’s reason is optional. |
| `recall` | Find memories by words or retrieve them by ID. |
| `forget` | Archive a memory or remove one observation. |
| `learn` | Save a mistake, its cause, and how to avoid it. |
| `briefing` | Read the project's current memory context. |
| `task_state` | Read or record the goal, next step, blocker, and done work. |
| `message` | Discover a conversation address; send, read, or inspect a typed conversation message and its audit state. |
| `export` | Back up memories as JSON. |
| `import` | Import a memory backup. |
| `work_package` | Prepare a bounded memory digest or transcript package for human review. |
| `user_patterns` | Summarize work patterns. |
| `improvement` | Propose an improvement for human review. |

**Command-line notes.**
- `memesh remember` files a new memory under the current folder's project, like `memesh learn`; `--project <name>` picks another project and `--no-project` stores one with none. Appending to an existing unfiled memory without an explicit project or project tag keeps it unfiled; an existing name also keeps its type when `--type` is omitted.
- `memesh export -o backup.json` signs the backup with a secret that stays in your MeMesh folder. `memesh import backup.json` trusts it again only if it is unchanged and came from this folder; any other file imports as untrusted (searchable, never auto-injected) and the output says so. A memory you forgot stays forgotten: the output prints the one command that brings it back (`--restore-archived`).
- `memesh message send` receives its text from `--payload-stdin`; it does not accept body text in argv.

---

The Claude Code plugin ships **12 hooks**; the Codex plugin also registers two Codex-only commands. MeMesh does not classify saving intent by
keywords: conversations are captured by default, and the agent can store structured memories. Sessions start with a bounded
memory overview and recent user conversation titles. When a prompt matches
stored memory, up to two memories bring their content along, within one 4 KiB
UTF-8 limit including the data notice and `[mem:id]` handles. An opening title
does not count as having read the content. Truncated content is marked with
the ID to retrieve using `recall`. Titles containing “pending” or “blocked”
are eligible too. Turn the prompt part off with `memesh config set promptRecall false`. Memory editing lives in Claude Code/Claude Desktop Code
through the MeMesh Mod, and in Codex through MCP/native forms. There is no
standalone Web Dashboard.

**Scored Ranking** — relevance (30%) + recency (25%) + frequency (18%) + confidence (17%) + recall impact (10%). See the [architecture](docs/ARCHITECTURE.md) for details.

## The fine print

**Agent messaging, the exact rules** (full guide: [docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)):

- The current MCP/CLI conversation schema is exactly `discover`, `send`, `read`, and `status`. `send` takes `recipient`, `kind` (`task`, `question`, `review_request`, `result`), a text `body`, and optional `reply_to` (the CLI reads body text from stdin); it derives sender identity from the host, not `--sender` or `--project`.
- The complete rendered envelope is limited to 8,000 UTF-8 bytes. Unknown recipients and oversized sends are rejected and audited; known offline recipients are queued. Store-open maintenance retains messages and events for 14 days and creates one notice for an eligible undelivered message after a day.
- `read` records delivery/read. `status` shows sent/received messages and audit events; the CLI owner view can emit the complete history with `--json`. There are no update or delete actions.
- The legacy HTTP agent-message lifecycle remains separate for compatibility. Its polling, fetch and receipt fields are not valid conversation MCP/CLI fields; see the [messaging guide](docs/platforms/agent-messaging.md#legacy-http-messaging).

</details>

[MIT license](LICENSE)
