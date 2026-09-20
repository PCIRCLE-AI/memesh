/**
 * #360 — the ONE policy table that decides what `minimal` / `standard` /
 * `full` include, and the ONE precedence rule (env > config > default) both
 * the SessionStart hook and the `briefing` tool/CLI resolve through.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import {
  BRIEFING_LEVELS,
  DEFAULT_BRIEFING_LEVEL,
  isBriefingLevel,
  resolveBriefingLevel,
  briefingLevelPolicy,
} from '../../src/core/briefing-level.js';

describe('briefing-level', () => {
  it('the three levels, in order, with standard as the default', () => {
    expect(BRIEFING_LEVELS).toEqual(['minimal', 'standard', 'full']);
    expect(DEFAULT_BRIEFING_LEVEL).toBe('standard');
  });

  describe('isBriefingLevel', () => {
    it('accepts exactly the three known levels', () => {
      expect(isBriefingLevel('minimal')).toBe(true);
      expect(isBriefingLevel('standard')).toBe(true);
      expect(isBriefingLevel('full')).toBe(true);
    });
    it('rejects everything else, including near-misses', () => {
      expect(isBriefingLevel('Full')).toBe(false);
      expect(isBriefingLevel('minimal ')).toBe(false);
      expect(isBriefingLevel('')).toBe(false);
      expect(isBriefingLevel(undefined)).toBe(false);
      expect(isBriefingLevel(null)).toBe(false);
      expect(isBriefingLevel(3)).toBe(false);
    });
  });

  // The real bound `describeInvalidValue` (private to briefing-level.ts)
  // enforces on the SERIALIZED form — not exported, so this is a test-only
  // mirror of the literal used there; a drift between the two would show
  // up as a failure in whichever test relies on the boundary being exact
  // (the 96-vs-97-character pairs below).
  const INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS = 100;

  describe('resolveBriefingLevel — env > config > default(standard)', () => {
    it('defaults to standard when neither env nor config sets it', () => {
      expect(resolveBriefingLevel(undefined, undefined)).toEqual({ level: 'standard', invalid: null });
    });

    it('a valid config value takes effect with no env set', () => {
      expect(resolveBriefingLevel(undefined, 'minimal')).toEqual({ level: 'minimal', invalid: null });
      expect(resolveBriefingLevel(undefined, 'full')).toEqual({ level: 'full', invalid: null });
    });

    it('a valid env value wins over a valid config value', () => {
      expect(resolveBriefingLevel('minimal', 'full')).toEqual({ level: 'minimal', invalid: null });
    });

    // B4: each source's invalid value yields the default AND a recorded
    // reason naming that source and the offending value — the caller (hook
    // or core) records `.invalid` on its own outcome/trace channel; this
    // pins the DATA the resolver hands back, independent of how each
    // caller reports it.
    it('an invalid env value yields the default AND names env as the source — does not fall through to config', () => {
      // "does not fall through": unlike resolveSessionLimit, an explicit but
      // malformed higher-priority value must not uncover a permissive
      // config value (same reasoning resolveAutoUpdatePolicy already uses
      // in scripts/hooks/_shared.js for a security-relevant setting).
      // #360 round 6 (Codex round 5 re-review, item 3): `value` is the real
      // `JSON.stringify('banana')` form (quoted), not the old flattened
      // `'banana'` (no quotes) — see the dedicated whitespace-evidence
      // tests further down for why that distinction matters.
      expect(resolveBriefingLevel('banana', 'full')).toEqual({
        level: 'standard',
        invalid: { source: 'env', value: '"banana"' },
      });
    });

    it('an invalid config value (no env set) yields the default AND names config as the source', () => {
      expect(resolveBriefingLevel(undefined, 'banana')).toEqual({
        level: 'standard',
        invalid: { source: 'config', value: '"banana"' },
      });
    });

    it('a non-string config value (e.g. a stray number) is also reported invalid, not silently ignored', () => {
      expect(resolveBriefingLevel(undefined, 42)).toEqual({
        level: 'standard',
        invalid: { source: 'config', value: '42' },
      });
    });

    it('config ABSENT (undefined) is "not set" — no false invalid report', () => {
      expect(resolveBriefingLevel(undefined, undefined)).toEqual({ level: 'standard', invalid: null });
    });

    // #360 round 5 (Codex round 4 re-review, item 2): this test used to
    // assert `null` was the same as "not set" too — checked against the
    // real product first: `memesh config unset briefing` DELETES the key
    // (`updateConfig({ briefing: undefined })`), it never writes `null`,
    // and nothing else in this codebase writes `null` here either. A
    // stored `null` can therefore only be a hand edit or a foreign
    // version's value — exactly the same "unexpected value" case as `42`,
    // not a legitimate absence. It now gets the SAME invalid treatment.
    it('an explicit stored null is INVALID, not "not set" — same bounded reason as any other bad value', () => {
      expect(resolveBriefingLevel(undefined, null)).toEqual({
        level: 'standard',
        invalid: { source: 'config', value: 'null' },
      });
    });

    // #360 round 4 (Codex round 3 re-review, item 2): `invalid.value` is
    // untrusted — it lands in a single-line stderr trace AND a JSONL
    // outcome-record `reason` field. Neither channel survives an embedded
    // newline (a raw one fragments the log line / the JSONL record into
    // more than one line) or an unbounded length (a config file is not
    // size-limited). `describeInvalidValue` (private to this module) is
    // what bounds it — exercised here only through the public return value.
    it('a huge stored config value is truncated, not passed through whole (would otherwise blow up the trace)', () => {
      const huge = 'x'.repeat(10_000);
      const result = resolveBriefingLevel(undefined, huge);
      expect(result.level).toBe('standard');
      expect(result.invalid?.source).toBe('config');
      // Capped well under the hook outcome channel's own 200-char
      // truncation (see briefing-level.ts's `INVALID_VALUE_SERIALIZED_MAX`
      // comment) — this pins the actual number so a future change to the
      // cap is a deliberate edit here, not a silent regression.
      //
      // #360 round 7 (Codex round 6 re-review, item 3): the ellipsis is
      // now part of the STRING VALUE, so the serialized form ends with
      // `…"` (the closing quote), not a bare `…` — the round-6 assertion
      // pinned the old (buggy) shape; see the dedicated truncation-boundary
      // tests below for why this moved.
      //
      // #360 round 8 (Codex round 7 re-review, item 1): the bound itself
      // moved from "120 INPUT code points" to "100 SERIALIZED UTF-16
      // units" — the round-7 number was measured on the INPUT side, which
      // is not the same thing for escape-heavy input (see the exhaustive
      // comment on `describeInvalidValue`). 100 units + quotes cannot
      // exceed ~102 for plain ASCII; the loose bound below is deliberately
      // generous (the exact boundary is pinned by the 96-vs-97 pair tests
      // further down, which is where "wrong by exactly one" would show).
      expect(result.invalid!.value.length).toBeLessThanOrEqual(105);
      expect(result.invalid!.value.endsWith('…"')).toBe(true);
      expect(result.invalid!.value).not.toContain('x'.repeat(10_000));
    });

    // #360 round 6 (Codex round 5 re-review, item 3): rewritten — the OLD
    // `.replace(/\s+/g, ' ').trim()` implementation flattened AND trimmed
    // whitespace, which is exactly what this test used to assert
    // (`'line one line two line three \`backtick\` "quote"'`, no quotes, no
    // raw newlines, but ALSO no leading/trailing evidence). The NEW
    // `JSON.stringify`-based implementation keeps the surrounding quotes and
    // escapes an embedded newline to the two-CHARACTER sequence `\n` (never
    // a raw line break) instead of erasing it — verified against a real
    // `JSON.stringify` call, not assumed.
    it('backticks and embedded newlines in a stored config value: no raw line break, but the escaped evidence survives', () => {
      const hostile = 'line one\nline two\r\nline three\t`backtick` "quote"';
      const result = resolveBriefingLevel(undefined, hostile);
      expect(result.level).toBe('standard');
      expect(result.invalid?.source).toBe('config');
      expect(result.invalid!.value).not.toContain('\n');
      expect(result.invalid!.value).not.toContain('\r');
      // The ESCAPED newline (backslash + n, two characters) is present —
      // this is the "evidence preserved" half of the fix, distinct from
      // "never a raw line break" (checked above).
      expect(result.invalid!.value).toContain('\\n');
      expect(result.invalid!.value).toContain('\\r');
      expect(result.invalid!.value).toContain('`backtick`');
      expect(result.invalid!.value).toBe(JSON.stringify(hostile));
    });

    it('the same bounding applies to an invalid env value, not just config', () => {
      const huge = 'y'.repeat(10_000);
      const result = resolveBriefingLevel(huge, undefined);
      expect(result.invalid?.source).toBe('env');
      // #360 round 8: bound is on the SERIALIZED form now (100 UTF-16
      // units), not input code points — see the dedicated
      // truncation-boundary tests further down for the exact pinned value.
      expect(result.invalid!.value.length).toBeLessThanOrEqual(105);
    });

    // #360 round 6 (Codex round 5 re-review, item 3) — THE regression this
    // whole finding is about: a near-miss string that differs from a valid
    // level only by whitespace used to be reported as if it WERE the valid
    // level, because the old implementation trimmed exactly the evidence
    // that made it invalid.
    it('a whitespace-padded near-miss (" full ") is NOT reported as the bare, valid-looking level "full"', () => {
      const result = resolveBriefingLevel(undefined, ' full ');
      expect(result.level).toBe('standard');
      expect(result.invalid?.source).toBe('config');
      // The old rendering ('full', no quotes, no spaces) is gone; the new
      // one shows exactly what made this invalid — quotes AND the spaces.
      expect(result.invalid!.value).toBe('" full "');
      expect(result.invalid!.value).not.toBe('full');
    });

    // The coordinator's explicit adversarial list for this finding, each
    // checked against the real `JSON.stringify` shape rather than assumed.
    it.each([
      ['FULL (wrong case)', 'FULL', '"FULL"'],
      ['a number', 42, '42'],
      ['a boolean', true, 'true'],
      ['null', null, 'null'],
    ])('%s renders as its real JSON.stringify form, not a flattened/trimmed one', (_label, value, expected) => {
      const result = resolveBriefingLevel(undefined, value);
      expect(result.level).toBe('standard');
      expect(result.invalid?.source).toBe('config');
      expect(result.invalid!.value).toBe(expected);
    });

    // #360 round 10 (Codex round 9 re-review, Z1): round 9 kept small
    // arrays/objects rendering their real JSON form, gated by a count
    // check (`NON_STRING_SIZE_MAX`, >50 elements/keys → summary). Codex
    // found the guard itself still input-proportional two ways a count
    // check cannot cover — `Object.keys()` on a huge-key-count object
    // materializes every key before the count compares, and a SMALL count
    // of HUGE elements passes the guard outright. Fixed by summarising
    // every array/object by TYPE ALONE, unconditionally, before any
    // inspection — no size check, no `Object.keys`, no `JSON.stringify`,
    // no iteration. These tests prove that with a Proxy engineered to
    // throw on every trap, not with a size threshold a differently-shaped
    // adversarial input could dodge.
    describe('containers are summarised by TYPE ALONE — zero traversal, any size', () => {
      function throwingTrapHandler(label: string): ProxyHandler<object> {
        return {
          ownKeys() { throw new Error(`${label}: ownKeys trap fired`); },
          get() { throw new Error(`${label}: get trap fired`); },
          has() { throw new Error(`${label}: has trap fired`); },
          getOwnPropertyDescriptor() { throw new Error(`${label}: getOwnPropertyDescriptor trap fired`); },
        };
      }

      it('a Proxy-wrapped object whose traps all throw: still returns the object summary, no trap fires', () => {
        const proxy = new Proxy({}, throwingTrapHandler('object'));
        const result = resolveBriefingLevel(undefined, proxy);
        expect(result.invalid!.value).toBe('[object]');
      });

      it('a Proxy-wrapped array whose traps all throw: still returns the array summary — Array.isArray does not trigger a trap', () => {
        const proxy = new Proxy([], throwingTrapHandler('array'));
        // Sanity check on the language guarantee this fix relies on, not
        // just this module's behaviour: if Array.isArray ever stopped
        // being trap-safe, this line itself would throw.
        expect(() => Array.isArray(proxy)).not.toThrow();
        expect(Array.isArray(proxy)).toBe(true);
        const result = resolveBriefingLevel(undefined, proxy);
        expect(result.invalid!.value).toBe('[array]');
      });

      it('an object with a throwing toJSON: returns the object summary, toJSON is never called', () => {
        let toJSONCalled = false;
        const value = {
          toJSON() {
            toJSONCalled = true;
            throw new Error('toJSON should never be called');
          },
        };
        const result = resolveBriefingLevel(undefined, value);
        expect(result.invalid!.value).toBe('[object]');
        expect(toJSONCalled).toBe(false);
      });

      it('even a tiny (or empty) array/object now gets the type summary, not its real JSON form', () => {
        // Round 9 kept small-container fidelity ([1,2,3] → "[1,2,3]");
        // round 10 gives that up in exchange for zero traversal at any
        // size — these four used to render their real JSON.stringify form
        // (asserted in the it.each above, before round 9's size-check
        // tests below it, before this round's rewrite).
        expect(resolveBriefingLevel(undefined, [1, 2, 3]).invalid!.value).toBe('[array]');
        expect(resolveBriefingLevel(undefined, { a: 1, b: 2 }).invalid!.value).toBe('[object]');
        expect(resolveBriefingLevel(undefined, []).invalid!.value).toBe('[array]');
        expect(resolveBriefingLevel(undefined, {}).invalid!.value).toBe('[object]');
      });

      // The coordinator's exact adversarial shapes: a small COUNT of huge
      // elements (which passed round 9's >50-count guard outright) and a
      // huge COUNT (whose Object.keys() alone cost round 9 ~15.6 MiB).
      // The assertion is the deterministic return value, not RSS/timing —
      // a real large container returning the summary, immediately.
      it('a 40-element array of 1 MB strings returns the array summary (round 9\'s count guard let this through at 40 < 50)', () => {
        const value = new Array(40).fill('x'.repeat(1024 * 1024));
        expect(resolveBriefingLevel(undefined, value).invalid!.value).toBe('[array]');
      });

      it('a 10-key object with 1 MB values returns the object summary', () => {
        const value: Record<string, string> = {};
        for (let i = 0; i < 10; i++) value[`k${i}`] = 'x'.repeat(1024 * 1024);
        expect(resolveBriefingLevel(undefined, value).invalid!.value).toBe('[object]');
      });

      it('a 1,000,000-key object returns the object summary (Object.keys() on this input alone measured ~15.6 MiB under round 9\'s guard)', () => {
        const value: Record<string, number> = {};
        for (let i = 0; i < 1_000_000; i++) value[`k${i}`] = i;
        expect(resolveBriefingLevel(undefined, value).invalid!.value).toBe('[object]');
      });
    });

    // #360 round 11 (Codex round 10 re-review): round 10 left
    // `bigint`/`symbol`/`function` going through the scalar
    // `JSON.stringify(value) ?? String(value)` path, ending in a raw
    // `.slice(0, 100)` — Codex measured two inputs that come back ending
    // in a lone (unpaired) high surrogate, `\ud83d`, because the slice cut
    // landed inside a surrogate pair: `Symbol('a'.repeat(92) + '😀')` and a
    // `Function` whose source string ends in `😀`. Fixed by summarising
    // all three by TYPE ALONE, same as containers — no `String()`,
    // `JSON.stringify()`, or `.description` access at all, so there is no
    // slice left to bisect anything.
    describe('bigint/symbol/function are summarised by TYPE ALONE — no description/source access, never a split surrogate', () => {
      // `String.prototype.isWellFormed()` (ES2024) is what Codex's own
      // probe used, but this repo's `tsconfig.check.json` `lib` target
      // predates ES2024 — `noLoneSurrogate` (defined below, hoisted within
      // this same describe block since it is a `function` declaration) is
      // the equivalent well-formedness check this file already uses for
      // the exact same reason on the string-truncation tests further down.
      it('Codex\'s Symbol input: a Symbol description ending in an astral emoji no longer splits a surrogate pair', () => {
        const value = Symbol('a'.repeat(92) + '😀');
        const result = resolveBriefingLevel(undefined, value);
        expect(result.invalid!.value).toBe('[symbol]');
        expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
      });

      it('Codex\'s Function input: function source ending in an astral emoji no longer splits a surrogate pair', () => {
        // eslint-disable-next-line no-new-func -- deliberately building a Function whose .toString() is escape/astral-heavy, exactly Codex's adversarial input; never executed.
        const value = Function('/*' + 'a'.repeat(73) + '😀' + '*/');
        const result = resolveBriefingLevel(undefined, value);
        expect(result.invalid!.value).toBe('[function]');
        expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
      });

      it('a 10,000-digit BigInt returns the type summary without ever computing its decimal expansion', () => {
        const value = BigInt('1'.repeat(10_000));
        const result = resolveBriefingLevel(undefined, value);
        expect(result.invalid!.value).toBe('[bigint]');
        expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
      });

      // Only number/boolean/null/undefined are left on the final
      // `JSON.stringify` line — every one of these renders in full, still
      // real JSON.stringify/String output, never a `[type]` summary.
      it.each([
        ['NaN', NaN, 'null'],
        ['Infinity', Infinity, 'null'],
        ['-Infinity', -Infinity, 'null'],
        ['-0', -0, '0'],
        ['1e308', 1e308, '1e+308'],
      ])('%s renders as its real JSON.stringify form, not a type summary', (_label, value, expected) => {
        const result = resolveBriefingLevel(undefined, value);
        expect(result.invalid!.value).toBe(expected);
      });

      // `describeInvalidValue(undefined)` — the scalar-`undefined` case the
      // coordinator asked to cover — is NOT reachable through this file's
      // public surface, by the resolver's own contract, not an oversight:
      // `resolveBriefingLevel` treats `configValue === undefined` (and
      // `envValue === undefined`) as "not set" and returns BEFORE ever
      // calling `describeInvalidValue` (see the "config ABSENT (undefined)
      // is 'not set'" test above, and the resolver's own doc comment: "Only
      // `configValue === undefined` … means 'not set' now"). There is no
      // public call shape that hands a literal `undefined` VALUE to
      // `describeInvalidValue` — an object property that IS `undefined`
      // makes the property's OWN typeof 'undefined', but the containing
      // value is still an object, which the container branch above already
      // intercepts before any property is inspected. Left unverified here
      // rather than faked with a call the production code path can't make.
    });

    // #360 round 7 (Codex round 6 re-review, item 3): the round-6 fix
    // truncated `JSON.stringify`'s OUTPUT at a raw character offset, which
    // could bisect the two-character `\n` escape or a UTF-16 surrogate
    // pair. Fixed (that round) by truncating the VALUE at a Unicode CODE
    // POINT boundary (`Array.from`) before serializing — but bounding the
    // INPUT's code-point count is not the same as bounding the SERIALIZED
    // form: an escape-heavy 120-code-point input still serialized past 700
    // units in a real run (round 8, Codex round 7 re-review, item 1),
    // which is what actually mattered — `session-start.js` embeds this in
    // a reason string `recordHookOutcome` then truncates a SECOND time,
    // and a too-long `describeInvalidValue` output pushed that second,
    // cruder truncation past its own safe boundary. Fixed by bounding the
    // SERIALIZED form directly, to `INVALID_VALUE_SERIALIZED_MAX` (100)
    // UTF-16 units — see the exhaustive comment on `describeInvalidValue`.
    // Every number below is the REAL measured output, not assumed.
    function noLoneSurrogate(s: string): boolean {
      // A lone (unpaired) high or low surrogate anywhere in the string.
      return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
    }

    it('96 "a" characters plus a newline: whole serialized form is exactly 100 units — preserved whole, newline escaped', () => {
      const value = 'a'.repeat(96) + '\n';
      expect(JSON.stringify(value).length).toBe(100); // fixture sanity: exactly at the bound
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value).toBe(JSON.stringify(value));
      expect(result.invalid!.value.endsWith('\\n"')).toBe(true); // properly closed, no dangling backslash
      expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
    });

    it('97 "a" characters plus a newline: whole serialized form is 101 units, ONE over — truncated, newline dropped whole', () => {
      const value = 'a'.repeat(97) + '\n';
      expect(JSON.stringify(value).length).toBe(101); // fixture sanity: exactly one over
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      expect(result.invalid!.value.endsWith('…"')).toBe(true);
      expect(result.invalid!.value).not.toContain('\\n'); // dropped whole, not a dangling escape
      expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
    });

    it('96 "a" characters plus 😀: whole serialized form is exactly 100 units — preserved whole, emoji intact', () => {
      const value = 'a'.repeat(96) + '😀';
      expect(JSON.stringify(value).length).toBe(100); // fixture sanity
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value).toBe(JSON.stringify(value));
      expect(result.invalid!.value).toContain('😀');
      expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
    });

    it('97 "a" characters plus 😀: whole serialized form is 101 units, ONE over — truncated, emoji dropped whole, never bisected', () => {
      const value = 'a'.repeat(97) + '😀';
      expect(JSON.stringify(value).length).toBe(101); // fixture sanity
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      expect(result.invalid!.value.endsWith('…"')).toBe(true);
      expect(result.invalid!.value).not.toContain('😀');
      expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
    });

    it('a string of 200 emoji: truncated so the SERIALIZED form stays <= 100 units, every kept emoji intact', () => {
      const value = '😀'.repeat(200);
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      expect(result.invalid!.value.endsWith('…"')).toBe(true);
      expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
      // Real measured value: 48 emoji kept (each is 2 UTF-16 units, so 48
      // emoji + ellipsis + quotes = 99 units, the most that fits <= 100).
      expect((result.invalid!.value.match(/😀/gu) ?? []).length).toBe(48);
      expect(result.invalid!.value.length).toBe(99);
    });

    it('a 10,000-character string truncates so the SERIALIZED form stays <= 100 units', () => {
      const value = 'x'.repeat(10_000);
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      expect(result.invalid!.value.endsWith('…"')).toBe(true);
      expect(result.invalid!.value).not.toContain('x'.repeat(10_000));
      // Real measured value: 97 'x' + ellipsis + quotes = 100 units exactly.
      expect(result.invalid!.value).toBe(`"${'x'.repeat(97)}…"`);
    });

    // #360 round 8 (Codex round 7 re-review, item 1): the coordinator's
    // real-hook regression list, each checked against `describeInvalidValue`
    // directly (the real hook / recordHookOutcome cross-surface proof is a
    // separate test in tests/hooks/session-start.test.ts, since it needs a
    // real subprocess).
    it('30 lone high surrogates: serialized form stays <= 100 units, JSON.parse of the value succeeds (no dangling escape)', () => {
      const value = '\ud83d'.repeat(30);
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      expect(() => JSON.parse(result.invalid!.value)).not.toThrow();
    });

    it('150 characters of mixed newline/tab/quote/backslash: serialized form stays <= 100 units, JSON.parse succeeds', () => {
      const value = '\n\t"\\'.repeat(38); // 152 raw characters, all escape-worthy
      const result = resolveBriefingLevel(undefined, value);
      expect(result.invalid!.value.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      expect(() => JSON.parse(result.invalid!.value)).not.toThrow();
    });

    // #360 round 8 (Codex round 7 re-review, item 1): the coordinator's
    // exact requirement — "assert that in a test with the longest prefix
    // the hook uses, so the second truncation provably never fires for
    // this diagnostic". `session-start.js`'s reason template is
    // `` `briefing-level: invalid ${source} value "${value}", using
    // ${briefingLevel}` `` (see scripts/hooks/session-start.js) — the
    // longest `source` is `"config"` (6 chars, vs `"env"`'s 3) and the
    // ONLY `briefingLevel` reachable here is `"standard"` (the resolver's
    // default: an invalid value can only ever produce the DEFAULT level,
    // never `"minimal"`/`"full"`, so there is no longer variant to check).
    // This is a symbolic worst-case proof, not just an empirical one —
    // it fails the instant the template, the source names, or the bound
    // change in a way that erodes the margin, even for an input this
    // file's adversarial cases above did not happen to cover.
    it('the whole reason (fixed prefix + <=100-unit value + fixed suffix) stays well under recordHookOutcome\'s 200-unit second truncation', () => {
      const longestSource = 'config'; // vs "env" (3 chars) — the longer of the two
      const onlyReachableLevel = 'standard'; // the DEFAULT — the only level an invalid value can produce here
      // A value that is EXACTLY at the 100-unit serialized bound (the
      // worst case describeInvalidValue can produce) — reuse the same
      // fixture this file already proved hits the bound.
      const worstCaseValue = resolveBriefingLevel(undefined, 'x'.repeat(10_000)).invalid!.value;
      expect(worstCaseValue.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      const reason = `briefing-level: invalid ${longestSource} value "${worstCaseValue}", using ${onlyReachableLevel}`;
      expect(reason.length).toBeLessThan(200);
      // State the margin explicitly, not just the pass/fail: proves this
      // is a real safety margin, not a boundary this test happens to
      // scrape past.
      expect(200 - reason.length).toBeGreaterThanOrEqual(30);
    });

    // #360 round 9 (Codex round 8 re-review): the round-8 fix bounds the
    // OUTPUT (100 serialized units) but does INPUT-proportional work to
    // get there — `Array.from(value)` and (for a short-looking value)
    // `JSON.stringify(value)` both materialize the WHOLE input before the
    // bound is ever applied. Measured against a real 10 MB invalid
    // `briefing` string (built via JSON.parse, the same way the real
    // config reader produces one — see the round-9 report for why a
    // `.repeat()`-built string is not representative): ~91 MB RSS for one
    // `describeInvalidValue` call, before this fix; ~0 MB after.
    //
    // Fixed by pre-slicing the RAW input to `PRE_SLICE_RAW_MAX` (256)
    // UTF-16 units before any per-code-point work — this describe block
    // proves that pre-slice never changes the RESULT for every
    // adversarial case already covered, by comparing against a REFERENCE
    // implementation of the OLD (round-8, whole-string) algorithm kept
    // here ONLY for this comparison (not reachable from production code).
    describe('input-side bounding (round 9) never changes the result vs the OLD whole-string algorithm', () => {
      // The round-8 algorithm, verbatim — Array.from(value) on the WHOLE
      // string, no pre-slice. Kept as a local reference only; if this
      // function and the real `describeInvalidValue` ever disagree for a
      // case below, the round-9 pre-slice bound (256) is not generous
      // enough and MUST be revisited, not the test.
      function describeInvalidValueOldAlgorithm(value: string): string {
        const whole = JSON.stringify(value);
        if (whole.length <= 100) return whole;
        const codePoints = Array.from(value);
        let kept = 0;
        for (; kept < codePoints.length; kept++) {
          const candidate = JSON.stringify(`${codePoints.slice(0, kept + 1).join('')}…`);
          if (candidate.length > 100) break;
        }
        return JSON.stringify(`${codePoints.slice(0, kept).join('')}…`);
      }

      it.each([
        ['10,000 "x" characters', 'x'.repeat(10_000)],
        ['200 emoji', '😀'.repeat(200)],
        ['30 lone high surrogates', '\ud83d'.repeat(30)],
        ['150 characters of mixed newline/tab/quote/backslash', '\n\t"\\'.repeat(38)],
      ])('%s: new (pre-sliced) result === old (whole-string) reference result', (_label, value) => {
        const oldResult = describeInvalidValueOldAlgorithm(value);
        const newResult = resolveBriefingLevel(undefined, value).invalid!.value;
        expect(newResult).toBe(oldResult);
      });

      // The two cases above whose raw length exceeds PRE_SLICE_RAW_MAX
      // (256) are where the pre-slice actually engages — pin that
      // explicitly, so this describe block is not vacuously true for
      // inputs that never reach the new code path at all.
      it('10,000 "x" and 200 emoji genuinely exceed the 256-unit pre-slice threshold (the other two do not — still checked above)', () => {
        expect('x'.repeat(10_000).length).toBeGreaterThan(256);
        expect('😀'.repeat(200).length).toBeGreaterThan(256); // 400 UTF-16 units (2 per emoji)
        expect('\ud83d'.repeat(30).length).toBeLessThanOrEqual(256);
        expect('\n\t"\\'.repeat(38).length).toBeLessThanOrEqual(256);
      });
    });

    // #360 round 9 (Codex round 8 re-review): the RSS probe itself, as a
    // real gate — a child process (own V8 heap, `--expose-gc` for a clean
    // baseline) builds each adversarial value via JSON.parse (NOT
    // `String.prototype.repeat()` — measured that a `.repeat()`-built
    // string forces V8 to flatten its internal lazy representation on the
    // first `.slice()`, costing ~10 MB RSS on its own; a JSON.parse'd
    // string does not have this artifact, and JSON.parse is the ONLY way
    // this module's real callers ever produce `configValue`), then
    // measures RSS immediately before and after the `resolveBriefingLevel`
    // call alone. Before the round-9 fix (measured against a
    // temporarily-reverted copy of `describeInvalidValue`, same
    // JSON.parse-based construction): ~91 MB for the 10 MB string. The
    // string threshold below sits strictly between that OLD cost and the
    // ~0 MB the fix actually measures — proven to discriminate, not just
    // generous, by reverting the fix and confirming the test goes RED.
    //
    // Round 10 (Codex round 9 re-review, Z1): the container-side RSS
    // check this block used to carry (a tight, per-shape threshold on a
    // 1,000,000-element array) was replaced — see the `describe` above
    // this one for why (round 9's count guard was itself
    // input-proportional) and the deterministic Proxy-trap tests for the
    // primary proof. The one RSS check this block keeps for containers is
    // now supplemental only, with a loose threshold.
    describe('RSS probe: describeInvalidValue does not do input-proportional work (real child process)', () => {
      const distModulePath = path.resolve('dist/core/briefing-level.js');

      function measureRssDeltaMb(buildValueSnippet: string): number {
        // `buildValueSnippet` is a JS expression string that evaluates to
        // the value under test — kept as a snippet (not a JSON literal)
        // because building a 10 MB string or a 1,000,000-element array as
        // a literal JSON.parse ARGUMENT in the child process's source is
        // the simplest way to construct it while still round-tripping
        // through JSON.parse, matching the real calling context exactly.
        const script = `
          const { resolveBriefingLevel } = await import(${JSON.stringify(distModulePath)});
          const value = ${buildValueSnippet};
          if (global.gc) global.gc();
          const before = process.memoryUsage().rss;
          resolveBriefingLevel(undefined, value);
          const after = process.memoryUsage().rss;
          console.log(Math.round((after - before) / (1024 * 1024) * 10) / 10);
        `;
        const out = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
          encoding: 'utf8',
          timeout: 30_000,
        });
        return Number(out.trim());
      }

      it('a 10 MB invalid string (built via JSON.parse) costs well under 20 MB RSS for one resolveBriefingLevel call', () => {
        // OLD algorithm measured ~91 MB here — 20 MB is generous relative
        // to the ~0 MB this fix measures, decisive relative to the OLD cost.
        const deltaMb = measureRssDeltaMb(
          "JSON.parse(JSON.stringify('x'.repeat(10 * 1024 * 1024)))",
        );
        expect(deltaMb, `measured delta: ${deltaMb} MB`).toBeLessThan(20);
      });

      // #360 round 10 (Codex round 9 re-review, Z1): round 9's per-shape
      // array threshold (4 MB) was flagged platform-sensitive. The
      // deterministic proof for containers is now the Proxy-trap and
      // large-container tests above (zero traversal, any size, any
      // shape) — this RSS check is supplemental only, with a loose
      // threshold: Codex's own measurement of `Object.keys()` ALONE on a
      // 1,000,000-key object under round 9's guard was ~15.6 MiB, so 10
      // MB here still discriminates a regression back to full traversal
      // without pinning a tight, platform-sensitive number.
      it('a 1,000,000-key invalid object (built via JSON.parse) costs well under 10 MB RSS for one resolveBriefingLevel call (supplemental)', () => {
        const deltaMb = measureRssDeltaMb(
          "JSON.parse(JSON.stringify(Object.fromEntries(Array.from({ length: 1_000_000 }, (_, i) => [`k${i}`, i]))))",
        );
        expect(deltaMb, `measured delta: ${deltaMb} MB`).toBeLessThan(10);
      });
    });
  });

  describe('briefingLevelPolicy', () => {
    it('minimal: no global, no foreign, no task state, no index, no work-package notice', () => {
      expect(briefingLevelPolicy('minimal')).toEqual({
        global: false, foreign: false, taskState: false, index: false, workPackageNotice: false,
      });
    });
    it('standard: task state + index, still no global/foreign/notice', () => {
      expect(briefingLevelPolicy('standard')).toEqual({
        global: false, foreign: false, taskState: true, index: true, workPackageNotice: false,
      });
    });
    it('full: everything', () => {
      expect(briefingLevelPolicy('full')).toEqual({
        global: true, foreign: true, taskState: true, index: true, workPackageNotice: true,
      });
    });
  });
});
