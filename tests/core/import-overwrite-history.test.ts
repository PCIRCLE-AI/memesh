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

  it('restoring the same bundle again records nothing, so older versions are not pushed out', () => {
    remember({ name: 'r', type: 'decision', observations: ['genuine v1'] });
    remember({ name: 'r', type: 'decision', observations: ['v2'], replace: true });
    for (let i = 0; i < 22; i++) importMemories({ data: bundle('r', ['restored']), merge_strategy: 'overwrite' });
    const history = entityOf('r').metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history.map((h) => h.observations)).toEqual([['genuine v1'], ['v2']]);
  });

  it.each([
    ['a title-only change', { title: 'New title' }, true],
    ['a tag-only change', { tags: ['t2'] }, true],
    ['an observation-order change', { observations: ['b', 'a'] }, true],
    ['a tag-order-only change', { tags: ['t2', 't1'] }, false],
  ] as const)('overwrite with %s records a version only when stored content changed', (_label, change, recorded) => {
    const name = `diff-${_label.replace(/\W+/g, '-')}`;
    remember({ name, type: 'decision', title: 'Old title', observations: ['a', 'b'], tags: ['t1', 't2'] });
    const next = { title: 'Old title', observations: ['a', 'b'], tags: ['t1', 't2'], ...change };
    const data = bundle(name, [...next.observations], [...next.tags]);
    (data.entities[0] as Record<string, unknown>).title = next.title;
    importMemories({ data, merge_strategy: 'overwrite' });
    const history = entityOf(name).metadata?.replaced_history as unknown[] | undefined;
    expect(history?.length ?? 0).toBe(recorded ? 1 : 0);
  });

  it('remember replace also trims the tags of one oversized version to the 64 KiB bound', () => {
    const tags = Array.from({ length: 300 }, (_, i) => String(i).padStart(3, '0') + 'x'.repeat(252));
    remember({ name: 'rt', type: 'decision', observations: ['old'], tags });
    remember({ name: 'rt', type: 'decision', observations: ['new'], tags: ['t'], replace: true });
    const history = entityOf('rt').metadata?.replaced_history as Array<{ tags: string[]; truncated?: boolean }>;
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(REPLACED_HISTORY_MAX_BYTES);
    expect(history[0].truncated).toBe(true);
    expect(history[0].tags.length).toBeGreaterThan(0);
  });

  it('records nothing for a new memory, skip, or append', () => {
    importMemories({ data: bundle('n', ['a']), merge_strategy: 'overwrite' });
    expect(entityOf('n').metadata?.replaced_history).toBeUndefined();
    importMemories({ data: bundle('n', ['b']), merge_strategy: 'skip' });
    importMemories({ data: bundle('n', ['c']), merge_strategy: 'append' });
    expect(entityOf('n').metadata?.replaced_history).toBeUndefined();
  });

  it('refuses a bundle that names one memory twice, before writing anything', () => {
    remember({ name: 'dup', type: 'decision', observations: ['genuine v1'] });
    remember({ name: 'dup', type: 'decision', observations: ['genuine v2'], replace: true });
    remember({ name: 'dup', type: 'decision', observations: ['current'], replace: true });
    const big = Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(9000, 'y'));
    const data = bundle('unrelated-first', ['zebraprefixtoken']);
    data.entities.push({ ...bundle('dup', big).entities[0] });
    data.entities.push({ ...bundle('dup', ['secondtoken']).entities[0] });
    data.entity_count = 3;

    expect(() => importMemories({ data, merge_strategy: 'overwrite' })).toThrow(/names "dup" more than once\. Nothing was imported/);

    // Nothing was written: not the valid entry before the duplicates, not the index.
    expect(new KnowledgeGraph(getDatabase()).getEntity('unrelated-first')).toBeNull();
    const indexed = (token: string) => (getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM entities_fts WHERE entities_fts MATCH ?').get(token) as { n: number }).n;
    expect(indexed('zebraprefixtoken')).toBe(0);
    expect(indexed('secondtoken')).toBe(0);
    expect(indexed('current')).toBe(1);

    const e = entityOf('dup');
    expect(e.observations).toEqual(['current']);
    const history = e.metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history.map((h) => h.observations)).toEqual([['genuine v1'], ['genuine v2']]);
  });

  it('reports blank names one entry at a time instead of refusing the file as a duplicate', () => {
    const data = bundle('', ['x']);
    data.entities.push({ ...bundle('', ['y']).entities[0] });
    data.entities.push({ ...bundle('fine', ['z']).entities[0] });
    data.entity_count = 3;
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('no usable "name"');
    expect(entityOf('fine').observations).toEqual(['z']);
  });

  it('refuses two names that differ only in a lone surrogate, which the database stores as one', () => {
    remember({ name: 'x\uFFFD', type: 'decision', observations: ['genuine v1'] });
    remember({ name: 'x\uFFFD', type: 'decision', observations: ['genuine v2'], replace: true });
    remember({ name: 'x\uFFFD', type: 'decision', observations: ['current'], replace: true });
    const data = bundle('x\uD800', ['first']);
    data.entities.push({ ...bundle('x\uD801', ['second']).entities[0] });
    data.entity_count = 2;

    expect(() => importMemories({ data, merge_strategy: 'overwrite' })).toThrow(/more than once\. Nothing was imported/);

    const history = entityOf('x\uFFFD').metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history.map((h) => h.observations)).toEqual([['genuine v1'], ['genuine v2']]);
    expect(entityOf('x\uFFFD').observations).toEqual(['current']);
    // Two lone low halves, and two runs of lone high halves, are each one name too.
    for (const [a, b] of [['y\uDC00', 'y\uDC01'], ['z\uD800\uD800', 'z\uD801\uD802']]) {
      const pair = bundle(a, ['p']);
      pair.entities.push({ ...bundle(b, ['q']).entities[0] });
      pair.entity_count = 2;
      expect(() => importMemories({ data: pair, merge_strategy: 'skip' })).toThrow(/more than once/);
    }
    // A valid surrogate pair is one character: two emoji that differ in the high half are two names.
    const emoji = bundle('\u{1F600}', ['e']);
    emoji.entities.push({ ...bundle('\u{1F200}', ['f']).entities[0] });
    emoji.entity_count = 2;
    expect(importMemories({ data: emoji, merge_strategy: 'skip' }).imported).toBe(2);
  });
});
