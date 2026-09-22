/**
 * #360 — the ONE policy table that decides what `minimal` / `standard` /
 * `full` include, and the ONE precedence rule (env > config > default) both
 * the SessionStart hook and the `briefing` tool/CLI resolve through.
 */
import { describe, it, expect } from 'vitest';
import {
  BRIEFING_LEVELS,
  DEFAULT_BRIEFING_LEVEL,
  isBriefingLevel,
  resolveBriefingLevel,
  briefingLevelPolicy,
} from '../../src/core/briefing-level.js';

describe('briefing-level', () => {
  it('the three levels, in order, with minimal as the default', () => {
    expect(BRIEFING_LEVELS).toEqual(['minimal', 'standard', 'full']);
    expect(DEFAULT_BRIEFING_LEVEL).toBe('minimal');
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

  describe('resolveBriefingLevel — env > config > default(minimal)', () => {
    it('defaults to minimal when neither env nor config sets it', () => {
      expect(resolveBriefingLevel(undefined, undefined)).toEqual({ level: 'minimal', invalid: null });
    });

    // The explicit values below are the two levels that are NOT the default: a
    // resolver that ignored its inputs would answer `minimal` for every call,
    // so an explicit `minimal` could not tell "took effect" from "ignored".
    it('a valid config value takes effect with no env set', () => {
      expect(resolveBriefingLevel(undefined, 'standard')).toEqual({ level: 'standard', invalid: null });
      expect(resolveBriefingLevel(undefined, 'full')).toEqual({ level: 'full', invalid: null });
    });

    it('an explicit minimal is a valid value, not an invalid one that happens to give the default', () => {
      expect(resolveBriefingLevel('minimal', undefined)).toEqual({ level: 'minimal', invalid: null });
      expect(resolveBriefingLevel(undefined, 'minimal')).toEqual({ level: 'minimal', invalid: null });
    });

    it('a valid env value wins over a valid config value', () => {
      expect(resolveBriefingLevel('standard', 'full')).toEqual({ level: 'standard', invalid: null });
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
      // `value` is the real `JSON.stringify('banana')` form (quoted), not a
      // flattened `'banana'` — see the dedicated whitespace-evidence tests
      // further down for why that distinction matters.
      expect(resolveBriefingLevel('banana', 'full')).toEqual({
        level: 'minimal',
        invalid: { source: 'env', value: '"banana"' },
      });
    });

    it('an invalid config value (no env set) yields the default AND names config as the source', () => {
      expect(resolveBriefingLevel(undefined, 'banana')).toEqual({
        level: 'minimal',
        invalid: { source: 'config', value: '"banana"' },
      });
    });

    it('a non-string config value (e.g. a stray number) is also reported invalid, not silently ignored', () => {
      expect(resolveBriefingLevel(undefined, 42)).toEqual({
        level: 'minimal',
        invalid: { source: 'config', value: '42' },
      });
    });

    it('config ABSENT (undefined) is "not set" — no false invalid report', () => {
      expect(resolveBriefingLevel(undefined, undefined)).toEqual({ level: 'minimal', invalid: null });
    });

    // A stored `null` is not "not set": `memesh config unset briefing`
    // DELETES the key (`updateConfig({ briefing: undefined })`), it never
    // writes `null`, and nothing else in this codebase writes `null` here
    // either. A stored `null` can therefore only be a hand edit or a foreign
    // version's value — exactly the same "unexpected value" case as `42`, not
    // a legitimate absence. It gets the SAME invalid treatment.
    it('an explicit stored null is INVALID, not "not set" — same bounded reason as any other bad value', () => {
      expect(resolveBriefingLevel(undefined, null)).toEqual({
        level: 'minimal',
        invalid: { source: 'config', value: 'null' },
      });
    });

    // `invalid.value` is untrusted — it lands in a single-line stderr trace
    // AND a JSONL outcome-record `reason` field. Neither channel survives an
    // embedded newline (a raw one fragments the log line / the JSONL record
    // into more than one line) or an unbounded length (a config file is not
    // size-limited). `describeInvalidValue` (private to this module) is what
    // bounds it — exercised here only through the public return value.
    it('a huge stored config value is truncated, not passed through whole (would otherwise blow up the trace)', () => {
      const huge = 'x'.repeat(10_000);
      const result = resolveBriefingLevel(undefined, huge);
      expect(result.level).toBe('minimal');
      expect(result.invalid?.source).toBe('config');
      // Capped well under the hook outcome channel's own 200-char
      // truncation (see briefing-level.ts's `INVALID_VALUE_SERIALIZED_MAX`
      // comment) — this pins the actual number so a future change to the
      // cap is a deliberate edit here, not a silent regression.
      //
      // The ellipsis is part of the STRING VALUE, so the serialized form
      // ends with `…"` (the closing quote), not a bare `…`; see the
      // dedicated truncation-boundary tests below.
      //
      // The bound is "100 SERIALIZED UTF-16 units", not a count of INPUT code
      // points — the two differ for escape-heavy input (see the comment on
      // `describeInvalidValue`). 100 units + quotes cannot exceed ~102 for
      // plain ASCII; the loose bound below is deliberately generous (the
      // exact boundary is pinned by the 96-vs-97 pair tests further down,
      // which is where "wrong by exactly one" would show).
      expect(result.invalid!.value.length).toBeLessThanOrEqual(105);
      expect(result.invalid!.value.endsWith('…"')).toBe(true);
      expect(result.invalid!.value).not.toContain('x'.repeat(10_000));
    });

    // The value is the `JSON.stringify` form: it keeps the surrounding quotes
    // and escapes an embedded newline to the two-CHARACTER sequence `\n`
    // (never a raw line break) instead of flattening or erasing it — so the
    // rendering has no raw newlines AND keeps the leading/trailing evidence.
    it('backticks and embedded newlines in a stored config value: no raw line break, but the escaped evidence survives', () => {
      const hostile = 'line one\nline two\r\nline three\t`backtick` "quote"';
      const result = resolveBriefingLevel(undefined, hostile);
      expect(result.level).toBe('minimal');
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
      // The bound is on the SERIALIZED form (100 UTF-16 units), not input
      // code points — see the dedicated truncation-boundary tests further
      // down for the exact pinned value.
      expect(result.invalid!.value.length).toBeLessThanOrEqual(105);
    });

    // A near-miss string that differs from a valid level only by whitespace
    // must not be reported as if it WERE the valid level: trimming would
    // erase exactly the evidence that made it invalid.
    it('a whitespace-padded near-miss (" full ") is NOT reported as the bare, valid-looking level "full"', () => {
      const result = resolveBriefingLevel(undefined, ' full ');
      expect(result.level).toBe('minimal');
      expect(result.invalid?.source).toBe('config');
      // The rendering shows exactly what made this invalid — quotes AND the
      // spaces — not a bare, valid-looking 'full'.
      expect(result.invalid!.value).toBe('" full "');
      expect(result.invalid!.value).not.toBe('full');
    });

    // Adversarial near-miss values, each checked against the real
    // `JSON.stringify` shape rather than assumed.
    it.each([
      ['FULL (wrong case)', 'FULL', '"FULL"'],
      ['a number', 42, '42'],
      ['a boolean', true, 'true'],
      ['null', null, 'null'],
    ])('%s renders as its real JSON.stringify form, not a flattened/trimmed one', (_label, value, expected) => {
      const result = resolveBriefingLevel(undefined, value);
      expect(result.level).toBe('minimal');
      expect(result.invalid?.source).toBe('config');
      expect(result.invalid!.value).toBe(expected);
    });

    // Every array/object is summarised by TYPE ALONE, unconditionally, before
    // any inspection — no size check, no `Object.keys`, no `JSON.stringify`,
    // no iteration. A count threshold would still be input-proportional:
    // `Object.keys()` on a huge-key-count object materializes every key before
    // the count compares, and a SMALL count of HUGE elements passes a count
    // guard outright. These tests prove zero traversal with a Proxy
    // engineered to throw on every trap, not with a size threshold a
    // differently-shaped adversarial input could dodge.
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
        // Small-container fidelity ([1,2,3] → "[1,2,3]") is deliberately
        // given up in exchange for zero traversal at any size.
        expect(resolveBriefingLevel(undefined, [1, 2, 3]).invalid!.value).toBe('[array]');
        expect(resolveBriefingLevel(undefined, { a: 1, b: 2 }).invalid!.value).toBe('[object]');
        expect(resolveBriefingLevel(undefined, []).invalid!.value).toBe('[array]');
        expect(resolveBriefingLevel(undefined, {}).invalid!.value).toBe('[object]');
      });

      // The adversarial shapes: a small COUNT of huge elements (which a
      // count guard would pass outright) and a huge COUNT (whose
      // Object.keys() alone costs ~15.6 MiB). The assertion is the
      // deterministic return value, not RSS/timing — a real large container
      // returning the summary, immediately.
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

    // `bigint`/`symbol`/`function` are summarised by TYPE ALONE, same as
    // containers — no `String()`, `JSON.stringify()`, or `.description`
    // access at all, so there is no slice left to bisect anything. A raw
    // `.slice(0, 100)` on `Symbol('a'.repeat(92) + '😀')` or on a `Function`
    // whose source string ends in `😀` would come back ending in a lone
    // (unpaired) high surrogate, `\ud83d`, because the cut lands inside a
    // surrogate pair.
    describe('bigint/symbol/function are summarised by TYPE ALONE — no description/source access, never a split surrogate', () => {
      // `String.prototype.isWellFormed()` (ES2024) would be the natural
      // check, but this repo's `tsconfig.check.json` `lib` target predates
      // ES2024 — `noLoneSurrogate` (defined below, hoisted within this same
      // describe block since it is a `function` declaration) is the
      // equivalent well-formedness check this file also uses on the
      // string-truncation tests further down.
      it('Codex\'s Symbol input: a Symbol description ending in an astral emoji no longer splits a surrogate pair', () => {
        const value = Symbol('a'.repeat(92) + '😀');
        const result = resolveBriefingLevel(undefined, value);
        expect(result.invalid!.value).toBe('[symbol]');
        expect(noLoneSurrogate(result.invalid!.value)).toBe(true);
      });

      it('Codex\'s Function input: function source ending in an astral emoji no longer splits a surrogate pair', () => {
        // eslint-disable-next-line no-new-func -- deliberately building a Function whose .toString() is escape/astral-heavy, an adversarial input; never executed.
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

      // `describeInvalidValue(undefined)` — the scalar-`undefined` case — is
      // NOT reachable through this file's public surface, by the resolver's
      // own contract, not an oversight:
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

    // The SERIALIZED form is bounded directly, to `INVALID_VALUE_SERIALIZED_MAX`
    // (100) UTF-16 units — see the comment on `describeInvalidValue`.
    // Truncating at a raw character offset could bisect the two-character
    // `\n` escape or a UTF-16 surrogate pair, and bounding the INPUT's
    // code-point count is not the same as bounding the SERIALIZED form (an
    // escape-heavy 120-code-point input serializes past 700 units).
    // `session-start.js` embeds this in a reason string that
    // `recordHookOutcome` truncates a SECOND time, so an over-long
    // `describeInvalidValue` output would push that cruder truncation past
    // its own safe boundary. Every number below is the REAL measured output,
    // not assumed.
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

    // Real-hook regression inputs, each checked against `describeInvalidValue`
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

    // The second truncation (`recordHookOutcome`'s 200 units) provably never
    // fires for this diagnostic, checked with the longest prefix the hook
    // uses. `session-start.js`'s reason template is
    // `` `briefing-level: invalid ${source} value ${value}, using
    // ${briefingLevel}` `` (see scripts/hooks/session-start.js; `value` is
    // already quoted) — the longest `source` is `"config"` (6 chars, vs
    // `"env"`'s 3) and the ONLY `briefingLevel` reachable here is the one the
    // resolver returns for an invalid value: the DEFAULT level (an invalid
    // value can only ever produce the default, never one of the others, so
    // there is no longer variant to check). It is read from the resolver
    // below rather than written out, so this margin is measured against the
    // level the hook really names and cannot go stale when the default moves.
    // This is a symbolic worst-case proof, not just an empirical one —
    // it fails the instant the template, the source names, or the bound
    // change in a way that erodes the margin, even for an input this
    // file's adversarial cases above did not happen to cover.
    it('the whole reason (fixed prefix + <=100-unit value + fixed suffix) stays well under recordHookOutcome\'s 200-unit second truncation', () => {
      const longestSource = 'config'; // vs "env" (3 chars) — the longer of the two
      // A value that is EXACTLY at the 100-unit serialized bound (the
      // worst case describeInvalidValue can produce) — reuse the same
      // fixture this file already proved hits the bound.
      const worstCase = resolveBriefingLevel(undefined, 'x'.repeat(10_000));
      const worstCaseValue = worstCase.invalid!.value;
      const onlyReachableLevel = worstCase.level; // the DEFAULT — the only level an invalid value can produce here
      expect(onlyReachableLevel).toBe(DEFAULT_BRIEFING_LEVEL);
      expect(worstCaseValue.length).toBeLessThanOrEqual(INVALID_VALUE_SERIALIZED_MAX_FOR_TESTS);
      const reason = `briefing-level: invalid ${longestSource} value ${worstCaseValue}, using ${onlyReachableLevel}`;
      expect(reason.length).toBeLessThan(200);
      // State the margin explicitly, not just the pass/fail: proves this
      // is a real safety margin, not a boundary this test happens to
      // scrape past.
      expect(200 - reason.length).toBeGreaterThanOrEqual(30);
    });

    // Bounding the OUTPUT (100 serialized units) is not enough:
    // `Array.from(value)` and (for a short-looking value)
    // `JSON.stringify(value)` would materialize the WHOLE input before the
    // bound is applied. Measured
    // against a real 10 MB invalid `briefing` string (built via JSON.parse,
    // the same way the real config reader produces one; a `.repeat()`-built
    // string is not representative): ~91 MB RSS for one `describeInvalidValue`
    // call without the pre-slice, ~0 MB with it. That number is a one-off
    // measurement, not asserted here: the last test of this block guards the
    // mechanism instead (how much of the string the per-code-point work is
    // allowed to see).
    //
    // The RAW input is pre-sliced to `PRE_SLICE_RAW_MAX` (256) UTF-16 units
    // before any per-code-point work — this describe block proves that
    // pre-slice never changes the RESULT for every adversarial case already
    // covered, by comparing against a REFERENCE implementation of the
    // whole-string algorithm kept here ONLY for this comparison (not
    // reachable from production code).
    describe('input-side bounding (round 9) never changes the result vs the OLD whole-string algorithm', () => {
      // The whole-string algorithm, verbatim — Array.from(value) on the WHOLE
      // string, no pre-slice. Kept as a local reference only; if this
      // function and the real `describeInvalidValue` ever disagree for a
      // case below, the pre-slice bound (256) is not generous enough and
      // MUST be revisited, not the test.
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

      // A regression that removes PRE_SLICE_RAW_MAX changes no RESULT (the
      // tests above compare results), only the work: the whole string gets
      // materialised first. Watch the one call that does per-code-point
      // work and require it never sees more than the bounded prefix.
      it('the raw pre-slice is in force — Array.from never sees more than 256 units of an invalid string', () => {
        const realArrayFrom = Array.from;
        let maxSeen = 0;
        (Array as unknown as { from: unknown }).from = function (arg: unknown, ...rest: unknown[]) {
          if (typeof arg === 'string') maxSeen = Math.max(maxSeen, arg.length);
          return (realArrayFrom as (...a: unknown[]) => unknown[])(arg, ...rest);
        };
        try {
          resolveBriefingLevel(undefined, 'x'.repeat(10 * 1024 * 1024));
        } finally {
          (Array as unknown as { from: unknown }).from = realArrayFrom;
        }
        expect(maxSeen, 'the string branch never ran').toBeGreaterThan(0);
        expect(maxSeen, 'Array.from saw an unbounded input').toBeLessThanOrEqual(256);
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
