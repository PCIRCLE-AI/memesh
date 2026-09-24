import { appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { MemeshDatabase } from './_generated/sqlite.js';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// =============================================================================
// Path helpers + FTS primitives — GENERATED from src/core (do not hand-mirror)
// =============================================================================
//
// These were once a 965-line hand-mirror of `src/core`, kept in lockstep by
// human review — until the copies drifted and shipped the P0 FTS bug (a hook
// wrote an entity+observations but the mirror's reindex step diverged, leaving
// the memory unrecallable).
//
// `src/core/paths.ts` and `src/storage/fts-index.ts` are runtime-LEAF modules
// (paths.ts imports only node builtins; fts-index.ts has only a type-only
// import), so `tsc` emits self-contained JS for them. `scripts/generate-hook-core.mjs`
// copies that compiled JS to `_generated/` at build time — committed, shipped in
// the tarball, and version-locked to its own install. So the hook path still
// survives a missing/stale `dist/` (the F5 constraint) exactly as the hand-mirror
// did, but the copy is byte-locked to core and CI-gated (`git diff` on rebuild +
// `tests/hooks/mirror-parity.test.ts`), making drift structurally impossible.
//
// Re-exported here so all 6 hooks keep importing these names from `_shared.js`
// unchanged.
import {
  homeDir,
  memeshDir,
  getDbPath,
  getMemeshDirFromDbPath,
  getProjectName,
  redactSecrets,
  canonicalRemoteLocator,
  gitRepoRoot,
} from './_generated/core-paths.js';
import { autoCaptureDecision } from './_generated/capture-flag.js';
import { SESSION_HANDOFF_TYPE } from './_generated/session-handoff.js';
export { assembleTopologyBlock, buildReferenceContext, extractCitedMemoryIds, hasBriefingContent, projectLabel, DEFAULT_TOPOLOGY_BUDGET, GLOBAL_TOPOLOGY_LIMIT, SNIPPET_FETCH_CHARS, TOPOLOGY_CANDIDATE_CAP } from './_generated/work-topology.js';
export { readRepoState, repoStateLines } from './_generated/repo-state.js';
export { matchingGuards, guardFromMetadata } from './_generated/guards.js';
export { writeCitationRule, citationRulePath, CITATION_RULE_BODY } from './_generated/citation-rule.js';
// Imported locally (recordHookOutcome below uses them) AND re-exported, so
// every hook reaches the same definition through one module.
import {
  detectHookHost,
  serializeHookOutcome,
  trimHookOutcomeLines,
  HOOK_OUTCOMES_FILENAME,
  HOOK_OUTCOMES_ROTATE_BYTES,
} from './_generated/capture-liveness.js';
export {
  advanceGraceState,
  captureLivenessNotice,
  captureLivenessVerdict,
  graceInEffect,
  parseGraceState,
  parseHookOutcomes,
  summarizeHookOutcomes,
  HOOK_OUTCOMES_FILENAME,
  SKIP_REASONS,
  isGitCommitCommand,
} from './_generated/capture-liveness.js';
export {
  resolveUpdateNotice,
  shouldRefreshUpdateCache,
  readSnooze,
  writeSnooze,
  clearSnooze,
  readJustUpgradedMarker,
  writeJustUpgradedMarker,
  clearJustUpgradedMarker,
  claimJustUpgradedMarker,
  isStrictlyOlder,
} from './_generated/update-notice.js';
import { guardFromMetadata as guardFromMetadataLocal } from './_generated/guards.js';

/**
 * Every accepted, enabled guard for one tool. Guards live as
 * `metadata.guard` on lesson-family entities (G1); the LIKE is a cheap
 * prefilter and `guardFromMetadata` is the tolerant parser. Any failure —
 * missing column on an old schema, corrupt metadata — returns an empty
 * list: a broken guard store must degrade to "no warnings", never to a
 * broken hook.
 */
export function loadActiveGuards(db, tool) {
  try {
    const rows = db.prepare(
      `SELECT id, metadata FROM entities
       WHERE status = 'active'
         AND type IN ('lesson_learned', 'lesson', 'mistake')
         AND metadata LIKE '%"guard"%'`
    ).all();
    const out = [];
    for (const r of rows) {
      const g = guardFromMetadataLocal(r.id, r.metadata);
      if (g && g.tool === tool) out.push(g);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The lines a fired guard injects — the message is memory content
 * (attacker-influenced in the general case), so callers wrap these with
 * buildReferenceContext like every other injection path. The `[mem:id]`
 * handle ties a heeded warning into citation accounting (R1).
 */
export function guardWarningLines(matches, toolName) {
  const lines = [`A guard you accepted matched this ${toolName} input — check before proceeding:`];
  for (const g of matches) {
    lines.push(`- [guard] ${g.message} [mem:${g.lessonId}]`);
  }
  return lines;
}

/** How long the fire counter waits for another writer's lock, in ms. Exported
 *  so the tests read the same number the hook uses. */
export const GUARD_COUNTER_WAIT_MS = 200;

/**
 * Count a guard's fire. Opens its own WRITABLE handle briefly (the
 * evaluating hooks read through a read-only one) and swallows every
 * failure: the count powers guard-ROI review, and review data must never
 * block the user's work.
 *
 * Waits at most `GUARD_COUNTER_WAIT_MS` for the write lock. The hooks of
 * parallel tool calls each hold it for a millisecond or two and take turns;
 * when the lock is still held after the wait, the count is skipped and it is
 * reported on stderr as not counted. A missed count is invisible to the user;
 * a long wait is not. The host kills a hook at its `hooks.json` budget, and a
 * killed hook loses the guard warning the user needed — on slow CI runners a
 * contended 2 s wait was measured at close to 4 s of the 5 s, so the wait is
 * short. With no wait at all, hooks running at the same instant lost about a
 * third of their counts.
 */
export function recordGuardFires(dbPath, lessonIds) {
  if (!lessonIds || lessonIds.length === 0) return;
  try {
    const db = new MemeshDatabase(dbPath);
    try {
      // The constructor only opens the file and sets the 30 s wait meant for
      // the CLI and servers; nothing has touched the lock yet, so lowering it
      // here is early enough. Not `HOOK_BUSY_TIMEOUT_MS`: that wait is for
      // reads and capture writes, which are worth retrying for longer.
      db.pragma(`busy_timeout = ${GUARD_COUNTER_WAIT_MS}`);
      const stmt = db.prepare(
        `UPDATE entities
         SET metadata = json_set(metadata,
           '$.guard.fires', COALESCE(json_extract(metadata, '$.guard.fires'), 0) + 1,
           '$.guard.last_fired_at', ?)
         WHERE id = ?`
      );
      const now = new Date().toISOString();
      for (const id of lessonIds) stmt.run(now, id);
    } finally {
      db.close();
    }
  } catch (err) {
    // Never block the user's work — but say so. A read-only database file, a
    // lost lock, or a schema drift silently stopped the fire counter, and
    // guard ROI is judged on exactly this number: a guard that fires often
    // and a guard whose counter never landed look identical in review. One
    // line on stderr is what guard-check already does for its own failures.
    try {
      process.stderr.write(`[memesh guard-fires] not counted: ${err?.message || err}\n`);
    } catch { /* stderr gone */ }
  }
}
import { isAutoInjectable } from './_generated/work-topology.js';
export { parseTaskState, taskStateLines, taskStateName, briefingTaskStateLines, STALE_TASK_STATE_HOURS } from './_generated/task-state.js';
// #360 — the one briefing-level policy, shared with the `briefing` tool via
// src/core/briefing-level.ts (this is the generated mirror; see that file).
export {
  isBriefingLevel,
  DEFAULT_BRIEFING_LEVEL,
  briefingLevelPolicy,
  sessionStartAppendsWorkPackageNotice,
} from './_generated/briefing-level.js';
import { resolveBriefingLevel as resolveBriefingLevelValue } from './_generated/briefing-level.js';
import { unreadInboxLinesFor } from './_generated/agent-message-inbox.js';

// The hook-only work-package notice's literal text — ONE declaration,
// exported so both `session-start.js` (which appends it) and the test
// suite (which needs to assert the hook's `full`-level remainder is
// EXACTLY this string, not a hardcoded second copy of it) read the same
// constant.
export const WORK_PACKAGE_NOTICE = 'Work packages: check work_package prepare for this project (digest or transcript). When available, offer a concise host-native interactive choice in the user’s conversation language: dispatch an agent task, later (defer not_now), or stop suggesting for this session. Never dispatch without the user choosing it. The Dashboard cannot dispatch agents, and no durable opt-out is implied.';
import {
  indexedObservationText,
  insertFtsRow,
  joinIndexedObservations,
  removeFromFts,
  renderMatchExpression,
  renderPhraseExpression,
  tokenizeQuery,
} from './_generated/fts-index.js';

export { homeDir, memeshDir, getDbPath, getMemeshDirFromDbPath, getProjectName, redactSecrets, canonicalRemoteLocator, gitRepoRoot };

/**
 * Resolve the package root from a hook file's `import.meta.url`.
 *
 * Hooks live at `<pkgRoot>/scripts/hooks/<file>.js`, so the path needs
 * three `dirname()` hops to reach `<pkgRoot>`. Centralising this here
 * prevents the off-by-one regression that silently disabled hook-to-core
 * imports between 4.0.4–4.1.0 (the inline
 * `dirname(dirname(...))` only reached `<pkgRoot>/scripts`, and the
 * surrounding `catch` swallowed the resulting ENOENT).
 *
 * The path is derived strictly from the caller's URL — there is no env
 * override — so a malicious project's `.envrc` cannot redirect dynamic
 * imports to attacker-controlled code (the F5 boundary).
 *
 * @param {string} metaUrl - typically `import.meta.url` of the caller
 * @returns {string} absolute path to the package root
 */
export function resolvePluginRoot(metaUrl) {
  return dirname(dirname(dirname(fileURLToPath(metaUrl))));
}

/**
 * Dynamically import a built module from `<pluginRoot>/dist/...`.
 *
 * ESM `import()` takes a URL, not a filesystem path. On POSIX an absolute
 * path happens to work because it starts with `/`; on Windows an absolute
 * path is `D:\...`, which the ESM loader reads as a URL whose scheme is
 * `d:` and rejects with:
 *
 *   Only URLs with a scheme in: file, data, and node are supported by the
 *   default ESM loader. On Windows, absolute paths must be valid file://
 *   URLs. Received protocol 'd:'
 *
 * That error is caught by each caller's surrounding try/catch and only
 * traced to stderr, so on Windows every hook that reaches for a dist module
 * — lifecycle reads, lesson creation, and auto-decay —
 * silently did nothing, while macOS/Linux and `memesh doctor` stayed green.
 * A textbook fake-working boundary: the discipline of converting the path
 * (already applied to the install-channel import above via
 * `pathToFileURL().href`) simply stopped at these call sites.
 *
 * Centralising the conversion here means it is done correctly once and can
 * never drift per-site again. All hook → dist imports MUST go through this.
 *
 * @param {string} pluginRoot - from `resolvePluginRoot(import.meta.url)`
 * @param {string} relativePath - e.g. `'dist/core/config.js'`
 * @returns {Promise<any>} the imported module namespace
 */
export function importFromPluginRoot(pluginRoot, relativePath) {
  return import(pathToFileURL(join(pluginRoot, relativePath)).href);
}

// A bounded, generic classification for "the config document itself could
// not be used" —
// deliberately NOT the raw file path, the JSON.parse error text, or any
// fragment of the file's own content (a parse error message can echo a
// slice of the source in some engines; this string never does). One
// constant, so the wording cannot drift between the outcome-record reason
// below and whatever a future second reader of this state might print.
// Kept here rather than reusing `src/core/config.ts`'s own message: that
// file's `warnUnreadable()` prints the real path and the parse-error
// detail, is stateful (dedupes repeated warnings), and is not a zero-import
// leaf this hook could import (the A1a/F5 boundary) — the wording below is
// independently chosen to describe the SAME state, not literally shared.
export const HOOK_CONFIG_UNREADABLE_REASON =
  'config: config.json exists but could not be read as a settings object — using defaults until the file is fixed';

/**
 * Read ~/.memesh/config.json directly, with a classification of whether the
 * document itself could be used at all. Hooks must not depend on dist/ (F5
 * boundary), so this reads the JSON as a plain file rather than importing
 * readConfig from src/core/config.ts.
 *
 * Always reads `~/.memesh/config.json` to stay consistent with
 * `src/core/config.ts`, which is the single writer. Earlier versions
 * read `dirname(MEMESH_DB_PATH)/config.json`, which silently diverged
 * from the CLI-managed config any time a custom DB path was set: hooks
 * would ignore `memesh config set autoCapture …` and friends. Fixed
 * by treating the homedir path as the canonical source.
 *
 * `state` mirrors `src/core/config.ts`'s own `ConfigReadState` — same three
 * values, same meaning — so a caller recording an outcome for one matches
 * the wording a CLI/MCP caller would report for the other, without this
 * file importing that one (see `HOOK_CONFIG_UNREADABLE_REASON`'s comment).
 * `readHookConfig()` below is the pre-existing plain wrapper every current
 * caller uses; this file's five internal readers were left untouched on
 * purpose — only `session-start.js`'s malformed-config check needs `state`.
 *
 * @param {NodeJS.ProcessEnv} [_env=process.env] - kept for signature
 *   compatibility (env was the prior MEMESH_DB_PATH source); ignored.
 * @returns {{ config: Record<string, any>, state: 'ok' | 'absent' | 'unreadable' }}
 */
export function readHookConfigResult(_env = process.env) {
  const path = join(memeshDir(), 'config.json');
  if (!existsSync(path)) return { config: {}, state: 'absent' };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { config: parsed, state: 'ok' };
    }
    return { config: {}, state: 'unreadable' };
  } catch {
    return { config: {}, state: 'unreadable' };
  }
}

/**
 * The plain, backward-compatible reader every existing caller in this file
 * uses (`isAutoCaptureEnabled`, `resolveSessionLimit`, `resolveAutoUpdatePolicy`,
 * `resolveBriefingLevel`, `isUpdateCheckEnabled`) — returns an empty object
 * on missing/unreadable/malformed file; callers
 * must always be defensive about which fields are set. `readHookConfigResult()`
 * above is the state-aware version for a caller that needs to know WHY the
 * config came back empty, not just that it did.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Record<string, any>}
 */
export function readHookConfig(env = process.env) {
  return readHookConfigResult(env).config;
}

/**
 * Resolve the auto-capture flag.
 * Precedence: env > config > default(true).
 * Env semantics preserved: explicit `=== 'false'` disables; any other
 * value (including undefined) leaves it on or defers to config.
 *
 * src/core/doctor.ts duplicates this precedence (isAutoCaptureOff — the
 * TS/hook-JS bundle boundary forbids sharing code). A semantic change here
 * MUST be mirrored there, or doctor starts reasoning about a disabled state
 * the hooks don't agree on.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function isAutoCaptureEnabled(env = process.env) {
  // The precedence (env > config > default-on, and which values count) lives
  // in src/core/capture-flag.ts, executed here via its generated copy — the
  // same code doctor's autoCaptureOffSource runs, so the two sides cannot
  // fork. Only the config READ stays hook-side (readHookConfig's lenient
  // parse).
  return autoCaptureDecision(env.MEMESH_AUTO_CAPTURE, readHookConfig(env).autoCapture).enabled;
}

/**
 * Resolve the session-start memory-injection top-N limit.
 * Precedence: env > config > default(10).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number}
 */
export function resolveSessionLimit(env = process.env) {
  const envVal = env.MEMESH_SESSION_LIMIT;
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const cfg = readHookConfig(env);
  if (typeof cfg.sessionLimit === 'number' && cfg.sessionLimit > 0) {
    return cfg.sessionLimit;
  }
  return 10;
}

/**
 * Resolve the briefing level (#360). Precedence: env `MEMESH_BRIEFING` >
 * config `briefing` > default. A present-but-invalid env value fails closed to
 * the default without consulting config (unlike `resolveSessionLimit` above,
 * which falls through to config).
 * The validation and default live in the shared leaf (`resolveBriefingLevel`
 * in `_generated/briefing-level.js`); this only supplies the two raw values —
 * an unknown value on EITHER source is reported via `.invalid`, so the
 * caller can record why the default was used instead of silently falling
 * back (this repo treats a silent fallback as a defect).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {Record<string, any>} [config=readHookConfig(env)] - the settings
 *   document, when the caller has already read it (and needs the read's
 *   `state` too), so config.json is read once.
 * @returns {{level: 'minimal'|'standard'|'full', invalid: {source: 'env'|'config', value: string}|null}}
 */
export function resolveBriefingLevel(env = process.env, config = readHookConfig(env)) {
  return resolveBriefingLevelValue(env.MEMESH_BRIEFING, config.briefing);
}

/**
 * The tag every capture hook attaches to what it writes.
 *
 * `memesh doctor`'s hook-activity row counts THIS to answer "is the
 * auto-capture loop alive" — it used to answer from entity type, and one of
 * those types is what `memesh learn` writes by hand. The constant lives in
 * `src/core/types.ts` for the TypeScript side; the hooks are plain .js loaded
 * by Claude Code and cannot import it, so this is the one mirror.
 * `tests/auto-capture-provenance.test.ts` fails if the two ever disagree, or
 * if a capture hook stops writing it.
 */
export const AUTO_CAPTURE_TAG = 'source:auto-capture';

/**
 * Auto-captured SESSION-SNAPSHOT types — the transient rollups `pre-compact.js`
 * and `session-summary.js` restate on every PreCompact / Stop, purely as
 * session bookkeeping ("N tool calls", "compaction reason: auto"), and the
 * session handoff `_stop-handoff.js` restates on every Stop (the agent's last
 * message, which names files in passing). Not the
 * same set as `AUTO_CAPTURE_TAG`: that tag also marks `commit` entities,
 * which can genuinely be about the file being edited, so it is too broad for
 * this exclusion.
 *
 * `pre-edit-recall.js`'s Strategy 1 matches a `session-insight` entity for
 * ANY file a session touched — `session-<id>-files`/`-fixes` carry a
 * `file:<name>` tag per file, unconditionally — so without this exclusion it
 * injects lines like "Session edited 1 file(s): X" for every edit of a file
 * that session ever touched (#358). The handoff would match the same way
 * through its text. No list already in the codebase matches these three
 * alone: `EVIDENCE_LAYER_TYPES` (work-topology.ts), `NOISE_TYPES`
 * (analytics.ts, lifecycle.ts) and `COMPACTABLE_TYPES` (dreamer.ts) all also
 * include `commit` (and some include `session_keypoint`, `workflow_checkpoint`
 * etc.), which this exclusion must NOT touch.
 */
export const SESSION_SNAPSHOT_TYPES = new Set(['session-insight', 'session-summary', SESSION_HANDOFF_TYPE]);

const VALID_AUTO_UPDATE_POLICIES = new Set(['off', 'patch', 'minor', 'major']);

/**
 * Resolve the auto-update policy.
 * Precedence: env > config > default('off').
 *
 * The session-start hook uses this to decide whether to kick off a
 * background `npm install -g @pcircle/memesh@<latest>` when an update
 * is available. Default is 'off' so a fresh install never silently
 * upgrades the user's global binary; opting in is a deliberate
 * config write or env export.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {'off' | 'patch' | 'minor' | 'major'}
 */
export function resolveAutoUpdatePolicy(env = process.env) {
  const envVal = env.MEMESH_AUTO_UPDATE;
  if (envVal !== undefined) {
    if (typeof envVal !== 'string') return 'off';
    const lowered = envVal.toLowerCase();
    if (VALID_AUTO_UPDATE_POLICIES.has(lowered)) return lowered;
    // An explicit but malformed higher-priority value must not uncover a
    // permissive config value and authorise an unattended global mutation.
    return 'off';
  }
  const cfg = readHookConfig(env);
  if (typeof cfg.autoUpdate === 'string') {
    const lowered = cfg.autoUpdate.toLowerCase();
    if (VALID_AUTO_UPDATE_POLICIES.has(lowered)) return lowered;
  }
  return 'off';
}

// The schema and its migration toolkit come from src/storage/schema.ts via
// the generated copy — the SAME bytes core's openDatabase executes. The
// ~300-line hand-mirror that lived here ("must change in lockstep") is gone;
// a new column or migration lands in schema.ts once and reaches both sides.
export {
  SCHEMA_SQL,
  FTS_SQL,
  ensureTagsUniqueIndex,
  ensureHookRunsSince,
  FTS_SEGMENTATION_VERSION,
} from './_generated/schema.js';
import {
  SCHEMA_SQL,
  FTS_SQL,
  migrateEntitiesSchema,
  ensureTagsUniqueIndex,
  ensureHookRunsSince,
  ensureFtsSegmentation,
} from './_generated/schema.js';



/**
 * Open the hook-side memesh DB with schema + status migration applied.
 *
 * Two of three hooks (post-commit, pre-compact) previously inlined the
 * same SCHEMA_SQL but skipped the v2.11→v2.12 status migration that
 * session-summary.js ran. This unified helper closes the drift gap so
 * every hook converges on the same shape regardless of order.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {object} [opts]
 * @param {boolean} [opts.fts=false] - Also create the FTS5 virtual table.
 * @returns {{ db: any, dbPath: string }}
 */
// No native-binding probe, and nothing to self-heal.
//
// This is where ~160 lines used to live: a cached require() of
// better-sqlite3, an in-memory construction to force the deferred bindings
// load, two test seams to simulate the failure, and a detached
// `npm rebuild` with an O_EXCL marker so a crash-loop could not storm it.
// All of it existed because better-sqlite3 ships a compiled binary that
// `npm install --ignore-scripts` never builds — and Claude Code's
// `/plugin install` uses exactly that flag, so every hook silently did
// nothing. node:sqlite is part of the runtime: there is no binary to
// miss, so the failure mode and its whole recovery apparatus are gone.

/** See the pragma in `openHookDb` for why this is not the 30s the shared
 *  database class uses. Exported because the three hooks that open a
 *  read-only handle directly (bypassing `openHookDb`, which cannot express
 *  `readOnly`) must apply the same cap themselves. */
export const HOOK_BUSY_TIMEOUT_MS = 2000;

/**
 * Who this session says it is, for the durable message inbox: the exact
 * recipient id in `MEMESH_RECIPIENT`, or undefined when it is unset. A Claude
 * Code session that was not started with the channel flag has no identity a
 * sender could address, so without this it is never told a message is waiting.
 * The id is compared exactly (after Unicode NFC, trimmed, 1-200 characters),
 * the same rule the `message` tool applies to a recipient, so any id a sender
 * can address can be declared here. It is shown JSON-quoted, which is what
 * makes odd characters safe to print. An empty value counts as unset; one over
 * 200 characters is ignored with a line on stderr rather than silently.
 */
export function resolveMessageRecipient(env = process.env) {
  const raw = env.MEMESH_RECIPIENT;
  if (raw === undefined) return undefined;
  const id = String(raw).normalize('NFC').trim();
  if (id === '') return undefined;
  if (id.length > 200) {
    try { process.stderr.write('[memesh] MEMESH_RECIPIENT ignored: a recipient id is at most 200 characters\n'); } catch { /* stderr gone */ }
    return undefined;
  }
  return id;
}

/**
 * A failed inbox read is said twice: the full text on stderr, and one `error`
 * outcome in the ledger through the calling hook's own recorder. Without the
 * second, the ledger reads as a clean run and nothing afterwards can tell
 * "no message was waiting" from "the inbox could not be read". The recorder
 * gets the exception; it should persist a label, never the message (the
 * ledger is permanent and exportable, see `hookErrorReason`).
 */
function inboxReadFailed(err, recordFailure) {
  try { process.stderr.write(`[memesh] could not check for waiting messages: ${err?.message || err}\n`); } catch { /* stderr gone */ }
  recordFailure?.(err);
  return [];
}

/**
 * The reminder lines for `recipient` from an open database. Never throws
 * itself: a reminder must not be the reason a prompt or a session start fails,
 * and a failure that is not "nothing waiting" is said on stderr and handed to
 * `recordFailure`, not swallowed. `recordFailure` must not throw either; both
 * hooks pass one built on `recordHookOutcome`, which cannot.
 */
export function waitingMessageLines(db, recipient, recordFailure) {
  if (!recipient) return [];
  try {
    return unreadInboxLinesFor(db, recipient);
  } catch (err) {
    return inboxReadFailed(err, recordFailure);
  }
}

/**
 * The reminder lines for messages waiting for this session's declared
 * recipient. No `MEMESH_RECIPIENT` or no database: no lines, and the database
 * is not opened. Read-only, and it never throws (given a `recordFailure` that
 * does not, see `waitingMessageLines`).
 */
export function unreadMessageLines(env = process.env, recordFailure) {
  const recipient = resolveMessageRecipient(env);
  if (!recipient) return [];
  const dbPath = env.MEMESH_DB_PATH ?? getDbPath();
  if (!existsSync(dbPath)) return [];
  let db;
  try {
    // `readOnly`, not `readonly`: node:sqlite ignores the lowercase spelling.
    db = new MemeshDatabase(dbPath, { readOnly: true });
    db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
    return waitingMessageLines(db, recipient, recordFailure);
  } catch (err) {
    return inboxReadFailed(err, recordFailure);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export function openHookDb(env = process.env, opts = {}) {

  // Path helpers read process.env directly (no-arg). The `env` parameter
  // is kept on this signature for backward compatibility with callers
  // and is consulted directly only for the DB-PATH dirname check below
  // — that's the one place where a caller's custom env should win over
  // process.env (e.g. the test harness redirects MEMESH_DB_PATH per test).
  const dbPath = env.MEMESH_DB_PATH ?? getDbPath();
  const dbDir = env.MEMESH_DB_PATH ? dirname(env.MEMESH_DB_PATH) : memeshDir();
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = new MemeshDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // A hook waits for a held write lock for less time than Claude Code will
  // wait for the hook.
  //
  // `MemeshDatabase` sets `busy_timeout = 30000`, which lets ordinary CLI,
  // MCP and HTTP operations wait through brief write contention. A hook
  // cannot use that whole budget. Its timeout in
  // `hooks/hooks.json` is 3s (UserPromptSubmit) to 10s (Stop, PreCompact),
  // so a 30s wait has exactly one possible ending: the harness kills the
  // hook. The capture is lost either way — the difference is that the user
  // also gets a hook-timeout error, which is the failure mode that makes
  // memesh something to switch off.
  //
  // 2s fits inside every budget with room for the hook's own work. On
  // contention the capture is skipped quietly, this run's `hook_runs` stamp
  // is not written, and `memesh doctor` reports the gap honestly.
  db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
  // Bringing the schema current is a WRITE, and "cannot migrate" must not
  // mean "cannot open": a database file that is read-only but behind on
  // schema (a pre-upgrade backup, a permissions accident) dies on the
  // CREATE TABLE any release adds. If the FILE refuses writes, open it for
  // what it can still do — reads; capture writes fail individually at
  // their own guarded call sites. Any other error still throws. Mirrors
  // initialiseDatabase() in src/db.ts — keep the two in lockstep.
  try {
    migrateHookDbToCurrent(db, opts);
  } catch (err) {
    if (!/readonly database|SQLITE_READONLY/i.test(err?.message || '')) throw err;
    try {
      process.stderr.write(
        'MeMesh: the database file is read-only, so schema migration was skipped — ' +
          'opened for reads only. Capture and migrations resume when the file is writable.\n',
      );
    } catch { /* stderr gone */ }
  }


  // No heartbeat here. This helper used to stamp `hook_runs` as soon as the
  // handle was usable, and that stamped-then-crashed hooks into looking
  // alive: a hook that opened the database and then died in its own capture
  // logic — the failure class this table exists to expose — read as PASS in
  // `memesh doctor` for the next 24 hours. Each capture hook now calls
  // recordHookRun() itself at every SUCCESSFUL exit (including "ran, nothing
  // worth saving"), so a mid-capture throw leaves no stamp.

  return { db, dbPath };
}

/**
 * Everything that makes a hook-opened handle CURRENT: schema, FTS,
 * one-time migrations and the segmentation rebuild. Split from
 * openHookDb() so the read-only-file tolerance there has a single
 * boundary to wrap — every statement in here may write, and none of
 * them is load-bearing for reading what the database already holds.
 * Mirrors migrateToCurrentSchema() in src/db.ts — keep in lockstep.
 *
 * @param {import('./_generated/sqlite.js').MemeshDatabase} db
 * @param {{fts?: boolean}} opts
 */
function migrateHookDbToCurrent(db, opts) {
  db.exec(SCHEMA_SQL);
  ensureTagsUniqueIndex(db);
  ensureHookRunsSince(db);
  if (opts.fts) db.exec(FTS_SQL);

  // The full conditional-ALTER chain — the SAME generated code core's
  // migrateToCurrentSchema runs, so a hook-only-touched DB converges on the
  // exact schema state core produces (the hand-copied chain that lived here
  // once stalled at v2.12 while core was at v4.0+).
  migrateEntitiesSchema(db);

  // Rebuild entities_fts when the segmentation rules change — the shared
  // runOnceMigration-based owner, so the hook side and core share one
  // marker AND one implementation. The near-twin that lived here was
  // already missing the ORDER BY fix core had picked up.
  if (opts.fts) ensureFtsSegmentation(db);
}



/**
 * Stamp a hook's heartbeat from a path that has no database handle open.
 *
 * session-summary's low-signal bails (non-agentic session, vanished
 * transcript, fewer than three tool calls) decide "nothing worth saving"
 * BEFORE opening the database — and a correct nothing-to-do decision is a
 * successful run that must stamp, or a user whose sessions are consistently
 * short reads as "capture has stopped" in doctor within a day: the exact
 * crying-wolf this table exists to end. Stop fires at the end of EVERY turn
 * (#322), so this extra open+close happens once per bailed turn, not once
 * per session — still cheap enough next to the transcript read the bail
 * already did to skip.
 *
 * Never throws: the heartbeat is diagnostics, and the bail it decorates was
 * already a successful exit.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} hook
 */
export function stampHookRunOnly(env, hook) {
  try {
    const { db } = openHookDb(env);
    try { recordHookRun(db, hook); } finally { db.close(); }
  } catch (err) {
    try {
      process.stderr.write(
        `MeMesh: could not stamp the ${hook} heartbeat on a no-capture exit (${err?.message ?? err}).\n`,
      );
    } catch { /* stderr gone */ }
  }
}

const NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const APPEND_NOFOLLOW_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW;
const READ_NOFOLLOW_FLAGS = fsConstants.O_RDONLY | NOFOLLOW;

/**
 * A plain `.slice(0, maxUnits)` on a string cuts by raw UTF-16 CODE UNIT,
 * which can land between the two halves of a surrogate pair (an astral
 * character — any emoji, for one) and leave a lone, unpaired surrogate at
 * the very end — `"…".isWellFormed()` false, confirmed against a real cut landing on a
 * pair straddling unit 200. `recordHookOutcome` below truncates every
 * `reason`/`entity` this way, for every hook, on every call — most never
 * hit this in practice (ASCII diagnostics), but nothing stops a future
 * caller from passing through attacker- or import-controlled text that
 * does. This is a MINIMAL, targeted fix: it only ever trims one
 * ADDITIONAL character, only when the raw cut would otherwise split a
 * pair, and never changes the ~200-unit cap other callers already rely on
 * for anything else.
 */
export function sliceUtf16UnitsSurrogateSafe(s, maxUnits) {
  if (s.length <= maxUnits) return s;
  let end = maxUnits;
  // Only back off when the last kept unit is a HIGH surrogate AND the very
  // next unit (the one about to be cut off) is its matching LOW surrogate
  // — i.e. only when the cut would split a REAL pair. A lone high
  // surrogate that was already unpaired in the source string (no low
  // surrogate follows it) is left exactly as it was; this function does
  // not repair a source string that was already malformed, only avoid
  // CREATING a new instance of that problem.
  const lastKept = s.charCodeAt(end - 1);
  const nextUnit = s.charCodeAt(end);
  const lastKeptIsHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
  const nextUnitIsLowSurrogate = nextUnit >= 0xdc00 && nextUnit <= 0xdfff;
  if (lastKeptIsHighSurrogate && nextUnitIsLowSurrogate) end -= 1;
  return s.slice(0, end);
}

/**
 * Record what `hook` DID, on every exit path (issue #327).
 *
 * `recordHookRun` answers "did the hook execute"; this answers "and did it
 * write anything, and if not, why not". The gap between those two questions
 * is where two days of an empty graph hid: post-commit was executing on every
 * Bash call and skipping every one of them, because the commits were made
 * with `-q` and printed no line to match. From the outside that is
 * indistinguishable from a hook broken by an upgrade.
 *
 * Contract, in the same spirit as `stampHookRunOnly`:
 *   - NEVER throws. Diagnostics must not take capture down with them.
 *   - NEVER writes to stdout. The hook output contract is a single JSON
 *     document or nothing at all; one stray line breaks both hosts.
 *   - APPENDS one line (O_APPEND), never read-modify-write. SessionStart,
 *     UserPromptSubmit and a PreToolUse hook fire inside the same second on
 *     a busy turn: three processes reading the same JSON document and
 *     writing back what each of them read means the last one wins and the
 *     other two records are gone — the concurrency that proves a session is
 *     busy would be the concurrency that erases the proof. An append has no
 *     read step to lose, and the OS orders the writes.
 *   - Rotation (keep each hook's last 20 records) is the only rewrite, and it goes
 *     through temp + rename so a reader sees the old complete file or the
 *     new one.
 *
 * @param {Record<string,string|undefined>} env
 * `outcome` has four kinds, and the line between the first two is the whole
 * point of the record: `wrote` means a MEMORY was stored, and nothing else —
 * it is the numerator of the signal `memesh doctor` uses to answer "is memory
 * capture still alive". `notified` is for a hook whose effect is text the user
 * or the model sees: an injected context, a printed warning, a nudge. Six
 * hooks recorded those as `wrote`, each with its own comment saying it was not
 * a memory, and the answer to that question was inflated by all six.
 *
 * @param {{hook: string, outcome: 'wrote'|'notified'|'skipped'|'error', reason?: string, entity?: string, payload?: object}} info
 */
export function recordHookOutcome(env, { hook, outcome, reason, entity, payload }) {
  try {
    // getMemeshDirFromDbPath(), not memeshDir(): the record must sit beside
    // the database it describes. A test (or a user) that points
    // MEMESH_DB_PATH somewhere else would otherwise split the evidence — a
    // graph in one directory, the liveness history of the hooks that filled
    // it in another.
    const dir = getMemeshDirFromDbPath();
    ensurePrivateDir(dir);
    const filePath = join(dir, HOOK_OUTCOMES_FILENAME);
    const record = {
      hook,
      at: new Date().toISOString(),
      host: detectHookHost(payload ?? null, env),
      outcome,
    };
    // A hook's `reason` is, on the error path, the exception message — which
    // may echo a credential a failed request or git command surfaced. Skip
    // reasons are hard-coded literals and pass through unchanged, but the
    // error ones are redacted before they persist: stderr is transient, this
    // JSONL file is a permanent, exportable copy.
    if (reason) record.reason = sliceUtf16UnitsSurrogateSafe(redactSecrets(String(reason)), 200);
    if (entity) record.entity = sliceUtf16UnitsSurrogateSafe(redactSecrets(String(entity)), 200);
    // One O_APPEND write of one line. `mode` applies only when the file is
    // being created, which is the only moment the permission can be set
    // without a second syscall on the hot path. O_NOFOLLOW: the directory
    // can be a shared or repository path (MEMESH_DB_PATH), and a planted
    // symlink named hook-outcomes.jsonl would otherwise turn every hook run
    // into an append to a file of the planter's choosing. Windows has no
    // O_NOFOLLOW (the constant is undefined there), so it contributes 0.
    const fd = openSync(filePath, APPEND_NOFOLLOW_FLAGS, 0o600);
    try {
      writeSync(fd, serializeHookOutcome(record));
    } finally {
      closeSync(fd);
    }
    try { chmodSync(filePath, 0o600); } catch { /* best-effort hardening */ }
    rotateHookOutcomes(filePath);
  } catch (err) {
    try {
      process.stderr.write(
        `MeMesh: could not record the ${hook} hook outcome (${err?.message ?? err}). ` +
          `Capture itself is unaffected, but 'memesh doctor' will under-report capture liveness.\n`,
      );
    } catch { /* stderr gone */ }
  }
}

/**
 * The `reason` an outer catch may persist for an exception: its `code` or
 * class name, never its message.
 *
 * A message is not a label, it is a copy of whatever the failure echoed: a
 * V8 JSON parse error quotes the payload it choked on, an execFileSync error
 * carries git's stderr and absolute paths. stderr is transient; the outcome
 * file is permanent, exportable, and rendered into doctor and a pasted issue.
 * So the file gets `uncaught SyntaxError` / `uncaught ENOENT`, and the full
 * text goes to stderr where the hook already writes it.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function hookErrorReason(err) {
  const label = (value) => (typeof value === 'string' && /^[A-Za-z][\w-]{0,39}$/.test(value) ? value : null);
  const e = err && typeof err === 'object' ? err : null;
  return `uncaught ${label(e?.code) ?? label(e?.name) ?? 'error'}`;
}

/**
 * Keep the history bounded, without paying a read on every append.
 *
 * A line count would mean reading the file back on the hot path — the read
 * step O_APPEND exists to remove. A `stat` is cheap, so size is the trigger
 * and the trim is exact. The rewrite goes through temp + rename: a
 * concurrent appender may lose ONE line to the swap, which is why the byte
 * budget is far larger than the window any summary reads.
 */
function rotateHookOutcomes(filePath) {
  let tmpPath = null;
  try {
    // One descriptor for both the size check and the read, so the file that
    // was measured is the file that is read (a stat-then-open pair can be
    // swapped in between). The size check is the hot path on every append
    // and needs no random name.
    let raw;
    const fd = openSync(filePath, READ_NOFOLLOW_FLAGS);
    try {
      if (fstatSync(fd).size <= HOOK_OUTCOMES_ROTATE_BYTES) return;
      raw = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    // An unpredictable name, created exclusively ('wx' = O_CREAT|O_EXCL,
    // which refuses an existing path — a planted symlink included).
    // `${pid}.tmp` was guessable, and the plain write followed whatever sat
    // at that name.
    tmpPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    const trimmed = trimHookOutcomeLines(raw);
    writeFileSync(tmpPath, trimmed, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    try {
      process.stderr.write(`[memesh hook-outcomes] rotation failed for ${filePath}: ${err?.message ?? err}\n`);
    } catch { /* stderr gone */ }
  }
}

/**
 * Record that `hook` ran, right now.
 *
 * This is the only evidence in the system that a hook EXECUTED, as opposed to
 * a hook having captured something. Doctor could previously only count
 * auto-captured entities, which conflates the healthy "ran, nothing worth
 * saving" with the fatal "never ran" — see the `hook_runs` comment in
 * SCHEMA_SQL.
 *
 * A failure here must never take the hook down with it: the heartbeat is
 * diagnostics, and a session that captured its work but could not stamp the
 * row is far better than one that threw. But it is not swallowed either — it
 * writes to stderr, because a heartbeat that silently stops recording would
 * recreate the exact blind spot it exists to close.
 */
export function recordHookRun(db, hook) {
  try {
    db.prepare(
      `INSERT INTO hook_runs (hook, last_run_at, run_count)
       VALUES (?, datetime('now'), 1)
       ON CONFLICT(hook) DO UPDATE SET
         last_run_at = datetime('now'),
         run_count   = run_count + 1`,
    ).run(hook);
  } catch (err) {
    try {
      process.stderr.write(
        `MeMesh: could not record that the ${hook} hook ran (${err?.message ?? err}). ` +
          `Capture itself is unaffected, but 'memesh doctor' will under-report ` +
          `hook liveness until this succeeds.\n`,
      );
    } catch { /* stderr itself is gone; there is nowhere left to report */ }
  }
}


/** Same cap core uses, so a pathological filename cannot build a huge query. */
const HOOK_MAX_QUERY_TERMS = 32;

/**
 * Build an FTS5 MATCH expression the way core's `buildMatchExpression()` does.
 *
 * Hooks write to the index through the generated primitives, which segment and
 * normalise — but `pre-edit-recall.js` built its own MATCH by quoting a raw
 * filename. Against a segmented index a CJK basename therefore matched
 * nothing, and the surrounding `catch {}` meant neither the user nor an
 * operator ever saw it: the hook simply injected no memories.
 *
 * The document-frequency guard core applies is deliberately not mirrored here.
 * It is an optimisation, it needs a corpus-wide count, and this query is
 * already bounded by a tag filter and a LIMIT.
 *
 * @returns the MATCH expression, or null if there is nothing searchable
 */
export function hookMatchExpression(text) {
  return renderMatchExpression(tokenizeQuery(text).slice(0, HOOK_MAX_QUERY_TERMS));
}

/**
 * Build an FTS5 PHRASE expression the way `renderPhraseExpression()` does —
 * the terms of `text`, adjacent and in order, instead of `hookMatchExpression`'s
 * OR. `pre-edit-recall.js` uses this for an ASCII basename (extension
 * included, e.g. "CLAUDE.md" → `"CLAUDE md"`) so a row that merely mentions
 * ONE of a multi-word filename's words does not qualify as a match (#358).
 *
 * Not used for a non-ASCII basename: `text` there is bigram-segmented before
 * this runs, and this function's caller keeps those on `hookMatchExpression`
 * instead — see the comment at that call site.
 *
 * @returns the PHRASE expression, or null if there is nothing searchable
 */
export function hookPhraseExpression(text) {
  return renderPhraseExpression(tokenizeQuery(text).slice(0, HOOK_MAX_QUERY_TERMS));
}

// Embedded in a longer identifier on the BEFORE side — "xCLAUDE.md" (a
// letter/digit/underscore/hyphen right before) or "foo.CLAUDE.md" (a dot
// right before, i.e. a different extension chain) are not a mention of
// THIS file.
//
// Deliberately ASCII-only — an explicit, tested decision rather than an
// incidental one: a non-ASCII letter directly before an ASCII basename —
// "設定CLAUDE.md" — is NOT treated as embedding, because this class does not
// match it, so that case falls through to the bare-mention return below and
// IS accepted. Widening this to `\p{L}` would reject it instead; that is a
// real, defensible alternative rule, just not the one shipped, and this
// comment plus its test are what make the choice a decision instead of an
// accident.
const FILENAME_EMBED_BEFORE = /[A-Za-z0-9_.-]/;
// A letter/digit/underscore/hyphen right after extends the same token
// ("CLAUDE.mdx", "CLAUDE.md_backup").
const FILENAME_EMBED_AFTER = /[A-Za-z0-9_-]/;
// What makes a `.` after the basename an appended extension rather than a
// sentence end: a letter or digit in ANY script ("CLAUDE.md.bak",
// "CLAUDE.md.備份"). Not ASCII-only like the two classes above: those
// protect CJK prose, which is written with no space around a filename, while
// a sentence that carries on with no space after its full stop is rare in
// any script and misreading one costs a missed recall, never a wrong line.
// Marks and invisible format characters (`\p{M}`, `\p{Cf}`: a combining
// accent, ZWJ, ZWSP) count too — "CLAUDE.md.\u200Dx" still names another
// file. Anything else after the dot (an emoji, a symbol) is read as the end
// of a sentence, and a fullwidth full stop "．" is not a dot at all: both
// stay bare mentions, deliberately.
const FILENAME_EXTENSION_START = /[\p{L}\p{N}\p{M}\p{Cf}]/u;
// The same marks and format characters directly after the basename, with no
// dot ("CLAUDE.md\u200Bbak" reads as "CLAUDE.mdbak"): invisible or attached
// to the name, so part of a different name. Letters stay out of this class
// on purpose — CJK prose follows a filename with no space.
const FILENAME_EMBED_AFTER_INVISIBLE = /[\p{M}\p{Cf}]/u;
// Bidi marks, embeddings and isolates (LRM, RLM, ALM, LRE/RLE/PDF, LRI/RLI/
// FSI/PDI) are TRANSPARENT to the boundary check: right-to-left prose puts
// them around an embedded Latin filename, so they must not count as part of
// a longer name — but they are not delimiters either. They are skipped, and
// the character after them decides, exactly as if they were not there:
// "CLAUDE.md\u200Fقبل" confirms, "CLAUDE.md\u200Ebak" does not. The two
// OVERRIDES (LRO U+202D, RLO U+202E) are not skipped: they reorder the text
// that follows, which is how a name is spoofed, so they reject. This is the
// AFTER side only; the BEFORE class is ASCII-only by its own decision above.
const BIDI_TRANSPARENT = /[\u061C\u200E\u200F\u202A-\u202C\u2066-\u2069]/;
/** Index of the first UTF-16 unit at or after `i` that is not a transparent bidi control (all of them are BMP). */
function skipBidiTransparent(text, i) {
  while (i < text.length && BIDI_TRANSPARENT.test(text[i])) i++;
  return i;
}
/** The whole code point at `i`, or '' past the end. */
function codePointAt(text, i) {
  return i < text.length ? String.fromCodePoint(text.codePointAt(i)) : '';
}
// A path token: what a backward walk from a `/` or `\` before the match
// consumes as "part of the same path mention".
//
// Unicode-aware (`\p{L}\p{M}\p{N}`, the `u` flag): an ASCII-only class would
// stop a backward walk through `文件/CLAUDE.md` right at the slash, producing
// the bare token `/CLAUDE.md` and losing the directory name entirely. It
// excludes `:` — see `pathMentionMatches`'s drive-letter handling below for
// why that is a narrower, deliberate special case rather than a blanket
// inclusion (a bare
// `:` in the token class would swallow a `CLAUDE.md:12` line-number suffix
// that sits AFTER a match, a completely different position, into what looks
// like a path BEFORE the next one).
//
// `~` is in: it is an ordinary character inside a directory name, and
// Windows' 8.3 short names put one mid-component (`C:\Users\RUNNER~1\...`,
// the usual spelling of `%TEMP%`). Stopping the walk there cut such a mention
// down to `1/.../CLAUDE.md`, a suffix of nothing, so a memory naming the exact
// file was never recalled. A home-relative `~/docs/CLAUDE.md` is unaffected:
// it was not a suffix of the edited path before and is not one now.
//
// The other side of the same change: a `~` glued to the front of a mention
// is now part of it, so `x~docs/CLAUDE.md` is no longer read as
// `docs/CLAUDE.md`, and `x~C:\repo\docs\CLAUDE.md` no longer gets its drive
// letter spliced on (the splice requires a non-token character, or the start
// of the text, before the letter). The first used to confirm because the walk
// stopped at the `~`; the second because the drive-letter splice fired, which
// it no longer does. Neither string is a path that names the edited file.
const PATH_TOKEN_CHAR = /[\p{L}\p{M}\p{N}_.~\-/\\]/u;
// A single ASCII drive letter immediately followed by `:` — the two
// characters `pathMentionMatches` splices onto the front of a walked-back
// token when they precede it exactly, so "C:\repo\...\CLAUDE.md" is not
// truncated to "\repo\...\CLAUDE.md".
const DRIVE_LETTER = /[A-Za-z]/;

/**
 * Confirm a candidate: does `text` literally contain `needle` as a whole
 * filename-shaped token?
 *
 * The FTS prefilter (`hookPhraseExpression`/`hookMatchExpression`) only
 * proves the text contains a TOKEN SEQUENCE shaped like the basename —
 * "05-CLAUDE-md.md" tokenizes to a "claude" token immediately followed by an
 * "md" token too, and prose like "claude-md", "CLAUDE_MD" or "the Claude MD
 * file" can pass a token-adjacency check while never containing the literal
 * string "CLAUDE.md" (#358). This is the confirmation step: does the ACTUAL
 * text contain that literal string, called on the small set of rows the
 * prefilter already narrowed down to (`entities_fts` is contentless — it can
 * only be MATCHed, never read from — so this runs over `entities.name` and
 * `observations.content`, fetched separately).
 *
 * Both sides are NFC-normalised — the same normalisation
 * `registerNfcFunction`/`memesh_nfc` (src/storage/fts-index.ts,
 * src/knowledge-graph.ts's archived-search branch) applies in SQL. This
 * reuses that same `String.prototype.normalize('NFC')` call in JS rather
 * than inventing a second normaliser; SQL is not an option here because the
 * confirmation runs over rows already fetched into JS, not a query.
 *
 * The contract this pins (by design — see docs/ARCHITECTURE.md
 * and CHANGELOG.md [Unreleased]): two spellings are the SAME name after NFC
 * exactly when they are CANONICALLY equivalent under Unicode — that covers
 * composed vs. decomposed accents ("café" vs. "café") AND the handful
 * of singleton canonical mappings, such as KELVIN SIGN U+212A → LATIN CAPITAL
 * LETTER K (U+004B) and ANGSTROM SIGN U+212B → LATIN CAPITAL LETTER A WITH
 * RING ABOVE (U+00C5, itself canonically "Å" = A + combining ring above).
 * `K.ts` (U+212A) confirming a mention of `K.ts` (ASCII) is this rule working
 * as designed, not a false positive — U+212A IS the letter K under canonical
 * equivalence, the same relationship that makes composed/decomposed "é" one
 * name. It is NOT special-cased away: a carve-out for one singleton mapping
 * would need a per-character exception table on this hot path and would
 * break the simplicity the "é" guarantee depends on. COMPATIBILITY
 * equivalents are deliberately NOT folded together — fullwidth "Ａ" (U+FF21)
 * stays distinct from ASCII "A", and ligatures stay distinct from their
 * expansions — because this function normalises with NFC, not NFKC; NFKC
 * would additionally erase exactly those distinctions. Case folding (below)
 * runs AFTER normalisation and is ASCII `A-Z` only, so it does not reach
 * Turkish İ (U+0130) / ı (U+0131) or German ß (U+00DF) — none of those fold
 * to their naive ASCII lookalikes at any stage of this function.
 *
 * Case folding is ASCII-only and PER-CHARACTER, applied to both sides
 * unconditionally — never a locale/Unicode `.toLowerCase()`, and never gated
 * on the needle being ENTIRELY ASCII. An all-or-nothing gate (fold only when
 * `/^[\x00-\x7f]+$/` matches the whole needle) would skip folding for a
 * mixed-script basename (a non-ASCII stem with an ASCII extension, the
 * common case for any non-English filename), and "設定配置.TS" would fail to
 * confirm "設定配置.ts". An ASCII-only per-character fold has no such gate and
 * is a no-op on non-ASCII text (nothing in `\p{L}` outside `A-Za-z` has an
 * ASCII-fold mapping), so applying it unconditionally changes nothing for a
 * pure-CJK needle while handling the mixed-script one. `text.indexOf`, never
 * a RegExp built from `needle` — a basename with regex metacharacters
 * (`a+b(1).ts`, `[id].tsx`, `$types.d.ts`, `c++.md`) is matched literally,
 * not interpreted.
 *
 * A hit must also sit on a filename boundary:
 *   - AFTER: rejected when the next character is `~` (a common backup-file
 *     suffix, "CLAUDE.md~"), is `.` immediately followed by a letter or
 *     digit in any script, a mark or a format character
 *     ("CLAUDE.md.bak", "CLAUDE.md.備份"), or is `/` or `\`
 *     ("docs/CLAUDE.md/" and "docs/CLAUDE.md/subfile" name a DIRECTORY
 *     called CLAUDE.md, or a file inside it, never the edited file itself,
 *     the same way `pathMentionMatches` below already treats a `/`-prefixed
 *     mention as a path rather than a bare basename) — a bare trailing `.`,
 *     `)`, `,`, `#`, `?`, backtick or end-of-text is a sentence ending (or a
 *     URL fragment/query string, which still names the SAME file — a
 *     fragment/query does not change which file a path points at), not more
 *     of the filename, and still passes. A letter/digit/underscore/hyphen
 *     immediately after also rejects ("CLAUDE.mdx").
 *   - BEFORE: a letter/digit/underscore/dot/hyphen immediately before
 *     rejects (embedded in a longer identifier or extension chain) —
 *     ASCII-only, deliberately: a non-ASCII letter directly before an ASCII
 *     basename ("設定CLAUDE.md") is NOT a boundary-breaker and IS accepted
 *     as a bare mention (an explicit, tested decision;
 *     see `FILENAME_EMBED_BEFORE`'s own comment for why this is a stated
 *     decision, not an oversight). Start-of-text/whitespace/punctuation
 *     before it also passes as a bare mention. When the character
 *     immediately before is `/` or `\`, the mention is a PATH, not a bare
 *     basename ("docs/CLAUDE.md" while editing a DIFFERENT file must not
 *     count just because the basename matches) — see `pathMentionMatches`.
 *     A DIFFERENT stated decision, same shape: the
 *     character that must precede a PATH-style mention is any non-path-token
 *     character — a delimiter, not a script boundary. CJK prose with no
 *     delimiter directly before a path ("請看文件/CLAUDE.md", "please see
 *     文件/CLAUDE.md" with no space) is consumed into the path token by the
 *     same Unicode-aware walk that correctly keeps a real CJK directory name
 *     intact, and the resulting token is not a suffix of
 *     the edited path — a per-mention false negative, not a per-memory one:
 *     the same text is still reachable through any other bare or delimited
 *     mention it contains. An emoji (or any other non-path-token character)
 *     immediately before the same prose DOES delimit it correctly
 *     ("📁文件/CLAUDE.md" matches). No heuristic script-boundary splitting is
 *     applied — that would need per-script tables on this hot path, the same
 *     reasoning that keeps the NFC-vs-NFKC boundary above a flat rule.
 *
 * @param {string} text
 * @param {string} needle - the full basename to confirm, every script,
 *   ASCII or not (never the extension-less stem).
 * @param {{relPath: string | null, absPath: string, absPathAsGiven?: string} | null} [editedPath] -
 *   the edited file's own path(s), forward-slash-normalised, for the PATH
 *   branch above. `relPath` is relative to the file's repo root, or `null`
 *   when there is no repo root (or resolving it escaped the root — see the
 *   hook's own comment). `absPath` is the CANONICAL (realpath'd) absolute
 *   path; `absPathAsGiven`, when different, is the absolute path built from
 *   the directory AS THE PAYLOAD NAMED IT, before resolving any symlink —
 *   both are checked, so a memory can name either form of a symlinked
 *   location THE EDIT PAYLOAD ITSELF USED and both match (e.g. macOS
 *   `/var/...` vs its canonical `/private/var/...`).
 *   This is ONE-WAY, stated precisely, not the symmetric claim it might read
 *   as: `absPathAsGiven` only exists when the
 *   PAYLOAD's own as-given form differs from canonical — when the payload
 *   is already canonical, there is no alias candidate at all, so a memory
 *   naming an alias the payload never used does NOT match. Resolving an
 *   alias mentioned only in memory text would need a filesystem call per
 *   mention, which this hot path deliberately does not make; such a memory
 *   remains reachable through a relative or bare mention instead. Omit only
 *   when no reliable path info exists at all; a PATH-style mention then
 *   cannot be verified and is rejected, while a bare mention is unaffected.
 */
export function containsFileNameLiterally(text, needle, editedPath = null) {
  if (!text || !needle) return false;
  const normalizedNeedle = needle.normalize('NFC');
  if (normalizedNeedle.length === 0) return false;
  const normalizedText = text.normalize('NFC');
  const haystack = foldAsciiCase(normalizedText);
  const target = foldAsciiCase(normalizedNeedle);
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(target, from);
    if (idx === -1) return false;
    const matchEnd = idx + target.length;
    const before = idx > 0 ? haystack[idx - 1] : '';
    // Whole code points, not UTF-16 units: half of a surrogate pair is never
    // `\p{L}`/`\p{Cf}`, so an astral letter or format character would slip
    // through. Transparent bidi controls are stepped over first.
    const afterAt = skipBidiTransparent(haystack, matchEnd);
    const after = codePointAt(haystack, afterAt);
    const afterNext = after === '.'
      ? codePointAt(haystack, skipBidiTransparent(haystack, afterAt + 1)) : '';

    const afterRejects = FILENAME_EMBED_AFTER.test(after) ||
      FILENAME_EMBED_AFTER_INVISIBLE.test(after) || after === '~' ||
      after === '/' || after === '\\' ||
      (after === '.' && FILENAME_EXTENSION_START.test(afterNext));
    if (afterRejects) { from = idx + 1; continue; }

    if (before === '/' || before === '\\') {
      // NOT `haystack` (that copy is ASCII-folded in its ENTIRETY, which
      // would fold every directory component too).
      // `normalizedText` is NFC-normalised but un-folded, so the directory
      // portion of whatever token gets walked out of it keeps its real
      // case; `pathMentionMatches` folds only the final path segment (and a
      // Windows drive letter) itself. `foldAsciiCase` is a 1:1, length- and
      // position-preserving per-character map, so `idx`/`matchEnd` (computed
      // against the folded `haystack`) are valid indices into `normalizedText`
      // too — same positions, just the original casing at each one.
      if (pathMentionMatches(normalizedText, idx, matchEnd, editedPath)) return true;
      from = idx + 1;
      continue;
    }
    if (FILENAME_EMBED_BEFORE.test(before)) { from = idx + 1; continue; }

    return true; // bare mention: start of text, whitespace, quote, paren, ...
  }
}

/**
 * Fold ONLY the ASCII letters `A-Z` to `a-z`; every other character —
 * digits, punctuation, separators, and every non-ASCII script — passes
 * through unchanged. This is the literal reading of
 * "ASCII case-insensitive": per character, not "only when the whole string
 * happens to be pure ASCII". `String.prototype.toLowerCase()` is
 * deliberately not used here — it is locale/Unicode-aware and can fold (or,
 * for some scripts under some engines, even change the length of) text this
 * function has no business touching; an explicit ASCII-only replace cannot.
 */
function foldAsciiCase(s) {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Fold ONLY the final path segment (the basename) of a forward-slash path,
 * plus a leading single-letter Windows drive (`C:` → `c:`) when present —
 * every directory component in between is returned UNCHANGED. The
 * case-insensitivity rule this whole file documents is
 * scoped to "the full basename", not "every directory component of a path
 * mention" — a directory's case sensitivity depends on the volume, which
 * this function has no filesystem call to ask (and does not make one: an
 * empty result beats a wrong one on this hot path). So `docs/CLAUDE.md` and
 * `DOCS/CLAUDE.md` are DIFFERENT tokens here on purpose, while
 * `docs/CLAUDE.md` and `docs/claude.MD` are the same one.
 */
function foldFinalPathSegment(p) {
  // A single ASCII letter + `:` at the start is a drive, whether or not a
  // `/` immediately follows — `C:/repo/CLAUDE.md` (absolute) and
  // `a:docs/CLAUDE.md` (drive-relative) both qualify; requiring the `/`
  // would leave the drive-relative form's own drive letter un-folded (it
  // would still compare unequal either way, since nothing else about a
  // drive-relative token matches an absolute candidate, but the gap would be
  // unexplained rather than a real boundary).
  const drive = /^([A-Za-z]):(.*)$/.exec(p);
  const prefix = drive ? `${foldAsciiCase(drive[1])}:` : '';
  const rest = drive ? drive[2] : p;
  const lastSlash = rest.lastIndexOf('/');
  if (lastSlash === -1) return prefix + foldAsciiCase(rest);
  return prefix + rest.slice(0, lastSlash + 1) + foldAsciiCase(rest.slice(lastSlash + 1));
}

/**
 * Is the PATH mentioned right before this match (idx-1 is `/` or `\`) a
 * reference to the SAME file being edited?
 *
 * Walks back from the match through the whole path-shaped token (Unicode
 * letters/marks/digits included — `文件/CLAUDE.md` must not lose `文件` to
 * an ASCII-only scan), and, when a single ASCII drive letter and `:` sit
 * immediately before where the walk stopped, splices them onto the front
 * too (`:` itself stays OUT of `PATH_TOKEN_CHAR`, or the walk would swallow a
 * `CLAUDE.md:12` line-number suffix that sits AFTER a match into what looks
 * like a path BEFORE the next one; this is a narrow, position-specific
 * splice, not a general inclusion). Normalises the token (backslash to
 * forward slash, THEN strip a leading `./` — in that order, or a
 * Windows-style `.\CLAUDE.md` mention would keep its `.\` un-stripped and
 * never compare equal), and accepts it only if it equals, or is a
 * path-segment-aligned suffix of, the edited file's own relative path,
 * canonical absolute path, or as-given absolute path (checked in that
 * order — an ABSOLUTE mention naturally cannot suffix-match a relative
 * path but can equal or suffix one of the absolute ones; no separate
 * branch needed, and the drive-letter case above falls out of the same
 * absolute-path comparison once the token carries its own drive letter).
 *
 * `text` is NFC-normalised but NOT ASCII-folded — the caller passes the
 * un-folded copy on purpose. Only the basename
 * (the full filename, extension included) is documented as ASCII
 * case-insensitive; a directory component is not, because its actual case
 * sensitivity depends on the volume, which this function cannot ask
 * without a filesystem call. `foldFinalPathSegment` (above) folds only the
 * final path segment and any Windows drive letter on BOTH the extracted
 * token and each `editedPath` candidate, leaving every directory component
 * as originally written on both sides — so `docs/CLAUDE.md` vs
 * `DOCS/CLAUDE.md` compares unequal (a deliberate false negative — the
 * memory is still reachable by a relative or bare mention), while
 * `docs/CLAUDE.md` vs `docs/claude.MD` still compares equal.
 *
 * A token containing a `..` segment is rejected outright — this function has
 * no way to resolve it without knowing the mention's OWN base directory,
 * and guessing which file it would resolve to is worse than declining.
 */
function pathMentionMatches(text, matchStart, matchEnd, editedPath) {
  if (!editedPath) return false;
  let start = matchStart;
  while (start > 0 && PATH_TOKEN_CHAR.test(text[start - 1])) start--;
  // Windows drive letter: "C:" immediately precedes where the walk stopped.
  if (
    start >= 2 &&
    text[start - 1] === ':' &&
    DRIVE_LETTER.test(text[start - 2]) &&
    (start < 3 || !PATH_TOKEN_CHAR.test(text[start - 3]))
  ) {
    start -= 2;
  }
  let token = text.slice(start, matchEnd).replace(/\\/g, '/');
  if (token.split('/').includes('..')) return false;
  while (token.startsWith('./')) token = token.slice(2);
  if (token.length === 0) return false;
  token = foldFinalPathSegment(token);

  const candidates = [editedPath.relPath, editedPath.absPath, editedPath.absPathAsGiven];
  for (let candidate of candidates) {
    if (candidate == null) continue;
    candidate = foldFinalPathSegment(candidate);
    if (candidate === token || candidate.endsWith(`/${token}`)) return true;
  }
  return false;
}



// Title cap + truncation live in src/core/title.ts, executed here via the
// generated copy — the same code core's remember validation and the db
// backfill run, so the three writers cannot drift on the contract.
export { truncateTitle } from './_generated/title.js';

/**
 * `localHandoff` (the Stop hook's session handoff only): the replacement just
 * restated every word the entity holds with text this machine's agent wrote,
 * so marks that described OLDER text no longer apply. An `import` stamps
 * `trust: 'untrusted'` and `provenance.source: 'import'`, and without this the
 * handoff stays hidden from every later session although each Stop rewrites
 * it. Only those two marks change; every other key (forgotten_observation_hashes
 * among them) is kept. Runs inside captureEntity's transaction, so a failure
 * rolls the replacement back with it. A replacement that stored nothing —
 * every new line filtered as forgotten — throws, which also rolls back: the
 * old text stays, and it keeps its marks.
 */
function refreshLocalHandoffTrust(db, id, type, replace, written) {
  if (type !== SESSION_HANDOFF_TYPE || !replace) throw new Error('localHandoff applies only to replacing a session handoff');
  if (written === 0) throw new Error('the handoff replacement stored no text');
  const raw = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id)?.metadata;
  const parsed = parseEntityMetadata(raw);
  const corrupt = !parsed && raw != null;
  if (corrupt) {
    // Same healing, and the same trace, as the title path above: unparseable
    // metadata holds nothing that can be kept, and left alone it would hide
    // the handoff from every session.
    try { process.stderr.write(`MeMesh: healed corrupted metadata for entity ${id}. Original value was unparseable; replaced with {}.\n`); } catch { /* stderr gone */ }
  }
  const meta = parsed ?? {};
  let changed = corrupt;
  if (meta.trust === 'untrusted') { delete meta.trust; changed = true; }
  if (meta.provenance?.source === 'import') { meta.provenance = { source_host: 'claude-code' }; changed = true; }
  if (changed) db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), id);
}

/**
 * Single owner of the hook-side entity write dance: upsert entity, append
 * observations + tags, and — critically — keep the contentless `entities_fts`
 * index in sync so the memory is recallable via the FTS keyword hot path.
 *
 * Why this exists: post-commit.js, pre-compact.js, and session-summary.js each
 * hand-rolled this dance inline. Three copies drifted — session-summary's copy
 * omitted the FTS reindex entirely, so every `session-insight` memory it wrote
 * was invisible to `recall` and pre-edit-recall (no FTS trigger, no self-heal
 * rebuild on open back it up). Centralising the dance here makes the FTS step
 * impossible to forget in a future hook. This mirrors, on the hook side, what
 * `src/storage/fts-index.ts` already does for core (the F5 boundary keeps them
 * as two implementations of the same contract).
 *
 * The caller MUST open its DB with `openHookDb(env, { fts: true })` so the FTS
 * table is guaranteed present. Signal scoring is deliberately not done here:
 * hooks stay a cheap always-on capture path and core owns later enrichment.
 *
 * @param {import('./_generated/sqlite.js').MemeshDatabase} db - an open hook DB handle
 * @param {{name: string, type: string, observations?: string[], tags?: string[], title?: string | null, metadata?: Record<string, unknown>, replace?: boolean}} entity
 *   `metadata` is extra INSERT-only metadata (e.g. post-commit's session_id +
 *   files). It cannot override the provenance/title_source stamps below, and
 *   an OR IGNORE re-capture of an existing entity leaves it untouched — same
 *   first-writer-wins rule provenance already follows. `replace` (#322)
 *   restates the entity's observations and tags instead of adding to them —
 *   for a caller whose entity is a per-turn SNAPSHOT, not an accumulating log.
 *   Unlike `remember({ replace: true })` in core, this is a HARD delete: no
 *   `replaced_history` is kept (see the comment at the DELETE below for why).
 * @returns {{ id: number, isNew: boolean, archived?: true } | null} null if the row
 *   could not be resolved; `archived: true` if `replace` was requested on an
 *   entity `forget` archived — nothing was written, by design
 */
export function captureEntity(db, { name, type, observations = [], tags = [], title, metadata, replace = false, localHandoff = false }) {
  // One transaction, because this function performs six writes that only
  // mean anything together: the entity row, its observations, its tags, and
  // the contentless-FTS delete + insert that make them findable.
  //
  // Without it, a throw anywhere in the middle — a lock lost to the CLI, a
  // full disk, an FTS corruption — committed the prefix and dropped the
  // rest, and the two most likely resting places are both invisible:
  // observations inserted with no FTS row (a memory that exists and can
  // never be recalled), or the old FTS row deleted and the new one not
  // written (a memory that just stopped being findable). Neither is
  // retried, because the callers dedupe on the entity NAME existing —
  // `INSERT OR IGNORE` reports "already there" on the next run and the
  // half-written state is permanent.
  //
  // Returns `{ id, isNew, observationsWritten }`, or null when the entity row
  // could not be resolved. `observationsWritten` may be lower than
  // `observations.length`: an observation whose exact content is already on
  // the entity is not stored again (see the dedupe in captureEntityInner).
  return db.transaction(() => captureEntityInner(db, { name, type, observations, tags, title, metadata, replace, localHandoff }))();
}

function captureEntityInner(db, { name, type, observations, tags, title, metadata, replace, localHandoff }) {
  // source_host provenance: these hooks only ever run under Claude Code (they
  // are wired into ~/.claude/settings.json), so a hook-captured entity is by
  // definition a claude-code capture. Stamped only on the INSERT — an OR
  // IGNORE re-capture of an existing entity must not overwrite provenance an
  // earlier writer (possibly another host, via MCP) already recorded.
  //
  // title_source: every title a hook writes is machine-derived, so it is
  // marked 'heuristic'. The mark distinguishes generated display text from an
  // unmarked human-provided title, so later reviewed edits can preserve the
  // ownership boundary.
  const insertMetadata = { ...(metadata ?? {}), provenance: { source_host: 'claude-code' } };
  if (title != null) insertMetadata.title_source = 'heuristic';
  const insertResult = db
    .prepare('INSERT OR IGNORE INTO entities (name, type, metadata, title) VALUES (?, ?, ?, ?)')
    .run(name, type, JSON.stringify(insertMetadata), title ?? null);
  const isNew = insertResult.changes > 0;
  const row = db.prepare('SELECT id, type, title, status, metadata FROM entities WHERE name = ?').get(name);
  if (!row) return null;
  const id = row.id;

  // `replace` never touches an archived entity. src/core/operations.ts's
  // `remember({ replace: true })` REFUSES this case with a thrown error —
  // right for a rare, interactive call the user reads the response of, but
  // a hook must never throw (it would abort the OTHER two entities' writes
  // this Stop, and crash risk is exactly what this file exists to avoid).
  // So the hook path degrades to a silent no-op instead: the archived row,
  // its observations and its FTS absence are all left exactly as `forget`
  // left them.
  //
  // Without this, a whole-entity `forget` (archiveEntity: status flipped to
  // 'archived', its row removed from entities_fts) would come undone on the
  // next Stop — `replace` would overwrite the preserved observations with a
  // fresh derivation from the transcript and reinsert the entity into
  // entities_fts, un-hiding it from FTS keyword search even though its
  // status stays 'archived' (recall's default query filters status='active',
  // which caps but does not close that exposure). `removeFromFts` guards its
  // own delete on a rowid COUNT, so calling it on an already-removed row is
  // a safe no-op either way — this check is about not losing the user's
  // forgotten content, not about a contentless-FTS5 delete failure.
  //
  // Observation-level corrections remain active and are filtered below;
  // this branch preserves the separate whole-entity archive contract.
  if (replace && !isNew && row.status === 'archived') {
    return { id, isNew: false, archived: true };
  }

  // The handoff's name is `session-handoff:<project>`, and nothing stops a user
  // from storing a different kind of memory under it. The Stop hook must not
  // overwrite that memory (nor clear its trust marks): refuse BEFORE anything
  // is changed. The throw rolls back the transaction, the hook records an
  // error, and the row stays exactly as it was.
  if (localHandoff && !isNew && row.type !== type) {
    throw new Error(`"${name}" is stored as type ${row.type}, not ${type}; the Stop hook leaves it alone`);
  }

  // Title update on an EXISTING entity — INSERT OR IGNORE never touches
  // `title` when the row already exists, so mirror knowledge-graph.ts's
  // createEntity(): only an explicit, actually-different value writes
  // anything. Captured BEFORE the write so the FTS delete below matches
  // what was indexed.
  const previousTitle = row.title;
  if (!isNew && title !== undefined && title !== previousTitle) {
    db.prepare('UPDATE entities SET title = ? WHERE id = ?').run(title, id);
    // Keep the heuristic mark in step with the write. Heal corrupted metadata
    // (replace with {}) instead of leaving it — a corrupted metadata row would
    // otherwise never get title_source stamped and remain permanently broken.
    const metaRow = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id);
    let meta = parseEntityMetadata(metaRow?.metadata);
    // Heal corrupted metadata: if parse returned null but metadata field exists,
    // it's corrupted — replace with {} and log the healing.
    if (!meta && metaRow?.metadata) {
      try {
        // The id, not the name. The id is what a maintainer needs to look
        // the row up; the name is user-authored content, and this line goes
        // to a stderr stream the user may paste anywhere.
        process.stderr.write(
          `MeMesh: healed corrupted metadata for entity ${id}. ` +
          `Original value was unparseable; replaced with {}.\n`,
        );
      } catch { /* stderr gone */ }
      meta = {};
      // Write the healed metadata immediately so it doesn't get skipped again
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run('{}', id);
    }
    // Stamp title_source on every title write (not just initial). This keeps
    // the source field synchronized with the current title, per Fix C3.
    if (title != null) {
      const updatedMeta = { ...(meta ?? {}), title_source: 'heuristic' };
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(updatedMeta), id);
    }
  }

  // Capture the previously-indexed observation text BEFORE inserting new rows,
  // so the contentless-FTS 'delete' below matches what was indexed. Only for
  // existing entities — a brand-new row has no prior FTS entry to remove.
  // indexedObservationText is the convention's single owner (explicit ORDER
  // BY + the one join rule), via the generated fts-index copy.
  const prevObsText = isNew ? undefined : indexedObservationText(db, id);

  // `replace`: the caller is restating the whole entity, not adding to it.
  //
  // Appending is right for a `commit-<sha>` or a `pre-compact-<id>`, where
  // each capture is a new fact about the same subject. It is wrong for a
  // session insight, whose three entities are a SNAPSHOT of one session: Stop
  // fires at the end of every turn, so appending stored the same sentences
  // over and over (measured: 56 observations, 16 unique) and the workaround —
  // capture once, then skip — froze a two-day session's memory at its first
  // turn (#322). Replacing is the third answer: the snapshot is rewritten, so
  // it is neither duplicated nor stale.
  //
  // The old rows go AFTER `prevObsText` was read above, so the contentless-FTS
  // delete still matches exactly what was indexed. The re-insert below must
  // then leave that text out.
  //
  // This is a HARD delete — no history kept. That is a deliberate difference
  // from `remember({ replace: true })` in src/core/operations.ts, which files
  // the old text into `metadata.replaced_history` before overwriting: that
  // path is a rare, user-invoked correction, where an audit trail is worth
  // the bytes. This path fires on every Stop, every turn, for a session that
  // can run for hours — keeping history here would mean growing metadata on
  // every single turn for content nobody asks to undo.
  if (replace && !isNew) {
    db.prepare('DELETE FROM observations WHERE entity_id = ?').run(id);
    // Tags get the same treatment, for the same reason: "restating the whole
    // entity" was true for observations and FTS but not for tags until this
    // line — a session-<id>-files entity that stopped mentioning file A kept
    // answering `file:a.ts` lookups (pre-edit-recall's Strategy 1) for a
    // snapshot that no longer said anything about that file.
    db.prepare('DELETE FROM tags WHERE entity_id = ?').run(id);
  }

  // Never store the same sentence twice on one entity (#240, widened).
  //
  // #240 was fixed in session-summary.js alone, with an EXISTENCE guard: "if
  // this session already has an entity, bail". Its two siblings never got one
  // and wrote 2,202 duplicate rows on the maintainer's graph —
  // `pre-compact-<sessionId>` 2,188 of them (worst entity: 220 observations,
  // 2 distinct), `commit-<sha>` 14.
  //
  // The guard belongs HERE, on CONTENT, not there, on existence, because a
  // pre-compact entity is per-session and a session legitimately compacts
  // more than once: entity 1947's 110 captures span four days. An existence
  // guard would have dropped a second, genuinely different compaction
  // ("Tool calls: 47", "Files edited: …") along with the identical ones. A
  // content guard drops only rows that add nothing — a re-write of a sentence
  // already stored carries no information, whatever produced it.
  //
  // Unconditional rather than opt-in: every caller of this function is an
  // auto-capture hook writing machine-derived facts, and none of them has a
  // case where re-storing an identical string means something. A flag two of
  // three callers pass would be one more proxy for the question.
  //
  // Filtered ONCE, up front, because `allObsText` below composes the FTS text
  // from this list rather than re-reading the rows. Filtering only at the
  // insert loop would index text for rows that do not exist, and
  // `entities_fts` is contentless: the next delete would not match, which is
  // the "database disk image is malformed" failure this file warns about
  // above. The `seen` set also collapses repeats WITHIN one call.
  const seen = new Set(
    // `|| replace`: the rows a plain SELECT would find here were just
    // DELETEd above (same transaction), so this skips a query that would
    // only ever come back empty — not a second dedup path.
    isNew || replace
      ? []
      : db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(id).map((r) => r.content),
  );
  const freshObservations = [];
  const forgotten = parseEntityMetadata(row.metadata)?.forgotten_observation_hashes;
  const excluded = new Set(replace && Array.isArray(forgotten) ? forgotten : []);
  for (const obs of observations) {
    if (excluded.has(createHash('sha256').update(obs).digest('hex'))) continue;
    if (seen.has(obs)) continue;
    seen.add(obs);
    freshObservations.push(obs);
  }

  const insertObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
  for (const obs of freshObservations) insertObs.run(id, obs);
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
  for (const tag of tags) insertTag.run(id, tag);

  // Reindex FTS: delete the stale entry (if any) then insert the full,
  // current observation set. Uses the generated copy of src/storage/fts-index.ts
  // so the contentless-FTS5 delete+insert dance can no longer drift from core.
  if (prevObsText !== undefined) {
    removeFromFts(db, id, name, prevObsText, previousTitle);
  }
  // Compose the indexed text from data already in hand instead of
  // re-SELECTing the rows just inserted: prev text + the new observations,
  // joined by the owner's single rule. This runs on every
  // Stop/PreCompact/PostToolUse capture, and the re-read grew with an
  // upserted entity's accumulated observation count.
  const obsParts = [];
  // Not after a `replace`: those rows were deleted above, and carrying their
  // text forward would index words the entity no longer holds.
  if (prevObsText && !replace) obsParts.push(prevObsText);
  if (freshObservations.length) obsParts.push(joinIndexedObservations(freshObservations));
  const allObsText = joinIndexedObservations(obsParts);
  // Current title is fully determined by the branches above — no re-read.
  const currentTitle = isNew
    ? (title ?? null)
    : ((title !== undefined && title !== previousTitle) ? title : previousTitle);
  insertFtsRow(db, id, name, allObsText, currentTitle);

  if (localHandoff) refreshLocalHandoffTrust(db, id, type, replace, freshObservations.length);

  // `observationsWritten` is what actually landed, which is no longer the same
  // as `observations.length` once the dedupe above can drop rows. A caller
  // that reports a count to the user must read this one — pre-compact.js
  // printed "Saved 2 observations" on a run that stored none.
  return { id, isNew, observationsWritten: freshObservations.length };
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dirPath, PRIVATE_DIR_MODE);
  } catch {
    // Best-effort hardening only.
  }
}

export function writePrivateFile(filePath, content) {
  writeFileSync(filePath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  try {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Best-effort hardening only.
  }
}

export function writePrivateJson(filePath, value) {
  writePrivateFile(filePath, JSON.stringify(value));
}

export function parseEntityMetadata(rawMetadata) {
  if (!rawMetadata) return null;
  if (typeof rawMetadata === 'object') return rawMetadata;
  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// The POLICY (which metadata may be auto-injected) lives in the
// work-topology leaf — isAutoInjectable — shared with the MCP briefing
// surface so the gate cannot fork. This wrapper keeps only the raw-column
// contract the hooks need: null column = no metadata recorded = allowed;
// an unparseable column = fail closed.
export function isTrustedForAutoContext(rawMetadata) {
  if (rawMetadata == null) return true;
  const metadata = parseEntityMetadata(rawMetadata);
  if (!metadata) return false;
  return isAutoInjectable(metadata);
}

// buildReferenceContext moved to src/core/work-topology.ts (re-exported above)
// so the MCP briefing surface and the hooks share one fence implementation.

// ─── Auto-update shared helpers ─────────────────────────────────────────────
// Shared between SessionStart and Stop hooks for auto-update coordination.

export function readUpdateCheckCache(installedVersion) {
  if (process.env.MEMESH_UPDATE_CHECK_PATH) {
    try {
      const overridePath = process.env.MEMESH_UPDATE_CHECK_PATH;
      if (!existsSync(overridePath)) return null;
      const parsed = JSON.parse(readFileSync(overridePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }
  const versionTag = typeof installedVersion === 'string'
    && /^[0-9A-Za-z.+-]+$/.test(installedVersion)
    ? installedVersion
    : 'unknown';
  const cachePath = join(memeshDir(), `update-check.${versionTag}.json`);
  try {
    if (!existsSync(cachePath)) return null;
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/;

export function classifyBumpHook(from, to) {
  const a = SEMVER_RE.exec((from || '').trim());
  const b = SEMVER_RE.exec((to || '').trim());
  if (!a || !b) return null;
  const ai = a.slice(1, 4).map(Number);
  const bi = b.slice(1, 4).map(Number);
  if (bi[0] > ai[0]) return 'major';
  if (bi[0] < ai[0]) return null;
  if (bi[1] > ai[1]) return 'minor';
  if (bi[1] < ai[1]) return null;
  if (bi[2] > ai[2]) return 'patch';
  return null;
}

const POLICY_RANK = { off: 0, patch: 1, minor: 2, major: 3 };
const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
const AUTO_UPDATE_CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function autoUpdateConsentPath(sessionId, currentVersion, latestVersion, channel = 'unknown') {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId === 'unknown') return null;
  const key = createHash('sha256')
    .update(`${sessionId}\0${currentVersion}\0${latestVersion}\0${channel}`)
    .digest('hex');
  return join(memeshDir(), 'update-consent', `${key}.json`);
}

function updatePromptClaimPath(sessionId, currentVersion, latestVersion) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId === 'unknown') return null;
  const key = createHash('sha256')
    .update(`${sessionId}\0${currentVersion}\0${latestVersion}`)
    .digest('hex');
  return join(memeshDir(), 'update-prompt-claims', `${key}.json`);
}

/**
 * Atomically claim the one first-use update notice for a session/version.
 * Separate host hooks can start at the same time; a read-then-write pending
 * marker lets both print the prompt. O_EXCL makes the claim the decision.
 */
export function claimUpdatePrompt(sessionId, currentVersion, latestVersion, channel) {
  const path = updatePromptClaimPath(sessionId, currentVersion, latestVersion);
  if (!path || typeof channel !== 'string' || channel.length === 0) return false;
  try {
    ensurePrivateDir(join(memeshDir(), 'update-prompt-claims'));
    // A crash can leave a pending claim before the hook emits its output.
    // Reclaim only when that owner process is definitely gone; emitted
    // claims remain session-scoped and continue suppressing duplicates.
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      const ownerPid = Number(existing?.ownerPid);
      if (existing?.decision === 'pending' && Number.isInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
        } catch (err) {
          if (err?.code === 'ESRCH') unlinkSync(path);
        }
      }
    } catch {
      // A corrupt claim fails closed at the O_EXCL step below.
    }
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, JSON.stringify({
        sessionId,
        currentVersion,
        latestVersion,
        channel,
        decision: 'pending',
        ownerPid: process.pid,
        recordedAt: new Date().toISOString(),
      }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function finalizeUpdatePromptClaim(sessionId, currentVersion, latestVersion) {
  const path = updatePromptClaimPath(sessionId, currentVersion, latestVersion);
  if (!path || !existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.decision !== 'pending' || Number(value.ownerPid) !== process.pid) return false;
    writePrivateJson(path, { ...value, decision: 'emitted', emittedAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner answered this session's notice. After this, further words in the
 * same session ("no" to an unrelated question, a stray "never") are not
 * decisions about updates. Returns false when there was no claim to mark.
 */
export function markUpdatePromptAnswered(sessionId, currentVersion, latestVersion, decision) {
  const path = updatePromptClaimPath(sessionId, currentVersion, latestVersion);
  if (!path || !existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    writePrivateJson(path, { ...value, decision: 'answered', answer: decision, answeredAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

export function readUpdatePromptClaim(sessionId, currentVersion, latestVersion) {
  const path = updatePromptClaimPath(sessionId, currentVersion, latestVersion);
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function readAutoUpdateConsent(sessionId, currentVersion, latestVersion, channel = 'unknown') {
  const path = autoUpdateConsentPath(sessionId, currentVersion, latestVersion, channel);
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} sessionId
 * @param {string} currentVersion
 * @param {string} latestVersion
 * @param {string|null} [channel=null]
 */
export function findAutoUpdateConsent(sessionId, currentVersion, latestVersion, channel = null) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId === 'unknown') return null;
  try {
    const dir = join(memeshDir(), 'update-consent');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const value = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (value?.sessionId === sessionId
          && value?.currentVersion === currentVersion
          && value?.latestVersion === latestVersion
          && (channel === null || value?.channel === channel)) return value;
      } catch { /* ignore one corrupt marker */ }
    }
  } catch { /* missing/unreadable consent dir */ }
  return null;
}

export function writeAutoUpdateConsent(sessionId, currentVersion, latestVersion, channel, decision) {
  const path = autoUpdateConsentPath(sessionId, currentVersion, latestVersion, channel);
  if (!path || !['pending', 'approved', 'declined'].includes(decision)) return false;
  try {
    ensurePrivateDir(join(memeshDir(), 'update-consent'));
    writePrivateJson(path, {
      sessionId,
      currentVersion,
      latestVersion,
      channel,
      decision,
      recordedAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Owner's answer to the first-use update notice.
 *   'approved' — install (npm-global only; other channels have no in-session installer)
 *   'declined' — "Not now": snooze this target (24h, then 48h, then 7d)
 *   'never'    — "Never ask again": config.updateCheck = false
 */
export function parseAutoUpdateConsent(prompt) {
  if (typeof prompt !== 'string') return null;
  const value = prompt.trim().toLowerCase().replace(/[.!?。！？]+$/u, '');
  // "never" alone is NOT enough: it is an ordinary English word, and this
  // hook sees every prompt in a session that was shown the notice. The
  // phrases below are the ones the Settings hint tells users to type, in
  // each of the 11 dashboard locales.
  if (/^(?:never ask(?: me)?(?: again)?|don'?t ask(?: me)?(?: again)?|stop asking|不要再問|別再問|不再提醒|不要再问|今後は確認しない|다시 묻지 않기|não voltar a perguntar|ne plus demander|nicht mehr fragen|không hỏi lại|no volver a preguntar|ไม่ต้องถามอีก)$/.test(value)) return 'never';
  if (/^(?:yes|y|upgrade|update|install(?: it)?|go ahead|是|好|升級|更新|安裝)$/.test(value)) return 'approved';
  if (/^(?:no|n|not now|later|不要|不用|稍後|暫時不要|稍后|後で|나중에|agora não|pas maintenant|jetzt nicht|để sau|ahora no|ไว้ก่อน)$/.test(value)) return 'declined';
  return null;
}

/** `config.updateCheck` — false means the owner said never ask again. */
export function isUpdateCheckEnabled(env = process.env) {
  return readHookConfig(env).updateCheck !== false;
}

export function decideAutoUpdateHook(currentVersion, cache, policy) {
  if (!cache || cache.currentVersion !== currentVersion) return { run: false };
  const latest = cache.latestVersion;
  if (typeof latest !== 'string' || !latest) return { run: false };
  const bump = classifyBumpHook(currentVersion, latest);
  if (!bump) return { run: false };

  const lastSuccessAt = cache.lastSuccessfulCheckAt;
  const lastSuccessMs = typeof lastSuccessAt === 'string' ? Date.parse(lastSuccessAt) : NaN;
  const cacheAgeMs = Number.isFinite(lastSuccessMs) ? Date.now() - lastSuccessMs : Infinity;
  if (cacheAgeMs > AUTO_UPDATE_CACHE_FRESHNESS_MS) {
    return { run: false, reason: 'stale-cache' };
  }

  const policyAllows = (POLICY_RANK[policy] ?? 0) >= BUMP_RANK[bump];
  if (policyAllows) return { run: true, latest, bump, deprecationOverride: false };

  // The deprecation override does NOT apply when the policy is `off`.
  //
  // Look at what the override could ever do: it fires only for a `patch`
  // bump, and any policy above `off` already permits a patch. So its ONLY
  // effect was to defeat `off` — the one setting whose whole meaning is
  // "never install anything without me asking".
  //
  // And its trigger is `currentVersionDeprecation`, a string the PUBLISHER
  // writes into the npm registry. Anyone able to publish the package could
  // therefore make every user who had turned auto-update OFF run a detached
  // `npm install -g`, unattended, from a Stop hook. That is not a security
  // override; it is a remote switch on a user's explicit refusal.
  //
  // A deprecated version still gets said out loud: `memesh doctor` escalates
  // the update-status row to FAIL for it (there is a test named for that),
  // and the session banner reports it. The user decides.
  const deprecated = typeof cache.currentVersionDeprecation === 'string'
    && cache.currentVersionDeprecation.length > 0;
  if (deprecated && bump === 'patch' && policy !== 'off') {
    return { run: true, latest, bump, deprecationOverride: true };
  }

  return { run: false };
}

export function logAutoUpdate(line) {
  try {
    const dir = memeshDir();
    ensurePrivateDir(dir);
    const path = join(dir, 'auto-update.log');
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
    try { chmodSync(path, 0o600); } catch { /* non-POSIX */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch the detached updater runner after proving that this is an
 * npm-global install and that its durable outcome log is writable. The runner
 * owns the single-flight lock and emits the only terminal SUCCESS/FAILED line.
 *
 * @param {string} version - Target version to install
 * @param {object|null} installChannelMod - Preloaded dist/core/install-channel.js module
 * @returns {Promise<{ state: 'dispatched'|'channel'|'failed' }>}
 */
export async function spawnAutoUpdate(version, installChannelMod) {
  let fd = -1;
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    let channel = 'unknown';
    if (installChannelMod) {
      try {
        channel = installChannelMod.getCurrentInstallChannel({ packageRoot: pluginRoot });
      } catch { /* best-effort */ }
    }
    if (channel !== 'npm-global') {
      const line = `auto-update SKIPPED: install channel '${channel}' does not support self-update via npm install -g`;
      if (!logAutoUpdate(line)) {
        try { process.stderr.write(`[memesh] ${line}\n`); } catch { /* stderr unavailable */ }
      }
      return { state: 'channel' };
    }

    const dir = memeshDir();
    ensurePrivateDir(dir);
    const logPath = join(dir, 'auto-update.log');
    const lockPath = join(dir, 'auto-update.lock');
    const runnerPath = join(pluginRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
    if (!existsSync(runnerPath)) {
      const line = `auto-update FAILED: runner missing at ${runnerPath}`;
      if (!logAutoUpdate(line)) {
        try { process.stderr.write(`[memesh] ${line}\n`); } catch { /* stderr unavailable */ }
      }
      return { state: 'failed' };
    }

    try {
      fd = openSync(logPath, 'a', 0o600);
      try { chmodSync(logPath, 0o600); } catch { /* non-POSIX */ }
    } catch (err) {
      try {
        process.stderr.write(
          `[memesh] auto-update FAILED: durable log unavailable at ${logPath} (${err?.message ?? err})\n`,
        );
      } catch { /* stderr unavailable */ }
      return { state: 'failed' };
    }

    const child = spawn(
      process.execPath,
      [runnerPath, version, lockPath],
      { detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true },
    );

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (state, line) => {
        if (settled) return;
        settled = true;
        if (fd >= 0) {
          try { closeSync(fd); } catch { /* already closed */ }
          fd = -1;
        }
        if (!logAutoUpdate(line)) {
          try { process.stderr.write(`[memesh] ${line}\n`); } catch { /* stderr unavailable */ }
        }
        resolve({ state });
      };
      child.once('spawn', () => {
        child.unref();
        finish(
          'dispatched',
          `auto-update DISPATCHED: target=${version} worker_pid=${child.pid ?? 'unknown'} lock=${lockPath}`,
        );
      });
      child.once('error', (err) => {
        finish('failed', `auto-update FAILED: target=${version} stage=dispatch error=${err?.message ?? err}`);
      });
    });
  } catch (err) {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    const line = `auto-update FAILED: target=${version} stage=dispatch error=${err?.message ?? err}`;
    if (!logAutoUpdate(line)) {
      try { process.stderr.write(`[memesh] ${line}\n`); } catch { /* stderr unavailable */ }
    }
    return { state: 'failed' };
  }
}
