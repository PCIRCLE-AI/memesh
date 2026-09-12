# MeMesh memory provider

Local-first knowledge-graph memory for Hermes Agent, backed by
[MeMesh](https://github.com/PCIRCLE-AI/memesh) (`memesh serve`, HTTP API,
default `http://localhost:3737`).

## Setup

1. Install MeMesh globally: `npm install -g @pcircle/memesh` (requires Node >= 22).
   If your global npm prefix isn't user-writable, configure a user-owned one
   (e.g. `npm config set prefix ~/.npm-global`) and make sure the resulting
   `bin/` directory is on `PATH` — including in whatever process manager
   supervises Hermes (a systemd user service's `Environment=PATH=...` does
   **not** inherit your shell's `PATH`; this is the most common cause of
   `is_available()` reporting `false` even though `memesh --version` works
   fine interactively).
2. Run `memesh serve` as a persistent process. A systemd user service is
   recommended for anything beyond local experimentation — `Restart=always`
   so it survives crashes, ordered `After=network.target`.
3. Activate this provider: set `memory.provider: memesh` in
   `$HERMES_HOME/config.yaml` (or `hermes memory setup` once memesh is
   registered in the provider catalog).

No secrets are required for a local loopback deployment — MeMesh does not
require a bearer token when bound to `localhost`.

## Config

`$HERMES_HOME/memesh.json` (optional, written by `save_config`):

```json
{
  "base_url": "http://localhost:3737"
}
```

## Behavior

- `prefetch()` / `queue_prefetch()`: recalls up to 5 relevant entities via
  `POST /v1/recall` before each turn, injected as context.
- `sync_turn()`: hands each completed turn to `memesh hermes capture-turn`
  in a background thread. MeMesh stores it as one `conversation` entity
  (tagged `platform:hermes`, `signal:decision` or `signal:lesson`) **only**
  when the turn states a decision or a lesson; ordinary turns store nothing.
  Skipped for non-`primary` agent contexts (cron, subagents, flush) so
  automated jobs don't pollute long-term memory.
- Tools: `memesh_remember`, `memesh_recall`, `memesh_forget` — exposed for
  explicit LLM-directed memory management on top of the automatic hooks.
- `on_pre_compress()` / `on_session_end()`: pass the message list to
  `memesh hermes capture-session`, the same extractor the Claude Code Stop
  hook uses. It stores up to three `session-insight` entities —
  `session-<id>-files` (files edited), `session-<id>-fixes` (errors met while
  editing) and `session-<id>-summary` (a session with 20+ tool calls) — not a
  transcript. Both run **synchronously** (unlike `sync_turn()`): they fire
  once per session/compression, immediately before the host calls
  `shutdown()`, so a fire-and-forget background thread here reliably loses
  that race — don't "fix" this back to async.
- Automatic writes go through the `memesh` CLI (payload on stdin), so they
  are stamped `metadata.provenance.source_host: "hermes"`. The HTTP API
  stamps everything it writes `http`. Recall and the explicit tools still use
  HTTP. The CLI and `memesh serve` must therefore use the same database —
  the default when both run as the same user on the same machine. If
  `memesh serve` runs under systemd with `MEMESH_DB_PATH`/`MEMESH_DIR` in its
  unit file, give the Hermes process the same values.
- Hermes writes have no `project:` tag, so they don't show up in
  project-scoped views (for example the session-start briefing). Recall them
  by query or by the `platform:hermes` tag.
- `sync_turn()` never waits: turns go to one background worker through a
  queue of 8; when it is full the turn is dropped with a warning in the log.
  At session end and shutdown the plugin waits up to 5 s in total (one
  deadline shared by both) for queued turns; what is left is logged once,
  queued turns and still-running captures counted separately.
- `on_session_switch()`: keeps the cached `session_id` current across
  `/reset`, `/resume`, `/branch`, and context-compression session rotation,
  so memories written after a switch aren't mistagged with the pre-switch
  session id.

## Recall response shape

`POST /v1/recall` returns `data` as `{"entities": [...]}`. MeMesh 4.5.1
returned a bare array
([#159](https://github.com/PCIRCLE-AI/memesh/issues/159), fixed); this
plugin accepts both.
