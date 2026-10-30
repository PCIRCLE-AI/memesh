🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Tiếng Việt](README.vi.md)

# MeMesh

**Local collaboration layer for AI coding agents.**

MeMesh helps AI coding agents share context, exchange tasks and review results, and leave clear handoffs across sessions. Shared memory keeps your preferences, project decisions, and lessons available without explaining them again each time.

- **Coordinate work between sessions.** Send tasks, questions, review requests, and results between running Codex and Claude Code sessions through MeMesh messaging and the optional Claude Channel.
- **Share project context.** Agents on the same computer can reuse project decisions and lessons instead of starting from scratch.
- **Leave a clear handoff.** Record the goal, next step, and blockers for the next session to check before continuing.
- **Keep useful memory.** Save preferences, decisions, and lessons so they remain available across sessions and tools.

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

To use the command-line tools too, install [Node.js 22.13+](https://nodejs.org), then run:

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[Installation and update guide](llms-install.md) · [Other integrations](docs/platforms/README.md)

`PCIRCLE-AI/memesh` is the GitHub repository that supplies the marketplace. `memesh@pcircle-memesh` selects the `memesh` plugin from the `pcircle-memesh` marketplace.

## Let Codex and Claude Code collaborate

Use one session to implement a change and another to review it, ask questions, or report results. MeMesh provides a shared local message inbox; Claude Channel adds live delivery into a running Claude Code session. Codex uses its own native notification path, then fetches the message body.

1. Install the plugins above and start both hosts in the same repository, as the same OS user, with matching MeMesh database settings.
2. For live Claude delivery, follow the [Claude Channel setup](docs/platforms/agent-messaging.md#claude-channel-runner), including registration and the required launch flag. Eligible ordinary Codex CLI sessions register automatically when the plugin's SessionStart hook runs (macOS/Linux).
3. Ask your agent: “Find the running Claude/Codex session for this project with `message discover`, send it a review request, and report its reply.” Select the actual discovered recipient; do not guess a session ID. The receiver reads the message, records `intake`, and replies with findings.

Without Claude Channel, the durable inbox and Claude Code hook reminders still work. Delivery does not mean the other agent accepted or completed the work. Stopped sessions are not automatically resumed; verify Codex Desktop participation in `message discover` rather than assuming it. This local channel does not relay messages across computers.

[Setup, routing, and receipt details](docs/platforms/agent-messaging.md)

## Keep context between sessions

Ask your agent in plain language:

> Remember that this project uses SQLite.
>
> What did we decide about login last time?
>
> Save where we left off so the next session can pick it up.

Claude Code's plugin provides automatic capture and reminders. The Codex plugin can provide context at session start once its hooks are allowed to run; other capture behavior varies by host. You can also ask the agent to store or look up memories directly.

Claude Code inbox reminders work without Channel setup: hooks use the local `claude-code` recipient unless you configured another identity. They check at startup, your next prompt and turn end, and stop reminding once the agent records `intake` for that message. Live Channel push is optional; see the [messaging guide](docs/platforms/agent-messaging.md#claude-channel-runner).

Ordinary Claude Code MCP sessions register in `message discover` without enabling Channel. Online means the session is connected; immediate push still requires Channel. Without it, use the durable inbox and normal hook reminders.

Unreleased source builds add `/memesh-memories` in Claude Code to view and edit project memories. Claude Desktop edits inside the pane; terminal Claude Code and Codex use a native form. In Codex, ask `$memesh` to find and edit a memory. Fill only the title or paragraphs you want to change, leaving other fields blank. Save reads back the stored result; Cancel saves nothing. Unsupported hosts keep the existing conversation workflow.

[Full tool and command reference](docs/api/API_REFERENCE.md) · [Agent messaging](docs/platforms/agent-messaging.md) · [How it works](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

<details>
<summary>Tools and integration details</summary>

## All 12 Memory and Coordination Tools

| Tool | What it does |
|------|-------------|
| `remember` | Save a memory; decisions need a reason. |
| `recall` | Find memories. |
| `forget` | Archive a memory or remove one observation. |
| `learn` | Save a mistake, its cause, and how to avoid it. |
| `briefing` | Read the project's current memory context. |
| `task_state` | Read or record the goal, next step, blocker, and done work. |
| `message` | Find running local agents and exchange messages. |
| `export` | Back up memories as JSON. |
| `import` | Import a memory backup. |
| `work_package` | Prepare a bounded memory digest or transcript package for human review. |
| `user_patterns` | Summarize work patterns. |
| `improvement` | Propose an improvement for human review. |

---

Plugins ship **10 hooks**. The intent reminder recognizes "remember this"
(5 languages). Memory editing lives in Claude Code/Claude Desktop Code
through the MeMesh Mod, and in Codex through MCP/native forms. There is no
standalone Web Dashboard.

**Scored Ranking** — relevance (30%) + recency (25%) + frequency (18%) + confidence (17%) + recall impact (10%). See the [architecture](docs/ARCHITECTURE.md) for details.

## The fine print

**Agent messaging, the exact rules** (full guide: [docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)):

- Works today: an MCP, HTTP, or CLI sender can durably send one untrusted JSON-encoded payload of at most 65,536 UTF-8 bytes (64 KiB) to one named local recipient. A receiver can fetch it separately, resume from an opaque cursor after restart, and record intake, acknowledgement, workflow disposition, and host activation as separate facts.
- With the MeMesh Codex plugin enabled, each startup or resumed ordinary Codex CLI thread with a valid thread identity and existing working directory registers automatically under a thread-scoped identity; no manual `agent setup` is required. SessionStart launches an owner-private companion. SessionEnd keeps a bounded 45-second idle queue window, resume replaces the prior exact generation, and expiry removes the registration. A message accepted during that idle window reaches the thread as a short notice when the same thread resumes, and the agent then fetches the body from the inbox; it is not a claim that a stopped UI was awakened. `memesh agent setup codex-session` remains available only when one workspace needs a stable named principal. The complete native envelope, including routing metadata and payload, is capped separately at 16,384 bytes (16 KiB). An exact-session send returns success only after that native queue accepts it; an oversized full envelope reports `native_message_too_large`, an unreachable local router reports `router_unreachable`, and other unavailable or rejected sessions report `recipient_unavailable`. Scoped recovery data remains durable for all sender-side and recipient-side failures. Principal targets retain durable store-and-forward behavior. Native acceptance is not acknowledgement or disposition, and native messages must contain no secrets.
- A stopped, missing, or disconnected Codex session is not woken up or replaced, and a failed exact-session native delivery is not replayed automatically; the sender must retry deliberately. Its scoped recovery data stays available; `memesh message storage report` shows what is stored. Native delivery works on macOS and Linux only.
- This documented native path covers ordinary Codex CLI. Do not assume Codex Desktop or an unattached task registers unless that exact running session appears in `message discover`; this is an evidence boundary, not a claim that those hosts are universally incompatible.
- Pairing Claude Channel with automatic Codex registration needs no `--project` value copied between the two: each host derives its own routing project from its own working directory (Claude) or `--workspace` (Codex), so starting both in the same repository lands them in the same project automatically.

</details>

[MIT license](LICENSE)
