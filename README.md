🌐 [English](README.md) | [繁體中文](README.zh-TW.md)

# MeMesh

**Shared local memory for Claude Code and Codex.**

MeMesh helps your coding agents remember your preferences, project decisions, and lessons from past work, so you spend less time explaining the same things in every new session.

- **Remember across sessions.** Save a decision or lesson and find it again later.
- **Share context between tools.** Claude Code and Codex on the same computer can use the same memories.
- **Leave a handoff.** Keep a note of where work stopped for the next session to check.
- **Exchange messages.** Running local agents can send each other work, questions, and results.

Memories live in one file on your computer: `~/.memesh/knowledge-graph.db`. MeMesh needs no cloud memory service or separate AI model. Automatic reminders depend on the host integration; a handoff is context, not a guarantee that a task will restart itself.

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

To use the command-line tools too, install [Node.js 22.13+](https://nodejs.org), then run:

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[Installation and update guide](llms-install.md) · [Other integrations](docs/platforms/README.md)

## Use it

Ask your agent in plain language:

> Remember that this project uses SQLite.
>
> What did we decide about login last time?
>
> Save where we left off so the next session can pick it up.

Claude Code's plugin provides automatic capture and reminders. The Codex plugin can provide context at session start once its hooks are allowed to run; other capture behavior varies by host. You can also ask the agent to store or look up memories directly.

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
(5 languages). The included Dashboard has 4 tabs, 11 languages.

**Scored Ranking** — relevance (30%) + recency (25%) + frequency (18%) + confidence (17%) + recall impact (10%). See the [architecture](docs/ARCHITECTURE.md) for details.

</details>

[MIT license](LICENSE)
