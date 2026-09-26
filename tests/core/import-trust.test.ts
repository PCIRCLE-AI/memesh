// #407 — `importMemories`'s second argument, `{ trust: true }`. Never a field
// of `ImportInput`/`ImportSchema` (see tests/transports/schemas.test.ts and
// the MCP/HTTP boundary tests for that half); this file is the core-level
// behaviour once a caller (only the CLI) opts in.
import { describe, it, expect } from 'vitest';
import { remember, forget, importMemories } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { isAutoInjectable } from '../../src/core/work-topology.js';
import type { ExportResult } from '../../src/core/types.js';

useTestDatabase('memesh-import-trust-');

type BundleEntity = ExportResult['entities'][number];

function bundleOf(entities: BundleEntity[]): ExportResult {
  return {
    version: '3.1.0',
    exported_at: '2026-09-26T00:00:00.000Z',
    entity_count: entities.length,
    entities,
  };
}
function entityOf(overrides: Partial<BundleEntity> & { name: string }): BundleEntity {
  return { type: 'note', namespace: 'personal', observations: [], tags: [], relations: [], ...overrides };
}
function metadataOf(name: string): Record<string, unknown> {
  return new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata as Record<string, unknown>;
}

describe('importMemories({...}, { trust: true }) — create and overwrite', () => {
  it('overwriting an existing entity stamps trusted / trusted-import and keeps the bookkeeping fields', () => {
    remember({ name: 'alpha', type: 'note', observations: ['old'] });
    const data = bundleOf([entityOf({ name: 'alpha', observations: ['new'] })]);

    const result = importMemories({ data, merge_strategy: 'overwrite' }, { trust: true });

    expect(result.imported).toBe(1);
    const meta = metadataOf('alpha');
    expect(meta.trust).toBe('trusted');
    const provenance = meta.provenance as Record<string, unknown>;
    expect(provenance.source).toBe('trusted-import');
    expect(provenance.imported_at).toBeTruthy();
    expect(provenance.exported_at).toBe(data.exported_at);
    expect(provenance.export_version).toBe(data.version);
    expect(provenance.merge_strategy).toBe('overwrite');
    expect(isAutoInjectable(meta)).toBe(true);
  });

  it('creating a brand-new entity under `--trust` also stamps trusted / trusted-import', () => {
    const data = bundleOf([entityOf({ name: 'beta', observations: ['fresh'] })]);

    importMemories({ data, merge_strategy: 'skip' }, { trust: true });

    const meta = metadataOf('beta');
    expect(meta.trust).toBe('trusted');
    expect((meta.provenance as Record<string, unknown>).source).toBe('trusted-import');
    expect(isAutoInjectable(meta)).toBe(true);
  });

  it('without the option, create and overwrite still stamp trust untrusted / import, exactly as before this option existed', () => {
    remember({ name: 'gamma', type: 'note', observations: ['old'] });
    const data = bundleOf([
      entityOf({ name: 'gamma', observations: ['new'] }),
      entityOf({ name: 'delta', observations: ['fresh'] }),
    ]);

    importMemories({ data, merge_strategy: 'overwrite' });

    for (const name of ['gamma', 'delta']) {
      const meta = metadataOf(name);
      expect(meta.trust).toBe('untrusted');
      expect((meta.provenance as Record<string, unknown>).source).toBe('import');
      expect(isAutoInjectable(meta)).toBe(false);
    }
  });

  it('a `trust` field smuggled into the first argument is ignored — only the second argument reaches it', () => {
    // The boundary that keeps MCP/HTTP untrusted (ImportSchema.strict()) is a
    // schema, and a schema is not the only way to call this function: a
    // caller that bypasses TypeScript (`as never`) must still find the field
    // has no effect, because `importMemories` never reads `args.trust`.
    const data = bundleOf([entityOf({ name: 'smuggled', observations: ['x'] })]);
    importMemories({ data, merge_strategy: 'skip', trust: true } as never);

    const meta = metadataOf('smuggled');
    expect(meta.trust).toBe('untrusted');
    expect((meta.provenance as Record<string, unknown>).source).toBe('import');
  });
});

describe('importMemories({...}, { trust: true }) — append onto an entity that already existed leaves its trust exactly as it was', () => {
  it('append onto an existing TRUSTED local memory leaves it trusted, and its provenance untouched', () => {
    remember({ name: 'epsilon', type: 'note', observations: ['old'] });
    const before = metadataOf('epsilon');
    expect(before.trust).toBe('trusted'); // fixture sanity: remember() stamps this

    const data = bundleOf([entityOf({ name: 'epsilon', observations: ['appended'] })]);
    const result = importMemories({ data, merge_strategy: 'append' }, { trust: true });

    expect(result.appended).toBe(1);
    const after = metadataOf('epsilon');
    expect(after.trust).toBe('trusted');
    expect(after.provenance).toEqual(before.provenance);
    expect(isAutoInjectable(after)).toBe(true);
  });

  it('append onto an existing UNTRUSTED (previously imported) memory leaves it untrusted — --trust neither promotes nor demotes it', () => {
    // Seed an untrusted entity the same way a plain import (no --trust) would.
    const seed = bundleOf([entityOf({ name: 'zeta', observations: ['seed'] })]);
    importMemories({ data: seed, merge_strategy: 'skip' });
    const before = metadataOf('zeta');
    expect(before.trust).toBe('untrusted'); // fixture sanity

    const data = bundleOf([entityOf({ name: 'zeta', observations: ['appended'] })]);
    const result = importMemories({ data, merge_strategy: 'append' }, { trust: true });

    expect(result.appended).toBe(1);
    const after = metadataOf('zeta');
    expect(after.trust, '--trust must not promote an existing untrusted entity on append').toBe('untrusted');
    expect(after.provenance).toEqual(before.provenance);
    expect(isAutoInjectable(after)).toBe(false);
  });

  it('append onto a FRESH entity (not already present) is unaffected — that is the create path, not the preserve path', () => {
    const data = bundleOf([entityOf({ name: 'eta', observations: ['brand new'] })]);
    importMemories({ data, merge_strategy: 'append' }, { trust: true });

    const meta = metadataOf('eta');
    expect(meta.trust).toBe('trusted');
    expect((meta.provenance as Record<string, unknown>).source).toBe('trusted-import');
  });
});

describe('importMemories({...}, { trust: true }) — overwrite must not open createEntity\'s trusted-only side paths (#346)', () => {
  it('a bundle reasserting a forgotten session-insight observation does not restore it, and does not lift confidence, under --trust --merge overwrite', () => {
    // `createEntity` restores forgotten `session-*-summary`/`-files` text
    // and lifts confidence by 0.05 ONLY when it reads `trustOverride:
    // 'trusted'` — a path meant for a user's OWN `remember`, not an import.
    // `trust: true` must stamp the STORED metadata trusted without ever
    // passing `trustOverride: 'trusted'` into createEntity.
    const name = 'session-407-346-files';
    const kept = 'Session edited 1 file(s): kept.ts';
    const removed = 'Session edited 1 file(s): removed.ts';
    remember({ name, type: 'session-insight', observations: [kept, removed] });
    forget({ name, observation: removed });
    // remember() stamps confidence at 1.0 (the ceiling): seed it below that
    // so a wrongly-opened +0.05 bump would be visible instead of clamped.
    getDatabase().prepare('UPDATE entities SET confidence = 0.5 WHERE name = ?').run(name);

    const before = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(before.metadata?.forgotten_observation_hashes, 'fixture sanity').toHaveLength(1);

    // The bundle a real backup carries if taken before the forget (or from
    // a machine that never saw it) — reasserting the forgotten text is
    // exactly what a trusted import must still refuse to bring back.
    const data = bundleOf([entityOf({ name, type: 'session-insight', observations: [kept, removed] })]);

    importMemories({ data, merge_strategy: 'overwrite' }, { trust: true });

    const after = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(after.observations, 'forgotten text must not come back from a trusted import').not.toContain(removed);
    expect(after.metadata?.trust).toBe('trusted');
    expect((after.metadata?.provenance as Record<string, unknown>).source).toBe('trusted-import');
    expect(
      (getDatabase().prepare('SELECT confidence FROM entities WHERE name = ?').get(name) as { confidence: number }).confidence,
      'a trusted overwrite must not lift confidence via the createEntity confidence-bump gate',
    ).toBe(0.5);
  });
});
