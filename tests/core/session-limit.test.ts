/**
 * #431 — the ONE policy for `sessionLimit`: the documented range, and what
 * happens to a value outside it. Both the SessionStart hook and the CLI's
 * `describeEffectiveSessionLimit` resolve through `resolveSessionLimit`
 * here; `tests/hooks/mirror-parity.test.ts` pins the hook's generated copy
 * to this source.
 */
import { describe, it, expect } from 'vitest';
import {
  SESSION_LIMIT_MIN,
  SESSION_LIMIT_MAX,
  SESSION_LIMIT_DEFAULT,
  isSessionLimitInRange,
  resolveSessionLimit,
} from '../../src/core/session-limit.js';

describe('session-limit', () => {
  it('the documented range and default', () => {
    expect(SESSION_LIMIT_MIN).toBe(1);
    expect(SESSION_LIMIT_MAX).toBe(100);
    expect(SESSION_LIMIT_DEFAULT).toBe(10);
  });

  describe('isSessionLimitInRange', () => {
    it('accepts whole numbers inside the range, including both boundaries', () => {
      expect(isSessionLimitInRange(1)).toBe(true);
      expect(isSessionLimitInRange(100)).toBe(true);
      expect(isSessionLimitInRange(50)).toBe(true);
    });
    it('rejects below the min, above the max, and non-integers', () => {
      expect(isSessionLimitInRange(0)).toBe(false);
      expect(isSessionLimitInRange(101)).toBe(false);
      expect(isSessionLimitInRange(-5)).toBe(false);
      // A stored non-integer such as 2.5 is never "in range", even
      // though it falls numerically between 1 and 100.
      expect(isSessionLimitInRange(2.5)).toBe(false);
      expect(isSessionLimitInRange(NaN)).toBe(false);
    });
  });

  describe('resolveSessionLimit(envRaw, configValue) — env > config > default(10)', () => {
    it('defaults to 10 when neither env nor config sets it', () => {
      expect(resolveSessionLimit(undefined, undefined)).toEqual({ value: 10, effectiveSource: 'default', adjustments: [] });
    });

    it('a valid config value takes effect, unadjusted', () => {
      expect(resolveSessionLimit(undefined, 25)).toEqual({ value: 25, effectiveSource: 'config', adjustments: [] });
    });

    it('a valid env value takes effect and wins over a valid config value — config is never consulted', () => {
      expect(resolveSessionLimit('50', 500)).toEqual({ value: 50, effectiveSource: 'env', adjustments: [] });
    });

    // Parsed the way the CLI does: Number(v) + Number.isInteger, not parseInt.
    it('"1e3" means 1000 (Number, not parseInt), which is then clamped to the max', () => {
      expect(resolveSessionLimit('1e3', undefined)).toEqual({
        value: 100,
        effectiveSource: 'env',
        adjustments: [{ source: 'env', raw: '"1e3"', displayValue: '1000', cause: 'above max 100', shortCause: 'above 100' }],
      });
    });

    it('"150abc" is invalid (Number.isInteger(NaN) is false) and falls through to config', () => {
      expect(resolveSessionLimit('150abc', 25)).toEqual({
        value: 25,
        effectiveSource: 'config',
        adjustments: [{ source: 'env', raw: '"150abc"', displayValue: '150abc', cause: 'not a whole number', shortCause: 'not a whole number' }],
      });
    });

    it('"50.9" is invalid (not a whole number) and falls through to config', () => {
      expect(resolveSessionLimit('50.9', 25)).toEqual({
        value: 25,
        effectiveSource: 'config',
        adjustments: [{ source: 'env', raw: '"50.9"', displayValue: '50.9', cause: 'not a whole number', shortCause: 'not a whole number' }],
      });
    });

    it('an env value above the max clamps to the max and does not consult config at all, even when config is also out of range', () => {
      expect(resolveSessionLimit('500', 500)).toEqual({
        value: 100,
        effectiveSource: 'env',
        adjustments: [{ source: 'env', raw: '"500"', displayValue: '500', cause: 'above max 100', shortCause: 'above 100' }],
      });
    });

    it('"0" (below the min) falls through to config', () => {
      expect(resolveSessionLimit('0', 25)).toEqual({
        value: 25,
        effectiveSource: 'config',
        adjustments: [{ source: 'env', raw: '"0"', displayValue: '0', cause: 'below min 1', shortCause: 'below 1' }],
      });
    });

    it('a config value above the max clamps to the max', () => {
      expect(resolveSessionLimit(undefined, 500)).toEqual({
        value: 100,
        effectiveSource: 'config',
        adjustments: [{ source: 'config', raw: '500', displayValue: '500', cause: 'above max 100', shortCause: 'above 100' }],
      });
    });

    it('a config value below the min falls back to the default, not to the stored number', () => {
      expect(resolveSessionLimit(undefined, 0)).toEqual({
        value: 10,
        effectiveSource: 'default',
        adjustments: [{ source: 'config', raw: '0', displayValue: '0', cause: 'below min 1', shortCause: 'below 1' }],
      });
    });

    // A stored non-integer is invalid, the same as a non-numeric one.
    it('a non-integer config value (2.5) falls back to the default, not clamped or truncated', () => {
      expect(resolveSessionLimit(undefined, 2.5)).toEqual({
        value: 10,
        effectiveSource: 'default',
        adjustments: [{ source: 'config', raw: '2.5', displayValue: '2.5', cause: 'not a whole number', shortCause: 'not a whole number' }],
      });
    });

    it('config=100 (the exact upper bound) is valid, not "above"', () => {
      expect(resolveSessionLimit(undefined, 100)).toEqual({ value: 100, effectiveSource: 'config', adjustments: [] });
    });

    it('config=1 (the exact lower bound) is valid, not "below"', () => {
      expect(resolveSessionLimit(undefined, 1)).toEqual({ value: 1, effectiveSource: 'config', adjustments: [] });
    });

    it('an invalid env AND an above-max config both get reported, and the config clamp decides the value', () => {
      expect(resolveSessionLimit('abc', 500)).toEqual({
        value: 100,
        effectiveSource: 'config',
        adjustments: [
          { source: 'env', raw: '"abc"', displayValue: 'abc', cause: 'not a whole number', shortCause: 'not a whole number' },
          { source: 'config', raw: '500', displayValue: '500', cause: 'above max 100', shortCause: 'above 100' },
        ],
      });
    });

    it('a non-number stored config value (e.g. a string) is treated as absent — falls back to the default', () => {
      expect(resolveSessionLimit(undefined, '50')).toEqual({ value: 10, effectiveSource: 'default', adjustments: [] });
    });
  });
});
