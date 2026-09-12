// #324 pieces A and B: `remember({ note })` and `remember({ replace: true })`.
import { describe, it, expect } from 'vitest';
import { remember, recall, forget, REPLACED_HISTORY_MAX, REPLACED_HISTORY_MAX_BYTES } from '../../src/core/operations.js';
import { deriveNote } from '../../src/core/note-derive.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { RememberSchema } from '../../src/transports/schemas.js';
import { exportMemories } from '../../src/core/serializer.js';
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

  it('rejects a note that yields more observations than a memory stores, and counts observations', () => {
    const note = ['title', ...Array.from({ length: 101 }, (_, i) => `p${i}`)].join('\n\n');
    expect(RememberSchema.safeParse({ note }).success).toBe(false);

    // The refusal must name the unit it counted. One paragraph of 101 list
    // items is 101 observations and ONE paragraph; the message used to call
    // them paragraphs, which is the noun D5 corrected in API_REFERENCE.md.
    const oneParagraph = `title\n\n${Array.from({ length: 101 }, (_, i) => `- item ${i}`).join('\n')}`;
    const r = RememberSchema.safeParse({ note: oneParagraph });
    expect(r.success).toBe(false);
    const message = r.error!.issues.map((i) => i.message).join(' ');
    expect(message).toContain('yields 101 observations');
    expect(message).not.toContain('paragraphs');
  });

  it('still rejects an unknown key', () => {
    expect(RememberSchema.safeParse({ note: 'x', notes: 'y' }).success).toBe(false);
  });
});

describe('remember({ replace: true }) on a forgotten memory — #324 C4', () => {
  it('refuses, and names a recovery path that actually works', () => {
    remember({ name: 'forgotten_thing', type: 'decision', observations: ['the original text'] });
    expect(forget({ name: 'forgotten_thing' }).archived).toBe(true);

    // `replace` rewrites the memory in place. On an archived row that is a
    // silent undo of an explicit forget, with the original text gone into
    // replaced_history and a live memory in its place — note-ingest.ts:395
    // refuses exactly this, and the direct call did not.
    expect(() => remember({
      name: 'forgotten_thing', type: 'decision', observations: ['smuggled back in'], replace: true,
    })).toThrow(/archived with forget/);

    const row = getDatabase().prepare('SELECT status FROM entities WHERE name = ?')
      .get('forgotten_thing') as { status: string };
    expect(row.status).toBe('archived');
    const obs = getDatabase().prepare(
      'SELECT content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ?',
    ).all('forgotten_thing') as { content: string }[];
    expect(obs.map((o) => o.content)).toEqual(['the original text']);
  });

  it('the recovery path in the message is real: plain remember brings it back, then replace works', () => {
    remember({ name: 'recovered_thing', type: 'decision', observations: ['original'] });
    forget({ name: 'recovered_thing' });

    // No `replace`: createEntity reactivates an archived row (knowledge-graph.ts).
    remember({ name: 'recovered_thing', type: 'decision', observations: ['original'] });
    expect((getDatabase().prepare('SELECT status FROM entities WHERE name = ?')
      .get('recovered_thing') as { status: string }).status).toBe('active');

    const replaced = remember({ name: 'recovered_thing', type: 'decision', observations: ['rewritten'], replace: true });
    expect(replaced.replaced).toBe(true);
  });

  it('a memory that was never archived still replaces', () => {
    remember({ name: 'live_thing', type: 'decision', observations: ['before'] });
    expect(remember({ name: 'live_thing', type: 'decision', observations: ['after'], replace: true }).replaced).toBe(true);
  });
});

describe('remember({ replace: true }) rewrites the type too — #324 C5', () => {
  it('the stored type follows the replacement, and the receipt reports what was stored', () => {
    remember({ name: 'retyped_thing', type: 'feedback', observations: ['before'] });
    const r = remember({ name: 'retyped_thing', type: 'decision', observations: ['after'], replace: true });
    expect(r.replaced).toBe(true);
    expect(r.type, 'the receipt echoed the old type').toBe('decision');
    expect((getDatabase().prepare('SELECT type FROM entities WHERE name = ?')
      .get('retyped_thing') as { type: string }).type).toBe('decision');
  });

  it('without `replace`, an append still reports the type that is actually stored', () => {
    remember({ name: 'appended_thing', type: 'feedback', observations: ['before'] });
    const r = remember({ name: 'appended_thing', type: 'decision', observations: ['after'] });
    // createEntity preserves the stored type on a name collision, so echoing
    // args.type would make the receipt claim a type that was never written.
    expect(r.type).toBe('feedback');
    expect((getDatabase().prepare('SELECT type FROM entities WHERE name = ?')
      .get('appended_thing') as { type: string }).type).toBe('feedback');
  });
});

describe('the replaced-history exits a user can actually reach — #324 C8', () => {
  it('`truncated` reaches the user through export, so it is a contract and not dead weight', () => {
    // The flag is set in one place and read nowhere in src/. It is not dead:
    // serializer emits `metadata` verbatim, and so does GET
    // /v1/entities/:name — so a user who exports a memory whose single
    // replaced version lost observations to the byte cap sees the flag that
    // says so. Pinning the exit is what makes cutting it a visible change.
    const huge = Array.from({ length: 10 }, (_, i) => `${'y'.repeat(9000)}${i}`);
    remember({ name: 'exported_huge', type: 'note', observations: huge });
    remember({ name: 'exported_huge', type: 'note', observations: ['small'], replace: true });

    const bundle = exportMemories({}) as { entities: Array<{ name: string; metadata?: Record<string, unknown> }> };
    const row = bundle.entities.find((e) => e.name === 'exported_huge');
    expect(row, 'the memory is not in the export at all').toBeDefined();
    const history = row!.metadata?.replaced_history as Array<{ truncated?: boolean; observations: string[] }>;
    expect(history).toHaveLength(1);
    expect(history[0].truncated).toBe(true);
    expect(history[0].observations.length).toBeLessThan(10);
  });

  it('recall does NOT carry the history — the count stands in for it', () => {
    remember({ name: 'recalled_hist', type: 'note', observations: ['first version text'] });
    remember({ name: 'recalled_hist', type: 'note', observations: ['second version text'], replace: true });
    const hit = recall({ query: 'recalled_hist' }).find((e) => e.name === 'recalled_hist')!;
    expect(hit.metadata?.replaced_history).toBeUndefined();
    expect(hit.metadata?.replaced_history_count).toBe(1);
  });
});

// #324 T3. `RememberResult.title` is what a caller of the MCP tool or
// `POST /v1/remember` sees; those transports return this object verbatim
// (mcp/handlers.ts:602, http/server.ts:726). It used to carry the REQUESTED
// title, so every call that did not pass one reported no title at all while
// the row plainly had one — and the note form reported nothing while
// `derived.title` advertised a title that was never stored. The CLI was
// taught to re-read the row; the API had no such escape.
//
// These assert on the RETURN VALUE, not on the entity. The earlier round of
// tests checked the entity, which was never the broken half.
describe('remember() reports the stored title — #324 T3', () => {
  const storedTitle = (name: string) => kg().getEntity(name)!.title;

  it('a new memory: the title it was given', () => {
    const r = remember({ name: 't3-new', type: 'note', title: 'Fresh', observations: ['a'] });
    expect(r.title).toBe('Fresh');
    expect(r.title).toBe(storedTitle('t3-new'));
  });

  it('replace with a new title: the new one', () => {
    remember({ name: 't3-rep', type: 'note', title: 'Old', observations: ['a'] });
    const r = remember({ name: 't3-rep', type: 'note', title: 'New', observations: ['b'], replace: true });
    expect(r.title).toBe('New');
    expect(r.title).toBe(storedTitle('t3-rep'));
  });

  it('replace with no title given: the title that was kept', () => {
    remember({ name: 't3-keep', type: 'note', title: 'Kept', observations: ['a'] });
    const r = remember({ name: 't3-keep', type: 'note', observations: ['b'], replace: true });
    expect(r.title).toBe('Kept');
    expect(r.title).toBe(storedTitle('t3-keep'));
  });

  it('a note appended to an existing memory: that memory\'s own title, not the derived one', () => {
    remember({ name: 't3-note', type: 'note', title: 'Its own', observations: ['a'] });
    const r = remember({ name: 't3-note', note: 'Derived headline\n\nbody' });
    expect(r.derived!.title).toBe('Derived headline');
    expect(r.title).toBe('Its own');
    expect(r.title).toBe(storedTitle('t3-note'));
  });

  it('a memory with no title at all: null, not absent', () => {
    const r = remember({ name: 't3-null', type: 'note', observations: ['a'] });
    expect(r.title).toBeNull();
    expect(r.title).toBe(storedTitle('t3-null'));
  });
});

// #333 T4. The documented way to correct a memory is `name` + `replace: true`.
// The type inheritance it needs has always been in operations.ts — `typeGiven
// && args.type !== existing.type` only rewrites the type when one was PASSED —
// so the only thing forcing a caller to restate `type` was the transport
// schema. These pin the seam where that was true: the value the call returns
// and the value the row holds, not what a surface prints.
describe('remember({ name, replace: true }) inherits the stored type — #333 T4', () => {
  it('the documented correction call omits `type` and the memory keeps the one it has', () => {
    remember({ name: 'pkce_decision', type: 'decision', title: 'PKCE', observations: ['before'] });

    // The transport must let it through: this is the call the instructions
    // and API_REFERENCE tell a caller to make.
    expect(RememberSchema.safeParse({ name: 'pkce_decision', replace: true, title: 'Use PKCE' }).success).toBe(true);

    const r = remember({ name: 'pkce_decision', replace: true, title: 'Use PKCE', observations: ['after'] });
    expect(r.replaced).toBe(true);
    expect(r.type, 'the receipt reported a type the caller never passed').toBe('decision');
    const row = getDatabase().prepare('SELECT type, title FROM entities WHERE name = ?')
      .get('pkce_decision') as { type: string; title: string | null };
    expect(row.type, 'the stored type was rewritten by an omitted field').toBe('decision');
    expect(row.title).toBe('Use PKCE');
    expect(ftsHits('after')).toContain('pkce_decision');
  });

  it('passing `type` still reclassifies — inheriting an omitted type did not disable C5', () => {
    remember({ name: 'still_retypes', type: 'feedback', observations: ['before'] });
    const r = remember({ name: 'still_retypes', type: 'decision', observations: ['after'], replace: true });
    expect(r.type).toBe('decision');
    expect((getDatabase().prepare('SELECT type FROM entities WHERE name = ?')
      .get('still_retypes') as { type: string }).type).toBe('decision');
  });

  it('`type` is still required without `replace` — the relaxation is scoped to the correction call', () => {
    const parsed = RememberSchema.safeParse({ name: 'brand_new', title: 'x', observations: ['y'] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.path[0] === 'type')).toBe(true);
  });

  it('`replace` on a name that does not exist asks for `type` instead of inventing one', () => {
    // Relaxing the schema opens a path that did not exist before: create a NEW
    // entity with no type. Defaulting it to "note" would be the same silent
    // reclassification the typeGiven guard exists to prevent, so core — the
    // layer that knows whether the name exists — refuses and says why.
    expect(() => remember({ name: 'never_stored_yet', replace: true, title: 'x', observations: ['y'] }))
      .toThrow(/no memory named "never_stored_yet".*pass `type`/s);
    expect((getDatabase().prepare('SELECT COUNT(*) AS c FROM entities WHERE name = ?')
      .get('never_stored_yet') as { c: number }).c, 'a typeless entity was created anyway').toBe(0);
  });
});
