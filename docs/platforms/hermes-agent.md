# MeMesh With Hermes Agent (NousResearch)

Hermes Agent has a **first-party, documented plugin system for external memory
providers** — `agent.memory_provider.MemoryProvider` (ABC), activated via
convention-based discovery under `plugins/memory/<name>/`. This is not a
generic HTTP/CLI bridge situation like ChatGPT or Gemini: Hermes ships
multiple providers this way already (honcho, mem0, hindsight, holographic,
retaindb, byterover, openviking, supermemory), and MeMesh can be added alongside them,
with automatic per-turn recall/write — no core Hermes file needs editing.

This guide is written from a working integration built and verified live
against Hermes Agent `main` (2026-08-15), MeMesh 4.5.1, on a single-GPU host
running `memesh serve` as a local systemd service. Treat it as the source
material for a proper `hermes` entry in the platform table, not a stub.

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
whose synchronous-write requirement is Pitfall 5 below.

Minimum viable methods (all required by the ABC, see Hermes's own
`website/docs/developer-guide/memory-provider-plugin.md` for the full
contract):

| Method | MeMesh call | Notes |
|---|---|---|
| `is_available()` | none (no network) | Check `shutil.which("memesh")` **and** a hardcoded `~/.npm-global/bin/memesh` fallback — see Pitfall 2. |
| `initialize()` | none | Open one `httpx.Client(base_url=..., timeout=5.0)`, reused for the provider's lifetime. |
| `prefetch(query)` | `POST /v1/recall` | Background-thread pattern: `queue_prefetch()` starts a thread after the previous turn; `prefetch()` consumes the cached result or blocks up to ~3s before giving up and returning `""`. Copy this pattern from `plugins/memory/mem0/__init__.py` — don't reinvent it. |
| `sync_turn(user, assistant)` | `memesh hermes capture-turn` (stdin) | **Must** run in a daemon thread — see Threading Contract in the dev guide. Gate on `agent_context == "primary"` (see Pitfall 3). MeMesh stores the turn only when it states a decision or a lesson; ordinary turns store nothing. |
| `on_pre_compress(messages)` / `on_session_end(messages)` | `memesh hermes capture-session` (stdin) | **Synchronous**, bounded by a 20 s timeout — see Pitfall 5. Runs the Claude Code Stop hook's extractor and stores `session-<id>-files` / `-fixes` / `-summary`, not the message list. |
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
  one database while recall reads another, and captures look lost. Same
  shape as Pitfall 2 (a service's `Environment=` is not your shell's).
- **No `project:` tag.** Hermes writes carry `platform:hermes` and
  `session:<id>`, but no project, because a gateway's working directory says
  nothing reliable about which project a conversation is about. They
  therefore do not appear in project-scoped views such as the session-start
  briefing; recall them by query or by `platform:hermes`.

Activate with `hermes memory setup memesh` (non-interactive: the second
positional arg skips the picker) — this writes `memory.provider: memesh` to
`config.yaml`. Verify with `hermes memory status`.

## Pitfalls found the hard way (all reproduced and fixed in a live session)

1. **Older MeMesh releases returned a different recall shape.** MeMesh 4.5.1
   returned a bare array in `data`; current releases return the documented
   `{ "entities": [...], "retrieval": {...}, "conflicts"?: [...] }` envelope.
   [PCIRCLE-AI/memesh#159](https://github.com/PCIRCLE-AI/memesh/issues/159)
   records the resolved historical defect. Integrations that must support
   4.5.1 can accept both shapes; integrations targeting current MeMesh should
   use the object envelope from the API reference.

2. **PATH, not code, is the usual "provider shows unavailable" cause.**
   `is_available()`'s `shutil.which("memesh")` depends on the *systemd
   service's* PATH, not your interactive shell's. `hermes-gateway.service`
   sets `Environment="PATH=..."` explicitly and narrowly — `npm install -g`
   under a custom prefix (`~/.npm-global/bin`, needed if the default global
   npm dir isn't user-writable) won't be on it until you add it to the unit
   file **and** `daemon-reload`. Symptom: `discover_memory_providers()` shows
   `is_available: False` even though `memesh --version` works fine over SSH.

3. **The `system_prompt_block()` text can cause a real, undesired side
   effect: it can make the model rewrite Hermes's own built-in
   `MEMORY.md`/`USER.md` files, not just use your new provider.** Observed
   live: an early draft that said "use the memesh_* tools to *explicitly
   manage memory*" caused the model to also reorganize/rewrite the
   pre-existing `USER.md` (structured markdown → compact prose) on a query
   that just said "remember my favorite language" — an unintended cascade
   into the *built-in* memory tool, not something MeMesh's HTTP calls did.
   Confirmed by an A/B test: same query with the provider fully disabled did
   a single clean append via the built-in tool and never touched `USER.md`.
   **Fix**: keep `system_prompt_block()` minimal and explicitly say recall
   is automatic and the explicit tools are a narrow backstop, not an
   invitation to reorganize anything:
   > "MeMesh auto-recalls relevant memory each turn; you don't need to call
   > memesh_recall yourself for that. Only call memesh_remember/recall/forget
   > for a specific, narrow lookup or correction the automatic recall
   > missed — not as a cue to reorganize or rewrite existing memory files."
   After this fix, the same "remember this" query completed cleanly with no
   `USER.md` mutation, in ~51s (built-in memory tool still fired first; when
   it errored with "file is full," the model fell back to `memesh_remember`
   as a working backstop — a good emergent behavior *once* the prompt no
   longer over-encouraged it).

4. **Don't assume a hang is your integration's fault.** A `timeout 150
   python -m hermes_cli.main -z "..."` run that produced *zero output* and
   died at the timeout looked exactly like a stuck HTTP connection (a
   `CLOSE-WAIT`/`FIN-WAIT-2` pair on the MeMesh port was visible via `ss
   -tp`, which pointed straight at the plugin). It wasn't: `-z` is not a
   valid non-interactive single-query flag (the correct invocation is
   `hermes chat -q "..." --cli`), so the process was hanging on something
   else entirely (an interactive read) before it ever reached the
   memesh-aware code path. **Always verify the CLI invocation itself against
   `hermes chat --help` before diagnosing a hang as coming from your
   provider** — and once using the right invocation, response latency
   (~16–50s observed, tool-call-count dependent) was identical whether the
   MeMesh provider was on or off, i.e. MeMesh's prefetch overhead was not
   the source of the earlier apparent hang at all.

5. **`on_session_end()` / `on_pre_compress()` need to be synchronous, not
   backgrounded like `sync_turn()`.** These two hooks exist specifically to
   solve the real production complaint that motivated writing them: on
   Telegram, once context size triggers compression/reset, Hermes "doesn't
   remember previous conversation/work content" — anything not captured by
   an individual `sync_turn()` call is otherwise lost at that boundary. The
   first implementation copied `sync_turn()`'s fire-a-background-thread
   pattern and **silently failed every single time** with `[Errno 9] Bad
   file descriptor`: `on_session_end()` fires immediately before
   `MemoryManager` calls `provider.shutdown()` (which closes the shared
   `httpx.Client`) — confirmed back-to-back in `agent/memory_manager.py`,
   ~1ms apart in `~/.hermes/logs/agent.log`. A detached thread reliably
   loses that race. **Fix**: run the archive write synchronously inside
   `on_session_end()`/`on_pre_compress()` — unlike `sync_turn()` (fires every
   turn, must not add latency), these fire once per session/compression
   boundary, so blocking briefly is both safe and required for correctness.
   Verified afterward with a real session — including one killed by an
   external `timeout` mid-run, confirming the safety-net exit path still
   archives correctly — zero further `Bad file descriptor` errors.

## Recommended platform-table entry

| Client | Best Mode | Setup | Guide |
|--------|-----------|-------|-------|
| **Hermes Agent (NousResearch)** | Native `MemoryProvider` plugin | Drop `plugins/memory/memesh/` into a Hermes Agent checkout; `hermes memory setup memesh` | This page |

Unlike the HTTP-only platforms in this directory, Hermes Agent should get
listed as a **native integration**, same tier as MCP mode for Claude Code —
the plugin, once written, behaves exactly like Hermes's own first-party
providers, discoverable and configurable through Hermes's own CLI.
