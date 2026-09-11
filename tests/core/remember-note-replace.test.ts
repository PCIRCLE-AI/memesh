// #324 pieces A and B: `remember({ note })` and `remember({ replace: true })`.
import { describe, it, expect } from 'vitest';
import { remember, recall, REPLACED_HISTORY_MAX, REPLACED_HISTORY_MAX_BYTES } from '../../src/core/operations.js';
import { deriveNote } from '../../src/core/note-derive.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { RememberSchema } from '../../src/transports/schemas.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-note-replace-');

const kg = () => new KnowledgeGraph(getDatabase());
const ftsHits = (term: string) => kg().search(term).map((e) => e.name);
// Assembled at runtime so the literal never looks like a credential in source.
const FAKE_BEARER = ['Bearer', 'placeholderplaceholder1234'].join(' ');

describe('deriveNote', () => {
  it('first line → title, paragraphs → observations, slug+digest → name', () => {
    const d = deriveNote('# Use PKCE for auth\n\nImplicit flow leaks tokens.\n\n- rotate refresh tokens\n- pin redirect URIs')!;
    expect(d.title).toBe('Use PKCE for auth');
    expect(d.observations).toEqual(['Implicit flow leaks tokens.', 'rotate refresh tokens', 'pin redirect URIs']);
    expect(d.name).toMatch(/^use-pkce-for-auth-[a-f0-9]{8}$/);
  });

  it('a one-line note keeps its text as an observation too', () => {
    const d = deriveNote('Never squash-merge memesh PRs')!;
    expect(d.title).toBe('Never squash-merge memesh PRs');
    expect(d.observations).toEqual(['Never squash-merge memesh PRs']);
  });

  it('a title with no ASCII slugs to "note"', () => {
    expect(deriveNote('記憶不是狀態\n\n存下來的狀態必然腐爛')!.name).toMatch(/^note-[a-f0-9]{8}$/);
  });

  it('strips control characters and redacts credential-shaped text before deriving', () => {
    const d = deriveNote(`Deploy key rotated\n\nheader ${FAKE_BEARER} was leaked`)!;
    expect(d.title).toBe('Deploy key rotated');
    expect(d.observations.join(' ')).not.toContain('placeholderplaceholder');
    expect(d.observations.join(' ')).toContain('***REDACTED***');
  });

  it('an over-long first line titles from its first sentence and keeps the whole line', () => {
    const long = `Short first sentence. ${'x'.repeat(300)}`;
    const d = deriveNote(long)!;
    expect(d.title).toBe('Short first sentence.');
    expect(d.observations[0]).toBe(long);
  });

  it('empty after cleaning → null', () => {
    expect(deriveNote('   \n ')).toBeNull();
  });
});

describe('remember({ note }) — piece A', () => {
  it('stores the derived shape and echoes it', () => {
    const r = remember({ note: 'Use PKCE for auth\n\nImplicit flow leaks tokens.' });
    expect(r.stored).toBe(true);
    expect(r.type).toBe('note');
    expect(r.derived).toEqual({
      name: r.name,
      type: 'note',
      title: 'Use PKCE for auth',
      observations: ['Implicit flow leaks tokens.'],
    });
    const e = kg().getEntity(r.name)!;
    expect(e.title).toBe('Use PKCE for auth');
    expect(e.observations).toEqual(['Implicit flow leaks tokens.']);
    expect(ftsHits('implicit')).toContain(r.name);
  });

  it('the same text twice lands on one entity with no duplicate rows — lesson type included', () => {
    const a = remember({ note: 'Fix: retry the lock\n\nroot cause was a race', type: 'lesson_learned' });
    const b = remember({ note: 'Fix: retry the lock\n\nroot cause was a race', type: 'lesson_learned' });
    expect(b.name).toBe(a.name);
    expect(b.observations).toBe(0);
    expect(kg().getEntity(a.name)!.observations).toEqual(['root cause was a race']);
  });

  it('different text with the same first line gets a different entity', () => {
    const a = remember({ note: 'Release plan\n\nship Monday' });
    const b = remember({ note: 'Release plan\n\nship Friday' });
    expect(a.name).not.toBe(b.name);
    expect(kg().getEntity(a.name)!.observations).toEqual(['ship Monday']);
  });

  it('keeps tags, an explicit type and an explicit name', () => {
    const r = remember({ note: 'Gate on exit codes', type: 'lesson', tags: ['project:x'], name: 'exit-code-lesson' });
    expect(r.name).toBe('exit-code-lesson');
    expect(r.type).toBe('lesson');
    expect(kg().getEntity('exit-code-lesson')!.tags).toContain('project:x');
  });

  it('a note appended to an existing named memory does not overwrite its title', () => {
    remember({ name: 'n1', type: 'note', title: 'Original title', observations: ['first'] });
    remember({ name: 'n1', note: 'Another headline\n\nsecond' });
    const e = kg().getEntity('n1')!;
    expect(e.title).toBe('Original title');
    expect(e.observations).toEqual(['first', 'second']);
  });
});

describe('remember({ replace: true }) — piece B', () => {
  it('rewrites observations, drops the old text from FTS, and keeps a dated history', () => {
    remember({ name: 'auth', type: 'decision', title: 'Auth v1', observations: ['use implicit flow'], tags: ['project:a'] });
    const r = remember({ name: 'auth', type: 'decision', title: 'Auth v2', observations: ['use pkce flow'], replace: true });
    expect(r.replaced).toBe(true);

    const e = kg().getEntity('auth')!;
    expect(e.title).toBe('Auth v2');
    expect(e.observations).toEqual(['use pkce flow']);
    // Tags omitted → kept.
    expect(e.tags).toContain('project:a');

    // The contentless-FTS row must no longer answer for the replaced text.
    expect(ftsHits('implicit')).not.toContain('auth');
    expect(ftsHits('pkce')).toContain('auth');

    const history = e.metadata?.replaced_history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ title: 'Auth v1', observations: ['use implicit flow'], tags: ['project:a'] });
    expect(Date.parse(history[0].replaced_at as string)).not.toBeNaN();
  });

  it('replace with tags rewrites the tags', () => {
    remember({ name: 't', type: 'note', observations: ['a'], tags: ['old'] });
    remember({ name: 't', type: 'note', observations: ['b'], tags: ['new'], replace: true });
    expect(kg().getEntity('t')!.tags).toEqual(['new']);
  });

  it('replace on a name that does not exist creates it and says so', () => {
    const r = remember({ name: 'fresh', type: 'note', observations: ['x'], replace: true });
    expect(r.replaced).toBe(false);
    expect(kg().getEntity('fresh')!.observations).toEqual(['x']);
  });

  it('replace with a note and an explicit name rewrites title and observations', () => {
    remember({ name: 'plan', note: 'Plan A\n\nstep one' });
    remember({ name: 'plan', note: 'Plan B\n\nstep two', replace: true });
    const e = kg().getEntity('plan')!;
    expect(e.title).toBe('Plan B');
    expect(e.observations).toEqual(['step two']);
    expect(ftsHits('one')).not.toContain('plan');
  });

  it('history is capped', () => {
    remember({ name: 'h', type: 'note', observations: ['v0'] });
    for (let i = 1; i <= REPLACED_HISTORY_MAX + 3; i++) {
      remember({ name: 'h', type: 'note', observations: [`v${i}`], replace: true });
    }
    const history = kg().getEntity('h')!.metadata?.replaced_history as unknown[];
    expect(history).toHaveLength(REPLACED_HISTORY_MAX);
  });

  it('the default path still appends', () => {
    remember({ name: 'app', type: 'note', observations: ['one'] });
    const r = remember({ name: 'app', type: 'note', observations: ['two'] });
    expect(r.replaced).toBeUndefined();
    expect(kg().getEntity('app')!.observations).toEqual(['one', 'two']);
  });

  it('recall reports how many versions were replaced, not the versions; the entity read has them', () => {
    remember({ name: 'r1', type: 'note', observations: ['alpha wrong'] });
    remember({ name: 'r1', type: 'note', observations: ['alpha right'], replace: true });
    const hit = recall({ query: 'alpha' }).find((e) => e.name === 'r1')!;
    expect(hit.metadata?.replaced_history).toBeUndefined();
    expect(hit.metadata?.replaced_history_count).toBe(1);
    expect((kg().getEntity('r1')!.metadata?.replaced_history as Array<{ observations: string[] }>)[0].observations).toEqual(['alpha wrong']);
  });

  it('history is bounded in bytes, oldest first, and one oversized version is truncated', () => {
    const big = 'x'.repeat(9000);
    remember({ name: 'big', type: 'note', observations: [`${big}0`] });
    for (let i = 1; i <= 12; i++) {
      remember({ name: 'big', type: 'note', observations: [`${big}${i}`], replace: true });
    }
    const history = kg().getEntity('big')!.metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThan(12);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(REPLACED_HISTORY_MAX_BYTES);
    // Oldest dropped: the newest replaced version (v11) is still there.
    expect(history.at(-1)!.observations[0]).toBe(`${big}11`);

    const huge = Array.from({ length: 10 }, (_, i) => `${'y'.repeat(9000)}${i}`);
    remember({ name: 'huge', type: 'note', observations: huge });
    remember({ name: 'huge', type: 'note', observations: ['small'], replace: true });
    const only = kg().getEntity('huge')!.metadata?.replaced_history as Array<{ observations: string[]; truncated?: boolean }>;
    expect(only).toHaveLength(1);
    expect(only[0].truncated).toBe(true);
    expect(only[0].observations.length).toBeGreaterThan(0);
    expect(only[0].observations.length).toBeLessThan(10);
  });

  it('replace keeps the memory\'s relations', () => {
    remember({ name: 'target', type: 'note', observations: ['t'] });
    remember({ name: 'src', type: 'note', observations: ['v1'], relations: [{ to: 'target', type: 'related-to' }] });
    remember({ name: 'src', type: 'note', observations: ['v2'], replace: true });
    expect(kg().getEntity('src')!.relations).toEqual([{ from: 'src', to: 'target', type: 'related-to' }]);
  });
});

describe('RememberSchema (transport validation)', () => {
  it('accepts note alone', () => {
    expect(RememberSchema.safeParse({ note: 'hello' }).success).toBe(true);
  });

  it('rejects note combined with title or observations, naming the key', () => {
    const r = RememberSchema.safeParse({ note: 'hello', observations: ['x'] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(['observations']);
  });

  it('rejects replace + note without a name', () => {
    const r = RememberSchema.safeParse({ note: 'hello', replace: true });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(['name']);
  });

  it('rejects a blank note and a structured call missing type', () => {
    expect(RememberSchema.safeParse({ note: '  ' }).success).toBe(false);
    const r = RememberSchema.safeParse({ name: 'x' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(['type']);
  });

  it('rejects a note that splits into more paragraphs than a memory stores', () => {
    const note = ['title', ...Array.from({ length: 101 }, (_, i) => `p${i}`)].join('\n\n');
    expect(RememberSchema.safeParse({ note }).success).toBe(false);
  });

  it('still rejects an unknown key', () => {
    expect(RememberSchema.safeParse({ note: 'x', notes: 'y' }).success).toBe(false);
  });
});
