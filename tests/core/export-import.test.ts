import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { remember, forget, recall, exportMemories, importMemories, setPinned } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

useTestDatabase('memesh-export-');

it.each(['append', 'overwrite'] as const)('#346 %s imports preserve local forgotten observations against bundled metadata', (merge_strategy) => {
  const name = 'session-import-exclusion-files';
  const removed = 'Session edited 1 file(s): removed.ts';
  remember({ name, type: 'session-insight', observations: [removed] });
  forget({ name, observation: removed });
  const data = {
    version: '3.1.0', exported_at: '2026-09-14T00:00:00.000Z', entity_count: 1,
    entities: [{ name, type: 'session-insight', namespace: 'personal', relations: [], observations: [removed, 'new imported observation'], tags: [], metadata: { forgotten_observation_hashes: [] } }],
  };
  const kg = new KnowledgeGraph(getDatabase());
  for (let attempt = 0; attempt < 2; attempt++) {
    importMemories({ data, merge_strategy });
    const entity = kg.getEntity(name)!;
    expect(entity.observations).not.toContain(removed);
    expect(entity.observations).toContain('new imported observation');
    expect(entity.metadata?.forgotten_observation_hashes).toHaveLength(1);
  }
  remember({ name, type: 'session-insight', observations: [removed] });
  expect(kg.getEntity(name)!.observations).toContain(removed);
  expect(kg.getEntity(name)!.metadata?.forgotten_observation_hashes).toEqual([]);
});

// #359: the missing direction. #346 only ever preserved a LOCAL exclusion
// list against a bundle that also carried one — the fix above still let a
// bundle SET `forgotten_observation_hashes` on a local entity that had none,
// because the spread order (`...existingMetadata, ...bundledSafe`) puts the
// bundle's value into the gap and nothing put it back. A bundle is content;
// it must never be able to introduce a forget-exclusion the importer never
// recorded.
it.each(['append', 'overwrite'] as const)(
  '#359 %s never lets a bundle SET forgotten_observation_hashes where the local entity has none',
  (merge_strategy) => {
    const name = 'session-import-no-local-exclusion-files';
    remember({ name, type: 'session-insight', observations: ['kept'] });
    const data = {
      version: '3.1.0', exported_at: '2026-09-14T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'session-insight', namespace: 'personal', relations: [], tags: [],
        observations: ['kept', 'new imported observation'],
        metadata: { forgotten_observation_hashes: ['a'.repeat(64)] },
      }],
    };
    importMemories({ data, merge_strategy });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(
      entity.metadata?.forgotten_observation_hashes,
      'a bundle introduced an exclusion the local entity never recorded',
    ).toBeUndefined();
  },
);

// #359 MUST-FIX-2 (review round 2): a DENY-ALWAYS fix regressed a promise
// 4.10.1 already published — CHANGELOG [4.10.1] says an observation removed
// with `forget` "stays removed from later Stop snapshots" with no caveat,
// and 4.10.1's own (buggy, unvalidated) behaviour let a user's OWN backup
// restore its OWN exclusions onto a fresh machine. The fix is validate, not
// deny: a FRESH entity (no local row) accepts the bundle's
// `forgotten_observation_hashes` ONLY when every element is a real SHA-256
// hex digest, de-duplicated, and under the cap — never the raw value, and
// never a partially-filtered one.
//
// (1) fresh entity + a VALID list → present after import, for both
// merge strategies (both take the same "create fresh" path in importMemories
// when the entity does not exist yet, so this also guards that path staying
// shared).
it.each(['append', 'overwrite'] as const)(
  '#359 MUST-FIX-2 a fresh entity accepts a VALID bundled forgotten_observation_hashes list (%s)',
  (merge_strategy) => {
    const name = 'session-fresh-valid-exclusion-files';
    const hash = 'a'.repeat(64);
    const data = {
      version: '3.1.0', exported_at: '2026-09-14T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'session-insight', namespace: 'personal', relations: [], tags: [],
        observations: ['brand new text'],
        metadata: { forgotten_observation_hashes: [hash] },
      }],
    };
    importMemories({ data, merge_strategy });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(entity.metadata?.forgotten_observation_hashes).toEqual([hash]);
  },
);

// (2) THE TWO-IMPORT SCENARIO this whole fix is FOR: restoring a backup that
// already reflects a `forget` decision (creates the entity, carries the
// exclusion hash, has no occurrence of the removed text), then later
// append-importing an OLDER backup that still has the removed text. The
// downstream mechanism that makes this work is `createEntityInner`'s
// untrusted-write filter (knowledge-graph.ts ~576): it reads
// `forgotten_observation_hashes` off the row CURRENTLY in the database on
// every untrusted write to a `session-*-(files|fixes|summary)` entity and
// strips re-appearing forgotten text. That filter only has something to read
// if the FIRST import actually persisted the hash — which a deny-always fix
// does not do. This is RED against a deny-always fix and GREEN once a fresh
// entity can accept a validated list (also true of 4.10.1's original,
// unvalidated pass-through — this is the regression MUST-FIX-2 closes).
it('#359 MUST-FIX-2 a later append-import cannot re-add text a first restore already excluded', () => {
  const name = 'session-two-import-exclusion-files';
  const removedText = 'Session edited 1 file(s): removed.ts';
  const removedHash = createHash('sha256').update(removedText).digest('hex');

  // Bundle B: the newer backup, already reflecting the forget — carries the
  // exclusion, not the excluded text.
  const bundleB = {
    version: '3.1.0', exported_at: '2026-09-14T00:00:00.000Z', entity_count: 1,
    entities: [{
      name, type: 'session-insight', namespace: 'personal', relations: [], tags: [],
      observations: ['Session edited 1 file(s): kept.ts'],
      metadata: { forgotten_observation_hashes: [removedHash] },
    }],
  };
  importMemories({ data: bundleB, merge_strategy: 'skip' });

  // Bundle A: an OLDER backup that still has the removed text.
  const bundleA = {
    version: '3.0.0', exported_at: '2026-09-01T00:00:00.000Z', entity_count: 1,
    entities: [{
      name, type: 'session-insight', namespace: 'personal', relations: [], tags: [],
      observations: [removedText],
    }],
  };
  importMemories({ data: bundleA, merge_strategy: 'append' });

  const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
  expect(
    entity.observations,
    'an older, append-imported backup put back text a newer restore had already excluded',
  ).not.toContain(removedText);
});

// (3) malformed bundles on a FRESH entity: never partially trusted. One
// invalid element (or an oversized list — decided to drop whole rather than
// truncate; see the comment on MAX_IMPORTED_FORGOTTEN_HASHES in
// serializer.ts) drops the WHOLE list, same as non-array or empty.
it.each([
  ['not an array', 'not-an-array'],
  ['one non-hex element among otherwise-valid ones', ['a'.repeat(64), 'not-a-hash']],
  ['wrong-length hex', ['a'.repeat(63)]],
  ['oversize: 10,000 distinct valid hashes', Array.from({ length: 10_000 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))],
  // Round-3 independent review, item 5: `Array.prototype.every` SKIPS holes,
  // so validating before de-duplicating let a sparse array pass the
  // element-shape check vacuously (no element for the callback to reject),
  // and spreading it through `new Set(...)` then materialised the holes as
  // literal `undefined` — stored as `[null]` after the JSON round trip.
  // Unreachable from a real JSON bundle (JSON has no sparse arrays), but it
  // broke the "never a partially-honoured exclusion list" invariant the
  // function's own comment states.
  ['sparse array (holes)', new Array(3)],
])(
  '#359 MUST-FIX-2 a malformed bundled forgotten_observation_hashes (%s) on a FRESH entity leaves the field absent',
  (_label, malformed) => {
    const name = 'session-fresh-malformed-exclusion-files';
    const data = {
      version: '3.1.0', exported_at: '2026-09-14T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'session-insight', namespace: 'personal', relations: [], tags: [],
        observations: ['brand new text'],
        metadata: { forgotten_observation_hashes: malformed },
      }],
    };
    importMemories({ data, merge_strategy: 'skip' });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(entity.metadata?.forgotten_observation_hashes).toBeUndefined();
    expect(entity.observations).toContain('brand new text');
  },
);

// #359 round 4 (independent review, item A): the deny-list named `guard`,
// `demo`, `forgotten_observation_hashes` — and missed `task_state`, `pin`,
// `signal_score`, `consolidation_depth`, `compacted_into`, `proposal_id`,
// `session_id`. A bundle could write `task_state.goal`, which SessionStart
// and `memesh briefing` inject verbatim into the agent's context — a file
// someone sends you could put text in front of the agent. `buildImportedMetadata`
// is now an ALLOW-list (`IMPORTABLE_METADATA_KEYS`): only a named descriptive
// key ever reaches the merge; everything else — every authority key AND any
// future/unknown key — is absent by construction, the same one mechanism.
describe('#359 round 4: import metadata is an ALLOW-list, not a deny-list', () => {
  it("the reviewer's task_state probe: a bundle cannot inject text a SessionStart briefing would show", () => {
    const name = 'task-state:authority-project';
    const data = {
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'task-state', namespace: 'personal', relations: [], tags: [],
        observations: ['goal: HOSTILE BUNDLE GOAL'],
        metadata: { task_state: { goal: 'HOSTILE BUNDLE GOAL' } },
      }],
    };
    importMemories({ data, merge_strategy: 'skip' });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(entity.metadata?.task_state, 'a bundle set task_state on a fresh entity').toBeUndefined();
  });

  it.each(['append', 'overwrite'] as const)(
    'a bundle cannot set task_state on an EXISTING task-state entity either (%s)',
    (merge_strategy) => {
      const name = 'task-state:existing-authority-project';
      remember({ name, type: 'task-state', observations: ['goal: real goal'] });
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'task-state', namespace: 'personal', relations: [], tags: [],
          observations: ['goal: real goal', 'goal: HOSTILE BUNDLE GOAL'],
          metadata: { task_state: { goal: 'HOSTILE BUNDLE GOAL' } },
        }],
      };
      importMemories({ data, merge_strategy });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.task_state, 'a bundle set task_state on an existing entity').toBeUndefined();
    },
  );

  // #359 round 6 (independent review): `args.isNewEntity &&` guarding
  // `freshPin` had no test that would go RED if it were removed — mutating
  // it away left 90/90 green. These two pairs are that mutation-sensitive
  // regression guard, for BOTH directions and BOTH merge strategies: a
  // bundle must be able to neither GRANT nor REVOKE a pin on an entity you
  // already have.
  it.each(['append', 'overwrite'] as const)(
    "pin:false from a bundle cannot unpin an existing pinned entity (%s)",
    (merge_strategy) => {
      const name = 'pinned-real-memory';
      remember({ name, type: 'decision', observations: ['mine'] });
      setPinned(name, true);
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'decision', namespace: 'personal', relations: [], tags: [],
          observations: ['mine', 'from bundle'],
          metadata: { pin: false },
        }],
      };
      importMemories({ data, merge_strategy });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.pin, "a bundle's pin:false cleared the user's protection").toBe(true);
    },
  );

  it.each(['append', 'overwrite'] as const)(
    "pin:true from a bundle cannot pin an existing UNPINNED entity (%s)",
    (merge_strategy) => {
      const name = 'unpinned-real-memory';
      remember({ name, type: 'decision', observations: ['mine'] });
      expect(new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata?.pin, 'fixture: entity must start unpinned').toBeUndefined();
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'decision', namespace: 'personal', relations: [], tags: [],
          observations: ['mine', 'from bundle'],
          metadata: { pin: true },
        }],
      };
      importMemories({ data, merge_strategy });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.pin, "a bundle's pin:true granted protection to an entity that never asked for it").toBeUndefined();
    },
  );

  it('pin:true from a bundle DOES protect a fresh entity it creates', () => {
    const name = 'fresh-entity-pin-grant';
    const data = {
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'decision', namespace: 'personal', relations: [], tags: [],
        observations: ['brand new'],
        metadata: { pin: true },
      }],
    };
    importMemories({ data, merge_strategy: 'skip' });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(entity.metadata?.pin).toBe(true);
  });

  it.each([['1' as unknown as boolean, 1], ['the string "true"', 'true'], ['omitted entirely', undefined]])(
    'pin is refused on a fresh entity unless the bundle sends the literal boolean true (%s)',
    (_label, value) => {
      const name = 'fresh-entity-pin-non-strict';
      const metadata = value === undefined ? {} : { pin: value };
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'decision', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'], metadata,
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.pin).not.toBe(true);
    },
  );

  it.each(['consolidation_depth', 'compacted_into', 'proposal_id', 'session_id'])(
    'ranking/routing authority key %s is dropped on a fresh entity, not restored from the bundle',
    (key) => {
      const name = `fresh-entity-authority-${key}`;
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { [key]: key === 'session_id' ? 'sess-hostile' : 7 },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.[key]).toBeUndefined();
    },
  );

  it('an unknown/future metadata key is dropped, not admitted by default', () => {
    const name = 'fresh-entity-unknown-key';
    const data = {
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'note', namespace: 'personal', relations: [], tags: [],
        observations: ['brand new'],
        metadata: { evil_new_key: 1 },
      }],
    };
    importMemories({ data, merge_strategy: 'skip' });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(entity.metadata?.evil_new_key).toBeUndefined();
  });

  it('a genuinely DESCRIPTIVE key is kept — the allow-list is not a synonym for "deny everything"', () => {
    const name = 'fresh-entity-descriptive-key';
    const data = {
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'note', namespace: 'personal', relations: [], tags: [],
        observations: ['brand new'],
        metadata: { title_source: 'heuristic', retired_recall: { hits: 3, misses: 1 } },
      }],
    };
    importMemories({ data, merge_strategy: 'skip' });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(entity.metadata?.title_source).toBe('heuristic');
    expect(entity.metadata?.retired_recall).toEqual({ hits: 3, misses: 1 });
  });

  // #359 round 6 (independent review): `evidence_for` was classified
  // DESCRIPTIVE through round 5 ("read only by its own writer"), but that
  // writer's read GATES a decision (dreamer.ts ~810: `if (!evidenceFor.
  // includes(digestId)) evidenceFor.push(digestId)`) — a genuine conditional,
  // not display. Reclassified AUTHORITY: denied always, fresh or existing,
  // same as every other authority key with no restore exception.
  it.each(['append', 'overwrite'] as const)(
    'evidence_for is refused on an EXISTING entity (%s) — it is a dreamer idempotency gate, not display',
    (merge_strategy) => {
      const name = 'existing-entity-evidence-for';
      remember({ name, type: 'note', observations: ['mine'] });
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['mine', 'from bundle'],
          metadata: { evidence_for: [999] },
        }],
      };
      importMemories({ data, merge_strategy });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.evidence_for).toBeUndefined();
    },
  );

  it('evidence_for is refused on a FRESH entity too — no restore exception, unlike forgotten_observation_hashes/pin/signal_score', () => {
    const name = 'fresh-entity-evidence-for';
    const data = {
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
      entities: [{
        name, type: 'note', namespace: 'personal', relations: [], tags: [],
        observations: ['brand new'],
        metadata: { evidence_for: [999] },
      }],
    };
    importMemories({ data, merge_strategy: 'skip' });
    const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
    expect(entity.metadata?.evidence_for).toBeUndefined();
  });

  // #363: import respects the archived state. `kg.createEntity()` reactivates
  // any archived row sharing its name (the re-remember rule `remember` keeps),
  // and import inherited that for BOTH `append` and `overwrite`: a memory the
  // user had forgotten came back to life, unannounced, when a bundle named it.
  // Now such an entity is left untouched and counted in `kept_archived`;
  // `restore_archived: true` is the explicit way back. `remember` is unchanged.
  describe('#363: an existing entity that is ARCHIVED stays archived unless restore_archived is set', () => {
    const bundleOf = (entities: Array<{ name: string } & Record<string, unknown>>) => ({
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: entities.length,
      entities: entities.map((e) => ({ type: 'note', namespace: 'personal', relations: [], tags: [], observations: [], ...e })),
    }) as Parameters<typeof importMemories>[0]['data'];
    /** A local entity the user forgot, through the real archive path. */
    const seedArchived = (name: string) => {
      remember({ name, type: 'note', title: 'local title', observations: ['original text'], tags: ['keep-tag'] });
      expect(forget({ name }).archived, 'fixture: forget must archive the entity').toBe(true);
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      // `getEntity` filters by name only, with no status clause — it returns
      // an archived row like an active one, with `archived: true` (absent
      // when active).
      expect(entity.archived, 'fixture: entity must start archived').toBe(true);
      return entity;
    };
    const getEntity = (name: string) => new KnowledgeGraph(getDatabase()).getEntity(name)!;
    const authority = {
      pin: true, signal_score: 0.9, forgotten_observation_hashes: ['a'.repeat(64)],
      replaced_history: [{ replaced_at: '1900-01-01', title: 'forged', observations: ['forged'], tags: [] }],
    };

    it.each(['append', 'overwrite'] as const)(
      'import (%s) leaves an ARCHIVED existing entity archived and untouched, and counts it',
      (merge_strategy) => {
        const name = `archived-kept-${merge_strategy}`;
        const before = seedArchived(name);

        const result = importMemories({
          data: bundleOf([{
            name, type: 'decision', title: 'bundle title', namespace: 'team',
            observations: ['bundle text'], tags: ['bundle-tag'], metadata: authority,
          }]),
          merge_strategy,
          // The override moves entities that already exist; an archived one is
          // not moved either.
          namespace: 'team',
        });

        expect(result.kept_archived).toBe(1);
        expect(result.imported, 'an untouched entity was counted as imported').toBe(0);
        expect(result.appended).toBe(0);
        expect(result.overwritten).toBe(0);
        expect(result.skipped, '`skipped` is the merge-strategy skip, not this').toBe(0);
        expect(result.errors).toEqual([]);
        // The whole entity — observations, tags, title, type, namespace,
        // metadata (provenance, authority keys, everything), status — is what
        // it was.
        expect(getEntity(name)).toEqual(before);
      },
    );

    // The transports only pass a real boolean, but the core function is the
    // one place that decides: anything else is refused, never read as "yes".
    it.each(['append', 'overwrite'] as const)(
      'import (%s) refuses a restore_archived that is not a boolean, and writes nothing',
      (merge_strategy) => {
        const name = `archived-not-boolean-${merge_strategy}`;
        const before = seedArchived(name);

        for (const value of ['false', 'true', 1, null, {}]) {
          expect(
            () => importMemories({
              data: bundleOf([{ name, observations: ['bundle text'] }, { name: `fresh-${merge_strategy}` }]),
              merge_strategy,
              restore_archived: value as unknown as boolean,
            }),
            `restore_archived ${JSON.stringify(value)} was accepted`,
          ).toThrow(/restore_archived must be the boolean true or false/);
        }
        expect(getEntity(name)).toEqual(before);
        expect(new KnowledgeGraph(getDatabase()).getEntity(`fresh-${merge_strategy}`), 'an entry was written before the refusal').toBeNull();
      },
    );

    it.each(['append', 'overwrite'] as const)(
      'import (%s) with restore_archived brings it back, and the trust rules for an existing entity still hold',
      (merge_strategy) => {
        const name = `archived-restored-${merge_strategy}`;
        seedArchived(name);

        const result = importMemories({
          data: bundleOf([{ name, observations: ['bundle text'], metadata: authority }]),
          merge_strategy,
          restore_archived: true,
        });

        expect(result.kept_archived).toBe(0);
        expect(result.errors).toEqual([]);
        if (merge_strategy === 'append') expect(result.appended).toBe(1);
        else expect(result.overwritten).toBe(1);
        const entity = getEntity(name);
        expect(entity.archived, 'restore_archived did not reactivate the entity').toBeUndefined();
        expect(entity.observations).toContain('bundle text');
        if (merge_strategy === 'append') expect(entity.observations).toContain('original text');
        else expect(entity.observations).not.toContain('original text');
        // The FOUR fresh-only authority exceptions stay ABSENT/UNCHANGED
        // regardless — reactivation does not make `buildImportedMetadata`
        // treat this as a FRESH entity; `isNewEntity` is `!existing`, and
        // `existing` was resolved (and was truthy) BEFORE any of this ran.
        expect(entity.metadata?.pin, 'pin leaked onto a restored EXISTING entity').toBeUndefined();
        expect(entity.metadata?.signal_score, "the bundle's signal_score overwrote the local one on a restored EXISTING entity").toBe(0.55);
        expect(entity.metadata?.forgotten_observation_hashes, 'forgotten_observation_hashes leaked onto a restored EXISTING entity').toBeUndefined();
        expect(entity.metadata?.replaced_history, 'a forged replaced_history leaked onto a restored EXISTING entity with no local history').toBeUndefined();
      },
    );

    it.each(['append', 'overwrite'] as const)(
      'an ACTIVE existing entity with the same name still merges/overwrites (%s), and nothing is counted as kept',
      (merge_strategy) => {
        const name = `active-still-merges-${merge_strategy}`;
        remember({ name, type: 'note', observations: ['original text'] });

        const result = importMemories({
          data: bundleOf([{ name, observations: ['bundle text'] }]),
          merge_strategy,
        });

        expect(result.kept_archived).toBe(0);
        const observations = getEntity(name).observations;
        expect(observations).toContain('bundle text');
        if (merge_strategy === 'append') {
          expect(result.appended).toBe(1);
          expect(observations).toContain('original text');
        } else {
          expect(result.overwritten).toBe(1);
          expect(observations).not.toContain('original text');
        }
      },
    );

    it.each(['skip', 'append', 'overwrite'] as const)(
      'a bundle with no archived collision reports kept_archived 0 (%s)',
      (merge_strategy) => {
        remember({ name: 'collision-active', type: 'note', observations: ['original text'] });
        const result = importMemories({
          data: bundleOf([{ name: 'collision-active', observations: ['x'] }, { name: 'collision-fresh', observations: ['y'] }]),
          merge_strategy,
        });
        expect(result.kept_archived).toBe(0);
        expect(getEntity('collision-fresh').observations).toEqual(['y']);
      },
    );

    it('`skip` still counts an archived entity as `skipped`, not as kept_archived', () => {
      const before = seedArchived('archived-under-skip');
      const result = importMemories({
        data: bundleOf([{ name: 'archived-under-skip', observations: ['bundle text'] }]),
        merge_strategy: 'skip',
      });
      expect(result.skipped).toBe(1);
      expect(result.kept_archived).toBe(0);
      expect(getEntity('archived-under-skip')).toEqual(before);
    });

    it('counts each archived entity once and still imports everything else in the same bundle', () => {
      seedArchived('kept-one');
      seedArchived('kept-two');
      remember({ name: 'still-active', type: 'note', observations: ['original text'] });

      const result = importMemories({
        data: bundleOf([
          { name: 'kept-one', observations: ['bundle text'] },
          { name: 'still-active', observations: ['bundle text'] },
          { name: 'kept-two', observations: ['bundle text'] },
          { name: 'brand-new', observations: ['bundle text'] },
        ]),
        merge_strategy: 'append',
      });

      expect(result.kept_archived).toBe(2);
      expect(result.appended).toBe(1);
      expect(result.imported).toBe(1);
      expect(getEntity('kept-one').archived).toBe(true);
      expect(getEntity('kept-two').archived).toBe(true);
      expect(getEntity('still-active').observations).toContain('bundle text');
      expect(getEntity('brand-new').observations).toEqual(['bundle text']);
    });

    it('restore_archived with `skip` is refused, and nothing is written', () => {
      const before = seedArchived('archived-refused-under-skip');
      const bundle = bundleOf([
        { name: 'archived-refused-under-skip', observations: ['bundle text'] },
        { name: 'refused-fresh', observations: ['bundle text'] },
      ]);

      expect(() => importMemories({ data: bundle, merge_strategy: 'skip', restore_archived: true }))
        .toThrow(/restore_archived.*"append" or "overwrite"/);

      expect(getEntity('archived-refused-under-skip')).toEqual(before);
      expect(new KnowledgeGraph(getDatabase()).getEntity('refused-fresh'), 'the refused import still wrote an entity').toBeNull();
    });

    it.each(['skip', 'append', 'overwrite'] as const)(
      'restore_archived: false is accepted with every strategy (%s)',
      (merge_strategy) => {
        seedArchived(`archived-false-${merge_strategy}`);
        const result = importMemories({
          data: bundleOf([{ name: `archived-false-${merge_strategy}`, observations: ['bundle text'] }]),
          merge_strategy,
          restore_archived: false,
        });
        expect(result.errors).toEqual([]);
        expect(getEntity(`archived-false-${merge_strategy}`).archived).toBe(true);
      },
    );

    // The same rule `merge_strategy: 'skip'` already applies to an entity it
    // leaves alone: the entry's own relations are not queued (nothing in
    // `skipped_relations` either), while a relation from ANOTHER entry to it
    // is created, because the second pass finds the row by name.
    it('drops the relations an untouched archived entry carries, and keeps relations that point at it', () => {
      seedArchived('kept-with-relations');
      const result = importMemories({
        data: bundleOf([
          { name: 'kept-with-relations', observations: ['bundle text'], relations: [{ to: 'points-at-kept', type: 'depends-on' }] },
          { name: 'points-at-kept', observations: ['y'], relations: [{ to: 'kept-with-relations', type: 'depends-on' }] },
        ]),
        // `overwrite`, because it is the strategy that queues an existing
        // entry's own relations; `append` never does.
        merge_strategy: 'overwrite',
      });

      expect(result.kept_archived).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.skipped_relations).toEqual([]);
      expect(getEntity('kept-with-relations').relations ?? [], 'an untouched entity gained a relation').toEqual([]);
      expect(getEntity('points-at-kept').relations).toEqual([
        { from: 'points-at-kept', to: 'kept-with-relations', type: 'depends-on' },
      ]);
    });
  });

  // #359 round 8 (independent review): `replaced_history` was classified
  // DESCRIPTIVE through rounds 4-7 — "read back only to compute a display
  // count" — which was true of ONE reader and false of a SECOND:
  // `rememberInTransaction`'s `replace` path reads the CURRENT value,
  // appends the version it just replaced, and writes the result back
  // (operations.ts ~334-335). Letting a bundle's value through the plain
  // allow-list meant an append import could REPLACE a real local history
  // entry with a forged one, and the NEXT genuine local `--replace` would
  // then append onto the forged list. Now the FOURTH narrow, validated
  // fresh-entity-only exception, same pattern as the other three.
  describe('#359 round 8: replaced_history — the fourth narrow fresh-entity exception', () => {
    const forged = [{ replaced_at: '1900-01-01', title: 'forged', observations: ['forged'], tags: [] }];

    it.each(['append', 'overwrite'] as const)(
      "an EXISTING entity's local replaced_history is never overwritten by a bundle's forged one (%s)",
      (merge_strategy) => {
        const name = 'existing-entity-real-replaced-history';
        remember({ name, type: 'note', title: 'v1', observations: ['real-old'] });
        remember({ name, type: 'note', observations: ['real-new'], replace: true });
        const before = new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata?.replaced_history;
        expect(before, 'fixture: a real local replace must have happened').toHaveLength(1);

        const data = {
          version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
          entities: [{
            name, type: 'note', namespace: 'personal', relations: [], tags: [],
            observations: ['real-new'],
            metadata: { replaced_history: forged },
          }],
        };
        importMemories({ data, merge_strategy });

        const after = new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata?.replaced_history;
        expect(after, "a bundle's forged replaced_history overwrote the real local one").toEqual(before);
      },
    );

    it.each(['append', 'overwrite'] as const)(
      "an EXISTING entity with NO local replaced_history stays absent, whatever the bundle sends (%s)",
      (merge_strategy) => {
        const name = 'existing-entity-no-replaced-history';
        remember({ name, type: 'note', observations: ['never replaced'] });
        expect(
          new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata?.replaced_history,
          'fixture: entity must start with no replaced_history',
        ).toBeUndefined();

        const data = {
          version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
          entities: [{
            name, type: 'note', namespace: 'personal', relations: [], tags: [],
            observations: ['never replaced'],
            metadata: { replaced_history: forged },
          }],
        };
        importMemories({ data, merge_strategy });

        expect(
          new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata?.replaced_history,
          "a bundle granted replaced_history where none existed locally",
        ).toBeUndefined();
      },
    );

    it('a FRESH entity keeps a VALID bundled replaced_history, and a LATER local replace appends to it', () => {
      const name = 'fresh-entity-valid-replaced-history';
      const valid = [{ replaced_at: '2026-01-01T00:00:00.000Z', title: 'v1', observations: ['old text'], tags: ['t1'] }];
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { replaced_history: valid },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const kg = new KnowledgeGraph(getDatabase());
      expect(kg.getEntity(name)!.metadata?.replaced_history).toEqual(valid);

      // A later LOCAL replace appends to the restored history, proving it is
      // genuinely stored in the shape `rememberInTransaction` expects, not
      // merely round-tripped as opaque JSON.
      remember({ name, type: 'note', observations: ['newer text'], replace: true });
      const grown = kg.getEntity(name)!.metadata?.replaced_history as Array<{ title: string | null }>;
      expect(grown).toHaveLength(2);
      expect(grown[0].title, 'the restored entry must still be first').toBe('v1');
    });

    // #359 round 10: re-checked after the byte cap moved from per-entry
    // (round 8, 128 KiB) to the whole array (round 9, 256 KiB) — this is the
    // exact real-writer shape (a probe of `rememberInTransaction`'s own
    // `replace` path) that proved a COUNT-based cap would have rejected
    // legitimate data. The exact byte count has been mis-cited twice before
    // this round (3474, then 4978) — round 10 re-measured it with Codex's
    // own one-liner (`Buffer.byteLength(JSON.stringify(fixture), 'utf8')`)
    // and asserts the EXACT number below, not merely "under the cap", so a
    // future accidental change to this fixture's shape is caught by an
    // exact-value mismatch instead of silently still passing a loose bound.
    it('a FRESH entity keeps a VALID bundled replaced_history with 500 tiny observations in one entry — the real shape a COUNT cap would have rejected', () => {
      const name = 'fresh-entity-replaced-history-500-observations';
      const manyObs = Array.from({ length: 500 }, (_, i) => `obs-${i}`);
      const valid = [{ replaced_at: '2026-01-01T00:00:00.000Z', title: null, observations: manyObs, tags: [] }];
      expect(Buffer.byteLength(JSON.stringify(valid), 'utf8'), 'fixture: the exact measured real-writer size — re-measure with Buffer.byteLength(JSON.stringify(...), \'utf8\') if this ever goes red').toBe(4974);
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { replaced_history: valid },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.replaced_history).toEqual(valid);
    });

    it.each([
      ['not an array', { replaced_at: '2026-01-01T00:00:00.000Z', title: null, observations: [], tags: [] }],
      ['empty array', []],
      ['entry not an object', ['just a string']],
      ['entry is an array', [[1, 2, 3]]],
      ['entry missing replaced_at', [{ title: 'x', observations: [], tags: [] }]],
      ['entry replaced_at not a string', [{ replaced_at: 123, title: null, observations: [], tags: [] }]],
      ['entry title is a number (must be string or null)', [{ replaced_at: 'x', title: 5, observations: [], tags: [] }]],
      ['entry observations not an array', [{ replaced_at: 'x', title: null, observations: 'nope', tags: [] }]],
      ['entry observations contains a non-string', [{ replaced_at: 'x', title: null, observations: [1], tags: [] }]],
      ['entry tags not an array', [{ replaced_at: 'x', title: null, observations: [], tags: 'nope' }]],
      ['entry truncated is not a boolean', [{ replaced_at: 'x', title: null, observations: [], tags: [], truncated: 'yes' }]],
      ['entry has an unknown key', [{ replaced_at: 'x', title: null, observations: [], tags: [], extra: true }]],
      ['entry has a __proto__ key', [JSON.parse('{"replaced_at":"x","title":null,"observations":[],"tags":[],"__proto__":{"polluted":true}}')]],
      ['51 entries (over the 50-entry cap)', Array.from({ length: 51 }, () => ({ replaced_at: 'x', title: null, observations: [], tags: [] }))],
      // #359 round 9: the byte cap moved from PER-ENTRY (128 KiB, round 8) to
      // the WHOLE ARRAY (256 KiB) — see src/core/serializer.ts's comment on
      // `MAX_IMPORTED_REPLACED_HISTORY_TOTAL_BYTES`. 200,000 bytes (round 8's
      // value) is now comfortably UNDER 256 KiB and would no longer be
      // rejected; 300,000 is clearly over.
      ['one entry over the whole-array byte cap', [{ replaced_at: 'x', title: null, observations: ['y'.repeat(300_000)], tags: [] }]],
    ])('a FRESH entity with a malformed bundled replaced_history (%s) gets no replaced_history at all', (_label, malformed) => {
      const name = 'fresh-entity-malformed-replaced-history';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { replaced_history: malformed },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.replaced_history).toBeUndefined();
      // Confirms prototype pollution specifically did not happen — a
      // regression here would show up on ANY plain object, not just this
      // entity's own metadata.
      expect(({} as Record<string, unknown>).polluted, 'a __proto__ key polluted Object.prototype').toBeUndefined();
    });

    // #359 round 9: the byte cap is checked over the SERIALIZED WHOLE ARRAY
    // (`jsonBytesOf(value) <= MAX_IMPORTED_REPLACED_HISTORY_TOTAL_BYTES`,
    // 256 KiB = 4x the real writer's whole-array cap). These two tests pin
    // the boundary itself — MEASURED with the same `Buffer.byteLength(
    // JSON.stringify(...), 'utf8')` the validator uses, not hand-calculated,
    // so a future change to JSON's own escaping rules cannot silently drift
    // this fixture out from under the assertion.
    const TOTAL_BYTE_CAP = 256 * 1024;
    /** Builds a one-entry `replaced_history` array whose OWN serialized byte
     *  size is exactly `targetBytes`, by padding a single ASCII observation
     *  string and measuring after every adjustment. */
    function replacedHistoryAtBytes(targetBytes: number): Array<Record<string, unknown>> {
      const build = (padLength: number) => [{ replaced_at: 'x', title: null, observations: ['y'.repeat(padLength)], tags: [] }];
      const overhead = Buffer.byteLength(JSON.stringify(build(0)), 'utf8');
      let padLength = Math.max(0, targetBytes - overhead);
      let entry = build(padLength);
      // `'y'` is one ASCII byte and needs no JSON escaping, so the estimate
      // above is normally exact on the first try; adjust defensively rather
      // than assume.
      while (Buffer.byteLength(JSON.stringify(entry), 'utf8') < targetBytes) { padLength++; entry = build(padLength); }
      while (Buffer.byteLength(JSON.stringify(entry), 'utf8') > targetBytes) { padLength--; entry = build(padLength); }
      return entry;
    }

    it('a FRESH entity replaced_history measuring EXACTLY the 256 KiB whole-array cap is ACCEPTED', () => {
      const atCap = replacedHistoryAtBytes(TOTAL_BYTE_CAP);
      expect(Buffer.byteLength(JSON.stringify(atCap), 'utf8'), 'fixture: must measure exactly at the cap').toBe(TOTAL_BYTE_CAP);
      const name = 'fresh-entity-replaced-history-at-byte-cap';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { replaced_history: atCap },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.replaced_history).toEqual(atCap);
    });

    it('a FRESH entity replaced_history measuring ONE BYTE OVER the 256 KiB whole-array cap is REJECTED', () => {
      const overCap = replacedHistoryAtBytes(TOTAL_BYTE_CAP + 1);
      expect(Buffer.byteLength(JSON.stringify(overCap), 'utf8'), 'fixture: must measure exactly one byte over the cap').toBe(TOTAL_BYTE_CAP + 1);
      const name = 'fresh-entity-replaced-history-over-byte-cap';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { replaced_history: overCap },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.replaced_history).toBeUndefined();
    });

    // #359 round 10 (independent review): documentation and prose had
    // drifted back to describing a PER-ENTRY byte bound, which is not what
    // the code does or has done since round 9. These two tests are Codex's
    // own counter-examples, made permanent — proof that the bound is over
    // the WHOLE ARRAY, not per entry, because a per-entry reading predicts
    // the OPPOSITE verdict on both.
    it("two entries, each individually under any per-entry reading of the cap, are REJECTED once their aggregate exceeds the 256 KiB WHOLE-ARRAY cap (Codex's counter-example)", () => {
      const oneEntryAt = (targetBytes: number): Record<string, unknown> => {
        const build = (padLength: number) => ({ replaced_at: 'x', title: null, observations: ['y'.repeat(padLength)], tags: [] });
        const overhead = Buffer.byteLength(JSON.stringify([build(0)]), 'utf8');
        let padLength = Math.max(0, targetBytes - overhead);
        let candidate = build(padLength);
        while (Buffer.byteLength(JSON.stringify([candidate]), 'utf8') < targetBytes) { padLength++; candidate = build(padLength); }
        while (Buffer.byteLength(JSON.stringify([candidate]), 'utf8') > targetBytes) { padLength--; candidate = build(padLength); }
        return candidate;
      };
      const entryBytes = 140 * 1024;
      const e1 = oneEntryAt(entryBytes);
      const e2 = oneEntryAt(entryBytes);
      // Each entry ALONE measures 140 KiB — comfortably under 256 KiB, so a
      // (wrong) per-entry reading of the cap would accept both.
      expect(Buffer.byteLength(JSON.stringify([e1]), 'utf8'), 'fixture: entry 1 alone must be under the whole-array cap').toBeLessThan(TOTAL_BYTE_CAP);
      expect(Buffer.byteLength(JSON.stringify([e2]), 'utf8'), 'fixture: entry 2 alone must be under the whole-array cap').toBeLessThan(TOTAL_BYTE_CAP);
      const combined = [e1, e2];
      const combinedBytes = Buffer.byteLength(JSON.stringify(combined), 'utf8');
      expect(combinedBytes, 'fixture: the two together must exceed the whole-array cap — that is the whole point of this test').toBeGreaterThan(TOTAL_BYTE_CAP);
      const name = 'fresh-entity-replaced-history-two-140kib-entries';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { replaced_history: combined },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.replaced_history, 'two individually-small entries must still be rejected once their aggregate exceeds 256 KiB').toBeUndefined();
    });

    it("one 200 KiB entry is ACCEPTED under the real 256 KiB WHOLE-ARRAY cap, even though a (wrong) per-entry 128 KiB reading would reject it (Codex's counter-example)", () => {
      const build = (padLength: number) => [{ replaced_at: 'x', title: null, observations: ['y'.repeat(padLength)], tags: [] }];
      const targetBytes = 200 * 1024;
      const overhead = Buffer.byteLength(JSON.stringify(build(0)), 'utf8');
      let padLength = Math.max(0, targetBytes - overhead);
      let entry = build(padLength);
      while (Buffer.byteLength(JSON.stringify(entry), 'utf8') < targetBytes) { padLength++; entry = build(padLength); }
      while (Buffer.byteLength(JSON.stringify(entry), 'utf8') > targetBytes) { padLength--; entry = build(padLength); }
      const measured = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      expect(measured, 'fixture: must measure ~200 KiB — over the retired 128 KiB per-entry figure, under the real 256 KiB whole-array cap').toBe(targetBytes);
      expect(measured, 'fixture: must be over the retired per-entry 128 KiB figure — that is the whole point of this test').toBeGreaterThan(128 * 1024);
      const name = 'fresh-entity-replaced-history-one-200kib-entry';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { replaced_history: entry },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const importedEntity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(importedEntity.metadata?.replaced_history, 'a 200 KiB single entry must be accepted under the real whole-array cap').toEqual(entry);
    });
  });

  // #359 round 5 (owner decision on the round-4 conflict): `signal_score` is
  // AUTHORITY, but the existing round-trip promise for a FRESH entity stays
  // — bounded to a value `computeSignalScore` itself could produce. An
  // EXISTING entity's own score always wins, same as every other authority
  // key; the bundle's value never even reaches the merge.
  describe('#359 round 5: signal_score — the third narrow fresh-entity exception', () => {
    it.each(['append', 'overwrite'] as const)(
      "an EXISTING entity's local signal_score is never overwritten by a bundle's (%s)",
      (merge_strategy) => {
        const name = 'existing-entity-local-signal-score';
        remember({ name, type: 'note', observations: ['mine'] });
        new KnowledgeGraph(getDatabase()).updateEntityMetadata(name, (meta) => ({ ...meta, signal_score: 0.2 }));
        const data = {
          version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
          entities: [{
            name, type: 'note', namespace: 'personal', relations: [], tags: [],
            observations: ['mine', 'from bundle'],
            metadata: { signal_score: 0.99 },
          }],
        };
        importMemories({ data, merge_strategy });
        const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
        expect(entity.metadata?.signal_score, "a bundle's signal_score overwrote the local one").toBe(0.2);
      },
    );

    it('an EXISTING entity with NO local signal_score stays absent, whatever the bundle sends', () => {
      const name = 'existing-entity-no-local-signal-score';
      remember({ name, type: 'note', observations: ['mine'] });
      new KnowledgeGraph(getDatabase()).updateEntityMetadata(name, (meta) => {
        const { signal_score: _drop, ...rest } = meta;
        return rest;
      });
      expect(new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata?.signal_score, 'fixture: entity must start with no signal_score').toBeUndefined();
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['mine', 'from bundle'],
          metadata: { signal_score: 0.99 },
        }],
      };
      importMemories({ data, merge_strategy: 'append' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.signal_score, "a bundle's signal_score was granted where none existed locally").toBeUndefined();
    });

    it('a FRESH entity keeps a VALID bundled signal_score', () => {
      const name = 'fresh-entity-valid-signal-score';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { signal_score: 0.73 },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.signal_score).toBe(0.73);
    });

    // #359 round 7 (independent review): the round-6 rewrite of this matrix
    // dropped two ACCEPTED boundary cases the validator's own range check
    // (`value >= 0 && value <= 1`) makes true, not obviously so. Restored
    // explicitly, asserting what is actually STORED, not just that the
    // import did not throw.
    it('a FRESH entity keeps a bundled signal_score of -0 — it passes `-0 >= 0`, and JSON storage normalizes it to plain 0', () => {
      const name = 'fresh-entity-signal-score-negative-zero';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { signal_score: -0 },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      // Accepted (not replaced by the locally computed score): the stored
      // value is numerically 0, and `Object.is` confirms it is PLAIN 0, not
      // -0 — JSON has no negative-zero literal, so `JSON.stringify(-0)` is
      // `"0"`, and reading the metadata column back through `JSON.parse`
      // yields ordinary positive zero. This is a property of the STORAGE
      // layer, not of `validateFreshSignalScore` clamping anything.
      expect(entity.metadata?.signal_score).toBe(0);
      expect(Object.is(entity.metadata?.signal_score, -0), 'expected plain 0 after JSON storage, not -0').toBe(false);
    });

    it('a FRESH entity keeps a bundled signal_score of 1e-400 — it underflows to the double 0 before validation ever sees it', () => {
      // `1e-400` is smaller than the smallest representable positive double
      // (~5e-324): the JS engine parses the LITERAL itself as exactly `0`,
      // whether it arrives as a source literal (here) or as JSON text
      // (`JSON.parse('1e-400')` underflows identically) — by the time
      // `validateFreshSignalScore` runs, the value it sees is plain `0`,
      // already numerically indistinguishable from the `-0` case above.
      expect(1e-400).toBe(0);
      const name = 'fresh-entity-signal-score-subnormal-underflow';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { signal_score: 1e-400 },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      expect(entity.metadata?.signal_score).toBe(0);
    });

    it.each([
      ['string', '0.9'],
      ['string "0.5"', '0.5'],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['negative', -0.1],
      ['greater than 1', 1.1],
      ['null', null],
      ['object', { value: 0.9 }],
      ['boolean true', true],
      ['array', [0.5]],
    ])('a FRESH entity with a malformed bundled signal_score (%s) gets its own LOCALLY COMPUTED score, not "absent"', (_label, malformed) => {
      const name = 'fresh-entity-malformed-signal-score';
      const data = {
        version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
        entities: [{
          name, type: 'note', namespace: 'personal', relations: [], tags: [],
          observations: ['brand new'],
          metadata: { signal_score: malformed },
        }],
      };
      importMemories({ data, merge_strategy: 'skip' });
      const entity = new KnowledgeGraph(getDatabase()).getEntity(name)!;
      // Dropped, not clamped, and NOT left absent: `createEntityInner` always
      // stamps a signal_score at creation when none survived the merge
      // (knowledge-graph.ts ~356), so a rejected bundle value is replaced by
      // `computeSignalScore`'s own content-derived number — here `0.1`,
      // because 'note' bases at 0.5 (signal-scorer.ts) and the 9-character
      // observation "brand new" is under the 10-char floor that clamps any
      // type down to `Math.min(base, 0.1)`. Asserted exactly, not just
      // `typeof === 'number'`, per the round-6 review's correction: the
      // field is never "absent" here, only ever "not the bundle's value".
      expect(entity.metadata?.signal_score).not.toBe(malformed);
      expect(entity.metadata?.signal_score).toBe(0.1);
    });
  });
});

// ── Export ───────────────────────────────────────────────────────────────────

describe('exportMemories', () => {
  it('exports all active entities as JSON', () => {
    remember({ name: 'test-entity', type: 'note', observations: ['some data'] });
    const result = exportMemories({});
    expect(result.version).toBe('3.1.0');
    expect(result.entity_count).toBe(1);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('test-entity');
    expect(result.entities[0].observations).toContain('some data');
    expect(result.exported_at).toBeTruthy();
  });

  it('round-trips `title` — export omitted it and import never read it', async () => {
    // Export is the backup path, and it silently dropped the one field UX-1
    // exists to provide: a bundle taken after titles shipped restored a
    // library of machine dedup keys. Both halves are pinned, because fixing
    // only the export side would still lose the title on the way back in.
    remember({ name: 'titled', type: 'decision', title: 'Why we chose JWT', observations: ['ctx'] });
    const bundle = exportMemories({});
    expect(bundle.entities.find((e) => e.name === 'titled')?.title).toBe('Why we chose JWT');

    // Re-import under a new name, which proves the IMPORT half reads it.
    const copy = {
      ...bundle,
      entities: bundle.entities.map((e) => ({ ...e, name: `${e.name}-copy` })),
    };
    importMemories({ data: copy, merge_strategy: 'skip' });
    const restored = (await recall({ query: 'JWT' })).find((e) => e.name === 'titled-copy');
    expect(restored?.title, 'the title did not survive the round trip').toBe('Why we chose JWT');
  });

  it('includes version and exported_at fields', () => {
    remember({ name: 'a', type: 'note' });
    const result = exportMemories({});
    expect(result.version).toBe('3.1.0');
    expect(new Date(result.exported_at).getTime()).not.toBeNaN();
  });

  it('filters by tag', () => {
    remember({ name: 'a', type: 'note', tags: ['project:x'] });
    remember({ name: 'b', type: 'note', tags: ['project:y'] });
    const result = exportMemories({ tag: 'project:x' });
    expect(result.entity_count).toBe(1);
    expect(result.entities[0].name).toBe('a');
  });

  it('filters by namespace', () => {
    remember({ name: 'personal-item', type: 'note', namespace: 'personal' });
    remember({ name: 'team-item', type: 'note', namespace: 'team' });
    const result = exportMemories({ namespace: 'team' });
    expect(result.entity_count).toBe(1);
    expect(result.entities[0].name).toBe('team-item');
  });

  it('respects limit', () => {
    remember({ name: 'e1', type: 'note' });
    remember({ name: 'e2', type: 'note' });
    remember({ name: 'e3', type: 'note' });
    const result = exportMemories({ limit: 2 });
    expect(result.entities.length).toBeLessThanOrEqual(2);
  });

  it('exports entity tags and relations fields', () => {
    remember({ name: 'src', type: 'note', tags: ['t1', 't2'] });
    remember({ name: 'dst', type: 'note' });
    remember({ name: 'src', type: 'note', relations: [{ to: 'dst', type: 'related-to' }] });
    const result = exportMemories({});
    const src = result.entities.find((e) => e.name === 'src');
    expect(src).toBeDefined();
    expect(src!.tags).toContain('t1');
    expect(src!.relations.some((r) => r.to === 'dst' && r.type === 'related-to')).toBe(true);
  });

  it('exports archived entities, carrying their status', () => {
    // They used to be skipped, so `memesh forget` followed by an export and
    // a restore brought the memory back to life: the one operation whose
    // purpose is to take something out of circulation, undone by the one
    // whose purpose is to preserve state faithfully.
    remember({ name: 'active', type: 'note' });
    remember({ name: 'to-archive', type: 'note' });
    forget({ name: 'to-archive' });

    const result = exportMemories({});

    const archived = result.entities.find((e) => e.name === 'to-archive');
    expect(archived, 'an archived memory was left out of the backup').toBeDefined();
    expect(archived?.status).toBe('archived');
    // And the active one is not mislabelled — the field is absent, not
    // present-and-wrong.
    expect(result.entities.find((e) => e.name === 'active')?.status).toBeUndefined();
  });

  it('carries created_at, so a restore does not flatten the timeline', () => {
    remember({ name: 'dated', type: 'note', observations: ['a fact'] });
    const result = exportMemories({});
    const entity = result.entities.find((e) => e.name === 'dated');
    expect(entity?.created_at, 'the creation time was dropped from the backup').toBeTruthy();
  });

  it('carries metadata, but never a guard', () => {
    // Every other metadata field describes the memory. `guard` describes
    // memesh's BEHAVIOUR — an enabled guard matches a regex against the
    // user's Bash commands — and a bundle must be able to bring memories,
    // not to change what memesh does.
    remember({ name: 'with-meta', type: 'note', observations: ['a fact'] });
    new KnowledgeGraph(getDatabase()).updateEntityMetadata('with-meta', (current) => ({
      ...current,
      signal_score: 0.9,
      guard: { enabled: true, tool: 'Bash', pattern: '.*', message: 'do as I say' },
    }));

    const bundle = exportMemories({});
    const exported = bundle.entities.find((e) => e.name === 'with-meta');
    expect(exported?.metadata?.signal_score, 'metadata was dropped from the backup').toBe(0.9);

    // Round-trip into a graph that does not have it.
    forget({ name: 'with-meta' });
    getDatabase().prepare("DELETE FROM entities WHERE name = 'with-meta'").run();
    importMemories({ data: bundle, merge_strategy: 'skip' });

    const restored = new KnowledgeGraph(getDatabase()).getEntity('with-meta');
    expect(restored?.metadata?.signal_score, 'metadata did not survive the round trip').toBe(0.9);
    expect(restored?.metadata?.guard, 'a bundle installed a guard').toBeUndefined();
  });

  it('defaults namespace to personal in export', () => {
    remember({ name: 'item', type: 'note' });
    const result = exportMemories({});
    expect(result.entities[0].namespace).toBe('personal');
  });

  describe('a bundle that is only part of the graph says so', () => {
    // Measured on the real graph before this fix: 1272 memories, a default
    // export carried 1000, and the CLI printed `✅ Exported 1000 entities`.
    // A backup was missing 21% of the thing it was taken to preserve and
    // nothing anywhere said so — including the MCP `export` tool, which an
    // agent calls on the user's behalf.
    it('sets truncated when the graph holds more than the limit', () => {
      for (const n of ['a', 'b', 'c']) remember({ name: n, type: 'note', observations: ['x'] });

      const result = exportMemories({ limit: 2 });

      expect(result.truncated, 'a short bundle claimed to be the whole graph').toBe(true);
      expect(result.entity_count, 'the limit was not honoured').toBe(2);
      expect(result.entities, 'the probe row leaked into the bundle').toHaveLength(2);
    });

    it('does not set it when the graph fits — including when it fits EXACTLY', () => {
      // The anti-vacuity half, and the case a `length === limit` check gets
      // wrong: three memories under a limit of three is a complete backup.
      for (const n of ['a', 'b', 'c']) remember({ name: n, type: 'note', observations: ['x'] });

      expect(exportMemories({ limit: 10 }).truncated, 'a complete bundle was called short').toBe(false);
      expect(exportMemories({ limit: 3 }).truncated, 'an exactly-full bundle was called short').toBe(false);
      expect(exportMemories({ limit: 3 }).entity_count).toBe(3);
    });
  });
});

// ── Import ───────────────────────────────────────────────────────────────────

describe('importMemories', () => {
  const makeExport = (entities: Array<{
    name: string;
    type?: string;
    namespace?: string;
    observations?: string[];
    tags?: string[];
    relations?: Array<{ to: string; type: string }>;
  }>) => ({
    version: '3.0.0',
    exported_at: new Date().toISOString(),
    entity_count: entities.length,
    entities: entities.map((e) => ({
      name: e.name,
      type: e.type ?? 'note',
      namespace: e.namespace ?? 'personal',
      observations: e.observations ?? [],
      tags: e.tags ?? [],
      relations: e.relations ?? [],
    })),
  });

  it('imports new entities and returns correct count', () => {
    const data = makeExport([
      { name: 'new-a', observations: ['obs a'] },
      { name: 'new-b', observations: ['obs b'] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.appended).toBe(0);
    expect(result.errors).toHaveLength(0);

    const importedEntity = recall({ query: 'new-a' }).find((entity) => entity.name === 'new-a');
    expect(importedEntity?.metadata).toMatchObject({
      trust: 'untrusted',
      provenance: expect.objectContaining({ source: 'import', merge_strategy: 'skip' }),
    });
  });

  it('skips existing entities with skip strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['original'] });
    const data = makeExport([
      { name: 'existing', observations: ['new obs'] },
      { name: 'fresh', observations: ['data'] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('does not modify existing observations with skip strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['original'] });
    const data = makeExport([{ name: 'existing', observations: ['should-not-appear'] }]);
    importMemories({ data, merge_strategy: 'skip' });

    const entities = recall({ query: 'existing' });
    const entity = entities.find((e) => e.name === 'existing');
    expect(entity?.observations).toContain('original');
    expect(entity?.observations).not.toContain('should-not-appear');
  });

  it('appends observations to existing entity with append strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['old'] });
    const data = makeExport([{ name: 'existing', observations: ['new'] }]);
    const result = importMemories({ data, merge_strategy: 'append' });
    expect(result.appended).toBe(1);
    expect(result.imported).toBe(0);

    const existing = recall({ query: 'existing' }).find((entity) => entity.name === 'existing');
    expect(existing?.metadata).toMatchObject({
      trust: 'untrusted',
      provenance: expect.objectContaining({ source: 'import', merge_strategy: 'append' }),
    });
  });

  it('overwrites existing entity with overwrite strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['old'] });
    const data = makeExport([{ name: 'existing', observations: ['fresh'] }]);
    const result = importMemories({ data, merge_strategy: 'overwrite' });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.appended).toBe(0);

    const existing = recall({ query: 'existing' }).find((entity) => entity.name === 'existing');
    expect(existing?.metadata).toMatchObject({
      trust: 'untrusted',
      provenance: expect.objectContaining({ source: 'import', merge_strategy: 'overwrite' }),
    });
  });

  it('append does not duplicate an observation that already reached the entity (M-18)', () => {
    // Dogfooded on the real v4.7.1 release: running `import --merge append`
    // on the same bundle twice duplicated every observation verbatim, with
    // no bound on how many times — the exact shape of re-restoring the
    // same backup, or two overlapping bundles that share an entity.
    remember({ name: 'existing', type: 'note', observations: ['old'] });
    const data = makeExport([{ name: 'existing', observations: ['old', 'genuinely new'] }]);
    const result = importMemories({ data, merge_strategy: 'append' });
    expect(result.appended).toBe(1);

    const entity = recall({ query: 'existing' }).find((e) => e.name === 'existing');
    // 'old' appears once, not twice — the bundle's copy of an observation
    // the entity already had was skipped, not re-inserted.
    expect(entity?.observations.filter((o) => o === 'old')).toHaveLength(1);
    expect(entity?.observations).toContain('genuinely new');
    expect(entity?.observations).toHaveLength(2);
  });

  it('re-importing the identical bundle with append is idempotent — no growth on a second run', () => {
    remember({ name: 'existing', type: 'note', observations: ['old'] });
    const data = makeExport([{ name: 'existing', observations: ['old', 'genuinely new'] }]);
    importMemories({ data, merge_strategy: 'append' });
    importMemories({ data, merge_strategy: 'append' });

    const entity = recall({ query: 'existing' }).find((e) => e.name === 'existing');
    expect(entity?.observations).toHaveLength(2);
  });

  it('distinguishes "overwrote an existing entity" from "created one from nothing" (M-18)', () => {
    // Dogfooded: `Imported: 4, Skipped: 0, Appended: 0` printed identically
    // whether it overwrote 4 pre-existing memories or created 4 from an
    // empty graph — no signal in the output telling the two apart.
    remember({ name: 'existing', type: 'note', observations: ['old'] });
    const data = makeExport([
      { name: 'existing', observations: ['fresh'] },
      { name: 'brand-new', observations: ['from nothing'] },
    ]);
    const result = importMemories({ data, merge_strategy: 'overwrite' });
    expect(result.imported).toBe(2);
    expect(result.overwritten, 'only "existing" replaced a real entity').toBe(1);
  });

  it('a fresh-create import reports zero overwritten — the anti-vacuity half', () => {
    const data = makeExport([{ name: 'never-seen-before', observations: ['new'] }]);
    const result = importMemories({ data, merge_strategy: 'overwrite' });
    expect(result.imported).toBe(1);
    expect(result.overwritten).toBe(0);
  });

  it('overrides namespace on import', () => {
    const data = makeExport([{ name: 'team-item', namespace: 'personal' }]);
    importMemories({ data, namespace: 'team', merge_strategy: 'skip' });

    // Recalled entity should have the overridden namespace
    const entities = recall({});
    const entity = entities.find((e) => e.name === 'team-item');
    expect(entity).toBeDefined();
    expect(entity!.namespace).toBe('team');
  });

  it('REPORTS a relation whose target is not in the bundle and not in the graph', () => {
    // This used to be "silently skips", and the silence is what let the real
    // defect hide: relations were created inside the per-entity loop, so a
    // target further down the file had not been imported yet and was skipped
    // by the same catch. Export writes newest-first and relations point
    // newer -> older, so that was the ORDINARY case, not the edge case — a
    // backup restored with none of its relations and said nothing.
    //
    // With the second pass, a relation that still fails is genuinely
    // pointing outside the bundle. That is real information loss, and the
    // import now says so — in `skipped_relations`, NOT in `errors`.
    //
    // The distinction is the whole point. Every bundle narrowed by `--tag`,
    // `--namespace` or `--limit` has relations leaving it: measured, a full
    // backup of a 1272-memory graph restored 1000 entities and 142 of its
    // 151 relations, all nine losses being targets the limit cut off. In
    // `errors` those set exit 1, so the round trip this project documents —
    // `memesh export > b.json && memesh import b.json` — became a failing
    // command on a restore that did exactly what it should.
    const data = makeExport([
      { name: 'entity-a', relations: [{ to: 'nonexistent', type: 'related-to' }] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });

    expect(result.imported, 'the entity itself must still import').toBe(1);
    expect(result.skipped_relations, 'a lost relation was not reported').toHaveLength(1);
    expect(result.skipped_relations[0]).toContain('nonexistent');
    expect(result.errors, 'a link leaving the bundle was counted as a failure').toHaveLength(0);
  });

  it('a target already in the GRAPH is restored, not reported as lost', () => {
    // The anti-vacuity half: `skipped_relations` must mean "the target is
    // nowhere", not "the target was not in the bundle". A bundle that brings
    // one memory linked to one you already keep must rebuild that link.
    remember({ name: 'already-here', type: 'note', observations: ['kept'] });
    const data = makeExport([
      { name: 'incoming', relations: [{ to: 'already-here', type: 'related-to' }] },
    ]);

    const result = importMemories({ data, merge_strategy: 'skip' });

    expect(result.skipped_relations, 'a restorable link was reported lost').toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    const relations = getDatabase()
      .prepare(
        `SELECT f.name AS "from", t.name AS "to" FROM relations r
         JOIN entities f ON f.id = r.from_entity_id
         JOIN entities t ON t.id = r.to_entity_id
         WHERE f.name = 'incoming'`,
      )
      .all();
    expect(relations, 'the link to an entity already stored was not rebuilt').toHaveLength(1);
  });

  it('restores a relation whose target appears LATER in the bundle', () => {
    // The defect itself, in the order `export` actually writes.
    const data = makeExport([
      { name: 'newer-note', relations: [{ to: 'older-note', type: 'implements' }] },
      { name: 'older-note' },
    ]);

    const result = importMemories({ data, merge_strategy: 'skip' });

    expect(result.imported).toBe(2);
    expect(result.errors, `unexpected errors: ${result.errors.join('; ')}`).toHaveLength(0);
    const relations = getDatabase()
      .prepare(
        `SELECT f.name AS "from", t.name AS "to", r.relation_type AS type
         FROM relations r
         JOIN entities f ON f.id = r.from_entity_id
         JOIN entities t ON t.id = r.to_entity_id`,
      )
      .all() as Array<{ from: string; to: string; type: string }>;
    expect(relations, 'the relation was dropped because its target came later').toHaveLength(1);
    expect(relations[0]).toEqual({ from: 'newer-note', to: 'older-note', type: 'implements' });
  });

  it('imports relations when target entity exists', () => {
    remember({ name: 'target-entity', type: 'note' });
    const data = makeExport([
      { name: 'source-entity', relations: [{ to: 'target-entity', type: 'depends-on' }] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('rolls back one archived entity when removing its fresh FTS row fails, then imports the rest', () => {
    const data = {
      ...makeExport([
        {
          name: 'archive-fails',
          observations: ['must not survive'],
          tags: ['must:not-survive'],
          relations: [{ to: 'survivor', type: 'depends-on' }],
        },
        { name: 'survivor', observations: ['still imported'] },
      ]),
      entities: [
        {
          ...makeExport([{ name: 'archive-fails' }]).entities[0],
          observations: ['must not survive'],
          tags: ['must:not-survive'],
          relations: [{ to: 'survivor', type: 'depends-on' }],
          status: 'archived' as const,
          created_at: '2024-01-02T03:04:05.000Z',
        },
        makeExport([{ name: 'survivor', observations: ['still imported'] }]).entities[0],
      ],
    };
    const db = getDatabase();
    const realPrepare = db.prepare.bind(db);
    const diagnostics: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      diagnostics.push(String(chunk));
      return true;
    });

    Object.defineProperty(db, 'prepare', {
      configurable: true,
      value: (sql: string) => {
        if (sql.includes('INSERT INTO entities_fts (entities_fts, rowid, name, observations)')) {
          throw new Error('injected archive FTS delete failure');
        }
        return realPrepare(sql);
      },
    });

    let result: ReturnType<typeof importMemories>;
    try {
      result = importMemories({ data, merge_strategy: 'skip' });
    } finally {
      delete (db as unknown as { prepare?: unknown }).prepare;
      stderrSpy.mockRestore();
    }

    expect(diagnostics.some((line) => line.includes('removeFromFts'))).toBe(true);
    expect(result.imported, 'the failed entity was counted as imported').toBe(1);
    expect(result.overwritten).toBe(0);
    expect(result.appended).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([
      'archive-fails: injected archive FTS delete failure',
    ]);
    expect(result.skipped_relations, 'a relation from a rolled-back entity was queued').toEqual([]);

    expect(db.prepare("SELECT name FROM entities WHERE name = 'archive-fails'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS c FROM observations WHERE content = 'must not survive'").get())
      .toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM tags WHERE tag = 'must:not-survive'").get())
      .toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM relations').get()).toMatchObject({ c: 0 });
    expect(recall({ query: 'must not survive' }), 'the rolled-back FTS document remained searchable').toEqual([]);
    expect(recall({ query: 'survivor' }).map((entity) => entity.name)).toEqual(['survivor']);
  });

  it('records entity errors in errors array', () => {
    // Force an error by using the same import twice with overwrite to trigger
    // edge case — we can also test via a bad entity name length (empty string
    // would fail Zod but not here since operations layer doesn't validate).
    // Most robust: test that errors array is always present and is an array.
    const data = makeExport([{ name: 'ok-entity' }]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('refuses a merge strategy it does not recognise, instead of overwriting', () => {
    // This used to be two `if`s and a fall-through, so ANY other string took
    // the overwrite path — the most destructive of the three, chosen on the
    // least information. The CLI now validates too, but the CLI is not the only
    // caller, and a guard that only exists one layer up is a guard the next
    // caller does not get.
    remember({ name: 'guarded', type: 'note', observations: ['ORIGINAL'] });
    const bundle = {
      version: '3.0.0',
      exported_at: '2026-08-10T00:00:00.000Z',
      entity_count: 1,
      entities: [{ name: 'guarded', type: 'note', observations: ['REPLACEMENT'], tags: [] }],
    };

    expect(() => importMemories({
      data: bundle as unknown as Parameters<typeof importMemories>[0]['data'],
      merge_strategy: 'sikp' as Parameters<typeof importMemories>[0]['merge_strategy'],
    })).toThrow(/Unknown merge strategy/);

    // Nothing was written on the way to the throw.
    const found = recall({ query: 'guarded' });
    expect(found[0]?.observations).toEqual(['ORIGINAL']);
  });

  describe('namespace: whose choice moves an existing entity', () => {
    /** A bundle that claims one entity, in `personal`. */
    function bundleFor(name: string) {
      return {
        version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 1,
        entities: [{ name, type: 'note', namespace: 'personal', observations: ['from bundle'], tags: [], relations: [] }],
      } as Parameters<typeof importMemories>[0]['data'];
    }

    it('the caller\'s override forces an entity that already exists', () => {
      // Documented as "force all imported entities into this namespace", and
      // it did not: `createEntity` applied a namespace on creation only, so
      // the override was accepted, ignored, and reported as success.
      remember({ name: 'held', type: 'note', observations: ['mine'], namespace: 'personal' });
      importMemories({ data: bundleFor('held'), merge_strategy: 'append', namespace: 'team' });
      expect(exportMemories({ namespace: 'team' }).entities.map(e => e.name)).toContain('held');
    });

    it('the bundle\'s own namespace does not relocate an entity you already have', () => {
      // The other direction, and the reason the override is not applied
      // blindly: a bundle should not be able to move a memory out of the
      // scope you keep it in just by mentioning it.
      remember({ name: 'kept', type: 'note', observations: ['mine'], namespace: 'team' });
      importMemories({ data: bundleFor('kept'), merge_strategy: 'append' });
      expect(exportMemories({ namespace: 'team' }).entities.map(e => e.name)).toContain('kept');
      expect(exportMemories({ namespace: 'personal' }).entities.map(e => e.name)).not.toContain('kept');
    });

    it('records where a bulk-moved entity came from', () => {
      // Import is the path where losing the breadcrumb hurts most: it moves
      // entities in bulk, so nobody can remember where each one was. The
      // record was being wiped — `updateEntityMetadata(name, () => built)`
      // rebuilt the whole column from a snapshot taken before `createEntity`,
      // discarding what `createEntity` had just written.
      remember({ name: 'bulk-moved', type: 'note', observations: ['mine'], namespace: 'team' });
      importMemories({ data: bundleFor('bulk-moved'), merge_strategy: 'append', namespace: 'personal' });

      const moved = recall({ query: 'bulk-moved' })[0];
      const meta = moved.metadata as Record<string, unknown>;
      expect(meta.previous_namespace, 'the import wiped the record of where it came from').toBe('team');
      // …and the import's own provenance is still there, so this is a merge
      // rather than one clobber traded for another.
      expect((meta.provenance as Record<string, unknown>).source).toBe('import');
      expect(meta.trust).toBe('untrusted');
    });

    // #359 round 6 (independent review): `namespace_moved_at` is written
    // alongside `previous_namespace` (knowledge-graph.ts ~420-432, the SAME
    // namespace-move code) but was missing from `IMPORTABLE_METADATA_KEYS`
    // through round 5 — a REAL export -> import round trip silently dropped
    // it while its sibling survived. This test goes through the ACTUAL
    // `exportMemories()`/`importMemories()` pair, not hand-written metadata,
    // to prove the fix the way the defect was found.
    it("a moved entity's namespace-move breadcrumb pair survives a real export -> import round trip", () => {
      remember({ name: 'moved-note', type: 'note', observations: ['x'], namespace: 'personal' });
      // Re-remembering under a DIFFERENT namespace is what stamps
      // previous_namespace + namespace_moved_at (knowledge-graph.ts's own
      // namespace-move code, not the import path).
      remember({ name: 'moved-note', type: 'note', observations: ['x'], namespace: 'team' });
      const before = new KnowledgeGraph(getDatabase()).getEntity('moved-note')!.metadata as Record<string, unknown>;
      expect(before.previous_namespace, 'fixture: the move must have happened').toBe('personal');
      expect(typeof before.namespace_moved_at, 'fixture: the move must have stamped a timestamp').toBe('string');

      const bundle = exportMemories({});
      getDatabase().prepare("DELETE FROM entities WHERE name = 'moved-note'").run();
      importMemories({ data: bundle, merge_strategy: 'skip' });

      const after = new KnowledgeGraph(getDatabase()).getEntity('moved-note')!.metadata as Record<string, unknown>;
      expect(after.previous_namespace, 'previous_namespace did not survive the round trip').toBe('personal');
      expect(after.namespace_moved_at, 'namespace_moved_at did not survive the round trip').toBe(before.namespace_moved_at);
    });

    it('refuses a per-entity namespace outside the three, without losing the rest', () => {
      // The caller's override became an enum; the namespace a bundle carries
      // per entity did not. Over MCP a bundle is content an agent may have
      // been handed, and an unrecognised scope is invisible to every scoped
      // recall and to `export --namespace` while still squatting the name
      // database-wide. Reported per entity, so one bad row does not cost the
      // whole bundle.
      const bundle = {
        version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 2,
        entities: [
          { name: 'good', type: 'note', namespace: 'personal', observations: ['ok'], tags: [], relations: [] },
          { name: 'smuggled', type: 'note', namespace: 'attacker-scope', observations: ['bad'], tags: [], relations: [] },
        ],
      } as Parameters<typeof importMemories>[0]['data'];

      const result = importMemories({ data: bundle, merge_strategy: 'skip' });

      expect(result.imported, 'the good entry was lost along with the bad one').toBe(1);
      expect(result.errors.join(' ')).toContain('entities[1].namespace');
      expect(result.errors.join(' ')).toContain('attacker-scope');
      // The database is the check: nothing landed in the invented scope.
      expect(recall({ query: 'smuggled' })).toEqual([]);
      expect(recall({ query: 'good' })[0]?.namespace).toBe('personal');
    });

    it('the bundle\'s namespace still places entities the import creates', () => {
      importMemories({ data: bundleFor('brand-new'), merge_strategy: 'skip' });
      expect(exportMemories({ namespace: 'personal' }).entities.map(e => e.name)).toContain('brand-new');
    });
  });

  it('round-trips export then import', () => {
    remember({ name: 'round-trip', type: 'pattern', observations: ['fact 1', 'fact 2'], tags: ['t:a'] });

    // Export from source db
    const exported = exportMemories({});

    // Import into the same db (skip — entity already exists)
    const importResult = importMemories({ data: exported, merge_strategy: 'skip' });
    expect(importResult.skipped).toBe(1);
    expect(importResult.imported).toBe(0);
  });
});
