# MeMesh integrations

MeMesh is a local memory layer for Claude Code and Codex. Start with the
[installation guide](../../llms-install.md). Both hosts share memories when
they run as the same user with matching database settings.

## Choose an entry point

| Entry point | Use it for |
|---|---|
| Claude Code plugin | Memory tools, automatic capture, and reminders. |
| Codex plugin | Memory tools, startup context, and eligible CLI message notifications. |
| MCP server (`memesh-mcp`) | Other local MCP clients; automatic hooks depend on the host. |
| CLI (`memesh`) | Direct commands, diagnostics, and backups. |
| HTTP (`memesh serve`) | Local scripts, apps, or a bridge you operate. |

The database is local. MeMesh does not run a separate model or connect a hosted
chat product to your computer automatically. A browser-based product needs a
bridge that can reach your local server. For non-loopback HTTP access, follow
the [bearer-token requirements](../api/API_REFERENCE.md#http-rest-api).

## Guides

- [Agent messaging](agent-messaging.md): send, fetch, and acknowledge messages.
  Delivery or queue acceptance is not task completion.
- [Universal HTTP guide](universal.md): connect a local script or app.
- [ChatGPT bridge](chatgpt.md) and [Gemini bridge](gemini.md): optional bridge
  setups, not native local access from the hosted chat page.
- [Hermes Agent](hermes-agent.md): optional native MemoryProvider integration;
  its recorded live test used MeMesh 4.5.1. Verify current host compatibility.
- [OpenClaw](openclaw.md): source-only integration, not published or live-tested.
- [DeepSeek worker](deepseek-worker.md): optional delegated worker, not a MeMesh host.

The Dashboard is included in 4.10.12. Its future replacement does not change
the shared memory core, MCP tools, or CLI described here.

[API reference](../api/API_REFERENCE.md) · [Architecture](../ARCHITECTURE.md)
