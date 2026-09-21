// =============================================================================
// briefing-level — how much of the briefing to inject, decided in ONE place
// =============================================================================
//
// #360: measured on a real session (plugin 4.10.0, 2026-09-19) the injected
// SessionStart block was 2,545 characters, and only 59% of that (global
// memory + other-projects memory + a work-package notice repeated verbatim
// every session) was NOT about the project the agent was actually in. Hosts
// (Claude Code, Codex) now carry their own memory, so MeMesh should inject
// what they do NOT already have: live repository state and this project's
// own recent, cross-session activity — not another project's memory or a
// notice that reads the same every time.
//
// `briefing` is the one new setting. Both injection surfaces — the
// SessionStart hook and the `briefing` MCP tool / CLI — assemble their block
// from the SAME pools (work-topology.ts) and the SAME task-state leaf
// (task-state.ts); what decides which of those pieces reaches a given level
// has to live in exactly one place too, or the two surfaces could render
// "standard" differently. This module is that place.
//
// A runtime leaf with NO imports at all (same constraint, same reason, as
// work-topology.ts), so scripts/generate-hook-core.mjs copies it verbatim
// next to the hooks.

export type BriefingLevel = 'minimal' | 'standard' | 'full';

export const BRIEFING_LEVELS: readonly BriefingLevel[] = ['minimal', 'standard', 'full'];

/**
 * `minimal` is the default: a new session gets what belongs to the project it
 * is in — decisions, lessons, known facts, recent activity — and the fresh task
 * state and the durable-memory index only when asked for (`memesh config set
 * briefing standard`, or `MEMESH_BRIEFING=standard`). `full` — everything — was
 * every session's only behaviour before levels existed, and the owner's own
 * usage did not justify it: `memesh doctor` reported 3 of 137 sessions ever
 * citing an injected memory. `full` keeps that behaviour's section selection
 * and its work-package notice; a stale or unknown-age task state replaces its
 * block with a one-line flag at every level, `full` and the default included.
 */
export const DEFAULT_BRIEFING_LEVEL: BriefingLevel = 'minimal';

export function isBriefingLevel(value: unknown): value is BriefingLevel {
  return typeof value === 'string' && (BRIEFING_LEVELS as readonly string[]).includes(value);
}

export interface BriefingLevelResolution {
  level: BriefingLevel;
  /**
   * Set when an explicit env or config value was present but was not one of
   * BRIEFING_LEVELS. The caller MUST record why the default was used instead
   * of silently falling back — an unknown value defaulting quietly is exactly
   * the "silent skip" this codebase treats as a defect (CONTRIBUTING.md,
   * `recordHookOutcome`). `null` means the level was resolved cleanly (an
   * explicit valid value, or nothing set at all).
   */
  invalid: { source: 'env' | 'config'; value: string } | null;
}

/**
 * `invalid.value` is untrusted input — a stored config value (any JSON type)
 * or an env var — headed for a stderr trace line and an outcome-record
 * `reason` field. Both are single-line, human-facing diagnostics, so the value
 * is bounded ONCE here, for every caller (hook, core), rather than trusting
 * each call site to remember:
 *
 *   - The result is the value's `JSON.stringify` form. It keeps the quotes
 *     and any whitespace inside them (`" full "` must read as different from
 *     `"full"`, or a near-miss looks valid), and escapes an embedded newline
 *     to the two characters `\n`, so it never contains a raw line break that
 *     would fragment a log line or a JSONL record. It is already quoted:
 *     callers must not quote it again.
 *   - The SERIALIZED form is bounded to INVALID_VALUE_SERIALIZED_MAX UTF-16
 *     units, well under the outcome channel's own 200-unit cut
 *     (`recordHookOutcome` in `_shared.js`) even with the longest fixed
 *     prefix the hook wraps it in (asserted in tests/core/briefing-level.test.ts),
 *     so that second, cruder cut never lands inside an escape or a surrogate
 *     pair. Escape expansion is per character (a lone surrogate serializes to
 *     six units, `\n` to two), so no limit on the INPUT can guarantee one on the
 *     output: the kept prefix grows one code point at a time, is re-serialized
 *     after each, and stops the instant the quoted form with its ellipsis
 *     would exceed the bound. The loop is bounded by the output bound, never
 *     by the input length.
 *   - Work is not proportional to the input either. A string is pre-sliced
 *     to PRE_SLICE_RAW_MAX raw UTF-16 units before any per-code-point work
 *     (`Array.from` on a 10 MB string measured ~111 MB RSS). Serialization
 *     never shrinks a string, so `value.length > INVALID_VALUE_SERIALIZED_MAX`
 *     already proves truncation is needed. The least-expanding input (plain
 *     ASCII) needs the most raw units to fill the budget — one serialized
 *     unit per kept unit, minus 3 fixed-overhead units (the two quotes and
 *     the one-unit `…`) — so at most 100 − 3 = 97 raw units can be useful;
 *     256 is ~2.6x that: generous and inspectable, still O(1). A dangling high
 *     surrogate left at the cut is dropped the same way
 *     `sliceUtf16UnitsSurrogateSafe` (`_shared.js`) does; this file is a
 *     zero-import leaf and cannot import that one, so the small check is
 *     repeated locally. The pre-slice never changes the RESULT, only the work
 *     done to get it: tests/core/briefing-level.test.ts compares it against a
 *     whole-string reference implementation for every adversarial case.
 *   - Every array and every non-null object is summarised by TYPE ALONE
 *     (`[array]`, `[object]`), before any inspection. `Array.isArray` is the
 *     only check run and it does not trigger a Proxy trap (tests/core/briefing-level.test.ts
 *     uses a throwing-trap Proxy and a throwing `toJSON`). Inspecting a
 *     container costs input-proportional work either way: `Object.keys()` on
 *     a 1,000,000-key object materializes every key (~15.6 MiB, 118 ms
 *     measured), and a small count of huge elements still sends all of it
 *     through `JSON.stringify` (a 40-element array of 1 MB strings: ~40.7 MiB).
 *     `bigint`, `symbol` and `function` are summarised by type alone for the
 *     same reason (`[bigint]`, `[symbol]`, `[function]`): a BigInt's decimal
 *     expansion, a Symbol's description and a function's source text are each
 *     as unbounded as a container, and a raw `.slice` on them can leave a
 *     lone surrogate. Only number/boolean/null/undefined reach the final
 *     `JSON.stringify` line, none of which can throw or produce more than a
 *     few characters.
 */
const INVALID_VALUE_SERIALIZED_MAX = 100; // UTF-16 units, of the SERIALIZED (JSON.stringify'd) form
const PRE_SLICE_RAW_MAX = 256; // UTF-16 units of RAW string input examined before any per-code-point work

/** Drop a dangling high surrogate left at a raw UTF-16 slice boundary — the
 * cut landed between a real pair's two halves. Mirrors
 * `sliceUtf16UnitsSurrogateSafe` in scripts/hooks/_shared.js; duplicated
 * (not imported) because this file must stay a zero-import leaf. */
function safeRawPreSlice(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  let end = maxUnits;
  const lastKept = value.charCodeAt(end - 1);
  const nextUnit = value.charCodeAt(end);
  const lastKeptIsHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
  const nextUnitIsLowSurrogate = nextUnit >= 0xdc00 && nextUnit <= 0xdfff;
  if (lastKeptIsHighSurrogate && nextUnitIsLowSurrogate) end -= 1;
  return value.slice(0, end);
}

/** Grow the kept prefix one code point at a time, re-serializing after
 * each, stopping the instant the serialized form would exceed the bound.
 * `codePoints` must already be pre-bounded (see callers) — this function
 * does no input-side bounding of its own. */
function truncateToSerializedBound(codePoints: string[]): string {
  let kept = 0;
  for (; kept < codePoints.length; kept++) {
    const candidate = JSON.stringify(`${codePoints.slice(0, kept + 1).join('')}…`);
    if (candidate.length > INVALID_VALUE_SERIALIZED_MAX) break;
  }
  return JSON.stringify(`${codePoints.slice(0, kept).join('')}…`);
}

function describeInvalidValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length <= INVALID_VALUE_SERIALIZED_MAX) {
      // Cheap regardless: at most 100 raw units, so JSON.stringify-ing it
      // whole is bounded work even before any truncation decision.
      const whole = JSON.stringify(value);
      if (whole.length <= INVALID_VALUE_SERIALIZED_MAX) return whole;
      return truncateToSerializedBound(Array.from(value));
    }
    // value.length > INVALID_VALUE_SERIALIZED_MAX already PROVES
    // truncation is needed (serialization never shrinks a string), so
    // there is no "does the whole thing fit" case left to check here —
    // go straight to the bounded pre-slice, never touching the full
    // (potentially multi-MB) string with Array.from or JSON.stringify.
    return truncateToSerializedBound(Array.from(safeRawPreSlice(value, PRE_SLICE_RAW_MAX)));
  }
  // A container is summarised by TYPE ALONE, unconditionally — no size check,
  // no `Object.keys`, no `JSON.stringify`, no iteration of any kind.
  // `Array.isArray` does not trigger a Proxy trap, so this stays safe even
  // against a Proxy built to throw on every trap (tests/core/briefing-level.test.ts).
  if (Array.isArray(value)) return '[array]';
  if (value !== null && typeof value === 'object') return '[object]';
  // Scalars only from here: number, boolean, null, bigint, undefined,
  // symbol, function. None of this module's real callers (JSON.parse
  // output, an env var string) can produce bigint/symbol/function — JSON
  // has no literal for any of them — so these three are a defensive
  // fallback, not a path with a realistic huge-input case; but a BigInt's
  // decimal expansion, a Symbol's description, and a function's source
  // text are each exactly as unbounded as a container, with no
  // serialized-length limit of their own, so — same fix as the container
  // branch above — they are summarised by TYPE ALONE, with no
  // `String()`/`JSON.stringify()`/`.description` access at all.
  if (typeof value === 'bigint') return '[bigint]';
  if (typeof value === 'symbol') return '[symbol]';
  if (typeof value === 'function') return '[function]';
  // Only number/boolean/null/undefined are left, and none of them needs a
  // bound: `JSON.stringify` never throws on any of the four and never
  // returns more than a few characters (`NaN`/`Infinity`/`-Infinity`
  // become the 4-character `"null"`; everything else — `-0`, exponential
  // notation, `true`/`false`/`null` — is its own short literal).
  // `JSON.stringify(undefined)` is the one case that returns the
  // `undefined` VALUE, not a string; `??` covers it with `String(undefined)`.
  return JSON.stringify(value) ?? String(value);
}

/**
 * Env > config > default. An env value that is present but is not a level
 * fails closed to the default WITHOUT consulting config (the same fail-closed
 * rule `autoUpdate` follows); `resolveSessionLimit` (`_shared.js`) differs:
 * it falls back to config when its env value is unusable. Takes the raw
 * env/config values rather than reading them itself, so this stays a
 * zero-import leaf while each surface still owns HOW it reads its source:
 * the hook reads an env var string and its own hand-parsed config.json
 * (`_shared.js`'s `readHookConfig`); core reads `process.env` and
 * `readConfig()` (`src/core/config.ts`). Only the POLICY (what counts as
 * valid, and what a level means) is shared.
 */
export function resolveBriefingLevel(envValue: string | undefined, configValue: unknown): BriefingLevelResolution {
  if (envValue !== undefined) {
    if (isBriefingLevel(envValue)) return { level: envValue, invalid: null };
    return { level: DEFAULT_BRIEFING_LEVEL, invalid: { source: 'env', value: describeInvalidValue(envValue) } };
  }
  // `configValue` may be ANY JSON type: every surface passes the stored value
  // through unfiltered (`config.ts`'s `selectConfig` does not gate on
  // `typeof`), so `isBriefingLevel`'s own type check is what rejects a
  // non-string here — the same check, the same resolver, for every surface.
  //
  // An explicit stored `null` is NOT "not set". `memesh config unset briefing`
  // (`updateConfig({ briefing: undefined })` in config.ts) deletes the key
  // outright, and nothing in this codebase writes a literal `null` for this
  // field, so a `null` on disk comes from a hand edit or another memesh
  // version — the same "something unexpected is here" case as `42` or
  // `"banana"`. It takes the invalid branch below with the same bounded
  // reason. Only `configValue === undefined` (the key absent from the parsed
  // object) means "not set".
  if (configValue !== undefined) {
    if (isBriefingLevel(configValue)) return { level: configValue, invalid: null };
    return { level: DEFAULT_BRIEFING_LEVEL, invalid: { source: 'config', value: describeInvalidValue(configValue) } };
  }
  return { level: DEFAULT_BRIEFING_LEVEL, invalid: null };
}

/**
 * THE CONTRACT — stated identically here, in the tests' names, CHANGELOG.md,
 * docs/api/API_REFERENCE.md, docs/ARCHITECTURE.md and AGENTS.md; check every
 * sentence written about levels against this one:
 *
 *   - `minimal` (default): only this project — its decisions, lessons, known
 *     facts and recent activity, with the live repository state in front of
 *     them whenever anything else is injected (the repository state alone is
 *     never injected). No task state, no durable index, nothing from outside
 *     the project.
 *   - `standard`: `minimal` + the task state when fresh + the capped index of
 *     this project's durable memories.
 *   - `full`: `standard` + memories from your other projects + global
 *     memory. At `full` this MEMORY block is byte-for-byte identical across
 *     every surface (hook, `briefing` MCP tool, CLI) and to the output from
 *     before levels existed, EXCEPT when the task state is stale or of
 *     unknown age: that one-line replacement is a separate, intentional
 *     feature and applies at every level including `full`, the same as at
 *     `standard`. `full`'s compatibility claim is about section SELECTION
 *     (which pools are included) and the work-package notice, not about the
 *     task-state block.
 *
 * The work-package notice is deliberately not part of the bullets above. It
 * is a SessionStart-surface instruction to the HOST AGENT (offer a
 * work-package dispatch), not a memory: it is never part of what
 * `assembleBriefing()` returns, at any level, so the `briefing` MCP tool and
 * the CLI never include it. See `sessionStartAppendsWorkPackageNotice()`
 * below, the one place this is decided, and the parity tests in
 * `tests/core/briefing.test.ts`, which assert its presence or absence
 * explicitly.
 *
 * `minimal` includes a project's own curated decisions and lessons, not only
 * repository state and recent activity: they are the single most valuable
 * thing MeMesh injects and the one thing a host's own built-in memory does not
 * already have, so dropping them at the narrowest level would throw out
 * exactly what makes the injection worth its cost.
 *
 * Which pieces of the assembled block a level includes. The project's own
 * work/knowledge/evidence sections (decisions, lessons, what's known, recent
 * activity) are NOT listed in `BriefingLevelPolicy` below because they are
 * unconditional at EVERY level, `minimal` included — that is the contract
 * above, not an implementation shortcut. The live repository-state prefix is
 * not listed either: it goes in front of whatever else is injected, at every
 * level, and is never injected on its own (the hook and `assembleBriefing`
 * both add it only to a block that already has lines).
 */
export interface BriefingLevelPolicy {
  /** The "Global memory — applies across projects" section. */
  global: boolean;
  /** The "From your other projects" cross-project recent pool. */
  foreign: boolean;
  /** The FRESH task-state block. A STALE task state always renders its
   *  one-line flag regardless of this flag — see task-state.ts's
   *  `briefingTaskStateLines` and `STALE_TASK_STATE_HOURS`. */
  taskState: boolean;
  /** The durable-memory index (#323). */
  index: boolean;
  /**
   * SessionStart-HOOK-ONLY — identical boilerplate every session, appended
   * AFTER the memory block, never part of `assembleBriefing()`'s result (so
   * never part of the `briefing` MCP tool or CLI output) at ANY level,
   * including `full`. This is a host-agent instruction ("offer to dispatch
   * a work package"), not memory content, which is why it lives outside
   * the memory-block contract above instead of being one more thing `full`
   * includes.
   *
   * `session-start.js` is the ONLY place that should read this field — and
   * should do so through `sessionStartAppendsWorkPackageNotice()` below,
   * not by destructuring `.workPackageNotice` off the policy object
   * directly, so there is exactly one named call site to audit for "does
   * anything else append this" rather than a boolean that a second call
   * site could start reading by accident.
   */
  workPackageNotice: boolean;
}

const POLICIES: Readonly<Record<BriefingLevel, BriefingLevelPolicy>> = {
  minimal: { global: false, foreign: false, taskState: false, index: false, workPackageNotice: false },
  standard: { global: false, foreign: false, taskState: true, index: true, workPackageNotice: false },
  full: { global: true, foreign: true, taskState: true, index: true, workPackageNotice: true },
};

export function briefingLevelPolicy(level: BriefingLevel): BriefingLevelPolicy {
  return POLICIES[level];
}

/**
 * The ONE predicate for "should the SessionStart hook append the
 * work-package notice after the memory block at this level" — see the
 * field comment on `BriefingLevelPolicy.workPackageNotice` for why this
 * exists instead of every caller reading `.workPackageNotice` directly.
 * `assembleBriefing()` (core/briefing.ts) never calls this: the `briefing`
 * MCP tool and CLI are not the SessionStart surface, and the parity tests
 * assert they never render the notice, at any level.
 */
export function sessionStartAppendsWorkPackageNotice(level: BriefingLevel): boolean {
  return briefingLevelPolicy(level).workPackageNotice;
}
