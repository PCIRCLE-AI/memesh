# MeMesh Universal Integration Guide

Use MeMesh with any local app, script, or AI client that can call HTTP endpoints or run CLI commands.

If your goal is host-to-host collaboration, read the [Local Agent Messaging Guide](./agent-messaging.md) first. This page explains the transport shapes; the messaging guide explains the durable message lifecycle, support matrix, and current limits.

## Install

```bash
npm install -g @pcircle/memesh
```

## Local Collaboration Surfaces

Use the `message` MCP tool or `memesh message` for the four conversation actions: `discover`, `send`, `read`, and `status`. The host supplies the sender identity; CLI send bodies come from stdin. The complete rendered message is limited to 8,000 UTF-8 bytes.

- Messages and events are retained for 14 days; an eligible undelivered message produces one notice after a day. A known offline recipient can be queued. Queueing and push do not prove delivery or workflow acceptance.
- `discover` returns registered conversations. Send to the exact returned address; local addresses are conversation IDs and remote addresses add `@machine`.
- `read` returns complete pending messages and records delivery/read. Replies reference the original message ID. Neither implies the requested work was completed.
- Native wakeup and model-visible delivery need host-specific evidence; registration alone does not prove either.

`POST /v1/message` retains a separate legacy HTTP protocol, including `poll`, `fetch`, `intake` and workflow receipts. Its one-day retention and principal routing are not the MCP/CLI conversation contract. Keep HTTP clients on that protocol rather than sending its actions to the conversation tool. Cross-machine conversation delivery transfers messages between joined machines; memory remains local. Universal host resume is not implied.

## Option A: HTTP API

Start the server:

```bash
memesh serve
```

Default base URL:

```text
http://localhost:3737
```

Health check:

```bash
curl http://localhost:3737/v1/health
```

Remember:

```bash
curl -X POST http://localhost:3737/v1/remember \
  -H "Content-Type: application/json" \
  -d '{
    "name": "project-decision-2026",
    "type": "decision",
    "observations": ["We chose PostgreSQL"],
    "why": "Orders and invoices need transactions; revisit if write volume outgrows one primary",
    "tags": ["project:myapp", "topic:database"]
  }'
```

Recall:

```bash
curl -X POST http://localhost:3737/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"database decisions","limit":5}'
```

Learn from a fix:

```bash
curl -X POST http://localhost:3737/v1/learn \
  -H "Content-Type: application/json" \
  -d '{
    "error": "API timeout",
    "fix": "Increased connection pool",
    "root_cause": "Pool exhaustion",
    "severity": "major",
    "project": "my-project"
  }'
```

Archive:

```bash
curl -X POST http://localhost:3737/v1/forget \
  -H "Content-Type: application/json" \
  -d '{"name":"outdated-decision"}'
```

## Option B: CLI

Use this when your workflow can run shell commands:

```bash
memesh remember --name "test" --type note --obs "Hello World"
memesh recall "test" --json
memesh learn --error "CORS error" --fix "Added CORS middleware" --root-cause "Missing headers"
```

## Option C: MCP

Use MCP mode for clients that support Model Context Protocol:

```bash
memesh-mcp
```

Add that command to your MCP client's server configuration.

MeMesh binds a session to the project of the client's workspace root. For a client that reports no workspace root, set `MEMESH_PROJECT_ROOT` to the project's absolute directory in the server's environment, or pass `project` on each `remember`, `learn` and `recall` call.

## Prompt Template For Custom Integrations

```markdown
You have access to MeMesh persistent memory through the host application.

Use recall before project-specific work where prior decisions, bug fixes, or conventions may matter.
Saving is on by default: use remember for decisions, architecture choices, project conventions, patterns and user preferences, without waiting to be asked.
When known, add optional `why` to a decision: the reason, and what would make it stop holding. A decision without it is still stored.
Use learn for mistakes, root causes, fixes, and prevention notes.
Keep memories concise. Include tags such as project:<id> (the `project` field of `memesh briefing --json`), topic:<area>, and tech:<tool>.
Do not claim memory was checked or written unless the tool/API call succeeded.
```

## Operational Notes

- Default database: `~/.memesh/knowledge-graph.db`
- Default HTTP host: `127.0.0.1`
- Default HTTP port: `3737`
- API docs: [API_REFERENCE.md](../api/API_REFERENCE.md)

## Troubleshooting

Connection refused:

```bash
memesh serve
curl http://localhost:3737/v1/health
```

Port conflict:

```bash
MEMESH_HTTP_PORT=8080 memesh serve
```

No memories found:

```bash
memesh remember --name test --type note --obs "Hello"
memesh recall "test"
```
