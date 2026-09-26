// =============================================================================
// session-limit — the SessionStart hook's top-N memory-injection limit (#431)
// =============================================================================
//
// The one policy for `sessionLimit`: the documented range, and what happens
// to a value outside it. `config set` and `POST /v1/config` enforce the
// range on write; a read (`GET /v1/config`, the SessionStart hook) does not
// re-check it — it resolves what to actually USE, and reports when that
// differs from what was given, the same split `briefing-level.ts` uses for
// `briefing`.
//
// A runtime leaf with NO imports (same constraint as briefing-level.ts,
// paths.ts): scripts/generate-hook-core.mjs copies it verbatim next to the
// hooks, because a hook cannot import this file directly — `core/config.ts`,
// which owns the stored `sessionLimit` field, is not itself a zero-import
// leaf (it touches `fs`/`paths.ts`), so neither it nor anything importing it
// can be copied. This module holds only the parts that ARE leaf-safe.

export const SESSION_LIMIT_MIN = 1;
export const SESSION_LIMIT_MAX = 100;
export const SESSION_LIMIT_DEFAULT = 10;

/** A whole number inside the documented range. */
export function isSessionLimitInRange(n: number): boolean {
  return Number.isInteger(n) && n >= SESSION_LIMIT_MIN && n <= SESSION_LIMIT_MAX;
}

export type SessionLimitSource = 'env' | 'config';

export interface SessionLimitAdjustment {
  source: SessionLimitSource;
  /** Ready to interpolate into a one-line log/record message as-is: a
   *  config number's own decimal form (unquoted), or the env string
   *  JSON.stringify'd (quoted, so an unusual value still reads as one token
   *  and cannot break a log line with an embedded newline). */
  raw: string;
  /** The value ready for a user-facing message with no wrapping: a parsed
   *  number's own decimal form when the source parsed as some number (even
   *  out of range or non-integer), or the string exactly as given when it
   *  did not parse as a number at all. Never quoted. Same as `raw` for a
   *  config source, since that one is never quoted either. */
  displayValue: string;
  /** 'above max N' | 'below min N' | 'not a whole number'. */
  cause: string;
  /** Short form of `cause` for a compact message: 'above N' | 'below N' |
   *  'not a whole number'. */
  shortCause: string;
}

export interface SessionLimitResolution {
  value: number;
  /** Which source's own number IS `value` — 'default' when nothing usable
   *  was found anywhere (not merely when `value` happens to equal the
   *  default: an explicit, valid, in-range 10 is source 'config', not
   *  'default'). */
  effectiveSource: SessionLimitSource | 'default';
  /** Every source consulted whose own value was NOT used as given, in the
   *  order checked (env, then config). Empty when nothing was adjusted. */
  adjustments: SessionLimitAdjustment[];
}

type Classification = 'valid' | 'above' | 'below' | 'invalid';

function classify(n: number): Classification {
  if (!Number.isInteger(n)) return 'invalid';
  if (isSessionLimitInRange(n)) return 'valid';
  return n > SESSION_LIMIT_MAX ? 'above' : 'below';
}

function causeText(kind: 'above' | 'below' | 'invalid'): string {
  if (kind === 'above') return `above max ${SESSION_LIMIT_MAX}`;
  if (kind === 'below') return `below min ${SESSION_LIMIT_MIN}`;
  return 'not a whole number';
}

function shortCauseText(kind: 'above' | 'below' | 'invalid'): string {
  if (kind === 'above') return `above ${SESSION_LIMIT_MAX}`;
  if (kind === 'below') return `below ${SESSION_LIMIT_MIN}`;
  return 'not a whole number';
}

/** The env string's own decimal form when it parsed as some number (even
 *  out of range or non-integer), or the string exactly as given when it
 *  did not parse as a number at all — never quoted. */
function envDisplayValue(envRaw: string, parsed: number): string {
  return Number.isNaN(parsed) ? envRaw : String(parsed);
}

/**
 * Env > config > default. A number above the max clamps to it — a value
 * above range means "more", not "unset". Below the min, or not a whole
 * number, the source is unusable: env falls through to config, config falls
 * back to the default. Every source whose own value was not used as given
 * is reported in `adjustments`, so a caller can tell the user instead of
 * silently clamping or falling back.
 */
export function resolveSessionLimit(envRaw: string | undefined, configValue: unknown): SessionLimitResolution {
  const adjustments: SessionLimitAdjustment[] = [];
  if (envRaw !== undefined) {
    const n = Number(envRaw);
    const kind = classify(n);
    if (kind === 'valid') return { value: n, effectiveSource: 'env', adjustments: [] };
    adjustments.push({
      source: 'env',
      raw: JSON.stringify(envRaw),
      displayValue: envDisplayValue(envRaw, n),
      cause: causeText(kind),
      shortCause: shortCauseText(kind),
    });
    if (kind === 'above') return { value: SESSION_LIMIT_MAX, effectiveSource: 'env', adjustments };
  }
  if (typeof configValue === 'number') {
    const kind = classify(configValue);
    if (kind === 'valid') return { value: configValue, effectiveSource: 'config', adjustments };
    adjustments.push({
      source: 'config',
      raw: String(configValue),
      displayValue: String(configValue),
      cause: causeText(kind),
      shortCause: shortCauseText(kind),
    });
    if (kind === 'above') return { value: SESSION_LIMIT_MAX, effectiveSource: 'config', adjustments };
  }
  return { value: SESSION_LIMIT_DEFAULT, effectiveSource: 'default', adjustments };
}
