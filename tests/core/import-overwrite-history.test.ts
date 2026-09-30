import { describe, it, expect } from 'vitest';
import { remember, importMemories, REPLACED_HISTORY_MAX_BYTES } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

useTestDatabase('memesh-import-overwrite-history-');

function bundle(name: string, observations: string[], tags: string[] = []) {
  return {
    version: '3.1.0', exported_at: '2026-09-14T00:00:00.000Z', entity_count: 1,
    entities: [{ name, type: 'decision', namespace: 'personal', relations: [], observations, tags }],
  };
}

const entityOf = (name: string) => new KnowledgeGraph(getDatabase()).getEntity(name)!;

describe('#530 import overwrite keeps the previous content in replaced_history', () => {
  it('files the old observations and tags into replaced_history', () => {
    importMemories({ data: bundle('x', ['one'], ['t-old']), merge_strategy: 'skip' });
    importMemories({ data: bundle('x', ['two']), merge_strategy: 'append' });
    expect(entityOf('x').observations).toEqual(['one', 'two']);

    const result = importMemories({ data: bundle('x', ['back'], ['t-new']), merge_strategy: 'overwrite' });
    expect(result.overwritten).toBe(1);

    const e = entityOf('x');
    expect(e.observations).toEqual(['back']);
    expect(e.tags).toEqual(['t-new']);
    const history = e.metadata?.replaced_history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0].observations).toEqual(['one', 'two']);
    expect(history[0].tags).toEqual(['t-old']);
    expect(history[0].title).toBeNull();
    expect(typeof history[0].replaced_at).toBe('string');
  });

  it('keeps the title of the replaced version', () => {
    remember({ name: 'titled', type: 'decision', title: 'Old headline', observations: ['before'] });
    importMemories({ data: bundle('titled', ['after']), merge_strategy: 'overwrite' });
    const history = entityOf('titled').metadata?.replaced_history as Array<{ title: string | null; observations: string[] }>;
    expect(history).toHaveLength(1);
    expect(history[0].title).toBe('Old headline');
    expect(history[0].observations).toEqual(['before']);
  });

  it('keeps the older history and appends to it', () => {
    remember({ name: 'y', type: 'decision', observations: ['v1'] });
    remember({ name: 'y', type: 'decision', observations: ['v2'], replace: true });
    importMemories({ data: bundle('y', ['v3']), merge_strategy: 'overwrite' });
    const history = entityOf('y').metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history.map((h) => h.observations)).toEqual([['v1'], ['v2']]);
    expect(entityOf('y').observations).toEqual(['v3']);
  });

  it('never lets the bundle write the history of an existing memory', () => {
    remember({ name: 'z', type: 'decision', observations: ['real'] });
    const data = bundle('z', ['new']);
    (data.entities[0] as Record<string, unknown>).metadata = {
      replaced_history: [{ replaced_at: 'forged', title: null, observations: ['forged'], tags: [] }],
    };
    importMemories({ data, merge_strategy: 'overwrite' });
    const history = entityOf('z').metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history).toHaveLength(1);
    expect(history[0].observations).toEqual(['real']);
  });

  it('applies the same count bound as remember replace', () => {
    importMemories({ data: bundle('w', ['start']), merge_strategy: 'skip' });
    for (let i = 0; i < 25; i++) {
      importMemories({ data: bundle('w', [`v${i}`]), merge_strategy: 'overwrite' });
    }
    const history = entityOf('w').metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history).toHaveLength(20);
    expect(history[history.length - 1].observations).toEqual(['v23']);
  });

  it('keeps the 64 KiB bound when the replaced version carries many tags', () => {
    const tags = Array.from({ length: 300 }, (_, i) => String(i).padStart(3, '0') + 'x'.repeat(252));
    importMemories({ data: bundle('many-tags', ['old'], tags), merge_strategy: 'skip' });
    expect(entityOf('many-tags').tags).toHaveLength(300);
    importMemories({ data: bundle('many-tags', ['new']), merge_strategy: 'overwrite' });
    const history = entityOf('many-tags').metadata?.replaced_history as Array<{ observations: string[]; tags: string[]; truncated?: boolean }>;
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(REPLACED_HISTORY_MAX_BYTES);
    expect(history).toHaveLength(1);
    expect(history[0].truncated).toBe(true);
    expect(history[0].observations).toEqual(['old']);
    expect(history[0].tags.length).toBeGreaterThan(0);
    expect(history[0].tags).toEqual(tags.slice(0, history[0].tags.length));
  });

  it('records nothing for a new memory, skip, or append', () => {
    importMemories({ data: bundle('n', ['a']), merge_strategy: 'overwrite' });
    expect(entityOf('n').metadata?.replaced_history).toBeUndefined();
    importMemories({ data: bundle('n', ['b']), merge_strategy: 'skip' });
    importMemories({ data: bundle('n', ['c']), merge_strategy: 'append' });
    expect(entityOf('n').metadata?.replaced_history).toBeUndefined();
  });
});
