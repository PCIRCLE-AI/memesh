import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { remember } from '../../src/core/operations.js';
import { importMemories } from '../../src/core/serializer.js';
import { isAutoInjectable } from '../../src/core/work-topology.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-trust-washing-');

type Stored = { trust?: string; provenance?: { source?: string } };
const stored = (name: string) => new KnowledgeGraph(getDatabase()).getEntity(name)!.metadata as Stored;

// Adding to a memory that is not trusted must not make it trusted. Only an
// explicit decision (`--trust` on an import, the person's own memory folder)
// does that; an agent writing more text under the same name is not one.
describe('Feature: writing to an untrusted memory does not make it trusted', () => {
  function importedBundle(name: string) {
    importMemories({
      merge_strategy: 'skip',
      data: {
        version: '1', exported_at: new Date().toISOString(), entity_count: 1, relation_count: 0,
        entities: [{ name, type: 'fact', observations: ['text from a file someone else made'], tags: [] }], relations: [],
      } as never,
    });
  }

  it('a remember that adds to an imported memory leaves it untrusted and not injectable', () => {
    importedBundle('imported-fact');
    expect(stored('imported-fact')).toMatchObject({ trust: 'untrusted', provenance: { source: 'import' } });
    expect(isAutoInjectable(stored('imported-fact'))).toBe(false);

    remember({ name: 'imported-fact', type: 'fact', observations: ['an agent adds a line'] });

    expect(stored('imported-fact').trust).toBe('untrusted');
    expect(stored('imported-fact').provenance?.source).toBe('import');
    expect(isAutoInjectable(stored('imported-fact'))).toBe(false);
    // The text is there: only the trust is held back.
    expect(new KnowledgeGraph(getDatabase()).getEntity('imported-fact')!.observations).toContain('an agent adds a line');
  });

  it('a replace of an untrusted memory leaves it untrusted: an agent told to tidy an injected note must not make it trusted', () => {
    importedBundle('replaced-fact');
    remember({ name: 'replaced-fact', type: 'fact', replace: true, observations: ['rewritten by an agent'] });
    expect(stored('replaced-fact').trust).toBe('untrusted');
    expect(isAutoInjectable(stored('replaced-fact'))).toBe(false);
    expect(new KnowledgeGraph(getDatabase()).getEntity('replaced-fact')!.observations).toEqual(['rewritten by an agent']);
  });

  it('an untrusted note from another folder stays untrusted when an agent adds to it', () => {
    new KnowledgeGraph(getDatabase()).createEntity('foreign-note', 'feedback', {
      observations: ['from some folder'], tags: ['source:note-file'],
      metadata: { trust: 'untrusted', provenance: { source: 'note-file', note_dir_id: 'ffffffffffffffff' } }, trustOverride: 'untrusted',
    });
    remember({ name: 'foreign-note', type: 'feedback', observations: ['agent line'] });
    expect(stored('foreign-note').trust).toBe('untrusted');
    expect(isAutoInjectable(stored('foreign-note'))).toBe(false);
  });

  it('an explicit decision still works: a caller that says trusted makes it trusted', () => {
    importedBundle('vouched-fact');
    remember({ name: 'vouched-fact', type: 'fact', observations: ['the person vouches'], trustOverride: 'trusted' });
    expect(stored('vouched-fact').trust).toBe('trusted');
    expect(isAutoInjectable(stored('vouched-fact'))).toBe(true);
  });

  it('a memory an agent wrote stays trusted when an agent adds to it', () => {
    remember({ name: 'own-fact', type: 'fact', observations: ['first'] });
    remember({ name: 'own-fact', type: 'fact', observations: ['second'] });
    expect(stored('own-fact').trust).toBe('trusted');
  });
});
