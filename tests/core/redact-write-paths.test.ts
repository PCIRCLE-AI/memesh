// #523: every write path redacts credential-shaped text, not only `note`.
//
// `remember({ note })` has always cleaned its text (note-derive.ts), and the
// structured form stored `title` and `observations` verbatim — so the same
// connection string was kept or dropped depending on which argument carried
// it. `learn` builds its observations AND its entity name from the raw error
// text, so a secret in the error landed in the name too.
import { describe, it, expect, vi } from 'vitest';
import { remember, recall, learn, forget, importMemories, recallForAgent, setPinned, REPLACED_HISTORY_MAX, REPLACED_HISTORY_MAX_BYTES } from '../../src/core/operations.js';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { exportMemories } from '../../src/core/serializer.js';
import { matchingGuards, guardFromMetadata } from '../../src/core/guards.js';
import { handleTool } from '../../src/mcp/tools.js';
import { RememberSchema } from '../../src/transports/schemas.js';
import { RECALL_RESPONSE_MAX_BYTES } from '../../src/core/recall-agent-view.js';
import { handleMemoryCommand, MEMORY_ROOT } from '../../src/core/memory-tool.js';
import { setTaskState, getTaskState } from '../../src/core/task-state-store.js';
import { taskStateName } from '../../src/core/task-state.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { stageProductImprovement } from '../../src/core/product-improvements.js';
import { applyProposal } from '../../src/core/dreamer.js';
import { insertFtsRow, indexedObservationText } from '../../src/storage/fts-index.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { getDatabase } from '../../src/db.js';
import { holdsSecret, redactSecrets } from '../../src/core/paths.js';
import { createRequire } from 'node:module';
import type { ExportResult } from '../../src/core/types.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-redact-write-');

// Assembled at runtime so no line in the repository looks like a credential.
const DB_PASSWORD = 'hunter2hunter2';
const DB_URL = ['postgres://appuser', `${DB_PASSWORD}@db:5432/app`].join(':');
const TOKEN_VALUE = 'abc123abc123abc123';
const TOKEN_ASSIGNMENT = ['token', TOKEN_VALUE].join('=');

/** Every stored column that carries caller text, read straight off the graph. */
function storedText(name: string): string {
  const db = getDatabase();
  const entity = db.prepare('SELECT id, name, title FROM entities WHERE name = ?').get(name) as
    { id: number; name: string; title: string | null } | undefined;
  expect(entity, `entity ${name} was stored`).toBeTruthy();
  const observations = (db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity!.id) as
    { content: string }[]).map((o) => o.content);
  return JSON.stringify({ name: entity!.name, title: entity!.title, observations });
}

describe('remember with structured observations (#523)', () => {
  it('redacts a connection-string password in observations and a token in the title', () => {
    remember({
      name: 'staging-db',
      type: 'decision',
      title: `Set ${TOKEN_ASSIGNMENT} for staging`,
      observations: [`Staging database is ${DB_URL}`, 'Rotate quarterly.'],
      tags: ['project:redact-fixture'],
    });

    const stored = storedText('staging-db');
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).not.toContain(TOKEN_VALUE);
    expect(stored).toContain('***REDACTED***');
    // Text that is not a secret is kept exactly.
    expect(stored).toContain('Rotate quarterly.');

    const recalled = JSON.stringify(recall({ query: 'staging' }));
    expect(recalled).not.toContain(DB_PASSWORD);
    expect(recalled).not.toContain(TOKEN_VALUE);
  });

  it('redacts observations appended to an existing memory', () => {
    remember({ name: 'append-target', type: 'decision', observations: ['first'] });
    remember({ name: 'append-target', type: 'decision', observations: [`then ${DB_URL}`] });
    expect(storedText('append-target')).not.toContain(DB_PASSWORD);
  });

  it('redacts observations written through replace', () => {
    remember({ name: 'replace-target', type: 'decision', observations: ['first'] });
    remember({ name: 'replace-target', type: 'decision', observations: [`now ${DB_URL}`], replace: true });
    expect(storedText('replace-target')).not.toContain(DB_PASSWORD);
  });
});

describe('Anthropic memory tool (#523)', () => {
  const file = (name: string) => `${MEMORY_ROOT}/personal/${name}.md`;

  it('create stores the file text with credential-shaped lines redacted', () => {
    const result = handleMemoryCommand({
      command: 'create',
      path: file('deploy-notes'),
      file_text: `Deploy notes\nStaging database is ${DB_URL}\nRotate quarterly.`,
    });
    expect(result.isError).toBe(false);
    const stored = storedText('deploy-notes');
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).toContain('***REDACTED***');
    expect(stored).toContain('Rotate quarterly.');
  });

  it('a pretty-printed JSON file with nothing secret is stored as written, so str_replace on its text still matches', () => {
    const text = '{\n  "name": "deploy",\n  "id": 12345678901234567890,\n  "steps": [ "build" ,  "ship" ]\n}';
    expect(handleMemoryCommand({ command: 'create', path: file('pretty'), file_text: text }).isError).toBe(false);
    const edited = handleMemoryCommand({ command: 'str_replace', path: file('pretty'), old_str: '"steps": [ "build" ,  "ship" ]', new_str: '"steps": [ "build" ]' });
    expect(edited.isError).toBe(false);
    const stored = (getDatabase().prepare('SELECT content FROM observations WHERE entity_id = (SELECT id FROM entities WHERE name = ?) ORDER BY id').all('pretty') as { content: string }[]).map((o) => o.content).join('\n');
    expect(stored).toBe(text.replace('"steps": [ "build" ,  "ship" ]', '"steps": [ "build" ]'));
  });

  it('str_replace and insert redact the text they write', () => {
    new KnowledgeGraph(getDatabase()).createEntity('prefs', 'note', { observations: ['Favorite color: blue'], namespace: 'personal' });
    let result = handleMemoryCommand({
      command: 'str_replace',
      path: file('prefs'),
      old_str: 'Favorite color: blue',
      new_str: `Favorite color: blue; db is ${DB_URL}`,
    });
    expect(result.isError).toBe(false);
    result = handleMemoryCommand({
      command: 'insert',
      path: file('prefs'),
      insert_line: 1,
      insert_text: `Set ${TOKEN_ASSIGNMENT} first`,
    });
    expect(result.isError).toBe(false);
    const stored = storedText('prefs');
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).not.toContain(TOKEN_VALUE);
    expect(stored).toContain('Favorite color: blue');
  });
});

describe('Anthropic memory tool: credentials that span lines (#523)', () => {
  const file = (name: string) => `${MEMORY_ROOT}/personal/${name}.md`;
  // A PEM block and a `Bearer` + newline + token only match as a whole, so
  // splitting into lines BEFORE redacting stored the body verbatim. The
  // markers are assembled at runtime so no line in the repository is one.
  const pemMarker = (kind: string) => `-----${kind} RSA ${'PRIV' + 'ATE'} KEY-----`;
  const PEM = [pemMarker('BEGIN'), 'MIIEowIBAAKCAQEAsecretbodyline1AAAA', 'MIIEsecretbodyline2BBBB', pemMarker('END')].join('\n');
  const BEARER_SPLIT = ['Authorization: Bearer', 'abcdefghijklmnopqrstuvwxyz0123'].join('\n');

  it('create redacts a multi-line private key before the text is split into lines', () => {
    const result = handleMemoryCommand({ command: 'create', path: file('keys'), file_text: `note\n${PEM}\nafter` });
    expect(result.isError).toBe(false);
    const stored = storedText('keys');
    expect(stored).not.toContain('secretbodyline');
    expect(stored).toContain('***REDACTED***');
    expect(stored).toContain('after');
  });

  it('create stores no fragment of a generated key with no END line, however it is wrapped, broken or prefixed', () => {
    const REDACTED = '***REDACTED***';
    let n = 0;
    const readBack = (entity: string) => (getDatabase().prepare('SELECT content FROM observations WHERE entity_id = (SELECT id FROM entities WHERE name = ?) ORDER BY id').all(entity) as { content: string }[]).map((o) => o.content).join('\n');
    for (const key of [
      generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }),
      generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }),
    ]) {
      const [header, ...rest] = String(key.privateKey).trim().split('\n');
      const end = rest[rest.length - 1];
      const body = rest.slice(0, -1).join('');
      const reconstructs = (stored: string) => {
        try { createPrivateKey(`${header}\n${stored.replace(/\*\*\*REDACTED\*\*\*/g, '').replace(/[^A-Za-z0-9+/=]/g, '')}\n${end}\n`); return true; } catch { return false; }
      };
      const wrap = (widths: number[]) => {
        const lines: string[] = [];
        for (let i = 0, w = 0; i < body.length; w++) { const width = widths[Math.min(w, widths.length - 1)]; lines.push(body.slice(i, i + width)); i += width; }
        return lines;
      };
      for (const widths of [[1], [3], [8], [64], [2, 8, 64], [8, 64]]) {
        for (const sep of ['\n', '\r\n', '\\n', ' ', ' ']) {
          for (const prefix of ['', '> ', '+']) {
            const at = `wrap ${widths} / ${JSON.stringify(sep)} / ${JSON.stringify(prefix)}`;
            const entity = `grid-${n++}`;
            const text = `Saved it.\n${[header, ...wrap(widths).map((l) => prefix + l), `${prefix}(then) chmod 600`].join(sep)}`;
            expect(handleMemoryCommand({ command: 'create', path: file(entity), file_text: text }).isError, at).toBe(false);
            const stored = readBack(entity);
            expect(stored, at).toBe(`Saved it.\n${REDACTED}`);
            expect(reconstructs(stored), at).toBe(false);
          }
        }
      }
      // Junk in a key line, and a short last line with trailing text: nothing of the key is stored.
      const lines64 = wrap([64]);
      for (const text of [
        [header, lines64[0], `${lines64[1]}",`, ...lines64.slice(2)].join('\n'),
        [header, lines64[0], `${lines64[1]}\\",`, ...lines64.slice(2)].join('\n'),
        [header, ...lines64.slice(0, -1), `${lines64[lines64.length - 1].slice(0, 5)} "x`].join('\n'),
        [header, ...lines64.slice(0, -1), `${lines64[lines64.length - 1].slice(0, 15)} "x`].join('\n'),
        [header, '', 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF', '', ...lines64].join('\n'),
      ]) {
        const entity = `junk-${n++}`;
        expect(handleMemoryCommand({ command: 'create', path: file(entity), file_text: text }).isError).toBe(false);
        const stored = readBack(entity);
        expect(stored).toBe(REDACTED);
        expect(reconstructs(stored)).toBe(false);
      }
    }
  });

  it('create: a whole key in a JSON string masks that string; part of a key masks every string value of the document', () => {
    const REDACTED = '***REDACTED***';
    let n = 0;
    const create = (text: string) => {
      const entity = `json-${n++}`;
      expect(handleMemoryCommand({ command: 'create', path: file(entity), file_text: text }).isError).toBe(false);
      return (getDatabase().prepare('SELECT content FROM observations WHERE entity_id = (SELECT id FROM entities WHERE name = ?) ORDER BY id').all(entity) as { content: string }[]).map((o) => o.content).join('\n');
    };
    for (const key of [
      generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }),
      generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }),
    ]) {
      const [header, ...rest] = String(key.privateKey).trim().split('\n');
      const end = rest[rest.length - 1];
      const bodyLines = rest.slice(0, -1);
      const reconstructs = (stored: string) => {
        try { createPrivateKey(`${header}\n${stored.replace(/\*\*\*REDACTED\*\*\*/g, '').replace(/[^A-Za-z0-9+/=]/g, '')}\n${end}\n`); return true; } catch { return false; }
      };
      const expectNoBody = (stored: string) => {
        for (const line of bodyLines) expect(stored).not.toContain(line.slice(0, 40));
        expect(reconstructs(stored)).toBe(false);
      };
      for (const indent of [undefined, 2]) {
        const whole = { before: 'a "quoted", sibling', k: [header, ...bodyLines, end].join('\n'), n: 1, after: [1, 'x'] };
        const stored = create(JSON.stringify(whole, null, indent));
        expect(JSON.parse(stored), `indent ${indent}`).toEqual({ ...whole, k: REDACTED });
        expectNoBody(stored);
        for (const split of [
          ['before', `${header}\n`, ...bodyLines.map((l) => `${l}\n`), `${end}\n`, 'after', 42],
          ['before', `${header}\n`, ...bodyLines.map((l) => `${l}\n`), 'End.', 7],
          { a: header, b: bodyLines.join('\n'), c: 1 },
          [{ t: header }, ...bodyLines.map((t) => ({ t })), { t: end }],
        ]) {
          const storedSplit = create(JSON.stringify(split, null, indent));
          expectNoBody(storedSplit);
          const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
          expect(strings(JSON.parse(storedSplit)).every((v) => v === REDACTED)).toBe(true);
        }
      }
    }
  });

  it('str_replace redacts a Bearer token split across lines, and echoes what was stored', () => {
    new KnowledgeGraph(getDatabase()).createEntity('hdr', 'note', { observations: ['header', 'other'], namespace: 'personal' });
    const result = handleMemoryCommand({ command: 'str_replace', path: file('hdr'), old_str: 'header', new_str: BEARER_SPLIT });
    expect(result.isError).toBe(false);
    const stored = storedText('hdr');
    expect(stored).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(stored).toContain('other');
    // The response snippet shows the stored (redacted) text, not the request.
    expect(result.content).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(result.content).toContain('***REDACTED***');
  });
});

describe('task_state (#523)', () => {
  it('goal and next are stored redacted in title, observations and metadata, and injected redacted', () => {
    const project = 'redact-task-fixture';
    setTaskState({ project, patch: { goal: `migrate ${DB_URL}`, next: `set ${TOKEN_ASSIGNMENT} on staging` } });

    expect(JSON.stringify(getTaskState(project))).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(getTaskState(project))).not.toContain(TOKEN_VALUE);
    const stored = storedText(taskStateName(project));
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).not.toContain(TOKEN_VALUE);
    const meta = String((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(taskStateName(project)) as { metadata: string }).metadata);
    expect(meta).not.toContain(DB_PASSWORD);
    expect(meta).not.toContain(TOKEN_VALUE);
    expect(meta).toContain('***REDACTED***');

    const previous = process.env.MEMESH_BRIEFING;
    process.env.MEMESH_BRIEFING = 'standard';
    try {
      const text = assembleBriefing(project).text;
      expect(text).toContain('Goal:');
      expect(text).not.toContain(DB_PASSWORD);
      expect(text).not.toContain(TOKEN_VALUE);
    } finally {
      if (previous === undefined) delete process.env.MEMESH_BRIEFING;
      else process.env.MEMESH_BRIEFING = previous;
    }
  });
});

describe('import (#523)', () => {
  const bundle = (entities: Array<Record<string, unknown>>): ExportResult => ({
    version: '3.1.0', exported_at: '2026-09-30T00:00:00.000Z', entity_count: entities.length, entities,
  } as unknown as ExportResult);
  const entity = (name: string, extra: Record<string, unknown> = {}) => ({
    name, type: 'decision', namespace: 'personal', relations: [], tags: ['project:redact-fixture'],
    title: `Set ${TOKEN_ASSIGNMENT} for staging`,
    observations: [`Staging database is ${DB_URL}`, 'Rotate quarterly.'],
    metadata: {},
    ...extra,
  });

  it('a new imported entity is stored with title and observations redacted, name and tags kept', () => {
    importMemories({ data: bundle([entity('imported-new')]), merge_strategy: 'skip' });
    const stored = storedText('imported-new');
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).not.toContain(TOKEN_VALUE);
    expect(stored).toContain('***REDACTED***');
    expect(stored).toContain('"name":"imported-new"');
    expect(stored).toContain('Rotate quarterly.');
  });

  it('append merges redacted observations onto an existing entity', () => {
    remember({ name: 'imported-append', type: 'decision', observations: ['already here'] });
    importMemories({ data: bundle([entity('imported-append')]), merge_strategy: 'append' });
    const stored = storedText('imported-append');
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).toContain('already here');
    expect(stored).toContain('***REDACTED***');
  });

  it('a non-string observation is reported by the validator, not by the redactor', () => {
    const result = importMemories({ data: bundle([entity('imported-bad', { observations: ['fine', 42] })]), merge_strategy: 'skip' });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).not.toContain('is not a function');
    expect(result.errors[0]).toContain('observations[1] is number, not a string');
  });

  it('overwrite replaces an existing entity with redacted title and observations', () => {
    remember({ name: 'imported-overwrite', type: 'decision', observations: ['old text'] });
    importMemories({ data: bundle([entity('imported-overwrite')]), merge_strategy: 'overwrite' });
    const stored = storedText('imported-overwrite');
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).not.toContain(TOKEN_VALUE);
    expect(stored).not.toContain('old text');
    expect(stored).toContain('***REDACTED***');
  });
});

describe('the public KnowledgeGraph writer (#523)', () => {
  it('createEntity and createEntitiesBatch redact title and observations; name, tags and FTS stay exact', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('direct', 'note', { title: `Set ${TOKEN_ASSIGNMENT}`, observations: [`db ${DB_URL}`], tags: ['project:redact-fixture'] });
    kg.createEntitiesBatch([{ name: 'batch', type: 'note', observations: [`db ${DB_URL}`] }]);
    for (const name of ['direct', 'batch']) {
      const stored = storedText(name);
      expect(stored).not.toContain(DB_PASSWORD);
      expect(stored).not.toContain(TOKEN_VALUE);
      expect(stored).toContain('***REDACTED***');
    }
    // The keyword index sees the stored (redacted) text: the password is not searchable.
    expect(kg.search(DB_PASSWORD).map((e) => e.name)).toEqual([]);
    expect(kg.search('REDACTED').map((e) => e.name).sort()).toEqual(['batch', 'direct']);
  });

  it('replacing a legacy row files its old version redacted, and FTS forgets the old text', () => {
    // Seeded with raw SQL: this is a row written BEFORE #523, which no public
    // writer can produce any more.
    const db = getDatabase();
    const id = Number(db.prepare("INSERT INTO entities (name, type, title) VALUES ('legacy', 'note', ?)").run(`old ${TOKEN_ASSIGNMENT}`).lastInsertRowid);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, `old ${DB_URL}`);
    insertFtsRow(db, id, 'legacy', indexedObservationText(db, id), `old ${TOKEN_ASSIGNMENT}`);
    const kg = new KnowledgeGraph(getDatabase());
    expect(kg.search(DB_PASSWORD).map((e) => e.name)).toContain('legacy');

    remember({ name: 'legacy', type: 'note', title: 'clean', observations: ['clean'], replace: true });
    const entity = kg.getEntity('legacy')!;
    expect(entity.title).toBe('clean');
    expect(entity.observations).toEqual(['clean']);
    // The version `replace` files away is a NEW history entry and is
    // redacted like any other write (the public writer that trusted
    // its version argument is gone)…
    expect(JSON.stringify(entity.metadata?.replaced_history)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(entity.metadata?.replaced_history)).toContain('***REDACTED***');
    // …and the contentless FTS delete used the exact old text, so the old
    // password is no longer searchable.
    expect(kg.search(DB_PASSWORD).map((e) => e.name)).not.toContain('legacy');
  });
});

describe('dreamer product-improvement acceptance (#523)', () => {
  it('accepted title, observations and the two free-text metadata fields are stored redacted', () => {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    kg.createEntity('source', 'note', { observations: ['ordinary source'] });
    const proposal = stageProductImprovement(db, {
      project: 'redact-fixture', source_names: ['source'], title: `Title ${DB_URL}`,
      problem: `Problem ${DB_URL}`, proposed_change: 'change it',
      verification_scenario: `Verify ${TOKEN_ASSIGNMENT}`, success_criteria: [`No ${TOKEN_ASSIGNMENT}`],
    });
    const result = applyProposal(db, proposal.proposal_id, kg);
    const entity = kg.getEntity(result.digestEntityName)!;
    expect(entity.title).not.toContain(DB_PASSWORD);
    expect(entity.observations.join('\n')).not.toContain(DB_PASSWORD);
    const meta = JSON.stringify(entity.metadata);
    expect(meta).not.toContain(TOKEN_VALUE);
    expect(meta).toContain('***REDACTED***');
  });
});

describe('dreamer transcript and digest acceptance (#523)', () => {
  it('a pending proposal whose observations hold a credential is accepted redacted, with readback', () => {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const insertProposal = db.prepare(`INSERT INTO dream_proposals
      (project, cluster_key, source_ids, proposed_digest, prompt_version, source_kind, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'digest')`);
    const transcript = insertProposal.run(
      'redact-fixture', 'transcript-redact', JSON.stringify({ sessionId: 's1' }),
      JSON.stringify({ name: 'transcript-secret', type: 'decision', observations: [`db ${DB_URL}`], tags: [] }), 'v1', 'transcript',
    );
    const transcriptName = applyProposal(db, Number(transcript.lastInsertRowid), kg).digestEntityName;
    const sourceId = kg.createEntity('digest-source', 'commit', { observations: ['ordinary source'] });
    const digest = insertProposal.run(
      'redact-fixture', 'digest-redact', JSON.stringify([sourceId]),
      JSON.stringify({ name: 'digest-secret', type: 'digest', observations: [`db ${DB_URL}`], tags: [] }), 'v1', 'entities',
    );
    const digestName = applyProposal(db, Number(digest.lastInsertRowid), kg).digestEntityName;
    for (const name of [transcriptName, digestName]) {
      const stored = storedText(name);
      expect(stored).not.toContain(DB_PASSWORD);
      expect(stored).toContain('***REDACTED***');
    }
    expect(kg.search(DB_PASSWORD).map((e) => e.name)).toEqual([]);
  });
});

describe('redaction can lengthen text (#523)', () => {
  // `sk-abcd1 ` (9 chars) becomes `***REDACTED*** ` (15 chars): 1.667×.
  const key = 'sk-' + 'abcd1';
  const pattern = (n: number) => `${key} `.repeat(n);

  it('the title and observation caps are INPUT caps: accepted text may persist longer, and readback is clean', async () => {
    // 22 × 9 = 198 characters passes the 200-character schema cap on every
    // transport (MCP, HTTP and the CLI all validate with this schema).
    const parsed = RememberSchema.parse({ name: 'long-title', type: 'note', title: pattern(22), observations: [pattern(1111)] });
    expect(parsed.title!.length).toBeLessThanOrEqual(200);
    remember(parsed);
    const stored = storedText('long-title');
    expect(stored).not.toContain(key);
    expect(stored).toContain('***REDACTED***');
    // Persisted text is longer than the input cap — stated, not hidden.
    const db = getDatabase();
    const row = db.prepare('SELECT title, (SELECT content FROM observations WHERE entity_id = entities.id) AS content FROM entities WHERE name = ?').get('long-title') as { title: string; content: string };
    expect(row.title.length).toBeGreaterThan(200);
    expect(row.content.length).toBeGreaterThan(10000);
    // The OUTPUT cap is enforced on the stored bytes, so it still holds.
    const agentView = JSON.stringify(await recallForAgent({ query: 'REDACTED' }));
    expect(agentView).not.toContain(key);
    expect(Buffer.byteLength(agentView, 'utf8')).toBeLessThanOrEqual(RECALL_RESPONSE_MAX_BYTES + 1024);
  });

  it('the memory tool file-size cap is a PERSISTED cap: it is checked on the redacted text, so insert cannot exceed it', () => {
    new KnowledgeGraph(getDatabase()).createEntity('big', 'note', { observations: ['first'], namespace: 'personal' });
    // 20,000 × 9 = 180,000 raw characters (under the 256 KB cap); redacted
    // they become 300,000 (over it). The write must be refused, not stored.
    const result = handleMemoryCommand({ command: 'insert', path: `${MEMORY_ROOT}/personal/big.md`, insert_line: 1, insert_text: pattern(20_000) });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('over the');
    expect(storedText('big')).toBe(JSON.stringify({ name: 'big', title: null, observations: ['first'] }));
  });
});

describe('staged proposals, insert, import titles and snippets (#523)', () => {
  const file = (name: string) => `${MEMORY_ROOT}/personal/${name}.md`;

  it('a staged product-improvement proposal is stored redacted, and the staging response echoes the stored text', () => {
    const db = getDatabase();
    new KnowledgeGraph(db).createEntity('src-staged', 'note', { observations: ['ordinary source'] });
    const proposal = stageProductImprovement(db, {
      project: 'redact-fixture', source_names: ['src-staged'], title: `Title ${DB_URL}`,
      problem: `Problem ${TOKEN_ASSIGNMENT}`, proposed_change: 'change it',
      verification_scenario: `Verify ${DB_URL}`, success_criteria: [`No ${TOKEN_ASSIGNMENT}`],
    });
    const response = JSON.stringify(proposal);
    expect(response).not.toContain(DB_PASSWORD);
    expect(response).not.toContain(TOKEN_VALUE);
    const stored = String((db.prepare('SELECT proposed_digest FROM dream_proposals WHERE id = ?').get(proposal.proposal_id) as { proposed_digest: string }).proposed_digest);
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).not.toContain(TOKEN_VALUE);
    expect(stored).toContain('***REDACTED***');
    expect(stored).toContain('change it');
  });

  it('redaction is many-to-one: forget by the raw text of a line stored redacted is refused as ambiguous, the stored text removes it', () => {
    remember({ name: 'fg', type: 'note', observations: [`db is ${DB_URL}`, 'keep'] });
    const before = storedText('fg');
    let message = '';
    try { forget({ name: 'fg', observation: `db is ${DB_URL}` }); } catch (err) { message = String(err); }
    expect(message).toContain('No exact stored-text match');
    expect(message).not.toContain(DB_PASSWORD);
    expect(storedText('fg')).toBe(before);
    const result = JSON.stringify(forget({ name: 'fg', observation: JSON.parse(before).observations[0] }));
    expect(result).toContain('"observation_removed":true');
    expect(result).not.toContain(DB_PASSWORD);
    expect(storedText('fg')).toBe(JSON.stringify({ name: 'fg', title: null, observations: ['keep'] }));
  });

  it('insert redacts across the line break to an existing "Authorization: Bearer" line', () => {
    new KnowledgeGraph(getDatabase()).createEntity('hdr2', 'note', { observations: ['Authorization: Bearer', 'other'], namespace: 'personal' });
    const token = 'abcdefghijklmnopqrstuvwxyz0123';
    const result = handleMemoryCommand({ command: 'insert', path: file('hdr2'), insert_line: 1, insert_text: token });
    expect(result.isError).toBe(false);
    const stored = storedText('hdr2');
    expect(stored).not.toContain(token);
    expect(stored).toContain('***REDACTED***');
    expect(stored).toContain('other');
    const view = handleMemoryCommand({ command: 'view', path: file('hdr2') });
    expect(view.content).not.toContain(token);
  });

  it('an imported title is redacted BEFORE it is cut to 200 characters', () => {
    // The password starts at character 190 of the title, so a cut-then-redact
    // order leaves `postgres://appuser:hunter…` in the stored title.
    const title = `${'x'.repeat(171)} ${DB_URL}`;
    const data = { version: '3.1.0', exported_at: '2026-09-30T00:00:00.000Z', entity_count: 1, entities: [{
      name: 'imported-long-title', type: 'decision', namespace: 'personal', relations: [], tags: [], title, observations: ['clean'], metadata: {},
    }] } as unknown as ExportResult;
    importMemories({ data, merge_strategy: 'skip' });
    const row = getDatabase().prepare('SELECT title FROM entities WHERE name = ?').get('imported-long-title') as { title: string };
    expect(row.title).not.toContain('hunter');
    expect(row.title).not.toContain('postgres://appuser:');
    expect(row.title).toContain('***REDACTED***');
    expect(row.title.length).toBeLessThanOrEqual(200);
  });

  it('the str_replace response numbers its snippet on the REDACTED file, matching the next view', () => {
    // A multi-line key BEFORE the edit collapses to one line after redaction,
    // so a line number computed on the raw text would be off by three.
    // Seeded with raw SQL: a file written BEFORE #523 holds the raw key, one
    // line per observation (`createEntity` would already redact the header).
    const pemMarker = (kind: string) => `-----${kind} RSA ${'PRIV' + 'ATE'} KEY-----`;
    const db = getDatabase();
    const id = Number(db.prepare("INSERT INTO entities (name, type, namespace) VALUES ('keyed', 'note', 'personal')").run().lastInsertRowid);
    const addObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
    for (const line of [pemMarker('BEGIN'), 'MIIEowIBAAKCAQEAsecretbodyline1AAAA', 'MIIEsecretbodyline2BBBB', pemMarker('END'), 'target', 'after']) addObs.run(id, line);
    const result = handleMemoryCommand({ command: 'str_replace', path: file('keyed'), old_str: 'target', new_str: 'changed' });
    expect(result.isError).toBe(false);
    const view = handleMemoryCommand({ command: 'view', path: file('keyed') }).content;
    expect(view).toContain('     2\tchanged');
    expect(result.content).toContain('     2\tchanged');
    expect(result.content).not.toContain('     5\tchanged');
  });
});

describe('public metadata writers, accepted guards, legacy key bodies (#523)', () => {
  it('createEntity, createEntitiesBatch and updateEntityMetadata redact metadata string values; structure is kept', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('meta-lib', 'note', { observations: ['safe'], metadata: { verification_scenario: `Verify ${TOKEN_ASSIGNMENT}`, nested: { note: `db ${DB_URL}`, count: 3, flag: true } } });
    kg.createEntitiesBatch([{ name: 'meta-batch', type: 'note', observations: ['safe'], metadata: { success_criteria: [`No ${TOKEN_ASSIGNMENT}`] } }]);
    kg.createEntity('meta-upd', 'note', { observations: ['safe'] });
    kg.updateEntityMetadata('meta-upd', (current) => ({ ...current, verification_scenario: `Verify ${TOKEN_ASSIGNMENT}`, why: `db ${DB_URL}` }));
    for (const name of ['meta-lib', 'meta-batch', 'meta-upd']) {
      const meta = JSON.stringify(kg.getEntity(name)!.metadata);
      expect(meta).not.toContain(TOKEN_VALUE);
      expect(meta).not.toContain(DB_PASSWORD);
      expect(meta).toContain('***REDACTED***');
    }
    const lib = kg.getEntity('meta-lib')!.metadata as { nested: { count: number; flag: boolean } };
    expect(lib.nested.count).toBe(3);
    expect(lib.nested.flag).toBe(true);
  });

  const seedGuard = (lessonId: number, guard: Record<string, unknown>) => Number(getDatabase().prepare(`
    INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version, kind)
    VALUES ('redact-fixture', ?, ?, ?, 'guard-v1', 'guard')`).run(
    `guard:${lessonId}`, JSON.stringify([lessonId]), JSON.stringify({ guard, source_lesson: { id: lessonId, name: 'guard-src' } }),
  ).lastInsertRowid);

  it('an accepted guard stores its message redacted and its pattern and examples exactly as proposed', () => {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const lessonId = kg.createEntity('guard-src', 'lesson_learned', { observations: ['Error: checkout removed work', 'Fix: commit first'] });
    const proposalId = seedGuard(lessonId, {
      tool: 'Bash', pattern: 'git\\s+checkout\\s+--\\s', message: `Never use ${TOKEN_ASSIGNMENT}`,
      should_match: ['git checkout -- .', 'git checkout -- src/'], should_not_match: ['git checkout -b feature', 'git status'],
    });
    applyProposal(db, proposalId, kg);
    const raw = String((db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId) as { metadata: string }).metadata);
    expect(raw).not.toContain(TOKEN_VALUE);
    expect(raw).toContain('***REDACTED***');
    const saved = JSON.parse(raw).guard;
    expect(saved.pattern).toBe('git\\s+checkout\\s+--\\s');
    expect(saved.should_match).toEqual(['git checkout -- .', 'git checkout -- src/']);
    expect(saved.enabled).toBe(true);
  });

  it('a guard whose examples carry credential-shaped text is refused: nothing written, proposal still pending', () => {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const lessonId = kg.createEntity('guard-src', 'lesson_learned', { observations: ['Error: x', 'Fix: y'] });
    const proposalId = seedGuard(lessonId, {
      tool: 'Bash', pattern: 'git\\s+checkout\\s+--\\s', message: 'Never do this',
      should_match: [`git checkout -- src/ # ${TOKEN_ASSIGNMENT}`, 'git checkout -- .'], should_not_match: ['git checkout -b feature', 'git status'],
    });
    expect(() => applyProposal(db, proposalId, kg)).toThrow('credential-shaped text');
    const raw = String((db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId) as { metadata: string }).metadata ?? '');
    expect(raw).not.toContain('"guard"');
    expect(raw).not.toContain(TOKEN_VALUE);
    expect((db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(proposalId) as { status: string }).status).toBe('pending');
  });

  it('insert on a legacy file holding a key body one line per observation redacts the body on the untouched lines', () => {
    const db = getDatabase();
    const pemMarker = (kind: string) => `-----${kind} RSA ${'PRIV' + 'ATE'} KEY-----`;
    const bodyLine = 'MIIEowIBAAKCAQEAsecretbodyline1AAAA';
    const id = Number(db.prepare("INSERT INTO entities (name, type, namespace) VALUES ('legacy-pem', 'note', 'personal')").run().lastInsertRowid);
    const addObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
    for (const line of [pemMarker('BEGIN'), bodyLine, 'MIIEsecretbodyline2BBBB', pemMarker('END')]) addObs.run(id, line);
    const result = handleMemoryCommand({ command: 'insert', path: `${MEMORY_ROOT}/personal/legacy-pem.md`, insert_line: 4, insert_text: 'safe ending' });
    expect(result.isError).toBe(false);
    const stored = storedText('legacy-pem');
    expect(stored).not.toContain(bodyLine);
    expect(stored).toContain('***REDACTED***');
    expect(stored).toContain('safe ending');
  });
});

describe('legacy raw rows stay removable and editable, edits keep unrelated lines, reads redacted, guards intact (#523)', () => {
  const file = (name: string) => `${MEMORY_ROOT}/personal/${name}.md`;
  /** A row written BEFORE #523: raw SQL, credential as written. */
  const seedLegacy = (name: string, type: string, observations: string[], namespace = 'personal'): number => {
    const db = getDatabase();
    const id = Number(db.prepare('INSERT INTO entities (name, type, namespace) VALUES (?, ?, ?)').run(name, type, namespace).lastInsertRowid);
    for (const o of observations) db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, o);
    return id;
  };

  it('2a: forget removes a legacy raw observation by the text as originally sent, and never echoes the raw spelling', () => {
    seedLegacy('legacy-fg', 'note', [`db is ${DB_URL}`, 'keep']);
    const result = JSON.stringify(forget({ name: 'legacy-fg', observation: `db is ${DB_URL}` }));
    expect(result).toContain('"observation_removed":true');
    expect(result).not.toContain(DB_PASSWORD);
    expect(storedText('legacy-fg')).toBe(JSON.stringify({ name: 'legacy-fg', title: null, observations: ['keep'] }));
  });

  it('2b: str_replace edits a legacy raw line by its original text, and a miss never echoes the raw spelling', () => {
    seedLegacy('legacy-sr', 'note', [`db is ${DB_URL}`, 'other']);
    const hit = handleMemoryCommand({ command: 'str_replace', path: file('legacy-sr'), old_str: `db is ${DB_URL}`, new_str: 'db rotated' });
    expect(hit.isError).toBe(false);
    expect(hit.content).not.toContain(DB_PASSWORD);
    expect(storedText('legacy-sr')).toBe(JSON.stringify({ name: 'legacy-sr', title: null, observations: ['db rotated', 'other'] }));
    const miss = handleMemoryCommand({ command: 'str_replace', path: file('legacy-sr'), old_str: `gone ${DB_URL}`, new_str: 'x' });
    expect(miss.isError).toBe(true);
    expect(miss.content).not.toContain(DB_PASSWORD);
    expect(miss.content).toContain('***REDACTED***');
  });

  it('an edit never deletes the lines after a redacted token (redaction is idempotent)', () => {
    // Every insert/str_replace redacts the whole file again. A rule that read
    // `***REDACTED***` + base64-shaped lines as a key body ate the hash and
    // `next` below on the first insert, and reported success.
    const hash = '0123456789abcdef0123456789abcdef01234567';
    expect(handleMemoryCommand({ command: 'create', path: file('idem'), file_text: `deploy ${TOKEN_ASSIGNMENT}\n${hash}\nlonglonglonglonglong\nnext` }).isError).toBe(false);
    const expected = ['deploy ***REDACTED***', hash, 'longlonglonglonglong', 'next'];
    expect(JSON.parse(storedText('idem')).observations).toEqual(expected);
    expect(handleMemoryCommand({ command: 'insert', path: file('idem'), insert_line: 4, insert_text: 'appended' }).isError).toBe(false);
    expect(handleMemoryCommand({ command: 'str_replace', path: file('idem'), old_str: 'appended', new_str: 'appended twice' }).isError).toBe(false);
    const view = handleMemoryCommand({ command: 'view', path: file('idem') });
    expect(view.isError).toBe(false);
    for (const line of [...expected, 'appended twice']) expect(view.content).toContain(line);
    expect(JSON.parse(storedText('idem')).observations).toEqual([...expected, 'appended twice']);
  });

  it('a note that quotes a header with no END keeps the text before it and loses the text after it; edits of the stored file are stable', () => {
    const header = `-----BEGIN RSA ${'PRIV' + 'ATE'} KEY-----`;
    const end = `-----END RSA ${'PRIV' + 'ATE'} KEY-----`;
    const observations = (name: string) => JSON.parse(storedText(name)).observations as string[];
    // Created: the region from the header to the end of the text is masked.
    expect(handleMemoryCommand({ command: 'create', path: file('quoted-header'), file_text: `Intro line.\nThe key file starts with ${header}\nStep 2: chmod 600\nStep 3: ssh-add it` }).isError).toBe(false);
    expect(observations('quoted-header')).toEqual(['Intro line.', 'The key file starts with ***REDACTED***']);
    // Editing the stored (already masked) file changes nothing else and is a fixed point.
    expect(handleMemoryCommand({ command: 'insert', path: file('quoted-header'), insert_line: 2, insert_text: 'appended' }).isError).toBe(false);
    expect(handleMemoryCommand({ command: 'str_replace', path: file('quoted-header'), old_str: 'Intro line.', new_str: 'Intro changed.' }).isError).toBe(false);
    expect(observations('quoted-header')).toEqual(['Intro changed.', 'The key file starts with ***REDACTED***', 'appended']);
    // A genuine END closes the region: the text after it is kept.
    expect(handleMemoryCommand({ command: 'create', path: file('example-block'), file_text: `Example:\n${header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n${end}\nThen run ssh-add.` }).isError).toBe(false);
    expect(observations('example-block')).toEqual(['Example:', '***REDACTED***', 'Then run ssh-add.']);
    // A note written before #523 that quotes a header: the first edit masks from the header on, including the edited text after it.
    const legacy = Number(getDatabase().prepare("INSERT INTO entities (name, type) VALUES ('legacy-quoted', 'note')").run().lastInsertRowid);
    for (const line of ['Intro line.', `Starts with ${header}`, 'Step 2', 'Step 3']) getDatabase().prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(legacy, line);
    expect(handleMemoryCommand({ command: 'str_replace', path: file('legacy-quoted'), old_str: 'Step 3', new_str: 'Step three' }).isError).toBe(false);
    expect(observations('legacy-quoted')).toEqual(['Intro line.', 'Starts with ***REDACTED***']);
  });

  it('str_replace with a legacy raw line edits THAT line, not an unrelated ***REDACTED*** sibling', () => {
    seedLegacy('legacy-sr-order', 'note', [TOKEN_ASSIGNMENT, '***REDACTED***']);
    const r = handleMemoryCommand({ command: 'str_replace', path: file('legacy-sr-order'), old_str: TOKEN_ASSIGNMENT, new_str: 'EDITED' });
    expect(r.isError, r.content).toBe(false);
    expect(r.content).not.toContain(TOKEN_VALUE);
    expect(JSON.parse(storedText('legacy-sr-order')).observations).toEqual(['EDITED', '***REDACTED***']);
  });

  it('a raw selector whose redacted spelling is all that is stored is refused as ambiguous with no effect; a truly absent one is not found', () => {
    seedLegacy('absent-raw', 'note', ['***REDACTED***', 'keep']);
    expect(() => forget({ name: 'absent-raw', observation: TOKEN_ASSIGNMENT })).toThrow('No exact stored-text match');
    const sr = handleMemoryCommand({ command: 'str_replace', path: file('absent-raw'), old_str: TOKEN_ASSIGNMENT, new_str: 'EDITED' });
    expect(sr.isError).toBe(true);
    expect(sr.content).toContain('no exact stored-text match');
    expect(sr.content).not.toContain(TOKEN_VALUE);
    expect(JSON.parse(storedText('absent-raw')).observations).toEqual(['***REDACTED***', 'keep']);
    // Neither spelling stored: the documented not-found answer, unchanged.
    const gone = forget({ name: 'absent-raw', observation: 'never stored' });
    expect(gone.observation_removed).toBe(false);
    expect(gone.entity_found).toBe(true);
    const miss = handleMemoryCommand({ command: 'str_replace', path: file('absent-raw'), old_str: 'never stored', new_str: 'x' });
    expect(miss.content).toContain('did not appear verbatim');
    expect(JSON.parse(storedText('absent-raw')).observations).toEqual(['***REDACTED***', 'keep']);
  });

  it('setTaskState returns the redacted state, on a write and on a write that changed nothing', async () => {
    const project = 'legacy-task-write';
    getDatabase().prepare("INSERT INTO entities (name, type, status, metadata) VALUES (?, 'task-state', 'active', ?)").run(
      taskStateName(project),
      JSON.stringify({ task_state: { goal: `migrate ${DB_URL}`, next: 'same', updated_at: new Date().toISOString() } }),
    );
    const unchanged = setTaskState({ project, patch: { next: 'same' } });
    expect(unchanged.changed).toEqual([]);
    expect(JSON.stringify(unchanged)).not.toContain(DB_PASSWORD);
    const viaTool = JSON.stringify(await handleTool('task_state', { project, done: 'x' }));
    expect(viaTool).not.toContain(DB_PASSWORD);
    expect(viaTool).toContain('***REDACTED***');
  });

  it('a legacy raw task state is redacted on every READ surface (getTaskState, the MCP task_state read)', async () => {
    const project = 'legacy-task-fixture';
    getDatabase().prepare("INSERT INTO entities (name, type, status, metadata) VALUES (?, 'task-state', 'active', ?)").run(
      taskStateName(project),
      JSON.stringify({ task_state: { goal: `migrate ${DB_URL}`, next: `set ${TOKEN_ASSIGNMENT}`, updated_at: new Date().toISOString() } }),
    );
    const read = JSON.stringify(getTaskState(project));
    expect(read).not.toContain(DB_PASSWORD);
    expect(read).not.toContain(TOKEN_VALUE);
    expect(read).toContain('***REDACTED***');
    const viaTool = JSON.stringify(await handleTool('task_state', { project }));
    expect(viaTool).not.toContain(DB_PASSWORD);
    expect(viaTool).not.toContain(TOKEN_VALUE);
    // A restatement still overwrites the raw row: the write path compares the stored text.
    setTaskState({ project, patch: { goal: 'migrate the staging database' } });
    const raw = String((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(taskStateName(project)) as { metadata: string }).metadata);
    expect(raw).not.toContain(DB_PASSWORD);
  });

  it('a legacy accepted guard whose pattern looks like a credential survives a pin and an append, and still compiles', () => {
    const kg = new KnowledgeGraph(getDatabase());
    const pattern = 'api_key=[A-Za-z0-9_-]+';
    const id = kg.createEntity('guarded', 'lesson_learned', { observations: ['Error: leaked key', 'Fix: rotate'], metadata: {
      guard: { enabled: true, action: 'warn', tool: 'Bash', pattern, message: 'no keys in commands', should_match: ['curl x?api_key=zz99'], should_not_match: ['curl x'], fires: 0 },
    } });
    setPinned('guarded', true);
    remember({ name: 'guarded', type: 'lesson_learned', observations: ['Prevention: scan first'] });
    const saved = JSON.parse(String((getDatabase().prepare('SELECT metadata FROM entities WHERE id = ?').get(id) as { metadata: string }).metadata)).guard;
    expect(saved.pattern).toBe(pattern);
    expect(saved.should_match).toEqual(['curl x?api_key=zz99']);
    expect(() => new RegExp(saved.pattern, 'i')).not.toThrow();
    expect(matchingGuards([guardFromMetadata(id, JSON.stringify({ guard: saved }))!], 'Bash', 'curl x?api_key=zz99abcdef').length).toBe(1);
  });

  it('6b: matchingGuards reports a guard whose pattern no longer compiles instead of skipping it in silence', () => {
    const invalid = { lessonId: 7, tool: 'Bash', pattern: '***REDACTED***', message: 'm', action: 'warn' };
    const reported: number[] = [];
    expect(matchingGuards([invalid], 'Bash', 'anything', (g) => reported.push(g.lessonId))).toEqual([]);
    expect(reported).toEqual([7]);
  });

  it('a guard that DETECTS credentials is accepted; one whose EXAMPLE carries a credential is refused with a real action named', () => {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const lessonId = kg.createEntity('guard-src-legacy', 'lesson_learned', { observations: ['Error: x', 'Fix: y'] });
    const seed = (guard: Record<string, unknown>) => Number(db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version, kind)
      VALUES ('redact-fixture', ?, ?, ?, 'guard-v1', 'guard')`).run(
      `guard:${lessonId}:${Math.random()}`, JSON.stringify([lessonId]), JSON.stringify({ guard, source_lesson: { id: lessonId, name: 'guard-src-legacy' } }),
    ).lastInsertRowid);
    const detecting = { tool: 'Bash', pattern: 'api_key=[A-Za-z0-9_-]+', message: 'no keys in commands',
      should_match: ['curl x?api_key=zz99', 'curl y?api_key=a'], should_not_match: ['curl x', 'git status'] };
    applyProposal(db, seed(detecting), kg);
    const saved = JSON.parse(String((db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId) as { metadata: string }).metadata)).guard;
    expect(saved.pattern).toBe('api_key=[A-Za-z0-9_-]+');
    // The example must MATCH the pattern (validation runs first) AND be
    // credential-shaped: `api_key=` followed by 18 characters is both.
    const leaking = { ...detecting, should_match: [`curl x?api_key=${TOKEN_VALUE}`, 'curl y?api_key=a'] };
    const id = seed(leaking);
    expect(() => applyProposal(db, id, kg)).toThrow(`memesh dream reject ${id}`);
  });
});

describe('serialized metadata, fresh history, wrong-sibling forget, staging cap (#523)', () => {
  const metaOf = (name: string) => String((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as { metadata: string }).metadata);

  it('metadata is redacted as it will be serialized — a null-prototype dictionary and a toJSON() value cannot bypass it', () => {
    const kg = new KnowledgeGraph(getDatabase());
    const dict = Object.assign(Object.create(null), { verification_scenario: `Verify ${TOKEN_ASSIGNMENT}`, nested: { message: `db ${DB_URL}` } });
    kg.createEntity('null-proto', 'note', { observations: ['safe'], metadata: dict as Record<string, unknown> });
    kg.createEntity('json-object', 'note', { observations: ['safe'], metadata: { verification_scenario: { toJSON: () => `Verify ${TOKEN_ASSIGNMENT}` } } });
    kg.createEntity('json-upd', 'note', { observations: ['safe'] });
    kg.updateEntityMetadata('json-upd', () => Object.assign(Object.create(null), { why: { toJSON: () => `db ${DB_URL}` } }));
    for (const name of ['null-proto', 'json-object', 'json-upd']) {
      const meta = metaOf(name);
      expect(meta, name).not.toContain(TOKEN_VALUE);
      expect(meta, name).not.toContain(DB_PASSWORD);
      expect(meta, name).toContain('***REDACTED***');
    }
    expect(JSON.parse(metaOf('json-object')).verification_scenario).toBe('Verify ***REDACTED***');
  });

  it('a NEW replaced_history supplied by a caller is redacted; entries the row already holds stay exactly as stored', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('fresh-history', 'note', { observations: ['safe'], metadata: { replaced_history: [{ replaced_at: 't', title: `old ${TOKEN_ASSIGNMENT}`, observations: [`old ${DB_URL}`], tags: [] }] } });
    kg.createEntity('updated-history', 'note', { observations: ['safe'] });
    kg.updateEntityMetadata('updated-history', (m) => ({ ...m, replaced_history: [{ replaced_at: 't', title: `old ${TOKEN_ASSIGNMENT}`, observations: [`old ${DB_URL}`], tags: [] }] }));
    for (const name of ['fresh-history', 'updated-history']) {
      expect(metaOf(name), name).not.toContain(TOKEN_VALUE);
      expect(metaOf(name), name).not.toContain(DB_PASSWORD);
      expect(metaOf(name), name).toContain('***REDACTED***');
    }
    // A legacy row's stored history survives a later metadata write byte-for-byte.
    const legacy = { replaced_at: 't0', title: `legacy ${TOKEN_ASSIGNMENT}`, observations: ['legacy'], tags: [] };
    getDatabase().prepare("INSERT INTO entities (name, type, metadata) VALUES ('kept-history', 'note', ?)").run(JSON.stringify({ replaced_history: [legacy] }));
    kg.updateEntityMetadata('kept-history', (m) => ({ ...m, pin: true }));
    expect(JSON.parse(metaOf('kept-history')).replaced_history).toEqual([legacy]);
  });

  it('forget of a legacy raw line next to an unrelated ***REDACTED*** line removes the raw line, not the sibling', () => {
    const db = getDatabase();
    const id = Number(db.prepare("INSERT INTO entities (name, type) VALUES ('mixed-forget', 'note')").run().lastInsertRowid);
    // The raw line IS the credential, so its redacted spelling is exactly the
    // sibling's text — a redacted-first lookup deletes the sibling instead.
    for (const content of [TOKEN_ASSIGNMENT, '***REDACTED***']) db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, content);
    const result = forget({ name: 'mixed-forget', observation: TOKEN_ASSIGNMENT });
    expect(result.observation_removed).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN_VALUE);
    expect(new KnowledgeGraph(db).getEntity('mixed-forget')!.observations).toEqual(['***REDACTED***']);
    // A line stored redacted is removed by its stored spelling (what recall
    // shows); the raw text it was written from is refused as ambiguous (many raw texts
    // share one redacted spelling).
    remember({ name: 'new-forget', type: 'note', observations: [`db is ${DB_URL}`, 'keep'] });
    expect(() => forget({ name: 'new-forget', observation: `db is ${DB_URL}` })).toThrow('No exact stored-text match');
    const stored = new KnowledgeGraph(db).getEntity('new-forget')!.observations[0];
    expect(stored).toContain('***REDACTED***');
    expect(forget({ name: 'new-forget', observation: stored }).observation_removed).toBe(true);
    expect(new KnowledgeGraph(db).getEntity('new-forget')!.observations).toEqual(['keep']);
  });

  it('a staged title under the 200-character input cap is accepted even when redaction lengthens it', () => {
    new KnowledgeGraph(getDatabase()).createEntity('src-n1', 'note', { observations: ['safe'] });
    const title = ('sk-' + 'abcd1' + ' ').repeat(22);
    expect(title.length).toBe(198);
    const proposal = stageProductImprovement(getDatabase(), { project: 'redact-fixture', source_names: ['src-n1'], title, problem: 'problem', proposed_change: 'change', verification_scenario: 'verify', success_criteria: ['criterion'] });
    const stored = String((getDatabase().prepare('SELECT proposed_digest FROM dream_proposals WHERE id = ?').get(proposal.proposal_id) as { proposed_digest: string }).proposed_digest);
    expect(stored).not.toContain('sk-abcd1');
    expect(stored).toContain('***REDACTED***');
  });

  it('a staged success criterion under its 1000-character input cap is accepted even when redaction lengthens it', () => {
    new KnowledgeGraph(getDatabase()).createEntity('src-b5', 'note', { observations: ['safe'] });
    const criterion = ('sk-' + 'abcd1 ').repeat(111).trim();
    expect(criterion.length).toBe(998);
    const proposal = stageProductImprovement(getDatabase(), { project: 'redact-fixture', source_names: ['src-b5'], title: 'title', problem: 'problem', proposed_change: 'change', verification_scenario: 'verify', success_criteria: [criterion] });
    const stored = String((getDatabase().prepare('SELECT proposed_digest FROM dream_proposals WHERE id = ?').get(proposal.proposal_id) as { proposed_digest: string }).proposed_digest);
    expect(stored).not.toContain('sk-abcd1');
    expect(stored).toContain('***REDACTED***');
  });

  it('only guard.pattern is kept as given; the message, the examples and any other guard text are redacted', () => {
    const kg = new KnowledgeGraph(getDatabase());
    const guard = { enabled: true, tool: 'Bash', pattern: 'api_key=[A-Za-z0-9_-]+', message: `careful ${TOKEN_ASSIGNMENT}`, should_match: [`curl ${TOKEN_ASSIGNMENT}`], note: `db ${DB_URL}`, fires: 0 };
    kg.createEntity('guard-created', 'lesson_learned', { observations: ['Error: x'], metadata: { guard } });
    kg.createEntity('guard-updated', 'lesson_learned', { observations: ['Error: x'] });
    kg.updateEntityMetadata('guard-updated', (m) => ({ ...m, guard }));
    for (const name of ['guard-created', 'guard-updated']) {
      const saved = JSON.parse(metaOf(name)).guard;
      expect(saved.pattern, name).toBe('api_key=[A-Za-z0-9_-]+');
      expect(metaOf(name), name).not.toContain(TOKEN_VALUE);
      expect(metaOf(name), name).not.toContain(DB_PASSWORD);
      expect(saved.message, name).toBe('careful ***REDACTED***');
      expect(saved.fires, name).toBe(0);
    }
  });

  it('a replace on a legacy row files a redacted version that still honours the count and byte bounds, and every reader of the history still works', () => {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    // Short keys: redaction makes each ~1.67x longer, so a version under the
    // byte cap as stored can exceed it once redacted.
    const line = ('sk-' + 'abcd1 ').repeat(33).trim();
    const id = Number(db.prepare("INSERT INTO entities (name, type) VALUES ('legacy-bound', 'note')").run().lastInsertRowid);
    for (let i = 0; i < 200; i++) db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, `${line} ${i}`);
    remember({ name: 'legacy-bound', type: 'note', observations: ['v1'], replace: true });
    const history = JSON.parse(metaOf('legacy-bound')).replaced_history as Array<{ truncated?: boolean; observations: string[] }>;
    expect(metaOf('legacy-bound')).not.toContain('sk-abcd1');
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(REPLACED_HISTORY_MAX_BYTES);
    expect(history[0].truncated).toBe(true);
    // Count bound, over more replaces than it keeps.
    for (let i = 2; i <= REPLACED_HISTORY_MAX + 2; i++) remember({ name: 'legacy-bound', type: 'note', observations: [`v${i}`], replace: true });
    const later = JSON.parse(metaOf('legacy-bound')).replaced_history as Array<{ observations: string[] }>;
    expect(later).toHaveLength(REPLACED_HISTORY_MAX);
    expect(later[later.length - 1].observations).toEqual([`v${REPLACED_HISTORY_MAX + 1}`]);
    // Readers: recall's count, the entity read, and an export → import round trip.
    const hit = recall({ query: 'legacy-bound' }).find((e) => e.name === 'legacy-bound');
    expect(hit?.metadata?.replaced_history_count).toBe(REPLACED_HISTORY_MAX);
    expect((kg.getEntity('legacy-bound')!.metadata?.replaced_history as unknown[]).length).toBe(REPLACED_HISTORY_MAX);
    const bundle = exportMemories({}) as ExportResult;
    const row = bundle.entities.find((e) => e.name === 'legacy-bound')!;
    const copy = { ...bundle, entity_count: 1, entities: [{ ...row, name: 'legacy-bound-copy' }] } as ExportResult;
    expect(importMemories({ data: copy, merge_strategy: 'skip' }).imported).toBe(1);
    expect((kg.getEntity('legacy-bound-copy')!.metadata?.replaced_history as unknown[]).length).toBe(REPLACED_HISTORY_MAX);
  });

  it('the history byte bound holds for the whole entry when a legacy TITLE alone grows past it through redaction', () => {
    const db = getDatabase();
    const title = ('sk-' + 'abcd1 ').repeat(6600).trim();
    db.prepare("INSERT INTO entities (name, type, title) VALUES ('legacy-title', 'note', ?)").run(title);
    const id = (db.prepare("SELECT id FROM entities WHERE name = 'legacy-title'").get() as { id: number }).id;
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'old');
    const cut = remember({ name: 'legacy-title', type: 'note', title: 'new', observations: ['new'], replace: true });
    // A version that was only cut to fit is kept, so it is not reported as dropped.
    expect(cut.replaced).toBe(true);
    expect('previousVersionDropped' in cut).toBe(false);
    const history = JSON.parse(metaOf('legacy-title')).replaced_history as Array<{ title: string; truncated?: boolean }>;
    expect(history.length).toBeLessThanOrEqual(REPLACED_HISTORY_MAX);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(REPLACED_HISTORY_MAX_BYTES);
    expect(metaOf('legacy-title')).not.toContain('sk-abcd1');
    // The version was CUT, not dropped: one entry, marked truncated, whose
    // title is the start of the redacted original.
    expect(history).toHaveLength(1);
    expect(history[0].truncated).toBe(true);
    expect(history[0].title.length).toBeGreaterThan(0);
    expect(redactSecrets(title).startsWith(history[0].title)).toBe(true);
  });

  it('a version whose tags alone exceed the history byte cap is dropped, not stored over the cap', () => {
    const db = getDatabase();
    const id = Number(db.prepare("INSERT INTO entities (name, type) VALUES ('legacy-tags', 'note')").run().lastInsertRowid);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'old');
    for (let i = 0; i < 70; i++) db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, `${'t'.repeat(1000)}${i}`);
    const result = remember({ name: 'legacy-tags', type: 'note', observations: ['new'], replace: true });
    expect(JSON.parse(metaOf('legacy-tags')).replaced_history).toEqual([]);
    // The result says so: the memory was rewritten, but the old version is not in the history.
    expect(result.replaced).toBe(true);
    expect(result.previousVersionDropped).toBe(true);
  });

  it('a newest version that cannot fit is dropped alone: the earlier versions stay under the same bounds', () => {
    const db = getDatabase();
    const id = Number(db.prepare("INSERT INTO entities (name, type) VALUES ('legacy-keep', 'note')").run().lastInsertRowid);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'v0');
    // Twenty ordinary replaces: the history now holds REPLACED_HISTORY_MAX versions.
    for (let i = 1; i <= REPLACED_HISTORY_MAX; i++) {
      const normal = remember({ name: 'legacy-keep', type: 'note', observations: [`v${i}`], replace: true });
      expect('previousVersionDropped' in normal, `replace ${i}`).toBe(false);
    }
    const before = JSON.parse(metaOf('legacy-keep')).replaced_history as unknown[];
    expect(before).toHaveLength(REPLACED_HISTORY_MAX);
    // A legacy tag that alone is larger than the history cap, then one more replace.
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'x'.repeat(70000));
    expect(remember({ name: 'legacy-keep', type: 'note', observations: ['next'], replace: true }).previousVersionDropped).toBe(true);
    const after = JSON.parse(metaOf('legacy-keep')).replaced_history as Array<{ tags: string[] }>;
    expect(after).toEqual(before);
    expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThanOrEqual(REPLACED_HISTORY_MAX_BYTES);
    expect(JSON.stringify(after)).not.toContain('xxxxxxxxxx');
  });

  it('a title cut that lands inside an emoji drops the half pair', () => {
    const db = getDatabase();
    // 22222 emoji = 44444 UTF-16 units; the 0.9 cuts go 39999, 35999, 32399 —
    // each odd, so each lands between the two halves of a pair.
    const title = '\u{1F600}'.repeat(22222);
    db.prepare("INSERT INTO entities (name, type, title) VALUES ('legacy-emoji', 'note', ?)").run(title);
    const id = (db.prepare("SELECT id FROM entities WHERE name = 'legacy-emoji'").get() as { id: number }).id;
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'old');
    remember({ name: 'legacy-emoji', type: 'note', observations: ['new'], replace: true });
    const history = JSON.parse(metaOf('legacy-emoji')).replaced_history as Array<{ title: string; truncated?: boolean }>;
    expect(history).toHaveLength(1);
    expect(history[0].truncated).toBe(true);
    expect(history[0].title.length).toBeGreaterThan(0);
    expect(/[\uD800-\uDBFF]$/.test(history[0].title)).toBe(false);
    expect(title.startsWith(history[0].title)).toBe(true);
  });

  it('a guard pattern is kept as written only when it is a string; any other shape is redacted like other metadata', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('guard-obj-pattern', 'lesson_learned', { observations: ['Error: x'], metadata: { guard: { tool: 'Bash', pattern: { source: `x ${TOKEN_ASSIGNMENT}` }, message: 'm' } } });
    kg.createEntity('guard-arr-pattern', 'lesson_learned', { observations: ['Error: x'], metadata: { guard: { tool: 'Bash', pattern: [`x ${DB_URL}`], message: 'm' } } });
    for (const name of ['guard-obj-pattern', 'guard-arr-pattern']) {
      expect(metaOf(name), name).not.toContain(TOKEN_VALUE);
      expect(metaOf(name), name).not.toContain(DB_PASSWORD);
    }
  });

  it('history that is not an array, or that an updater pushes onto the stored array, is redacted', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('history-string', 'note', { observations: ['safe'], metadata: { replaced_history: `old ${TOKEN_ASSIGNMENT}` } });
    kg.createEntity('history-object', 'note', { observations: ['safe'] });
    kg.updateEntityMetadata('history-object', (m) => ({ ...m, replaced_history: { title: `old ${DB_URL}` } }));
    // The updater receives the stored metadata; mutating its array in place
    // must not make a new entry look like one the row already held.
    const legacy = { replaced_at: 't0', title: 'legacy', observations: ['legacy'], tags: [] };
    getDatabase().prepare("INSERT INTO entities (name, type, metadata) VALUES ('history-pushed', 'note', ?)").run(JSON.stringify({ replaced_history: [legacy] }));
    kg.updateEntityMetadata('history-pushed', (m) => {
      (m.replaced_history as unknown[]).push({ replaced_at: 't1', title: `new ${TOKEN_ASSIGNMENT}`, observations: [], tags: [] });
      return m;
    });
    // No public writer stores a caller-built version as given.
    const kgAny = kg as unknown as { appendReplacedHistory?: (name: string, version: unknown, bound: (h: unknown[]) => unknown[]) => void };
    kg.createEntity('history-appended', 'note', { observations: ['safe'] });
    kgAny.appendReplacedHistory?.('history-appended', { replaced_at: 't', title: `forged ${TOKEN_ASSIGNMENT}`, observations: [`forged ${DB_URL}`], tags: [] }, (h) => h);
    for (const name of ['history-string', 'history-object', 'history-pushed', 'history-appended']) {
      expect(metaOf(name), name).not.toContain(TOKEN_VALUE);
      expect(metaOf(name), name).not.toContain(DB_PASSWORD);
    }
    expect(JSON.parse(metaOf('history-pushed')).replaced_history[0]).toEqual(legacy);
  });
});

describe('import metadata (#523)', () => {
  it('fresh allow-listed text metadata and replaced_history entries are redacted', () => {
    const data = {
      version: '3.1.0', exported_at: '2026-09-30T00:00:00.000Z', entity_count: 1,
      entities: [{
        name: 'imported-meta', type: 'decision', namespace: 'personal', relations: [], tags: [],
        title: 'clean title', observations: ['clean'],
        metadata: {
          verification_scenario: `Verify ${TOKEN_ASSIGNMENT}`,
          success_criteria: [`No ${DB_URL}`],
          replaced_history: [{ replaced_at: '2026-09-29T00:00:00.000Z', title: `old ${TOKEN_ASSIGNMENT}`, observations: [`old ${DB_URL}`], tags: [] }],
        },
      }],
    } as unknown as ExportResult;
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.imported).toBe(1);
    const meta = JSON.stringify(new KnowledgeGraph(getDatabase()).getEntity('imported-meta')!.metadata);
    expect(meta).not.toContain(TOKEN_VALUE);
    expect(meta).not.toContain(DB_PASSWORD);
    expect(meta).toContain('***REDACTED***');
    // Structure and non-text values are untouched.
    expect(meta).toContain('"replaced_at":"2026-09-29T00:00:00.000Z"');
  });
});

describe('learn (#523)', () => {
  it('keeps a connection-string password out of the observations, the name and recall', () => {
    const result = learn({
      error: `Connection refused to ${DB_URL}`,
      fix: `Point the app at ${DB_URL} instead`,
      root_cause: `Old ${TOKEN_ASSIGNMENT} was revoked`,
      prevention: 'Rotate credentials through the vault.',
    });

    expect(result.name).not.toContain(DB_PASSWORD);
    const stored = storedText(result.name);
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).not.toContain(TOKEN_VALUE);
    expect(stored).toContain('***REDACTED***');
    expect(stored).toContain('Rotate credentials through the vault.');

    const recalled = JSON.stringify(recall({ query: 'Connection refused' }));
    expect(recalled).not.toContain(DB_PASSWORD);
    expect(recalled).not.toContain(TOKEN_VALUE);
  });
});

describe('a private key split across the strings of one write (#523)', () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const [header, ...rest] = String(key.privateKey).trim().split('\n');
  const end = rest[rest.length - 1];
  const bodyLines = rest.slice(0, -1);
  const expectNoBody = (stored: string) => {
    for (const line of bodyLines) expect(stored).not.toContain(line.slice(0, 40));
  };

  it('remember: a key written one line per observation stores no line of it', () => {
    remember({ name: 'split-observations', type: 'note', observations: [header, ...bodyLines, end] });
    const stored = storedText('split-observations');
    expectNoBody(stored);
    expect(JSON.parse(stored).observations.every((o: string) => o === '***REDACTED***')).toBe(true);
  });

  it('learn: a key split across its fields, or a password in a shadowed JSON key, reaches neither the observations nor the name', () => {
    // Masked as a set, the error has nothing left to tell the lesson apart: refused, nothing written.
    const before = (getDatabase().prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    expect(() => learn({ error: header, fix: bodyLines.join('\n'), root_cause: end })).toThrow(/did not store this lesson/);
    expect(() => learn({ error: `${'sk-'}${'abcd1234efgh'}`, fix: 'Rotate it.' })).toThrow(/did not store this lesson/);
    expect((getDatabase().prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n).toBe(before);
    const shadowed = learn({ error: `{"url":${JSON.stringify(DB_URL)},"url":"none"} refused`, fix: 'Rotate it.' });
    expect(shadowed.name).not.toContain(DB_PASSWORD);
    expect(storedText(shadowed.name)).not.toContain(DB_PASSWORD);
  });

  it('import: a history that no longer fits once redacted is left out, and the result says so', () => {
    const title = `${'sk-aaaa1 '.repeat(40)}`.trim();
    const result = importMemories({
      data: {
        version: '3.1.0', exported_at: '2026-09-30T00:00:00.000Z', entity_count: 1,
        entities: [{
          name: 'imported-history', type: 'decision', namespace: 'personal', relations: [], tags: [], title: 'now', observations: ['now'],
          metadata: { replaced_history: [{ replaced_at: '2026-09-29T00:00:00.000Z', title, observations: ['then'], tags: [] }] },
        }],
      } as unknown as ExportResult,
      merge_strategy: 'skip',
    });
    expect(title.length).toBeLessThanOrEqual(500);
    expect(redactSecrets(title).length).toBeGreaterThan(500);
    expect(result.imported).toBe(1);
    expect(result.errors).toEqual(['imported-history: imported without its replaced_history, which no longer fits its size limits once credentials in it are redacted']);
    const stored = getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('imported-history') as { metadata: string | null };
    expect(stored.metadata ?? '').not.toContain('replaced_history');
  });
});

describe('r15: sets, metadata and the decoded reading (#523)', () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const [header, ...rest] = String(key.privateKey).trim().split('\n');
  const end = rest[rest.length - 1];
  const bodyLines = rest.slice(0, -1);
  const expectNoBody = (stored: string) => {
    for (const line of bodyLines) expect(stored).not.toContain(line.slice(0, 40));
  };
  const escaped = (text: string) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

  it('a header escaped inside a JSON string masks the rest of the key in its siblings', () => {
    const jsonWithEscapedHeader = `{"h":"${escaped(header)}"}`;
    remember({ name: 'escaped-header-observations', type: 'note', observations: [jsonWithEscapedHeader, ...bodyLines] });
    expectNoBody(storedText('escaped-header-observations'));
    const doc = JSON.stringify({ a: jsonWithEscapedHeader, b: bodyLines.join('\n') });
    remember({ name: 'escaped-header-document', type: 'note', observations: [doc] });
    expectNoBody(storedText('escaped-header-document'));
  });

  it('the title and the observations are one set, and so are the fields of a task state', () => {
    remember({ name: 'title-split', type: 'note', title: header, observations: bodyLines });
    expectNoBody(storedText('title-split'));
    const project = 'r15-task';
    setTaskState({ project, patch: { goal: header, next: bodyLines.join(' ') } });
    const shown = JSON.stringify(getTaskState(project));
    expectNoBody(shown);
    const stored = getDatabase().prepare("SELECT title, metadata FROM entities WHERE name LIKE '%r15-task%'").get() as { title: string; metadata: string };
    expectNoBody(JSON.stringify(stored));
    // Timestamps are not text to mask.
    expect(JSON.parse(stored.metadata).task_state.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('metadata is redacted per string: trust, kind and timestamps stay; part of a key is refused, nothing written', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('meta-text', 'note', { observations: ['x'], metadata: { trust: 'untrusted', kind: 'product_improvement', accepted_at: '2026-01-01', note: `rotate ${TOKEN_ASSIGNMENT}` } });
    const meta = JSON.parse((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('meta-text') as { metadata: string }).metadata);
    expect(meta).toMatchObject({ trust: 'untrusted', kind: 'product_improvement', accepted_at: '2026-01-01' });
    expect(meta.note).not.toContain(TOKEN_VALUE);
    expect(() => kg.createEntity('meta-split', 'note', {
      observations: ['x'], metadata: { trust: 'untrusted', provenance: { source: 'import' }, verification_scenario: header, other: bodyLines.join('\n') },
    })).toThrow(/did not store this memory/);
    expect(getDatabase().prepare('SELECT 1 FROM entities WHERE name = ?').get('meta-split')).toBeUndefined();
  });

  it('a metadata key name holding a credential is refused, nothing written; text the row already holds is not checked again', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('meta-key', 'note', { observations: ['x'], metadata: { kept: 1 } });
    const before = (getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('meta-key') as { metadata: string }).metadata;
    expect(() => kg.updateEntityMetadata('meta-key', (m) => ({ ...m, [DB_URL]: 1 }))).toThrow(/key name holds a credential/);
    expect(() => kg.updateEntityMetadata('meta-key', (m) => ({ [DB_URL]: 1, ...m }))).toThrow(/key name holds a credential/);
    expect((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('meta-key') as { metadata: string }).metadata).toBe(before);
    // A row stored before #523 with a lone BEGIN line in its metadata can still be updated.
    getDatabase().prepare("UPDATE entities SET metadata = json_set(metadata, '$.verification_scenario', ?) WHERE name = ?").run(`see ${header}`, 'meta-key');
    setPinned('meta-key', false);
    remember({ name: 'meta-key', type: 'note', observations: ['appended'] });
    expect(storedText('meta-key')).toContain('appended');
  });

  it('a history entry whose title is not text is redacted string by string; a new entry holding a split key is masked as its own set', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('history-object-title', 'note', { observations: ['x'], metadata: { replaced_history: [{ replaced_at: '2026-01-01', title: { secret: DB_URL }, observations: [], tags: [] }] } });
    expect(JSON.stringify(getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('history-object-title'))).not.toContain(DB_PASSWORD);
    kg.createEntity('history-split', 'note', { observations: ['x'], metadata: { replaced_history: [{ replaced_at: '2026-01-02', title: header, observations: [...bodyLines, end], tags: [] }] } });
    const stored = JSON.parse((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('history-split') as { metadata: string }).metadata);
    expectNoBody(JSON.stringify(stored));
    expect(stored.replaced_history[0].replaced_at).toBe('2026-01-02');
  });

  it('a credential in a JSON key that JSON.parse drops is still secret-shaped', () => {
    expect(holdsSecret([`{"k":${JSON.stringify(TOKEN_ASSIGNMENT)},"k":"safe"}`])).toBe(true);
    expect(holdsSecret([`{"k":"sk-${'abcd1234efgh'}","k":"safe"}`])).toBe(true);
  });

  it('hook capture: the title and the observations are one set', () => {
    const require = createRequire(import.meta.url);
    const { captureEntity } = require('../../scripts/hooks/_shared.js');
    captureEntity(getDatabase(), { name: 'hook-split', type: 'session-insight', title: header, observations: bodyLines, tags: [] });
    expectNoBody(storedText('hook-split'));
  });

  it('the dreamer check: escaped pretty JSON is not secret-shaped; a split key is', () => {
    expect(holdsSecret(['{\n  "a": "line1\\nline2",\n  "path": "C:\\\\tmp",\n  "n": 1.50\n}'])).toBe(false);
    expect(holdsSecret([...bodyLines, end])).toBe(true);
    expect(holdsSecret([`see ${TOKEN_ASSIGNMENT}`])).toBe(true);
  });

  it('an imported history entry with part of a key does not mask the other entries', () => {
    const result = importMemories({
      data: {
        version: '3.1.0', exported_at: '2026-09-30T00:00:00.000Z', entity_count: 1,
        entities: [{
          name: 'history-entries', type: 'decision', namespace: 'personal', relations: [], tags: [], title: 'now', observations: ['now'],
          metadata: { replaced_history: [
            { replaced_at: '2026-09-28T00:00:00.000Z', title: 'first', observations: [...bodyLines, end], tags: [] },
            { replaced_at: '2026-09-29T00:00:00.000Z', title: 'second', observations: ['kept'], tags: ['t'] },
          ] },
        }],
      } as unknown as ExportResult,
      merge_strategy: 'skip',
    });
    expect(result.errors).toEqual([]);
    const history = JSON.parse((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('history-entries') as { metadata: string }).metadata).replaced_history;
    expectNoBody(JSON.stringify(history));
    expect(history[1]).toMatchObject({ replaced_at: '2026-09-29T00:00:00.000Z', title: 'second', observations: ['kept'], tags: ['t'] });
    expect(history[0].replaced_at).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('r18: part of a key beside new metadata text is refused as a whole (#523)', () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const [header, ...rest] = String(key.privateKey).trim().split('\n');
  const bodyLines = rest.slice(0, -1);
  const body = bodyLines.join('\n');
  const AMBIGUOUS = /cannot tell whether the new text continues that key/;
  const row = (name: string) => getDatabase().prepare('SELECT metadata, title, namespace FROM entities WHERE name = ?').get(name) as
    { metadata: string; title: string | null; namespace: string } | undefined;
  const observationCount = (name: string) => (getDatabase().prepare(
    'SELECT COUNT(*) n FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ?').get(name) as { n: number }).n;
  /** A row written before #523: its metadata holds a lone BEGIN line under `existing`. */
  const seedLegacyHeader = (name: string) => {
    new KnowledgeGraph(getDatabase()).createEntity(name, 'note', { observations: ['x'], metadata: { trust: 'trusted', kind: 'note', existing: 'x' } });
    getDatabase().prepare("UPDATE entities SET metadata = json_set(metadata, '$.existing', ?) WHERE name = ?").run(header, name);
  };

  it('F2: a stored lone BEGIN and a new body under a DIFFERENT top-level key: refused, metadata byte-identical', () => {
    seedLegacyHeader('r18-f2');
    const before = row('r18-f2')!.metadata;
    const kg = new KnowledgeGraph(getDatabase());
    expect(() => kg.updateEntityMetadata('r18-f2', (m) => ({ ...m, newbody: body }))).toThrow(AMBIGUOUS);
    expect(() => kg.updateEntityMetadata('r18-f2', (m) => ({ ...m, nested: { deeper: [body] } }))).toThrow(AMBIGUOUS);
    expect(row('r18-f2')!.metadata).toBe(before);
    expect(row('r18-f2')!.metadata).not.toContain(bodyLines[0].slice(0, 40));
  });

  it('X1a: a BEGIN in the observations or title and a body in the metadata of one createEntity: refused, no row', () => {
    const kg = new KnowledgeGraph(getDatabase());
    expect(() => kg.createEntity('r18-x1a', 'note', { observations: [header], metadata: { verification_scenario: body } })).toThrow(AMBIGUOUS);
    expect(() => kg.createEntity('r18-x1a', 'note', { title: header, observations: ['x'], metadata: { note: body } })).toThrow(AMBIGUOUS);
    expect(row('r18-x1a')).toBeUndefined();
    // The same note with no metadata is stored, the header masked.
    kg.createEntity('r18-x1a', 'note', { observations: [header] });
    expect(JSON.stringify(storedText('r18-x1a'))).not.toContain('BEGIN');
  });

  it('a legacy row keeps trust and kind; an unpin of a never-pinned row and an update with no new text succeed and store the lone line masked; a pin there is refused', () => {
    seedLegacyHeader('r18-pin');
    expect(() => setPinned('r18-pin', true)).toThrow(/memesh unpin/);
    expect(setPinned('r18-pin', false).found).toBe(true);
    seedLegacyHeader('r18-pin-noop');
    new KnowledgeGraph(getDatabase()).updateEntityMetadata('r18-pin-noop', (m) => ({ ...m }));
    expect(JSON.parse(row('r18-pin-noop')!.metadata).existing).toBe('***REDACTED***');
    const meta = JSON.parse(row('r18-pin')!.metadata);
    expect(meta).toMatchObject({ trust: 'trusted', kind: 'note', existing: '***REDACTED***' });
    expect(meta.pin).toBeUndefined();
    setPinned('r18-pin', true);
    expect(JSON.parse(row('r18-pin')!.metadata).pin).toBe(true);
  });

  it('recovery through existing writers: after an unpin, namespace move, replace and import append all succeed', () => {
    seedLegacyHeader('r18-recover');
    expect(() => remember({ name: 'r18-recover', type: 'note', observations: ['refused'] })).toThrow(AMBIGUOUS);
    expect(observationCount('r18-recover')).toBe(1);
    setPinned('r18-recover', false);
    remember({ name: 'r18-recover', type: 'note', observations: ['appended'], namespace: 'team' });
    expect(row('r18-recover')!.namespace).toBe('team');
    remember({ name: 'r18-recover', type: 'note', observations: ['replaced'], replace: true });
    const result = importMemories({
      data: {
        version: '3.1.0', exported_at: '2026-10-01T00:00:00.000Z', entity_count: 1,
        entities: [{ name: 'r18-recover', type: 'note', namespace: 'team', relations: [], tags: [], observations: ['imported'] }],
      } as unknown as ExportResult,
      merge_strategy: 'append',
    });
    expect(result.errors).toEqual([]);
    expect(JSON.parse(storedText('r18-recover')).observations).toEqual(['replaced', 'imported']);
    expect(row('r18-recover')!.metadata).not.toContain('BEGIN');
  });

  it('task_state: a legacy goal holding a lone BEGIN refuses new text with no new observation; an unpin recovers', () => {
    const project = 'r18-task';
    setTaskState({ project, patch: { goal: 'placeholder' } });
    const name = taskStateName(project);
    getDatabase().prepare("UPDATE entities SET metadata = json_set(metadata, '$.task_state.goal', ?) WHERE name = ?").run(header, name);
    const count = observationCount(name);
    const before = row(name)!.metadata;
    expect(() => setTaskState({ project, patch: { next: 'ship it' } })).toThrow(AMBIGUOUS);
    expect(observationCount(name)).toBe(count);
    expect(row(name)!.metadata).toBe(before);
    // Restating the goal is new text too; an unpin (no new text) stores the line masked first.
    expect(() => setTaskState({ project, patch: { goal: 'clean goal', next: 'ship it' } })).toThrow(AMBIGUOUS);
    setPinned(name, false);
    setTaskState({ project, patch: { goal: 'clean goal', next: 'ship it' } });
    expect(JSON.parse(row(name)!.metadata).task_state).toMatchObject({ goal: 'clean goal', next: 'ship it' });
  });

  it('a lone BEGIN or END held in replaced_history: new text is refused until an unpin, which masks only the entries holding part of a key', () => {
    const kg = new KnowledgeGraph(getDatabase());
    const entry = (at: string, observations: string[]) => ({ replaced_at: at, title: 'old', observations, tags: ['t'], truncated: false });
    kg.createEntity('r18-history-lock', 'note', { observations: ['x'], metadata: { trust: 'trusted', replaced_history: [
      entry('t0', ['first']), entry('t1', ['split', 'x']), entry('t2', ['last']),
    ] } });
    // Written before #523: entry t1 holds a header and a body line in two observations.
    getDatabase().prepare("UPDATE entities SET metadata = json_set(metadata, '$.replaced_history[1].observations', json(?)) WHERE name = ?")
      .run(JSON.stringify([header, bodyLines[0]]), 'r18-history-lock');
    const before = JSON.parse(row('r18-history-lock')!.metadata);
    expect(() => remember({ name: 'r18-history-lock', type: 'note', observations: ['more'] })).toThrow(AMBIGUOUS);
    expect(row('r18-history-lock')!.metadata).toBe(JSON.stringify(before));
    setPinned('r18-history-lock', false);
    const after = JSON.parse(row('r18-history-lock')!.metadata);
    expect(after.pin).toBeUndefined();
    expect(after.trust).toBe('trusted');
    expect(after.replaced_history.map((e: { replaced_at: string }) => e.replaced_at)).toEqual(['t0', 't1', 't2']);
    expect(JSON.stringify(after.replaced_history[0])).toBe(JSON.stringify(before.replaced_history[0]));
    expect(JSON.stringify(after.replaced_history[2])).toBe(JSON.stringify(before.replaced_history[2]));
    expect(after.replaced_history[1]).toMatchObject({ replaced_at: 't1', observations: ['***REDACTED***', '***REDACTED***'], tags: ['t'], truncated: false });
    expect(row('r18-history-lock')!.metadata).not.toContain(bodyLines[0].slice(0, 40));
    remember({ name: 'r18-history-lock', type: 'note', observations: ['more'] });
    expect(JSON.parse(storedText('r18-history-lock')).observations).toContain('more');
    // A lone END at the top level is masked by an unpin the same way.
    kg.createEntity('r18-end', 'note', { observations: ['x'], metadata: { note: 'x' } });
    getDatabase().prepare("UPDATE entities SET metadata = json_set(metadata, '$.note', ?) WHERE name = ?").run(rest[rest.length - 1], 'r18-end');
    expect(() => remember({ name: 'r18-end', type: 'note', observations: ['more'] })).toThrow(AMBIGUOUS);
    setPinned('r18-end', false);
    expect(JSON.parse(row('r18-end')!.metadata).note).toBe('***REDACTED***');
    remember({ name: 'r18-end', type: 'note', observations: ['more'] });
  });

  it('a guard whose pattern detects a key header is not part of a key: its memory still takes new text, and a pin keeps the pattern', () => {
    const kg = new KnowledgeGraph(getDatabase());
    const pattern = ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' ');
    kg.createEntity('r18-guard', 'lesson_learned', { observations: ['x'], metadata: { guard: { pattern, message: 'do not paste keys' } } });
    remember({ name: 'r18-guard', type: 'lesson_learned', observations: ['more'] });
    setPinned('r18-guard', true);
    expect(JSON.parse(row('r18-guard')!.metadata).guard.pattern).toBe(pattern);
    // An unpin adds no text, so it masks parts of a key in the metadata: the pattern is not one.
    setPinned('r18-guard', false);
    expect(JSON.parse(row('r18-guard')!.metadata).guard.pattern).toBe(pattern);
  });

  it('r19: a key body in NEW metadata key names counts as new text (legacy row, and a fresh createEntity with the header in an observation)', () => {
    seedLegacyHeader('r19-keys');
    const before = row('r19-keys')!.metadata;
    const kg = new KnowledgeGraph(getDatabase());
    const asKeys = Object.fromEntries(bodyLines.map((line) => [line, true]));
    expect(() => kg.updateEntityMetadata('r19-keys', (m) => ({ ...m, ...asKeys }))).toThrow(AMBIGUOUS);
    expect(row('r19-keys')!.metadata).toBe(before);
    expect(() => kg.createEntity('r19-keys-fresh', 'note', { observations: [header], metadata: asKeys })).toThrow(AMBIGUOUS);
    expect(row('r19-keys-fresh')).toBeUndefined();
  });

  it('r19: a lone header held in a stored OBSERVATION refuses new metadata text and new observations; forget of that exact line recovers, nothing else removed', () => {
    const kg = new KnowledgeGraph(getDatabase());
    // Written before #523: a raw header line among the observations.
    const id = Number(getDatabase().prepare("INSERT INTO entities (name, type, namespace, metadata) VALUES ('r19-obs', 'note', 'personal', '{\"trust\":\"trusted\"}')").run().lastInsertRowid);
    for (const o of ['keep one', header, 'keep two']) getDatabase().prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, o);
    const before = row('r19-obs')!.metadata;
    expect(() => kg.updateEntityMetadata('r19-obs', (m) => ({ ...m, note: body }))).toThrow(AMBIGUOUS);
    expect(() => kg.createEntity('r19-obs', 'note', { observations: [body] })).toThrow(AMBIGUOUS);
    expect(row('r19-obs')!.metadata).toBe(before);
    expect(observationCount('r19-obs')).toBe(3);
    forget({ name: 'r19-obs', observation: header });
    expect(JSON.parse(storedText('r19-obs')).observations).toEqual(['keep one', 'keep two']);
    remember({ name: 'r19-obs', type: 'note', observations: ['more'] });
    expect(JSON.parse(storedText('r19-obs')).observations).toEqual(['keep one', 'keep two', 'more']);
  });

  it('r19: on a frozen clock (reviewed_at equal to the stored one) remember and setTaskState on a legacy row are still refused with no effect', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
      remember({ name: 'r19-clock', type: 'note', observations: ['x'] });
      getDatabase().prepare("UPDATE entities SET metadata = json_set(metadata, '$.existing', ?) WHERE name = ?").run(header, 'r19-clock');
      const before = row('r19-clock')!.metadata;
      const count = observationCount('r19-clock');
      expect(() => remember({ name: 'r19-clock', type: 'note', observations: ['more'] })).toThrow(AMBIGUOUS);
      expect(row('r19-clock')!.metadata).toBe(before);
      expect(observationCount('r19-clock')).toBe(count);
      const project = 'r19-clock-task';
      setTaskState({ project, patch: { goal: 'placeholder' } });
      const name = taskStateName(project);
      getDatabase().prepare("UPDATE entities SET metadata = json_set(metadata, '$.task_state.goal', ?) WHERE name = ?").run(header, name);
      const taskBefore = row(name)!.metadata;
      const taskCount = observationCount(name);
      expect(() => setTaskState({ project, patch: { next: 'ship it' } })).toThrow(AMBIGUOUS);
      expect(row(name)!.metadata).toBe(taskBefore);
      expect(observationCount(name)).toBe(taskCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('r19: setTaskState is one write: a failure of its task_state update leaves no new observation and no metadata change', () => {
    const project = 'r19-atomic';
    setTaskState({ project, patch: { goal: 'start' } });
    const name = taskStateName(project);
    const db = getDatabase();
    db.exec(`CREATE TRIGGER r19_fail BEFORE UPDATE OF metadata ON entities WHEN json_extract(NEW.metadata, '$.task_state.next') = 'boom' BEGIN SELECT RAISE(ABORT, 'r19 controlled failure'); END;`);
    try {
      const before = row(name)!.metadata;
      const count = observationCount(name);
      expect(() => setTaskState({ project, patch: { next: 'boom' } })).toThrow(/r19 controlled failure/);
      expect(row(name)!.metadata).toBe(before);
      expect(observationCount(name)).toBe(count);
    } finally {
      db.exec('DROP TRIGGER r19_fail');
    }
  });

  it('a history entry with a null or object title and a split key in its observations stores no line of the key', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('r18-null-title', 'note', { observations: ['x'], metadata: { replaced_history: [{ replaced_at: 't0', title: null, observations: [header, ...bodyLines], tags: [] }] } });
    kg.createEntity('r18-object-title', 'note', { observations: ['x'], metadata: { replaced_history: [{ replaced_at: 't0', title: { a: header }, observations: bodyLines, tags: [] }] } });
    for (const name of ['r18-null-title', 'r18-object-title']) {
      const history = JSON.parse(row(name)!.metadata).replaced_history;
      for (const line of bodyLines) expect(JSON.stringify(history), name).not.toContain(line.slice(0, 40));
      expect(history[0].replaced_at).toBe('t0');
    }
    expect(JSON.parse(row('r18-null-title')!.metadata).replaced_history[0].title).toBeNull();
    const imported = importMemories({
      data: {
        version: '3.1.0', exported_at: '2026-10-01T00:00:00.000Z', entity_count: 1,
        entities: [{ name: 'r18-import-null-title', type: 'note', namespace: 'personal', relations: [], tags: [], observations: ['now'],
          metadata: { replaced_history: [{ replaced_at: 't0', title: null, observations: [header, ...bodyLines], tags: [] }] } }],
      } as unknown as ExportResult,
      merge_strategy: 'skip',
    });
    expect(imported.errors).toEqual([]);
    for (const line of bodyLines) expect(row('r18-import-null-title')!.metadata).not.toContain(line.slice(0, 40));
  });

  it('F1: a credential or a header written in \\u escapes inside a duplicate key JSON.parse drops is still found', () => {
    const escape = (text: string) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    expect(holdsSecret([`{"k":"t\\u006fken=ESCAPEDSHADOWBODY83647592","k":"safe"}`])).toBe(true);
    expect(holdsSecret([`{"k":"${escape(`sk-${'abcd1234efgh'}`)}","k":"safe"}`])).toBe(true);
    // A header in the dropped duplicate, the body in the member that stays: every string is masked.
    const doc = `{"k":"${escape(header)}","k":${JSON.stringify(body)}}`;
    const out = redactSecrets(doc);
    for (const line of bodyLines) expect(out).not.toContain(line.slice(0, 40));
    remember({ name: 'r18-f1', type: 'note', observations: [doc] });
    for (const line of bodyLines) expect(storedText('r18-f1')).not.toContain(line.slice(0, 40));
    // Escaped text with nothing secret in it is not secret-shaped.
    expect(holdsSecret(['{"k":"caf\\u00e9","k":"x"}'])).toBe(false);
  });
});
