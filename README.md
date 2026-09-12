🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Deutsch](README.de.md)

<p align="center">
  <h1 align="center">MeMesh</h1>
  <p align="center">
    <strong>A memory for your AI coding agent that survives between sessions.</strong><br />
    One SQLite file. No Docker. No cloud required.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## What it does

Each session, your AI coding agent starts from zero. It proposes the approach you rejected last month, trips over the same failing test, and asks you to explain the architecture it helped design.

MeMesh remembers for it. Claude Code hooks capture and restore routine context; supported clients share the same local SQLite database through their documented integration. It works with Claude Code, Codex, Cursor and other MCP clients.

```
   you work with the agent
            |
            v
   +------------------+      +------------------+
   |  capture         |      |  recall          |
   |  sessions,       | ---> |  at session      |
   |  commits, fixes  |      |  start and       |
   |  (automatic)     |      |  before edits    |
   +------------------+      +------------------+
            |                         ^
            v                         |
   +----------------------------------------+
   |  ~/.memesh/knowledge-graph.db           |
   |  decisions, lessons, links between them |
   +----------------------------------------+
```

- **Capture, recall, reminders, and safeguards at the right time.** MeMesh ships **9 hooks** (nine hook commands) across its Claude Code and Codex integrations: eight Claude Code hooks run at session start, before file edits, after `git commit`, after a plan is approved or a question answered, when Claude stops, before context compaction, when you say "remember this" (5 languages), and before a risky command that repeats an accepted lesson. The plan/question and "remember this" hooks only remind the agent to call `remember`; the ninth command handles both Codex SessionStart and SessionEnd to register and retire an eligible ordinary Codex CLI session.
- **One memory for all your tools.** A decision stored from Claude Code is available to Codex or Cursor the next day.
- **Agents can leave each other messages.** A durable inbox survives restarts; on macOS or Linux, an ordinary Codex CLI thread with the MeMesh plugin can keep a bounded post-turn native queue window and consume the accepted message when that same thread resumes.
- **A dashboard** to browse it all: 4 tabs, 11 languages, at `http://localhost:3737/dashboard`.

---

## Works with

| Platform | How | Notes |
|---|---|---|
| Claude Code | Plugin: hooks, MCP tools, `/memesh` skill | Full automatic capture and recall |
| Codex CLI | Plugin, or MCP server (`memesh-mcp`) | Zero-config plugin install, or `codex mcp add memesh -- memesh-mcp` |
| Gemini CLI | MCP server (`memesh-mcp`) | `gemini mcp add -s user memesh memesh-mcp` |
| Cursor, Cline and other MCP clients | MCP server (`memesh-mcp`) | Point the client at `memesh-mcp` |
| Hermes Agent | Native memory-provider plugin | [docs/platforms/hermes-agent.md](docs/platforms/hermes-agent.md) |
| OpenClaw | Native memory plugin | Source only; not published or live-tested: [docs/platforms/openclaw.md](docs/platforms/openclaw.md) |
| Your own scripts and apps | HTTP API from `memesh serve` | [docs/platforms/universal.md](docs/platforms/universal.md) |
| ChatGPT, Gemini web and other hosted chat | HTTP API through a local bridge you run | [docs/platforms/README.md](docs/platforms/README.md) |

Claude Code's eight hooks provide automatic capture, recall, reminders, and safeguards. The Codex plugin wires its SessionStart integration and MCP tools automatically. MCP-only clients call `recall` and `briefing` themselves.

Recall and capture are local and deterministic: SQLite FTS5 search, explicit memory tools, and rule-based hooks. This version does not configure or call an LLM, embedding, or vector provider. Retired provider settings from older versions stay on disk but are ignored; `memesh doctor` names the top-level keys without reading or printing their values.

---

## Install

Plugin installs and the npm-global CLI share one database. Most Claude Code users want its plugin plus the CLI; Codex can use its own plugin or the CLI's MCP server.

```
   Claude Code chat                Terminal, Codex, Cursor
         |                                  |
         v                                  v
   +-----------------+              +------------------+
   | A: plugin       |              | B: npm global    |
   | /plugin install |              | npm install -g   |
   | hooks + tools   |              | memesh CLI       |
   | + /memesh skill |              | + memesh-mcp     |
   +-----------------+              +------------------+
         |                                  |
         +---------------+------------------+
                         v
            ~/.memesh/knowledge-graph.db
               (one file, both paths)
```

**A. Inside Claude Code** (hooks, tools and the `/memesh` skill are wired for you):

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

Restart Claude Code. A `◉ MeMesh` line appears at the top of the next session.

**B. In a terminal** (needs [Node 22.13+](https://nodejs.org)):

```bash
npm install -g @pcircle/memesh
memesh doctor          # checks local install health and prints fixes
memesh install-hooks   # only if you skipped A: wires Claude Code, keeps your own hooks
```

For a zero-config Codex install, run `codex plugin marketplace add PCIRCLE-AI/memesh` and `codex plugin add memesh@pcircle-memesh`. The manual alternative is `codex mcp add memesh -- memesh-mcp`. For Cursor, add `{ "mcpServers": { "memesh": { "command": "memesh-mcp" } } }` to `~/.cursor/mcp.json`. The Dashboard's doctor banner can apply the two recoverable local repairs it knows how to verify; it never changes files just because the page was opened.

> **The plugin does not install the CLI.** After `/plugin install`, typing `memesh` in a terminal says `command not found` until you also run `npm install -g @pcircle/memesh`. If you only use Claude Code chat, A alone is enough.

**Update:** Claude Code plugin: `memesh upgrade-plugin` (or `npx @pcircle/memesh upgrade-plugin` without the CLI). Codex plugin: `codex plugin marketplace upgrade pcircle-memesh && codex plugin add memesh@pcircle-memesh`. npm-global CLI: `memesh update`. **Installing with an AI agent?** Point it at [llms-install.md](llms-install.md).

---

## Get started

```bash
memesh remember "Login uses OAuth 2.0 with PKCE"
memesh recall "login"
# -> finds the PKCE decision

memesh briefing        # what the agent knows about this project, where you left off
memesh serve           # starts the local server and prints the dashboard URL
```

Keep `memesh serve` running and open the printed URL. In Claude Code you do not even need the terminal for memory tools: say "remember this" in chat, and the briefing arrives on its own at every session start.

Two things worth knowing once you have memories:

- `forget` archives a memory instead of deleting it. A newer memory can replace an older one.
- A running agent can call `work_package` to prepare one calendar digest or bounded visible turns from the newest eligible recent Claude Code transcript. Transcript mode requires the client's single matching MCP file root; missing or ambiguous roots and bounded scan failures fail closed. Submission retains redacted source turns and only stages pending human review; agents cannot apply or reject it, and MeMesh calls no provider. The exact discovery bounds are in the [API reference](docs/api/API_REFERENCE.md#work_package).

Full command and tool reference: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md). How it is built: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## All 12 Memory and Coordination Tools

| Tool | What it does |
|------|-------------|
| `work_package` | Prepare one bounded untrusted calendar digest or Claude Code transcript package under one matching MCP workspace root; submit one strict result for pending human review, or defer without durable change. Transcript submission retains bounded redacted source turns; no file path, hidden reasoning, provider, embedding, or vector data is exposed. |
| `remember` | Store knowledge as observations, relations and tags — or pass free text as `note` and the title, observations and name are derived; `replace` corrects a memory in place |
| `recall` | Local FTS5 search with multi-factor scoring (relevance, recency, frequency, confidence, recall impact) |
| `forget` | Soft-archive (never deletes) or remove specific observations |
| `export` | Back up, migrate, or move memories as JSON between compatible agents |
| `import` | Import memories with merge strategies (skip / overwrite / append) |
| `learn` | Record structured lessons from mistakes (error, root cause, fix, prevention) |
| `task_state` | Read or record where the work stands — goal, next step, blocker, what was just finished |
| `briefing` | The assembled work topology for any MCP client, closing with a capped index of the project's durable memories; generic context stays quiet, while exact `project` + `recipient` can surface only that recipient's unfetched deliveries |
| `user_patterns` | Analyze your work patterns — schedule, tools, strengths, learning areas |
| `improvement` | Stage an evidence-linked product improvement for human review, or read its status; agents cannot accept or reject it |
| `message` | Discover live agents, then exchange exact-recipient untrusted messages. Durable JSON payload max: 64 KiB; complete native envelope max: 16 KiB with distinct `native_message_too_large` and `recipient_unavailable` failures. Native acceptance, discovery, poll, and fetch never imply acknowledgement or disposition |

---

## The fine print

**Scored Ranking** — Results ranked by relevance (30%) + recency (25%) + frequency (18%) + confidence (17%) + recall impact (10%).

**Agent messaging, the exact rules** (full guide: [docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)):

- Works today: an MCP, HTTP, or CLI sender can durably send one untrusted JSON-encoded payload of at most 65,536 UTF-8 bytes (64 KiB) to one named local recipient. A receiver can fetch it separately, resume from an opaque cursor after restart, and record intake, acknowledgement, workflow disposition, and host activation as separate facts.
- With the MeMesh Codex plugin enabled, each startup or resumed ordinary Codex CLI thread with a valid thread identity and existing working directory registers automatically under a thread-scoped identity; no manual `agent setup` is required. SessionStart launches an owner-private detached companion because Codex reaps an async hook child when its CLI process exits. SessionEnd keeps a bounded 45-second idle queue window, resume replaces the prior exact generation, and expiry removes the registration. A message accepted during that idle window becomes model-visible when the same thread resumes; it is not a claim that a stopped UI was awakened. `memesh agent setup codex-session` remains available only when one workspace needs a stable named principal. The complete native envelope, including routing metadata and payload, is capped separately at 16,384 bytes (16 KiB). An exact-session send returns success only after that native queue accepts it; an oversized full envelope reports `native_message_too_large`, an unreachable local router reports `router_unreachable`, and other unavailable or rejected sessions report `recipient_unavailable`. Scoped recovery data remains durable for all sender-side and recipient-side failures. Principal targets retain durable store-and-forward behavior. Native acceptance is not acknowledgement or disposition, and native messages must contain no secrets.
- A stopped, missing, or disconnected Codex session is not woken up or replaced, and a failed exact-session native delivery is not replayed automatically; the sender must retry deliberately. Its scoped recovery data stays available; `memesh message storage report` shows what is stored. Native delivery works on macOS and Linux only.
- This documented native path covers ordinary Codex CLI. Do not assume Codex Desktop or an unattached task registers unless that exact running session appears in `message discover`; this is an evidence boundary, not a claim that those hosts are universally incompatible.
- When pairing Claude Channel with automatic Codex registration, pass the complete `project` value from `memesh briefing --json` to `memesh agent setup claude`; the repository basename is not the same routing scope.

---

<p align="center"><strong>MIT License</strong></p>
