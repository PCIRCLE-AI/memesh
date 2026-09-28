// =============================================================================
// Shared #494 recall-size-cap fixture
// =============================================================================
//
// A real graph (~3,300 memories) returned a single entity at 61.9 KB (157
// observations, 71 tags) from one recall. The fixture adds `file:*` tags to
// that shape, the kind auto-captured session memories carry, so one entity
// exercises both the size cap and the file: omission. Three test files use
// it
// (tests/tools.test.ts, tests/cli/recall-size-caps.test.ts,
// tests/transports/http.test.ts) — factored out once so the fixture cannot
// drift between them.

import type { KnowledgeGraph } from '../../src/knowledge-graph.js';

/** Deterministic, index-distinguishable filler so nothing dedupes and every
 *  truncation boundary is easy to reason about. */
export function filler(label: string, bytes: number): string {
  const unit = `${label}-filler-`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/**
 * Seeds one entity shaped like the real graph that motivated #494: 157
 * observations of ~400 bytes each (~62.8 KB raw) plus 71 `file:*` tags and
 * `projectTag`. Returns the observations array so callers can assert against
 * the exact kept content (e.g. that the first one survives the cap).
 */
export function seedOversizedEntity(kg: KnowledgeGraph, name: string, projectTag: string): string[] {
  const observations = Array.from({ length: 157 }, (_, i) => filler(`obs${i}`, 400));
  const fileTags = Array.from({ length: 71 }, (_, i) => `file:module-${i}.ts`);
  kg.createEntity(name, 'session-insight', {
    observations,
    tags: [...fileTags, projectTag],
  });
  return observations;
}
