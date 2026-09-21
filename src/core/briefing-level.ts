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
 * `standard` is the new default (#360). `full` — everything, unchanged from
 * before this change for section selection and the notice (round 8, Codex
 * round 7 re-review, item 2: a stale or unknown-age task state still
 * replaces that one block at `full` too, exactly as it does at `standard`
 * — this line used to overstate it) — was every session's only behaviour,
 * and the owner's own usage did not justify it: `memesh doctor` reported 3
 * of 137 sessions ever citing an injected memory.
 */
export const DEFAULT_BRIEFING_LEVEL: BriefingLevel = 'standard';

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
 * Env > config > default — the same precedence `sessionLimit` already uses
 * (`resolveSessionLimit` in the hooks' `_shared.js`: "Env > config.sessionLimit
 * > default"). Takes the raw env/config values rather than reading them
 * itself, so this stays a zero-import leaf while each surface still owns HOW
 * it reads its source: the hook reads an env var string and its own
 * hand-parsed config.json (`_shared.js`'s `readHookConfig`); core reads
 * `process.env` and `readConfig()` (`src/core/config.ts`). That split is the
 * same one `resolveSessionLimit` and `assembleBriefing` already have — only
 * the POLICY (what counts as valid, and what level means) is shared.
 */
/**
 * Codex round 3 re-review, item 2: `invalid.value` is untrusted input — a
 * stored config value (any JSON type, per the fix below), or an env var —
 * headed for a stderr trace line and an outcome-record `reason` field. Both
 * are single-line, human-facing diagnostics, so this is where the value is
 * bounded ONCE for every caller (hook, core), rather than trusting each
 * call site to remember: length capped well under the outcome channel's own
 * 200-char truncation so the interesting part (which source, roughly what
 * was there) survives even after that later truncation, and guaranteed to
 * never contain a raw line break that would fragment a log line or a JSONL
 * record.
 *
 * Round 6 (Codex round 5 re-review, item 3): the FIRST version of this
 * function (`String(value).replace(/\s+/g, ' ').trim()`) collapsed AND
 * trimmed whitespace — which erased exactly the evidence that made a
 * near-miss value invalid. `{"briefing": " full "}` (leading/trailing
 * spaces around an otherwise-valid level) rendered as invalid level
 * `"full"`, indistinguishable from the valid value — a maintainer reading
 * the trace would reasonably ask "that looks valid, why was it rejected?"
 * `JSON.stringify` instead: keeps the surrounding quotes and the spaces
 * inside them, escapes an embedded newline to the two-character `\n` (never
 * a raw line break) and produces single-line compact output for
 * arrays/objects with no indent argument — so it satisfies the
 * one-line/no-raw-newline guarantee this function has always made, while
 * showing what was actually there.
 *
 * Round 7 (Codex round 6 re-review, item 3): that round-6 fix truncated
 * `JSON.stringify`'s OUTPUT at a raw UTF-16 code-unit offset, which can
 * land inside the two-character `\n` escape (leaving a dangling `\`) or
 * inside a surrogate pair (leaving a lone high surrogate) — bounded and
 * one-line, but no longer the "real JSON.stringify form" the round-6
 * comment above promised, right at the truncation boundary. Fixed by
 * truncating the VALUE at a Unicode CODE POINT boundary (`Array.from`)
 * before serializing, so `JSON.stringify` never sees anything cut mid
 * character.
 *
 * Round 8 (Codex round 7 re-review, item 1): the round-7 fix bounded the
 * INPUT to 120 code points, not the SERIALIZED form — and those are not
 * the same number. A code point that needs escaping expands on
 * serialization (a lone surrogate becomes the 6-character `\udXXX`, a
 * control character similarly, `\n`/`\r`/`\t`/`"`/`\` each become 2), so
 * 120 code points of escape-heavy input serialized past 700 UTF-16 units
 * in a real run. `session-start.js` then embeds that in a longer reason
 * string, which `recordHookOutcome()` (`_shared.js`) truncates a SECOND
 * time with its own raw `slice(0, 200)` — which can, again, land inside
 * an escape or a surrogate, reopening exactly the class of bug round 7
 * closed, one layer downstream, where this module can no longer see it.
 * The claimed bound ("123 characters" in round-7 tests/docs) was also
 * simply wrong for the same reason — that number was never guaranteed.
 *
 * Fixed by bounding the SERIALIZED form directly, at the source, well
 * under `recordHookOutcome`'s 200-char second truncation (verified with a
 * dedicated test using the longest fixed prefix session-start.js wraps
 * this in — see tests/core/briefing-level.test.ts): grow the kept prefix
 * one code point at a time and re-serialize after each, stopping the
 * INSTANT the serialized length (kept prefix + ellipsis, quoted) would
 * exceed `INVALID_VALUE_SERIALIZED_MAX` UTF-16 units. This is the only
 * correct approach — escape expansion is per-CHARACTER and cannot be
 * predicted from a code-point count alone, so no fixed input-side bound
 * can guarantee an output-side one. The loop cost is bounded by the
 * output bound itself (at most ~100 iterations, i.e. O(1)), never by the
 * input length, since the minimum growth per iteration is one unit.
 *
 * (As of round 8 this same serialize-then-bound approach also covered
 * non-string values, including containers — round 9 and round 10 below
 * replaced that for arrays/objects; scalars are still serialized whole,
 * unchanged, in the scalar branch of `describeInvalidValue` below.)
 *
 * Round 9 (Codex round 8 re-review): the round-8 fix bounds the OUTPUT
 * (100 units), but does INPUT-proportional work to get there —
 * `Array.from(value)` on a 10 MB invalid `briefing` string materializes
 * ~10 million array elements before the loop ever looks at the first 100;
 * measured ~111 MB RSS for that one call. Fixed for STRINGS by pre-slicing
 * the RAW input to `PRE_SLICE_RAW_MAX` UTF-16 units
 * (`String.prototype.slice`, O(1)-ish, never proportional to a multi-MB
 * input) BEFORE `Array.from` ever runs on it:
 *
 *   - `value.length <= INVALID_VALUE_SERIALIZED_MAX` is the cheap fast
 *     path (serialization never SHRINKS a string — every character
 *     contributes at least 1 output unit — so this is also the only case
 *     where "does the whole value already fit" needs checking at all).
 *     Otherwise, `value.length > INVALID_VALUE_SERIALIZED_MAX` already
 *     PROVES truncation is needed by that same non-shrinking property, so
 *     the pre-slice runs first. Sizing it: the LEAST-expanding input
 *     (plain ASCII, nothing that needs a JSON escape) needs the MOST raw
 *     units to fill the 100-unit budget — 1 serialized unit per kept
 *     unit, minus 3 fixed-overhead units (the two quotes plus the
 *     one-unit `…`) — so up to 100 − 3 = 97 raw units can be useful. 256
 *     is ~2.6x that largest useful prefix: generous and inspectable, but
 *     still O(1)-ish rather than input-proportional. (An earlier version
 *     of this comment sized the margin from the OPPOSITE, escape-DENSE
 *     case and claimed ">10x" — that direction cannot bound the prefix,
 *     since escape-dense input needs FEWER raw units, not more, to fill
 *     the same budget, so it was never the binding case.) A dangling high
 *     surrogate left at the cut boundary (this pre-slice landing between
 *     a real pair) is dropped the same way `sliceUtf16UnitsSurrogateSafe`
 *     (`_shared.js`) does for the exact same reason — this file cannot
 *     import that one (zero-import leaf constraint), so the same small
 *     check is repeated locally. Equivalence with the OLD (whole-string)
 *     algorithm — the pre-slice must never change the RESULT, only the
 *     work done to get there — is asserted directly in
 *     tests/core/briefing-level.test.ts for every adversarial case
 *     already covered (10,000 `x`, 200 emoji, 30 lone high surrogates,
 *     150 mixed control characters).
 *
 * Round 9 also tried to keep SMALL arrays/objects rendering their real
 * JSON form, gated by a count check (array length / object own-key count
 * over 50 → summary). Codex round 9 re-review (Z1) found the guard
 * itself still input-proportional, two ways a count check does not
 * cover: `Object.keys()` on a 1,000,000-key object materializes every
 * key before the count is even compared (~15.6 MiB, 118 ms measured);
 * and a SMALL count of HUGE elements passes the guard outright — a
 * 40-element array of 1 MB strings (well under 50) sent the full 40 MB
 * through `JSON.stringify` before being discarded (~40.7 MiB measured; a
 * 10-key object of 1 MB values, ~10.5 MiB). Both are the same class of
 * bug the string-side fix above exists to close, reached through a
 * container instead of a string.
 *
 * Round 10: fixed by giving up on small-container fidelity instead —
 * every array and every non-null object is now summarised by TYPE ALONE,
 * unconditionally, before any inspection. `Array.isArray` is the only
 * check run, and it does not trigger a Proxy trap (a direct internal
 * check, not a trap-observable operation) — confirmed with a
 * throwing-trap Proxy in tests/core/briefing-level.test.ts, alongside a
 * throwing `toJSON` that must never be called. This also removes the
 * circular-reference / throwing-`toJSON` handling that only existed to
 * catch a container's `JSON.stringify` failing.
 *
 * Round 11 (Codex round 10 re-review): round 10 left `bigint`/`symbol`/
 * `function` going through the scalar `JSON.stringify(value) ?? String(value)`
 * path, ending in a raw `.slice(0, 100)` — `Symbol('a'.repeat(92) + '😀')`
 * and a `Function` whose source ends in `😀` both came back ending in a
 * lone `\ud83d` (`isWellFormed()` false), the exact bisection-at-a-boundary
 * bug the string-side fix exists to close, and for the same reason a
 * BigInt's decimal expansion, a Symbol's description, and a function's
 * source text are each exactly as unbounded as a container. Fixed by
 * summarising all three by TYPE ALONE too (`[bigint]`/`[symbol]`/
 * `[function]`), with no `String()`/`JSON.stringify()`/`.description`
 * access at all — same fix as round 10's container branch, one type
 * check away from it. That leaves only number/boolean/null/undefined on
 * the final `JSON.stringify` line, none of which can throw or produce
 * more than a few characters, so the `.slice(0, 100)` bound and the
 * try/catch around it are both now dead code and are removed with it.
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
  // Round 10 (Codex round 9 re-review, Z1): a container is summarised by
  // TYPE ALONE, unconditionally — no size check, no `Object.keys`, no
  // `JSON.stringify`, no iteration of any kind. `Array.isArray` does not
  // trigger a Proxy trap, so this stays safe even against a Proxy built
  // to throw on every trap (tests/core/briefing-level.test.ts).
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

export function resolveBriefingLevel(envValue: string | undefined, configValue: unknown): BriefingLevelResolution {
  if (envValue !== undefined) {
    if (isBriefingLevel(envValue)) return { level: envValue, invalid: null };
    return { level: DEFAULT_BRIEFING_LEVEL, invalid: { source: 'env', value: describeInvalidValue(envValue) } };
  }
  // #360 round 4 (Codex round 3 re-review, item 2): `configValue` may be ANY
  // JSON type now, not just a string — `readConfig()` used to discard a
  // non-string `briefing` before this function ever saw it, so `{"briefing":42}`
  // was reported invalid by the hook (which reads raw JSON directly) but
  // silently became `standard` with no reason recorded anywhere else
  // (`assembleBriefing`, the CLI, the MCP tool, `GET /v1/config`). Every
  // surface now passes the raw stored value through unfiltered
  // (`config.ts`'s `selectConfig` no longer gates on `typeof === 'string'`),
  // so `isBriefingLevel`'s own type check is what rejects a non-string here
  // — the SAME check, the SAME resolver, for every surface.
  //
  // #360 round 5 (Codex round 4 re-review, item 2): an explicit stored
  // `null` used to be treated the SAME as "key absent" here — checked and
  // confirmed against the real product: `memesh config unset briefing`
  // (`updateConfig({ briefing: undefined })` in config.ts) DELETES the key
  // outright; nothing in this codebase ever WRITES a literal `null` for
  // this field. A `null` on disk can therefore only come from a hand
  // edit or an older/newer memesh version — exactly the same "someone put
  // something unexpected here" case as `42` or `"banana"`, not a
  // legitimate "not set" signal. It now falls through to the SAME invalid
  // branch as any other non-level value, with the SAME bounded reason. Only
  // `configValue === undefined` (the key genuinely absent from the parsed
  // object) means "not set" now.
  if (configValue !== undefined) {
    if (isBriefingLevel(configValue)) return { level: configValue, invalid: null };
    return { level: DEFAULT_BRIEFING_LEVEL, invalid: { source: 'config', value: describeInvalidValue(configValue) } };
  }
  return { level: DEFAULT_BRIEFING_LEVEL, invalid: null };
}

/**
 * THE CONTRACT (Codex review round 1, item 1 — stated identically here, in
 * the tests' names, CHANGELOG.md, docs/api/API_REFERENCE.md,
 * docs/ARCHITECTURE.md, AGENTS.md and the plan; check every sentence written
 * about levels against this one):
 *
 *   - `minimal`: only this project — live repository state, its decisions,
 *     lessons, known facts and recent activity. No task state, no durable
 *     index, nothing from outside the project.
 *   - `standard` (default): `minimal` + the task state when fresh + the
 *     capped index of this project's durable memories.
 *   - `full`: `standard` + memories from your other projects + global
 *     memory — this MEMORY block is byte-for-byte identical, at `full`,
 *     across every surface (hook, `briefing` MCP tool, CLI) and to the
 *     pre-#360 output, EXCEPT when the task state is stale or of unknown
 *     age (round 7, Codex round 6 re-review, item 1 — a real HEAD-vs-current
 *     run on a stale fixture measured 953 vs 1,016 bytes, not equal): that
 *     one-line replacement is a separate, intentional feature and applies
 *     at every level including `full`, the same as it does at `standard`.
 *     `full`'s compatibility claim was never about the task-state block —
 *     it was always about section SELECTION (which pools are included) and
 *     the work-package notice, both of which this branch left unchanged.
 *
 * The work-package notice is DELIBERATELY not part of the bullet above, on
 * purpose, and Codex round 4 found this file's OWN wording contradicting
 * itself about it: this docblock used to fold the notice into `full`'s
 * definition as if it were memory content, while the `workPackageNotice`
 * field comment below correctly called it hook-only — one file, two
 * disagreeing claims, and the disagreement had already leaked into
 * CHANGELOG.md, AGENTS.md, ARCHITECTURE.md, API_REFERENCE.md and the MCP
 * tool description ("the same block") before anyone measured whether the
 * `briefing` tool/CLI ever actually included it. They never did — verified
 * against a real HEAD (`554e7142`, this issue's base commit) build and
 * fixture: the hook's `additionalContext` included the notice, the built
 * `memesh briefing --json` did not, on the exact same database. The notice
 * is a SessionStart-surface instruction to the HOST AGENT (offer a
 * work-package dispatch), not a memory — it was never part of what
 * `assembleBriefing()` returns, at any level, before or after #360. See
 * `sessionStartAppendsWorkPackageNotice()` below, the one place this is
 * decided, and the parity tests in `tests/core/briefing.test.ts` that now
 * assert the notice's presence/absence explicitly rather than only
 * comparing the sections both surfaces DO share.
 *
 * The original #360 issue spec described `minimal` as ONLY repository state
 * plus recent activity — narrower than what shipped. The wider rule above is
 * the one actually implemented (and the better one): a project's own
 * curated decisions and lessons are the single most valuable thing MeMesh
 * injects, and the one thing a host's own built-in memory does not already
 * have — dropping them at the narrowest level would have thrown out exactly
 * what makes the injection worth its cost. The spec was wrong; this is the
 * corrected contract project-wide.
 *
 * Which pieces of the assembled block a level includes. The project's own
 * work/knowledge/evidence sections (decisions, lessons, what's known, recent
 * activity) and the live repository-state prefix are NOT listed in
 * `BriefingLevelPolicy` below because they are unconditional at EVERY level,
 * `minimal` included — that unconditional inclusion IS the contract above,
 * not an implementation shortcut.
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
