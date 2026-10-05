import { sliceWholeChars } from './work-topology.js';

/**
 * `metadata.replaced_history`: the previous versions a memory keeps when it
 * is replaced, by `remember` replace or by an `import` overwrite (#530).
 * One module so both writers share one shape and one bound, and neither
 * imports the other.
 */

export interface ReplacedVersion {
  replaced_at: string;
  title: string | null;
  observations: string[];
  tags: string[];
  /** Set when the version alone exceeded the byte cap and lost observations or tags. */
  truncated?: boolean;
}

/** Most previous versions a replaced memory keeps in `metadata.replaced_history`. */
export const REPLACED_HISTORY_MAX = 20;
/**
 * Most bytes (serialized JSON) the history may take. The count alone did not
 * bound it: a 256 KB note replaced twenty times is megabytes of metadata on
 * one row. Oldest versions go first; a single version larger than the cap
 * keeps as many of its observations, then its tags, as fit, has its title cut
 * when even that does not fit, and is marked `truncated`.
 */
export const REPLACED_HISTORY_MAX_BYTES = 64 * 1024;

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** Apply both history bounds. */
export function boundReplacedHistory(history: ReplacedVersion[]): ReplacedVersion[] {
  let out = history.slice(-REPLACED_HISTORY_MAX);
  while (out.length > 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES) out = out.slice(1);
  if (out.length === 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES) {
    const only = out[0];
    // Observations first, then tags, each in order, as many as fit. A title is
    // input-capped, but redaction can lengthen it (`***REDACTED***` is longer
    // than what it replaces, #523), so it is cut, never through half of an
    // emoji, until the rest fits. A version therefore always fits.
    const fits = (v: ReplacedVersion) => jsonBytes([v]) <= REPLACED_HISTORY_MAX_BYTES;
    let kept: ReplacedVersion = { ...only, observations: [], tags: [], truncated: true };
    while (kept.title && !fits(kept)) kept = { ...kept, title: sliceWholeChars(kept.title, Math.floor(kept.title.length * 0.9)) };
    for (const obs of only.observations) {
      const next = { ...kept, observations: [...kept.observations, obs] };
      if (!fits(next)) break;
      kept = next;
    }
    for (const tag of only.tags) {
      const next = { ...kept, tags: [...kept.tags, tag] };
      if (!fits(next)) break;
      kept = next;
    }
    out = [kept];
  }
  return out;
}
