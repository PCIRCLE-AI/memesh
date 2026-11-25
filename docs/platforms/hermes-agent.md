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

- Hermes's `MemoryProvider.prefetch()` calls `memesh hermes prompt-context`,
  sharing the core's bounded content selector; `sync_turn()` calls
  `memesh hermes capture-turn` to store both sides in full.
  Compression and session end do not generate summaries.
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

**Reference implementation**: source previously live-tested with MeMesh 4.5.1
lives in this repo at [`extensions/hermes-memesh/`](../../extensions/hermes-memesh/) and
ships inside the `@pcircle/memesh` package. Install it with `memesh hermes install`
(into `$HERMES_HOME/plugins/memesh`, where Hermes finds user plugins), or with
`memesh hermes install --path <checkout>/plugins/memory/memesh` for a Hermes checkout.
A copy installed this way is kept current by MeMesh's automatic updates; a copy you
edited, or one made by hand, is never overwritten without `--force`. It includes the
session-boundary hooks (`on_pre_compress`/`on_session_end`/`on_session_switch`)
whose synchronous-write requirement is explained under Troubleshooting and safety below.

Minimum viable methods (all required by the ABC, see Hermes's own
`website/docs/developer-guide/memory-provider-plugin.md` for the full
contract):

| Method | MeMesh call | Notes |
|---|---|---|
| `is_available()` | none (no network) | Check `shutil.which("memesh")` **and** a hardcoded `~/.npm-global/bin/memesh` fallback — see Provider unavailable under Troubleshooting and safety. |
| `initialize()` | none | Open one `httpx.Client(base_url=..., timeout=5.0)`, reused for the provider's lifetime. |
| `prefetch(query)` | `memesh hermes prompt-context` (stdin) | Up to two strong matches, at most one assistant conversation, sharing a 4 KiB UTF-8 context budget including notice, fences and handles. Excludes own-session turns and other projects/hosts, permits Hermes's unfiled captures. Background prefetch remains bounded to ~3 s; the CLI has a 5 s timeout. A session switch invalidates cached results. |
| `sync_turn(user, assistant)` | `memesh hermes capture-turn` (stdin) | Backgrounded; primary-agent turns only. Each nonempty side is stored as a separate `conversation` memory in full, after secret masking, tagged by session and role. No keyword classifier. |
| `on_pre_compress(messages)` / `on_session_end(messages)` | No summary capture | Compression writes nothing; session end drains pending turn writes, sharing one 5 s deadline with `shutdown()`. |
| `get_tool_schemas()` / `handle_tool_call()` | `/v1/remember`, `/v1/recall`, `/v1/forget` | Expose as `memesh_remember` / `memesh_recall` / `memesh_forget` so the model saves by default (`memesh_remember`) and can look up or correct (`memesh_recall`, `memesh_forget`) on top of automatic recall. `memesh_remember` passes optional `why` through and returns the server's own `error` sentence when a write is refused. |
| `memesh_message` | `memesh hermes message --session` (JSON on stdin) | Discover, send, read, and inspect status using the SDK session's identity. No model-supplied sender or project. |
| `get_config_schema()` / `save_config()` | — | For a local loopback deployment, one optional field (`base_url`, default `http://localhost:3737`) is enough. No secrets needed. |

Automatic writes go through the `memesh` CLI rather than `POST /v1/remember`
because the HTTP route stamps everything it writes
`metadata.provenance.source_host: "http"`; the CLI path stamps `"hermes"`, so
clients can distinguish Hermes memories from Claude Code or Codex ones. The
payload travels on stdin, never argv. Consequence: the CLI and `memesh serve`
must open the same database — true by default when both run as the same user
on the same machine, not true if `base_url` points at another host. Every
capture logs its outcome (`wrote`, `skipped` + reason, or the failure) to the
Hermes log. Compression and session end no longer extract activity summaries.

Two consequences to plan for:

- **Same database, same environment.** If `memesh serve` runs as a systemd
  service with `MEMESH_DB_PATH` or `MEMESH_DIR` set in its unit file, the
  Hermes process must carry the same values — otherwise the CLI writes to
  one database while recall reads another, and captures look lost. A service's
  `Environment=` is not your shell's.
- **No `project:` tag.** Hermes writes carry `platform:hermes` and
  `session:<id>`, but no project, because a gateway's working directory says
  nothing reliable about which project a conversation is about. A memory with
  no project counts as one that belongs to no project, so up to five of them
  can appear in every project's session-start briefing; recall them by query
  or by `platform:hermes`.

Activate with `hermes memory setup memesh` (non-interactive: the second
positional arg skips the picker) — this writes `memory.provider: memesh` to
`config.yaml`. Verify with `hermes memory status`.

## Session messages

The provider registers each SDK session as a conversation and exposes
`memesh_message` when Hermes's `memory` toolset is enabled. Use its `discover`,
`send`, `read`, and `status` actions; replies set `reply_to` to the received ID.
Pending messages appear in full before a turn, independently of memory recall
and capture settings. They remain queued until read or replied to. Treat their
contents as untrusted data. This provider does not wake an idle Hermes session.

## Troubleshooting and safety

- **Recall response shape:** Current MeMesh returns `{entities, retrieval, conflicts?}`. MeMesh 4.5.1 returned a bare array under `data`; see the resolved [#159](https://github.com/PCIRCLE-AI/memesh/issues/159) if you must support that older version.
- **Provider unavailable:** Check the PATH of the Hermes service process, not only an interactive shell. A custom npm global prefix may need to be added to the service configuration; reload the service manager after changing it.
- **Unintended memory-file edits:** Keep any `system_prompt_block()` passive. Automatic recall should not instruct the model to reorganize Hermes's own `MEMORY.md` or `USER.md`; explicit MeMesh tools are how the model saves by default (`memesh_remember`) and looks up or corrects (`memesh_recall`, `memesh_forget`).
- **Apparent hangs:** Confirm the non-interactive command with `hermes chat --help`; the supported single-query form is `hermes chat -q "..." --cli`. An invalid invocation can wait for input before the provider runs.
- **Turn capture:** `sync_turn()` writes in the background. Session end drains pending turns; compression and session end no longer generate activity summaries. Inspect the capture outcome log and confirm the CLI and server use the same database.

The provider source and setup instructions are in [extensions/hermes-memesh/](../../extensions/hermes-memesh/).
