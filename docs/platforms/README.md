# MeMesh integrations

MeMesh is a local collaboration layer for AI coding agents, with shared memory and session messaging. Start with the
[installation guide](../../llms-install.md). Hosts share memories when
they run as the same user with matching database settings.

## Choose an entry point

| Entry point | Use it for |
|---|---|
| Claude Code plugin | Memory tools, automatic capture, and reminders. |
| Codex plugin | Memory tools, startup context, and eligible CLI message notifications. |
| Hermes Agent memory provider | Memory recall and capture through the local MeMesh server and CLI. |
| MCP server (`memesh-mcp`) | Other local MCP clients; automatic hooks depend on the host. |
| CLI (`memesh`) | Direct commands, diagnostics, and backups. |
| HTTP (`memesh serve`) | Local scripts, apps, or a bridge you operate. |

The database is local. MeMesh does not run a separate model or connect a hosted
chat product to your computer automatically. A browser-based product needs a
bridge that can reach your local server. For non-loopback HTTP access, follow
the [bearer-token requirements](../api/API_REFERENCE.md#http-rest-api).

## Guides

- [Codex ↔ Claude Code collaboration](../../README.md#let-codex-and-claude-code-collaborate): exchange tasks, review requests, and results through MeMesh messaging. Claude Channel delivers into a running Claude session; eligible Codex CLI sessions receive native notices and fetch the body. Both need the same local MeMesh instance and project; stopped sessions are not automatically resumed.
- [Agent messaging](agent-messaging.md): send, fetch, and acknowledge messages.
  Delivery or queue acceptance is not task completion.
- [Universal HTTP guide](universal.md): connect a local script or app.
- [ChatGPT bridge](chatgpt.md) and [Gemini bridge](gemini.md): optional bridge
  setups, not native local access from the hosted chat page.
- [Hermes Agent](hermes-agent.md): optional native MemoryProvider integration;
  its recorded live test used MeMesh 4.5.1. Verify current host compatibility.
- [OpenClaw](openclaw.md): source-only integration, not published or live-tested.
- [DeepSeek worker](deepseek-worker.md): optional delegated worker, not a MeMesh host.

The standalone Web Dashboard was removed in 4.11.0. Claude Code and Claude
Desktop Code use the MeMesh Mod; Codex uses MCP/native forms. The shared memory
core, HTTP API and CLI remain available.

[API reference](../api/API_REFERENCE.md) · [Architecture](../ARCHITECTURE.md)
