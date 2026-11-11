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

**Reference implementation**: source previously live-tested with MeMesh 4.5.1
lives in this repo at [`extensions/hermes-memesh/`](../../extensions/hermes-memesh/) — copy
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
| `get_tool_schemas()` / `handle_tool_call()` | `/v1/remember`, `/v1/recall`, `/v1/forget` | Expose as `memesh_remember` / `memesh_recall` / `memesh_forget` for explicit LLM-directed lookups on top of automatic recall. `memesh_remember` passes `why` through (required for a decision) and returns the server's own `error` sentence when a write is refused. |
| `memesh_private_session` (a tool of the same two methods) | none | Marks the current session private: no turn and no session summary is captured from then on. Hermes ends the session and starts a new provider instance with the same session id at `/compress`, `/resume`, `/branch` and `/new`, so the mark is also written to a small file under the Hermes home (`memesh-private-sessions/<session id>`, or a sha256 of the id when it is not a plain token, mode 0600, holding only the id) and every capture path reads it first. A session found private from its message history (`sync_turn` and `memesh hermes capture-session` read it for a call to the tool) gets a marker too. `on_session_switch` writes the new id's marker for a branched or compressed session (a `/reset` does not, and `/resume` of an old session does not either when Hermes passes `reason`: that session is private only if its own marker exists; when the session being left is private and Hermes passes no `reason`, a resume cannot be told from a branch, so the new session saves nothing and every capture records an error saying why, before and after a restart alike, but it is never given a marker of its own; a switch with no `reason` from an ordinary session saves as usual). Where each new session came from is kept beside the markers (`memesh-session-parents/<session id>`, mode 0600, session ids only), so every capture, in the same instance or a new one, checks the parents again: a parent whose marker could not be read at the switch makes the session private once it can be read, and until then (or while that folder cannot be read) the capture saves nothing and records an error. If the marker cannot be written, the tool's reply says saving may start again after a compression or resume, and an error is recorded for `memesh doctor`; if it cannot be read, Hermes gave no home folder to look in, or the session id is empty, nothing is saved by that capture and an error is recorded (under the hook name `hermes-private-session`, host `hermes`, which doctor does not count against the Claude Code hooks); each capture decides again, so once the marker can be read and there is none, capture resumes. Every capture that stops for privacy records why, and an ordinary session records once per instance that it was checked, so an old error clears from doctor after five such records: five later Hermes sessions or provider instances, not five captures in one long-running session. A marker is never removed: once written, that session id stays private. `memesh hermes capture-turn` and `capture-session` also check memesh's own private-session marker for the id; when the private-sessions folder beside the database cannot be read they save nothing and return an `error` sentence, which the plugin records for doctor. |
| `get_config_schema()` / `save_config()` | — | For a local loopback deployment, one optional field (`base_url`, default `http://localhost:3737`) is enough. No secrets needed. |

Automatic writes go through the `memesh` CLI rather than `POST /v1/remember`
because the HTTP route stamps everything it writes
`metadata.provenance.source_host: "http"`; the CLI path stamps `"hermes"`, so
clients can distinguish Hermes memories from Claude Code or Codex ones. The
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
  nothing reliable about which project a conversation is about. A memory with
  no project counts as one that belongs to no project, so up to five of them
  can appear in every project's session-start briefing; recall them by query
  or by `platform:hermes`.

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
