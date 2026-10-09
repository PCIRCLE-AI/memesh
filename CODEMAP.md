# CODEMAP

**Version**: 4.10.12

A navigation map for the codebase: *"I want to change X — which file?"* For the
design rationale behind these modules see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
for the public API surface see [`docs/api/API_REFERENCE.md`](docs/api/API_REFERENCE.md).

---

## Start here (entry points)

| You run… | Entry point |
|---|---|
| `memesh <cmd>` (CLI) | `src/transports/cli/cli.ts` |
| `memesh-mcp` (MCP stdio server) | `src/mcp/server.ts` → `src/transports/mcp/handlers.ts` |
| `memesh-http` (HTTP REST server) | `src/transports/http/server.ts` |
| `memesh-router` (private local router) | `src/host-runtime/router.ts` |
| `memesh-host-claude` | `src/host-runtime/claude.ts` |
| `memesh-host-codex` | `src/host-runtime/codex.ts` |
| `memesh-host-codex-session` | `src/host-runtime/codex-session.ts` |
| `memesh-host-acp` (experimental, not release-gated) | `src/host-runtime/acp.ts` |
| `memesh serve` (HTTP REST) | `src/transports/http/server.ts` |
| `memesh` (dashboard) | `dashboard/src/main.tsx` → `dashboard/src/App.tsx` root component (served from `dashboard/dist/index.html`) |
| Claude Code hooks | `scripts/hooks/*.js` (wired in `hooks/hooks.json`) |

Memory CRUD flows share `src/core/operations.ts`. Durable local messaging uses
`src/core/agent-messaging.ts` plus the transport dispatcher and private router
listed below.

---

## Directory map

```
src/
├── core/            # framework-agnostic business logic (no transport deps, except `schema-export.ts`, which imports `src/transports/schemas.ts`)
├── db.ts            # SQLite open/handle + auto-decay (schema + migrations live in storage/schema.ts)
├── knowledge-graph.ts  # Entity CRUD, relations, FTS5 search, access tracking
├── storage/         # schema.ts (schema + migrations) · sqlite.ts (driver) · conflicts.ts · fts-index.ts / entity-index.ts (contentless-FTS5) · entity-write.ts / memory-mutation.ts (write kernel + guards) · graph-repairs.ts
├── transports/      # cli/ · http/ · mcp/ (+ schemas.ts = shared Zod validation)
├── host-adapters/   # native Claude/Codex adapters + experimental ACP protocol adapter
├── host-runtime/    # managed host processes + private-router client/server
├── mcp/             # stdio server (NOTE: server lives here, handlers in transports/mcp/)
└── cli/             # view-live.ts (dashboard fallback, NOT a transport)
scripts/hooks/       # Claude/Codex hook entrypoints + shared/generated helpers
dashboard/src/       # Preact + Vite dashboard
tests/               # vitest (forks pool) — mirrors src/ layout
benchmarks/longmemeval/  # public LongMemEval-S evidence (REPRODUCE.md)
benchmarks/token/        # token-usage measurability verdict + frozen benchmark contract (CONTRACT.md)
docs/                # ARCHITECTURE.md, api/API_REFERENCE.md
```

---

## Feature → file index

### Recall / search
- Ranking / scoring weights → `src/core/scoring.ts` (`rankEntities`)
- FTS5 query + access tracking → `src/knowledge-graph.ts`
- Shared transport recall operation (cross_project / namespace / include_archived) → `src/core/operations.ts` (`recallWithConflicts`, backed by `recallEnhanced`)

### Write flows (remember / forget / learn / pin)
- remember / forget / learn / **setPinned** → `src/core/operations.ts`
- Structured lessons → `src/core/lesson-engine.ts`
- Hook capture and classification → deterministic rules in `scripts/hooks/`

### Agent-assisted work packages + human review
- Calendar-cluster or visible-transcript package preparation and strict submission → `src/core/dreamer.ts` (`executeWorkPackage`)
- Package input is bounded, redacted, and treated as untrusted; submission stages one proposal rather than applying it
- Proposal list/detail/accept/reject → `src/core/dreamer.ts`; accept/reject authority remains human
- Transcript paths are server-resolved and never enter the package or API contract

### Project identity + tags
- `getProjectName()` (git-remote-slug → repo-root → cwd-basename, cached) → `src/core/paths.ts`
  (build-generated as `scripts/hooks/_generated/core-paths.js`, then imported by `_shared.js`)
- List / merge / rename `project:*` tags → `src/core/project-tags.ts` (backs `memesh kg rename-project`)
- Find plain project tags that share their name with a project id (doctor's `project-identity-split`) → `src/core/project-identity-split.ts`
- Heuristic relation backfill (orphan connector) → `src/core/kg-backfill.ts`

### Config / self-update
- Stated task state read by the dashboard's Project tab → `GET /v1/task-state` in `src/transports/http/server.ts` → `src/core/task-state-store.ts`
- Config read/write → `src/core/config.ts`
- Path resolution (explicit `MEMESH_DIR` / `MEMESH_DB_PATH` overrides, then HOME defaults) → `src/core/paths.ts`
- `memesh doctor` health check + real probes → `src/core/doctor.ts`
- What every entry point says about updates (snooze, just-upgraded receipt, failed check) → `src/core/update-notice.ts`; the MCP first-call and CLI stderr notice → `src/core/update-entrypoint.ts`
  (build-generated as `scripts/hooks/_generated/update-notice.js` for the SessionStart / UserPromptSubmit / Stop hooks)
- npm version check / self-update → `src/core/version-check.ts`, `src/core/updater.ts`, `src/core/install-channel.ts`, `src/core/install-hooks.ts`

### Durable local agent messaging + active-host delivery
- Transactional message/delivery/receipt storage → `src/core/agent-messaging.ts`
- Exact-recipient active-host routing and in-flight ownership → `src/core/agent-router.ts`
- Shared MCP / HTTP / CLI action dispatcher → `src/transports/agent-messaging.ts`
- Host-native adapters → `src/host-adapters/`
- Managed router and host runtimes → `src/host-runtime/`
- Lifecycle and operator contract → `docs/platforms/agent-messaging.md`

### Dashboard (Preact)
- Tab routing → `dashboard/src/App.tsx`
- Analytics and proposal-review panels → `dashboard/src/components/`
- Read-only aggregation endpoints → `src/core/analytics.ts`, `stats.ts`, `projects.ts`, `patterns.ts`
- i18n registry → `dashboard/src/lib/i18n.ts`

### Hook commands (`hooks/hooks.json`)
| Command | Fires on | Does |
|---|---|---|
| `session-start.js` | SessionStart | inject top-N memories (additionalContext), banner, lesson warnings, update notice / consent prompt (does not spawn the auto-update) |
| `pre-edit-recall.js` | PreToolUse Edit/Write | inject file-relevant memories; also evaluates accepted lesson guards on the content being written |
| `guard-check.js` | PreToolUse Bash | enforce accepted lesson guards before risky repeats |
| `src/host-runtime/codex-session.ts` | SessionStart / SessionEnd | launch, supersede, and retire the detached exact-thread companion; apply a matching optional identity override |
| `session-summary.js` | Stop | deterministic session capture; handoff capture (`_stop-handoff`), note ingest + remember nudge (`_stop-notes`), spawns the consented auto-update |
| `stop-message-gate.js` | Stop | Claude-Code-only: block the stop once per waiting agent-message id (#468) |
| `pre-compact.js` | PreCompact | end-of-context save |
| `post-commit.js` | PostToolUse Bash | git commit tracking |
| `decision-nudge.js` | PostToolUse ExitPlanMode/AskUserQuestion | remind Claude to `remember` a decision just made, once per tool per session |
| `user-prompt-intent.js` | UserPromptSubmit | detect "remember" intent; also records the update-consent answer |

`scripts/hooks/_shared.js`, `_claude-channel.js`, `_clear-alias.js`, `_stop-notes.js` and `_stop-handoff.js`
are helpers, not hook commands. `scripts/hooks/auto-update-runner.mjs` is spawned by the Stop hook
(`session-summary.js` → `_shared.js` `spawnAutoUpdate`) once consent is approved; it is not registered in the manifest.

---

## Core modules (navigation map)

| File | One line |
|---|---|
| `src/index.ts` | Package root export: the Anthropic memory-tool adapter |
| `src/mcp/tools.ts` | Back-compat shim re-exporting `src/transports/mcp/handlers.ts` |
| `src/transports/http/retired-routes.ts` | Routes that answer 410 Gone on purpose, with their messages |
| `src/transports/mcp/project-context.ts` | Which project an MCP call belongs to when it names none |
| `src/host-runtime/config.ts` | Host config + router token reading; unsupported-on-Windows guard |
| `src/host-runtime/entry.ts` | Shared entry guard for every `memesh-host-*` binary |
| `src/core/agent-message-inbox.ts` | Unread-message inbox fact used by briefings |
| `src/core/agent-message-storage.ts` | Message storage and terminal-workflow pruning |
| `src/core/agent-scope-id.ts` | Canonical form + validation of message scope ids |
| `src/core/briefing.ts`, `src/core/briefing-pools.ts` | Assembled work topology for agents without hooks; shared memory selection |
| `src/core/capture-liveness.ts` | Verdict on whether automatic capture has gone quiet |
| `src/core/session-handoff.ts` | The agent's last words kept per project for the next session |
| `src/core/task-state.ts`, `src/core/task-state-store.ts` | One "where we are" per project; its storage |
| `src/core/work-topology.ts` | Which memories are the work; one-line rendering |
| `src/core/memory-tool.ts` | Anthropic `memory_20250818` adapter over the graph |
| `src/core/note-ingest.ts` | Turn a directory of note files into memories |
| `src/core/recall-agent-view.ts` | Agent-facing recall output (MCP / CLI `--json`) |
| `src/core/replaced-history.ts` | Previous versions a replaced memory keeps |
| `src/core/product-improvements.ts` | Product-improvement proposals (redacted, bounded) |
| `src/core/doctor-fixes.ts` | Doctor fix that removes retired config keys, with backup |
| `src/core/database-diagnosis.ts` | Why the database will not open, and the one fix to print |
| `src/core/transcript-source.ts` | Read-only, project-scoped transcript discovery |
| `src/core/project-attribution.ts` | Which project a memory belongs to (pure functions) |
| `dashboard/src/lib/api.ts` | Dashboard bearer-token plumbing and fetch wrapper |
| `dashboard/src/lib/i18n.ts` | i18n registry |
| `dashboard/src/lib/entity-display.ts`, `dashboard/src/lib/type-palette.ts`, `dashboard/src/lib/tokens.ts` | Shared entity display helpers, type colours, canvas-readable tokens |
| `dashboard/src/lib/failure.ts`, `dashboard/src/lib/signalMode.ts`, `dashboard/src/lib/external-handoffs.ts` | Load-failure kinds, Signal Mode toggle, inventory of deliberate exits |

---

## Request path (a `recall` call, any transport)

```
transport (cli/http/mcp) → validate (transports/schemas.ts, Zod)
  → operations.recallWithConflicts() → recallEnhanced()
    → knowledge-graph FTS5 → scoring.rankEntities()
      → conflict detection (storage/conflicts.ts) → result
```

The same `operations.ts` memory functions run identically from all three transports.

---

## Tests & docs

- Tests: `tests/` mirrors `src/`. Run `node scripts/run-tests-isolated.mjs` (throwaway HOME; forks pool, one worker).
  Cross-hook contract gate: `tests/hooks/hook-output-contract.test.ts` (validates every hook's stdout against the real Claude Code contract).
- Owner-run live checks (never CI): `scripts/qa/live-journey.mjs` — `npm run qa:live-journey -- --host codex|claude`
  drives a real Codex thread or an interactive Claude channel session and requires model-visible proof.
  Its pure half is pinned by `tests/qa/live-journey.test.ts`; the contract is in `docs/platforms/agent-messaging.md`.
- Release gates, in the order a release meets them: `verify:release` (called by `qa:pre-release`
  below) now ends with `npm run check:entry-points-start`
  (`scripts/check-entry-points-start.mjs`), which spawns every `package.json` bin and every
  `hooks/hooks.json` hook command for real and fails on any unresolved `${...}` left in
  `hooks/hooks.json`. A root `.mcp.json` is scanned only when present; none ships today.
  `npm run qa:pre-release` (`scripts/qa/pre-release.mjs`) runs build + `verify:artifact` +
  `audit:memory` as one door and prints what it could not check; `verify:artifact` is the same
  sequence `prepublishOnly` runs, named once. `scripts/smoke-packed-upgrade.mjs` derives every
  upgrade path it proves from `package.json` and the registry (`scripts/lib/upgrade-matrix.mjs`)
  instead of pinning a version pair. `npm run release:finish` (`scripts/finish-release.mjs`) runs
  `qa:pre-release` itself and blocks on its exit code, and requires a `qa:live-journey` receipt
  under `.qa/` for both Codex and Claude (separate `<host>-report.json` files), each
  `PASS`, clean-tree, and naming the exact commit being released
  (`scripts/lib/release-preconditions.mjs`'s
  `findUsableLiveJourneyReceipt`) — real-credential checks CI cannot run, now required rather
  than merely available. After publishing, `npm run qa:post-release`
  (`scripts/qa/post-release.mjs`) checks registry acceptance, a fresh install from the registry,
  and whether this machine is on the release — read-only, printing fixes rather than running them.
- Version anchors that must agree on a bump: `package.json`, both root entries in `package-lock.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `herdr-plugin.toml`, `CHANGELOG.md`, `CODEMAP.md`, `docs/ARCHITECTURE.md`, and `docs/api/API_REFERENCE.md`. Run `npm run build` after to regenerate `dist/skills-manifest.json`.
