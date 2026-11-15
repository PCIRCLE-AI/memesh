# MeMesh memory provider

Local-first knowledge-graph memory for Hermes Agent, backed by
[MeMesh](https://github.com/PCIRCLE-AI/memesh) (`memesh serve`, HTTP API,
default `http://localhost:3737`).

## Codex and Claude Code collaboration

MeMesh also lets Codex and Claude Code sessions exchange tasks, questions, reviews, and results through its local messaging channel. Claude Channel provides live delivery into a running Claude session; eligible Codex CLI sessions receive a native notice and fetch the message body. See the [collaboration setup](../../README.md#let-codex-and-claude-code-collaborate). Both hosts need the same local MeMesh instance and project; stopped sessions are not automatically resumed. This Hermes memory provider does not register Hermes as a messaging recipient.

## Setup

1. Install MeMesh globally: `npm install -g @pcircle/memesh` (requires Node >= 22.16.0).
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
3. Install this provider with `memesh hermes install` (it copies the provider
   into `$HERMES_HOME/plugins/memesh` and records which version it wrote, so
   MeMesh's automatic updates can keep it current; use `--path` for a
   different directory).
4. Activate this provider: set `memory.provider: memesh` in
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

- `prefetch()` / `queue_prefetch()`: calls `memesh hermes prompt-context`
  with the prompt on stdin. The shared selector brings in at most two strong
  matches (at most one assistant conversation), with the entire fenced context
  limited to 4 KiB of UTF-8. Truncated content includes a recall handle. It
  excludes the current session's conversations and other projects/hosts;
  Hermes's unfiled captures remain eligible. A session switch invalidates the
  cache. Missing CLI, failures and timeouts skip injection with a log warning.
  Content delivered during this provider process is deduplicated per session;
  opening titles do not mark content as read.
- `sync_turn()`: sends every completed primary-agent turn to `memesh hermes
  capture-turn` in a background thread. Each nonempty side becomes a separate
  `conversation` memory in full, after secret masking, with `platform:hermes`,
  `session:<id>` and `role:user` / `role:assistant` tags. No keyword classifier
  or 2,000-character text cap is used. The prefetched recall block is removed
  before the user text is stored. Non-primary agent contexts remain excluded.
- Tools: `memesh_remember`, `memesh_recall`, `memesh_forget` remain available.
  `why` is optional for decisions; those without it are stored and labelled
  "no reason recorded".
- `on_pre_compress()` writes nothing. `on_session_end()` only drains queued
  turns, sharing one 5-second deadline with `shutdown()`; activity summaries
  are no longer generated. Check the outcome log for queued or running turns
  that remain at the deadline.
- Automatic writes go through the `memesh` CLI (payload on stdin), so they
  are stamped `metadata.provenance.source_host: "hermes"`. The HTTP API
  stamps everything it writes `http`. Automatic recall also uses the CLI;
  explicit tools use HTTP. The CLI and `memesh serve` must use the same database —
  the default when both run as the same user on the same machine. If
  `memesh serve` runs under systemd with `MEMESH_DB_PATH`/`MEMESH_DIR` in its
  unit file, give the Hermes process the same values.
- Hermes writes have no `project:` tag, so MeMesh treats them as memories
  that belong to no project: up to five of them can appear in every
  project's session-start briefing. Recall them by query or by the
  `platform:hermes` tag.
- `sync_turn()` never waits: turns go to one background worker through a
  queue of 8; when it is full the turn is dropped with a warning in the log.
  At session end and shutdown the plugin waits up to 5 s in total (one
  deadline shared by both) for queued turns; what is left is logged once,
  queued turns and still-running captures counted separately.
- `on_session_switch()`: keeps the cached `session_id` current across
  `/reset`, `/resume`, `/branch`, and context-compression session rotation,
  so memories written after a switch aren't mistagged with the pre-switch
  session id.

Automatic recall is controlled by `promptRecall`. Turning `autoCapture` off
stops automatic storage but leaves recall available; turn `promptRecall` off
separately to disable automatic recall.
After validating the session and input, `capture-turn` checks the effective
auto-capture setting before opening the database. When off it returns
`outcome: "skipped"` with reason `"auto-capture is turned off"`, which the provider
logs. Manual `remember` calls are unchanged.
The explicit `memesh_recall` tool retains the HTTP response envelope.
