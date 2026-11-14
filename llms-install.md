# Installing MeMesh — deterministic steps for an AI agent

This document is for an AI agent installing MeMesh (`@pcircle/memesh`) on its
user's machine. Execute each section exactly, verify with the stated check,
then stop. Once installed, read [AGENTS.md](AGENTS.md) for how to use it.

Facts that hold for every path below:

- Hosts running as the same local user share `~/.memesh/knowledge-graph.db`
  by default. `MEMESH_DIR` or `MEMESH_DB_PATH` can select a different database;
  keep those settings consistent when hosts should share memories.
- **Nothing is auto-configured beyond what each step states.** `npm install -g`
  runs **no install scripts** — the package has none, by design (it installs
  fully working even under `--ignore-scripts`). Nothing registers MCP servers
  except the per-host commands in this document.
- Where a host asks for a configured MCP command, use `memesh-mcp` —
  **never `npx -p @pcircle/memesh`**. `npx -p` resolves to the *local* package
  whenever the host's working directory is inside a checkout of this
  repository, silently running that working tree instead of the installed
  release.

## 1. Claude Code (plugin)

Type these in Claude Code's **chat input** — they are Claude Code slash
commands, not shell commands:

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

Claude Code wires the MCP server, the auto-capture hooks, and the `/memesh`
skill automatically.

**Verify**: restart Claude Code. A status line beginning `◉ MeMesh` appears at
the top of the next session. MeMesh supports Node 26.13.1 or later within 26.x (recommended),
24.22.3 or later within 24.x, or 22.23.5 or later within 22.x on the `PATH`
Claude Code uses (`node --version`); on a Node it cannot use, the top of the
session shows `MeMesh: This Node (v…) …` instead, with the one repair that
applies, and none of MeMesh's tools work until it is done (see the table).

| Failure | Remedy |
|---|---|
| `/plugin marketplace add` fails | The marketplace is fetched as a git clone. Check `git --version` succeeds and github.com is reachable. |
| `/plugin install` says plugin not found | The argument is exactly `memesh@pcircle-memesh` — plugin name `memesh`, marketplace name `pcircle-memesh`. Re-run the marketplace add first. |
| `MeMesh: This Node (v…) lacks the full-text search MeMesh needs; upgrade to Node 22.16 or newer …` | The Node on `PATH` lacks the required SQLite capability (`node --version`). Upgrade to one of the supported security releases above, then restart Claude Code. |
| `MeMesh: This Node (v…) is new enough, but its built-in SQLite (node:sqlite) is switched off …` | Node was started with `--no-experimental-sqlite`, on its command line, in the `NODE_OPTIONS` environment variable or in a Node config file. Remove it (or install the official Node build from nodejs.org), then restart Claude Code. Upgrading Node does not help. |
| `MeMesh: This Node build (v…) lacks the full-text search (FTS5) MeMesh needs …` | This Node build has no FTS5. Install an official supported security release above from nodejs.org, then restart Claude Code. |
| No `◉ MeMesh` line and no `MeMesh: …` line after restart | Run `/plugin` inside Claude Code and confirm the `memesh` plugin is installed and enabled, then restart again. |

The plugin does **not** put a `memesh` command on the shell PATH. For terminal
use — and as a prerequisite for section 4 and for section 3's manual
npm-global alternative — also do section 2. The two installs coexist and share
the database.

## 2. Terminal / CLI (npm global)

Check Node **first** — supported security floors are 22.23.5, 24.22.3,
or 26.13.1 within their respective major lines (`node:sqlite` is part of Node
itself, and its full-text search first ships in 22.16; npm only warns on an engine mismatch, so an install onto an old Node
"succeeds" and fails later at runtime):

```
node --version
```

Expected: `v26.13.1` or later within 26.x (recommended), `v24.22.3` or
later within 24.x, or `v22.23.5` or later within 22.x. Otherwise stop and
upgrade Node before continuing.

```
npm install -g @pcircle/memesh
```

Expected: exits without error; `memesh`, `memesh-mcp` and `memesh-http` are
now in `$(npm prefix -g)/bin/`. No compiler is involved and no install script
runs.

After installation, run `memesh doctor`. To probe the **installed** message MCP plus its bundled host-adapter imports (rather than only checking a manifest hash), opt in explicitly:

```
MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 memesh doctor
```

This probe does not exercise a real host session and never wakes a stopped
session. The current MCP/CLI conversation contract is separate from legacy
HTTP messaging: `discover`, `send`, `read`, and `status` are its only actions.
Use `send --recipient <id> --kind <task|question|review_request|result>
--payload-stdin`; body text is stdin-only and host identity supplies the
sender. The full rendered envelope is limited to 8,000 UTF-8 bytes. Unknown
recipients and oversized sends are rejected and audited; known offline
recipients are queued. `queued` is not delivery or a reply.

Messages and audit events remain for 14 days, with one undelivered notice after
a day. `read --message-id <id>` records delivery/read and `status --json` shows
the CLI audit view. These facts do not prove host-native or model-visible
delivery; verify runtime integration separately. Legacy HTTP polling, fetch and
receipt paths remain compatibility behavior, not aliases for conversation
actions.

### Optional legacy local-host setup

The current conversation MCP/CLI interface needs no router setup command: use `discover`, `send`, `read`, and `status`. Send body text only with `--payload-stdin`; host identity supplies the sender and the rendered envelope is capped at 8,000 UTF-8 bytes. Known offline recipients are queued, not delivered.

The source retains an older owner-operated HTTP/agent-message router and host setup for compatibility. Keep its private configuration owner-only and require explicit Channel admission. `memesh-router` is its owner diagnostic/legacy entrypoint, not a prerequisite for conversation MCP/CLI. Do not copy project, polling, fetch, intake, native-envelope, or receipt flags into new conversation calls. Host-native/Codex acceptance remains separate runtime verification.

## 3. Codex CLI

Install from the Codex plugin marketplace for zero-config MCP tools and the
SessionStart/SessionEnd companion lifecycle:

```
codex plugin marketplace add PCIRCLE-AI/memesh
codex plugin add memesh@pcircle-memesh
```

The plugin manifest starts its bundled `dist/mcp/server.js` directly from the
plugin cache. It does not need a global `memesh-mcp` command or a manual
`codex mcp add` entry.

**Verify**:

```
codex mcp list
```

Expected: `memesh` is listed as enabled.

### Manual npm-global alternative

If you installed section 2 instead of the Codex plugin, register the global
stdio command manually:

```
codex mcp add memesh -- memesh-mcp
```

This writes `[mcp_servers.memesh]` into `~/.codex/config.toml`.

### Refresh a damaged plugin cache

To move to a newer release, do nothing (MeMesh updates itself, see "Updates"
below) or run `memesh update`. To **repair** a damaged or unverifiable plugin
cache, run:

```
memesh update --reinstall
```

It puts this very version back through the same checks an update takes (the
release's source is verified, your database is backed up, the commit is pinned and
read back), for Claude Code and Codex alike. Do not use `codex plugin marketplace
upgrade` or `memesh upgrade-plugin` for this: they install the marketplace's
current branch, which is ahead of the last release and has not been checked.
`memesh doctor --fix` starts the same reinstall in the background. No `memesh`
command on your PATH (a plugin-only install)? Run the CLI the plugin ships:
`node <plugin directory>/dist/transports/cli/cli.js update --reinstall`; `npx`
cannot do it, because it runs a throwaway copy that is not your install.

| Failure | Remedy |
|---|---|
| `command not found: codex` | Codex CLI itself is not installed — out of scope here; install it first, then re-run the add. |
| Plugin-installed `memesh` is absent | Run `memesh update --reinstall` (above), then restart Codex. |
| Manually registered `memesh` is absent | Re-run `codex mcp add memesh -- memesh-mcp` and re-check. |
| Manual registration is listed, but tool calls fail | Run `command -v memesh-mcp`. Empty output means section 2 is incomplete or PATH is wrong — fix per section 2's table. |

## Updates

MeMesh updates itself by default, to every new version (patch, minor and major).
This default applies when HOME is the system account's home, including containers
and systems with no account-home entry, regardless of the data directory.
CI and a different test/sandbox HOME default to off; explicitly setting
`autoUpdate` in that environment can enable it. An account-level off still wins.
It installs only a release whose npm provenance it has checked, backs up your
database first, waits until your running sessions have ended (at most 3 days),
and then replaces the files; the new version starts with your next session.
npm-global installs, the Claude Code plugin and the Codex plugin are all covered.

- **What it checks**: the release's npm provenance (built by this project's
  release workflow at that version's tag), that its commit is part of `main` in
  the official repository (asked of the host's compare service; no answer means no
  install), and that it pins every dependency with a hash. It then installs
  without running any install script, and applies the pinned dependency versions,
  in the way each install method allows: an npm-global install rehearses the
  pinned install first, then installs the verified package and runs `npm ci` from
  its `npm-shrinkwrap.json`, and puts the previous version back if that fails; the
  Claude Code plugin installs the dependencies with `npm ci` from the lockfile of
  the release commit; the Codex plugin is installed from a self-contained bundle.
- **See what it did**: `memesh doctor` (row "Automatic updates").
- **Update right now**: `memesh update` (same checks, no waiting).
- **Turn it off**: `memesh config set autoUpdate off`, or set the environment
  variable `MEMESH_AUTO_UPDATE=off`. An explicit `off` is never overridden by an
  automatic update. It does not stop you from running `memesh update` yourself:
  that is an update you asked for, and it says the setting is still off.
- **Limit it**: `memesh config set autoUpdate patch` (or `minor`) installs only
  that size of change.

## 4. Cursor

Prerequisite: section 2 — `memesh-mcp` must resolve on PATH.

For a personal server available in every Cursor project, create or edit
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memesh": {
      "command": "memesh-mcp"
    }
  }
}
```

For one project only, use the same entry in that project's `.cursor/mcp.json`.
Restart Cursor, then open Cursor's MCP settings and confirm that `memesh` is
connected. If the Cursor Agent CLI is installed, `cursor-agent mcp list` also
shows the configured server.

A client that reports no workspace root needs `MEMESH_PROJECT_ROOT` set to the project's absolute directory in the server's `env`, or pass `project` on each `remember`, `learn` and `recall` call.

| Failure | Remedy |
|---|---|
| `memesh` is disconnected | Run `command -v memesh-mcp`. Empty output means section 2 is incomplete or PATH is not visible to Cursor. |
| Cursor cannot start the server | Use the absolute path returned by `command -v memesh-mcp` as `command`, then restart Cursor. |
| Tools are missing | Confirm the `mcpServers.memesh` entry is valid JSON and that the server is configured as a local stdio command, not an HTTP URL. |
