# MeMesh With Hermes Agent (NousResearch)

Hermes Agent has a **first-party, documented plugin system for external memory
providers** — `agent.memory_provider.MemoryProvider` (ABC), activated via
convention-based discovery under `plugins/memory/<name>/`. This is not a
generic HTTP/CLI bridge situation like ChatGPT or Gemini: Hermes ships
multiple providers this way already (honcho, mem0, hindsight, holographic,
retaindb, byterover, openviking, supermemory), and MeMesh can be added alongside them,
with automatic per-turn recall/write — no core Hermes file needs editing.

The integration was tested on 2026-08-15 against Hermes Agent `main` and
MeMesh 4.5.1 with a local `memesh serve` service. That dated test does not
verify compatibility with later host or MeMesh versions; check the current
installation before relying on automatic capture.

## Why this is a good fit

- Hermes's `MemoryProvider.prefetch()` hook maps directly onto MeMesh's
  `POST /v1/recall`, and `sync_turn()` / the session-boundary hooks map onto
  `memesh hermes capture-turn` / `capture-session` — the same capture rules
  the Claude Code hooks use, with no adapter logic in the plugin.
- Hermes's provider discovery (`plugins.memory.discover_memory_providers()`)
  scans the filesystem at runtime and reads each `plugin.yaml`'s `name` +
  `description` + `is_available()` — a new provider directory is enough;
  nothing in Hermes core needs to know MeMesh exists in advance.
- MeMesh's loopback-only auth model (no bearer token required for
  `localhost`) matches Hermes's local-first deployment pattern with zero
  secret management.

## The provider shape

```
plugins/memory/memesh/
├── __init__.py      # MemeshProvider(MemoryProvider) + register(ctx)
├── plugin.yaml       # name, version, description, hooks
└── README.md
```

**Reference implementation**: the deployed, live-tested source lives in this
repo at [`extensions/hermes-memesh/`](../../extensions/hermes-memesh/) — copy
it into a Hermes checkout as `plugins/memory/memesh/`. It includes the
session-boundary hooks (`on_pre_compress`/`on_session_end`/`on_session_switch`)
whose synchronous-write requirement is explained under Troubleshooting and safety below.

Minimum viable methods (all required by the ABC, see Hermes's own
`website/docs/developer-guide/memory-provider-plugin.md` for the full
contract):

| Method | MeMesh call | Notes |
|---|---|---|
| `is_available()` | none (no network) | Check `shutil.which("memesh")` **and** a hardcoded `~/.npm-global/bin/memesh` fallback — see Provider unavailable under Troubleshooting and safety. |
| `initialize()` | none | Open one `httpx.Client(base_url=..., timeout=5.0)`, reused for the provider's lifetime. |
| `prefetch(query)` | `POST /v1/recall` | Background-thread pattern: `queue_prefetch()` starts a thread after the previous turn; `prefetch()` consumes the cached result or blocks up to ~3s before giving up and returning `""`. Copy this pattern from `plugins/memory/mem0/__init__.py` — don't reinvent it. |
| `sync_turn(user, assistant)` | `memesh hermes capture-turn` (stdin) | **Must** run in a daemon thread — see Threading Contract in the dev guide. Gate on `agent_context == "primary"`. MeMesh stores the turn only when it states a decision or a lesson; ordinary turns store nothing. |
| `on_pre_compress(messages)` / `on_session_end(messages)` | `memesh hermes capture-session` (stdin) | **Synchronous** — see Session-boundary capture under Troubleshooting and safety. `on_session_end` first waits for queued turns (one 5 s deadline shared with the `shutdown()` that follows; turns left over are logged, queued and still-running apart), then runs the capture with a 15 s timeout, so the host waits at most 20 s. Runs the Claude Code Stop hook's extractor and stores `session-<id>-files` / `-fixes` / `-summary`, not the message list. |
| `get_tool_schemas()` / `handle_tool_call()` | `/v1/remember`, `/v1/recall`, `/v1/forget` | Expose as `memesh_remember` / `memesh_recall` / `memesh_forget` for explicit LLM-directed lookups on top of automatic recall. |
| `get_config_schema()` / `save_config()` | — | For a local loopback deployment, one optional field (`base_url`, default `http://localhost:3737`) is enough. No secrets needed. |

Automatic writes go through the `memesh` CLI rather than `POST /v1/remember`
because the HTTP route stamps everything it writes
`metadata.provenance.source_host: "http"`; the CLI path stamps `"hermes"`, so
the dashboard can tell Hermes memories from Claude Code or Codex ones. The
payload travels on stdin, never argv. Consequence: the CLI and `memesh serve`
must open the same database — true by default when both run as the same user
on the same machine, not true if `base_url` points at another host. Every
capture logs its outcome (`wrote`, `skipped` + reason, or the failure) to the
Hermes log, including tool names the extractor did not recognise and tool
results it could not read as JSON (errors inside those are not counted).

Two consequences to plan for:

- **Same database, same environment.** If `memesh serve` runs as a systemd
  service with `MEMESH_DB_PATH` or `MEMESH_DIR` set in its unit file, the
  Hermes process must carry the same values — otherwise the CLI writes to
  one database while recall reads another, and captures look lost. A service's
  `Environment=` is not your shell's.
- **No `project:` tag.** Hermes writes carry `platform:hermes` and
  `session:<id>`, but no project, because a gateway's working directory says
  nothing reliable about which project a conversation is about. They
  therefore do not appear in project-scoped views such as the session-start
  briefing; recall them by query or by `platform:hermes`.

Activate with `hermes memory setup memesh` (non-interactive: the second
positional arg skips the picker) — this writes `memory.provider: memesh` to
`config.yaml`. Verify with `hermes memory status`.

## Troubleshooting and safety

- **Recall response shape:** Current MeMesh returns `{entities, retrieval, conflicts?}`. MeMesh 4.5.1 returned a bare array under `data`; see the resolved [#159](https://github.com/PCIRCLE-AI/memesh/issues/159) if you must support that older version.
- **Provider unavailable:** Check the PATH of the Hermes service process, not only an interactive shell. A custom npm global prefix may need to be added to the service configuration; reload the service manager after changing it.
- **Unintended memory-file edits:** Keep any `system_prompt_block()` passive. Automatic recall should not instruct the model to reorganize Hermes's own `MEMORY.md` or `USER.md`; explicit MeMesh tools are for a specific lookup or correction.
- **Apparent hangs:** Confirm the non-interactive command with `hermes chat --help`; the supported single-query form is `hermes chat -q "..." --cli`. An invalid invocation can wait for input before the provider runs.
- **Session-boundary capture:** `on_session_end()` and `on_pre_compress()` write synchronously before the shared HTTP client closes. In contrast, per-turn `sync_turn()` is backgrounded. If boundary memories are missing, inspect the Hermes capture outcome log and confirm the CLI and server use the same MeMesh database.

The provider source and setup instructions are in [extensions/hermes-memesh/](../../extensions/hermes-memesh/).
