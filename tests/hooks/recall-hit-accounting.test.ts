/** Marker grammar only; native role/window accounting is tested by real hooks. */
import { describe, it, expect } from 'vitest';
import { extractCitedMemoryIds } from '../../src/core/work-topology.js';

describe('Feature: citation marker extraction', () => {
  it('credits exactly the memory the agent explicitly cited', () => {
    const cited = extractCitedMemoryIds('per [mem:301] we keep pkce in the cli flow');
    expect([...cited]).toEqual([301]);
  });

  it('an uncited injected memory earns nothing — and loses nothing (misses frozen)', () => {
    // Preserve the read side of the existing contract: silence supplies no id.
    const cited = extractCitedMemoryIds('per [mem:301] we keep pkce in the cli flow');
    expect(cited.has(302)).toBe(false);
  });

  it('the instruction line itself can never score a hit', () => {
    // The placeholder in the instruction is not a numeric memory handle.
    const cited = extractCitedMemoryIds('cite it once inline as [mem:ID], got it');
    expect(cited.size).toBe(0);
  });
});
