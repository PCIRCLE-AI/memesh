import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';
import { getProjectName } from '../src/core/paths.js';
import { projectTranscriptSlug } from '../src/core/transcript-source.js';
import { createHash } from 'node:crypto';
import { applyProposal, executeWorkPackage, getProposalDetail, listProposals, runDreamer } from '../src/core/dreamer.js';
import * as llmClient from '../src/core/llm-client.js';
import * as embedder from '../src/core/embedder.js';
import * as vectorIndex from '../src/storage/vector-index.js';
import * as agentMessaging from '../src/core/agent-messaging.js';
import { handleTool, TOOL_DEFINITIONS } from '../src/mcp/tools.js';
import { normalizeClientHost } from '../src/transports/mcp/handlers.js';
import { AGENT_MESSAGE_JSON_MAX_BYTES, AGENT_NATIVE_MESSAGE_MAX_BYTES } from '../src/core/agent-messaging.js';

// recall's MCP payload is an object envelope ({ entities, conflicts? }), never
// a bare array — see the shape contract test in the recall describe block.
const recallEntities = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text).entities;

let tmpDir: string;
let dbPath: string;
let previousMemeshDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-tools-'));
  dbPath = path.join(tmpDir, 'test.db');
  previousMemeshDir = process.env.MEMESH_DIR;
  // Tool tests must never inherit the developer's real embedder/LLM config.
  // A configured Ollama instance otherwise schedules network work from
  // `remember`, making a focused offline replay slow or non-terminating.
  process.env.MEMESH_DIR = tmpDir;
  openDatabase(dbPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeDatabase();
  if (previousMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousMemeshDir;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('work_package', () => {
  const result = { name: 'work-digest', type: 'digest', observations: ['Five commits completed the parser cleanup.'], tags: ['parser'] };
  const payload = (response: Awaited<ReturnType<typeof handleTool>>) => JSON.parse(response.content[0].text);
  const prepare = async (project = 'work-project') => payload(await handleTool('work_package', { action: 'prepare', kind: 'digest', project }));
  const seed = (project = 'work-project', count = 5) => {
    const kg = new KnowledgeGraph(getDatabase());
    return Array.from({ length: count }, (_, i) => kg.createEntity(`${project}-commit-${i}`, 'commit', {
      observations: [`Parser cleanup step ${i} completed.`], tags: [`project:${project}`],
    }));
  };
  const submit = (pkg: any, changes: Record<string, unknown> = {}) => handleTool('work_package', {
    action: 'submit', package_id: pkg.id, ref: pkg.ref, result, ...changes,
  });
  const snapshot = () => getDatabase().prepare('SELECT total_changes() AS changes').get();

  it('publishes digest/transcript actions with strict nested schemas and structured failures', async () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'work_package')!;
    expect(tool.description).toContain('transcript');
    const schema = tool.inputSchema as any;
    expect(schema.oneOf).toHaveLength(3);
    expect(schema.oneOf.every((s: any) => s.additionalProperties === false)).toBe(true);
    expect(schema.oneOf[0].properties.kind.enum).toEqual(['digest', 'transcript']);
    expect(schema.oneOf[1].properties.ref.oneOf.every((ref: any) => ref.additionalProperties === false)).toBe(true);
    expect(schema.oneOf[1].properties.result.additionalProperties).toBe(false);
    for (const input of [
      { action: 'prepare', project: 'work-project', kind: 'pattern' },
      { action: 'prepare', project: 'work-project', kind: 'digest', limit: 2 },
      { action: 'prepare', project: ' ', kind: 'digest' },
      { action: 'apply', proposal_id: 1 },
    ]) {
      const response = await handleTool('work_package', input);
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({ error: 'invalid_input' });
    }
  });

  it('returns one deterministic complete calendar package, or none, without writes', async () => {
    expect(await prepare()).toMatchObject({ status: 'none_available', available_action: [] });
    const ids = seed();
    const before = snapshot();
    const available = await prepare();
    expect(await prepare()).toEqual(available);
    expect(snapshot()).toEqual(before);
    expect(available).toMatchObject({ status: 'available', available_action: [{ action: 'submit', actor: 'agent' }, { action: 'defer', actor: 'agent' }] });
    expect(available.package).toMatchObject({
      ref: { kind: 'digest', project: 'work-project', source_ids: ids },
      limits: { max_output_bytes: 16384, max_results: 1 }, coverage: { truncated: false },
      trust: 'untrusted', selection_mode: 'calendar',
    });
    expect(available.package.id).toMatch(/^[a-f0-9]{64}$/);
    expect(available.package.ref.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(available.package.sources).toHaveLength(5);
    expect(available.package.sources[0]).toEqual({ id: ids[0], name: 'work-project-commit-0', type: 'commit', observations: ['Parser cleanup step 0 completed.'] });
    expect(await prepare('another-project')).toMatchObject({ status: 'none_available' });
  });

  it('stages pending offline output and preserves human list/detail/apply plus replay across settled statuses', async () => {
    const ids = seed();
    const pkg = (await prepare()).package;
    const staged = payload(await submit(pkg));
    expect(staged).toMatchObject({ status: 'staged', proposal_status: 'pending', review_authority: 'human', available_action: [] });
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM dream_proposals WHERE id = ?').get(staged.proposal_id) as any;
    expect(row).toMatchObject({ status: 'pending', llm_model: null, prompt_version: 'work-package-v1', project: 'work-project' });
    expect(JSON.parse(row.proposed_digest).work_package).toMatchObject({ id: pkg.id, ref: pkg.ref });
    expect(listProposals(db).some(p => p.id === staged.proposal_id)).toBe(true);
    expect(getProposalDetail(db, staged.proposal_id)?.digest.name).toBe(result.name);
    expect(payload(await submit(pkg))).toMatchObject({ status: 'existing', proposal_id: staged.proposal_id, proposal_status: 'pending' });
    expect(await prepare()).toMatchObject({ status: 'none_available' });
    expect(db.prepare("SELECT count(*) AS n FROM entities WHERE status = 'active'").get()).toMatchObject({ n: 5 });
    const applied = applyProposal(db, staged.proposal_id, new KnowledgeGraph(db));
    expect(applied.sourcesArchived).toBe(5);
    expect(db.prepare("SELECT count(*) AS n FROM entities WHERE status = 'archived'").get()).toMatchObject({ n: ids.length });
    expect(db.prepare('SELECT tag FROM tags WHERE entity_id = (SELECT id FROM entities WHERE name = ?)').all(result.name)).toContainEqual({ tag: 'project:work-project' });
    const before = snapshot();
    expect(payload(await submit(pkg))).toMatchObject({ status: 'existing', proposal_id: staged.proposal_id, proposal_status: 'applied' });
    expect(snapshot()).toEqual(before);
    const conflict = await submit(pkg, { result: { ...result, observations: ['Different result'] } });
    expect(conflict.isError).toBe(true);
    expect(payload(conflict).error).toBe('submission_conflict');
    db.prepare("UPDATE dream_proposals SET status = 'rejected' WHERE id = ?").run(staged.proposal_id);
    expect(payload(await submit(pkg))).toMatchObject({ status: 'existing', proposal_status: 'rejected' });
  });

  it('rejects stale, archived, missing, rescoped and changed sources without staging', async () => {
    const ids = seed();
    const pkg = (await prepare()).package;
    const db = getDatabase();
    const original = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(ids[0]) as { metadata: string };
    const badRefs = [
      { ...pkg.ref, project: 'other-project' },
      { ...pkg.ref, source_ids: [...ids.slice(0, 4), ids[4] + 1000] },
      { ...pkg.ref, source_hash: '0'.repeat(64) },
    ];
    for (const ref of badRefs) {
      const before = snapshot();
      expect((await submit(pkg, { ref })).isError).toBe(true);
      expect(snapshot()).toEqual(before);
    }
    expect((await submit({ ...pkg, id: '0'.repeat(64) })).isError).toBe(true);
    for (const sql of [
      "UPDATE observations SET content = 'changed' WHERE entity_id = ?",
      "UPDATE entities SET metadata = '{\"pin\":true}' WHERE id = ?",
      "UPDATE entities SET status = 'archived' WHERE id = ?",
      "UPDATE tags SET tag = 'project:other' WHERE entity_id = ?",
      'DELETE FROM entities WHERE id = ?',
    ]) {
      db.prepare(sql).run(ids[0]);
      const before = snapshot();
      expect(payload(await submit(pkg)).error).toBe('stale_package');
      expect(snapshot()).toEqual(before);
      db.prepare('UPDATE observations SET content = ? WHERE entity_id = ?').run('Parser cleanup step 0 completed.', ids[0]);
      db.prepare("UPDATE entities SET metadata = ?, status = 'active' WHERE id = ?").run(original.metadata, ids[0]);
      db.prepare('UPDATE tags SET tag = ? WHERE entity_id = ?').run('project:work-project', ids[0]);
    }
    expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toMatchObject({ n: 0 });
  });

  it('rejects malformed, secret-shaped and oversized output with zero durable changes', async () => {
    seed();
    const pkg = (await prepare()).package;
    const invalidResults = [
      { ...result, surprise: true }, { ...result, type: 'pattern_emergent' },
      { ...result, tags: ['project:forged'] }, { ...result, tags: [] },
      { ...result, tags: [''] }, { ...result, tags: Array(51).fill('tag') },
      { ...result, name: '' }, { ...result, name: 'x'.repeat(256) },
      { ...result, observations: [] }, { ...result, observations: [' '] },
      { ...result, observations: Array(101).fill('observation') },
      { ...result, observations: ['x'.repeat(10001)] },
      { ...result, observations: ['界'.repeat(3000), '界'.repeat(3000)] },
      { ...result, observations: ['sk-' + 'a'.repeat(40)] },
    ];
    for (const invalid of invalidResults) {
      const before = snapshot();
      expect((await submit(pkg, { result: invalid })).isError).toBe(true);
      expect(snapshot()).toEqual(before);
    }
    for (const changes of [
      { extra: true }, { ref: { ...pkg.ref, extra: true } },
      { ref: { ...pkg.ref, source_ids: [...pkg.ref.source_ids].reverse() } },
      { ref: { ...pkg.ref, source_ids: Array(5).fill(pkg.ref.source_ids[0]) } },
    ]) expect((await submit(pkg, changes)).isError).toBe(true);
    expect(getDatabase().prepare('SELECT count(*) AS n FROM dream_proposals').get()).toMatchObject({ n: 0 });
  });

  it('defers without durable changes and can immediately prepare the same package again', async () => {
    seed();
    const pkg = (await prepare()).package;
    for (const reason of ['insufficient_evidence', 'not_now', 'irrelevant']) {
      const before = snapshot();
      const response = await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason });
      expect(payload(response)).toEqual({ status: 'deferred', durable_change: false, available_action: [] });
      expect(snapshot()).toEqual(before);
      expect((await prepare()).package).toEqual(pkg);
    }
    expect((await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'forever' })).isError).toBe(true);
    getDatabase().prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(pkg.ref.source_ids[0]);
    expect((await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' })).isError).toBe(true);
  });

  it('replays an already submitted package for defer without durable changes', async () => {
    seed();
    const pkg = (await prepare()).package;
    const staged = payload(await submit(pkg));
    const db = getDatabase();
    for (const status of ['pending', 'applied', 'rejected']) {
      db.prepare('UPDATE dream_proposals SET status = ? WHERE id = ?').run(status, staged.proposal_id);
      const before = snapshot();
      const deferred = await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' });
      expect(payload(deferred)).toEqual({ status: 'existing', proposal_id: staged.proposal_id, proposal_status: status, available_action: [] });
      expect(snapshot()).toEqual(before);
    }
  });

  it('does not treat ref key order as freshness or replay identity', async () => {
    seed();
    const pkg = (await prepare()).package;
    const ref = {
      source_hash: pkg.ref.source_hash,
      source_ids: pkg.ref.source_ids,
      project: pkg.ref.project,
      kind: 'digest' as const,
    };
    const defer = { action: 'defer' as const, package_id: pkg.id, ref, reason: 'not_now' as const };
    expect(executeWorkPackage(getDatabase(), defer)).toEqual({ status: 'deferred', durable_change: false, available_action: [] });
    const staged = payload(await submit(pkg));
    expect(executeWorkPackage(getDatabase(), defer)).toEqual({ status: 'existing', proposal_id: staged.proposal_id, proposal_status: 'pending', available_action: [] });
  });

  it('reports unexpected work-package failures through the shared handler error path', async () => {
    const db = getDatabase();
    const prepare = vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('test database failure'); });
    try {
      const response = await handleTool('work_package', { action: 'prepare', kind: 'digest', project: 'work-project' });
      expect(response.isError).toBe(true);
      expect(response.content).toEqual([{ type: 'text', text: 'Tool "work_package" failed: test database failure' }]);
    } finally {
      prepare.mockRestore();
    }
  });

  it('prepares and defers without transactions while an independent connection holds the write lock', async () => {
    seed();
    const pkg = (await prepare()).package;
    const db = getDatabase();
    const peer = new MemeshDatabase(dbPath);
    const transaction = vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw new Error('read-only work must not acquire a transaction');
    });
    try {
      peer.exec('BEGIN IMMEDIATE');
      expect((await prepare()).package).toEqual(pkg);
      const deferred = await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' });
      expect(payload(deferred)).toMatchObject({ status: 'deferred', durable_change: false });
      expect(transaction).not.toHaveBeenCalled();
      // The independent connection can still read and write under its own lock.
      expect(peer.prepare('SELECT count(*) AS n FROM entities').get()).toMatchObject({ n: 5 });
      expect(peer.prepare('UPDATE entities SET name = ? WHERE id = ?').run('peer-write-probe', pkg.ref.source_ids[0]).changes).toBe(1);
      expect(peer.prepare('SELECT name FROM entities WHERE id = ?').get(pkg.ref.source_ids[0])).toMatchObject({ name: 'peer-write-probe' });
    } finally {
      transaction.mockRestore();
      if (peer.isTransaction) peer.exec('ROLLBACK');
      peer.close();
    }
    expect((await prepare()).package).toEqual(pkg);
  });

  it('never enters LLM, embedder, vector, network or agent-message paths in any action', async () => {
    seed();
    const forbidden = () => { throw new Error('forbidden provider path'); };
    const spies = [
      vi.spyOn(llmClient, 'callLLM').mockImplementation(forbidden),
      vi.spyOn(embedder, 'embedText').mockImplementation(forbidden),
      vi.spyOn(embedder, 'embedAndStore').mockImplementation(forbidden),
      vi.spyOn(embedder, 'scheduleEmbedAndStore').mockImplementation(forbidden),
      vi.spyOn(embedder, 'vectorSearch').mockImplementation(forbidden),
      vi.spyOn(vectorIndex, 'hasVectorIndex').mockImplementation(forbidden),
      vi.spyOn(agentMessaging, 'sendAgentMessage').mockImplementation(forbidden),
      vi.fn(forbidden),
    ];
    vi.stubGlobal('fetch', spies[spies.length - 1]);
    const pkg = (await prepare()).package;
    expect(pkg).toBeDefined();
    expect((await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' })).isError).toBeUndefined();
    expect((await submit(pkg)).isError).toBeUndefined();
    expect(payload(await submit(pkg))).toMatchObject({ status: 'existing' });
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it('serializes simultaneous requests into one proposal with the synchronous immediate transaction', async () => {
    seed();
    const pkg = (await prepare()).package;
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(pkg)));
    expect(responses.map(payload).filter(r => r.status === 'staged')).toHaveLength(1);
    expect(responses.map(payload).filter(r => r.status === 'existing')).toHaveLength(7);
    expect(getDatabase().prepare('SELECT count(*) AS n FROM dream_proposals').get()).toMatchObject({ n: 1 });
  });

  it('keeps the existing eligibility rules and skips whole oversized clusters without truncation', async () => {
    const ids = seed();
    const db = getDatabase();
    const original = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(ids[0]) as { metadata: string };
    for (const metadata of [
      { pin: true }, { compacted_into: 123 }, { consolidation_depth: 1 },
      { signal_score: 0.1 }, { signal_score: 0.8 },
    ]) {
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), ids[0]);
      expect(await prepare()).toMatchObject({ status: 'none_available' });
    }
    db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(original.metadata, ids[0]);
    for (const type of ['decision', 'digest', 'unknown']) {
      db.prepare('UPDATE entities SET type = ? WHERE id = ?').run(type, ids[0]);
      expect(await prepare()).toMatchObject({ status: 'none_available' });
    }
    db.prepare("UPDATE entities SET type = 'commit' WHERE id = ?").run(ids[0]);
    expect(await prepare()).toMatchObject({ status: 'available' });
    db.prepare('UPDATE observations SET content = ? WHERE entity_id = ?').run('x'.repeat(65536), ids[0]);
    expect(await prepare()).toMatchObject({ status: 'none_available' });
    seed('large-project', 101);
    expect(await prepare('large-project')).toMatchObject({ status: 'none_available' });
  });

  it('blocks overlapping and contained proposals without altering existing pending work', async () => {
    const ids = seed();
    const db = getDatabase();
    const pkg = (await prepare()).package;
    const insert = db.prepare(`INSERT INTO dream_proposals
      (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('work-project', 'legacy', ?, ?, 'v1')`);
    const overlappingId = Number(insert.run(JSON.stringify([ids[0], 9999]), JSON.stringify(result)).lastInsertRowid);
    expect(await prepare()).toMatchObject({ status: 'none_available' });
    const before = snapshot();
    expect(payload(await submit(pkg))).toMatchObject({ error: 'proposal_overlap' });
    expect(snapshot()).toEqual(before);
    db.prepare("UPDATE dream_proposals SET status = 'rejected' WHERE id = ?").run(overlappingId);
    const containedId = Number(insert.run(JSON.stringify(ids.slice(0, 2)), JSON.stringify(result)).lastInsertRowid);
    const containedBefore = snapshot();
    const containedRow = db.prepare('SELECT * FROM dream_proposals WHERE id = ?').get(containedId);
    expect(await prepare()).toMatchObject({ status: 'none_available' });
    const blocked = await submit(pkg);
    expect(blocked.isError).toBe(true);
    expect(payload(blocked)).toMatchObject({ error: 'proposal_overlap' });
    expect(snapshot()).toEqual(containedBefore);
    expect(db.prepare('SELECT * FROM dream_proposals WHERE id = ?').get(containedId)).toEqual(containedRow);
    expect(db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(containedId)).toMatchObject({ status: 'pending' });
    expect(db.prepare("SELECT count(*) AS n FROM dream_proposals WHERE status = 'pending'").get()).toMatchObject({ n: 1 });
  });

  it('legacy dreamer rechecks pending MCP work after awaiting its provider', async () => {
    seed();
    const pkg = (await prepare()).package;
    const db = getDatabase();
    let entered!: () => void;
    let release!: (output: string) => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const providerOutput = new Promise<string>(resolve => { release = resolve; });
    const provider = vi.spyOn(llmClient, 'callLLM').mockImplementation(() => {
      entered();
      return providerOutput;
    });
    const network = vi.fn(() => { throw new Error('unexpected network request'); });
    vi.stubGlobal('fetch', network);
    const running = runDreamer(db, { provider: 'ollama', model: 'synthetic-local' }, { project: 'work-project' });
    try {
      await providerEntered;
      const staged = payload(await submit(pkg));
      expect(staged.status).toBe('staged');
      const before = db.prepare('SELECT * FROM dream_proposals').all();
      // Only statements after the MCP submission belong to the final legacy stage.
      const exec = vi.spyOn(db, 'exec');
      release(JSON.stringify({ action: 'ADD', digest: result }));
      const dreamed = await running;
      expect(dreamed.proposalsCreated).toBe(0);
      expect(dreamed.llmCalls).toBe(1);
      expect(dreamed.skipped.some(skip => skip.reason.includes('appeared during generation'))).toBe(true);
      expect(exec).toHaveBeenCalledWith('BEGIN IMMEDIATE');
      expect(db.prepare('SELECT * FROM dream_proposals').all()).toEqual(before);
      expect(db.prepare('SELECT status, prompt_version FROM dream_proposals').all()).toEqual([
        { status: 'pending', prompt_version: 'work-package-v1' },
      ]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally {
      release(JSON.stringify({ action: 'NOOP' }));
      await running;
    }
  });

  it.each([false, true])('legacy dreamer preserves pending work-package review when a cluster grows (identical recovery: %s)', async (recovery) => {
    const ids = seed();
    const db = getDatabase();
    const staged = payload(await submit((await prepare()).package));
    const original = db.prepare('SELECT * FROM dream_proposals WHERE id = ?').get(staged.proposal_id);
    const sixth = new KnowledgeGraph(db).createEntity('work-project-commit-5', 'commit', {
      observations: ['Parser cleanup step 5 completed.'], tags: ['project:work-project'],
    });
    let narrowerLegacyId: number | undefined;
    if (recovery) {
      const insert = db.prepare(`INSERT INTO dream_proposals
        (project, cluster_key, source_ids, proposed_digest, prompt_version)
        VALUES ('work-project', 'legacy-recovery', ?, ?, 'v1')`);
      insert.run(JSON.stringify([...ids, sixth]), JSON.stringify(result));
      narrowerLegacyId = Number(insert.run(JSON.stringify(ids.slice(0, 2)), JSON.stringify(result)).lastInsertRowid);
    }
    const rowsBefore = db.prepare('SELECT count(*) AS n FROM dream_proposals').get();
    const provider = vi.spyOn(llmClient, 'callLLM').mockResolvedValue(JSON.stringify({ action: 'ADD', digest: result }));
    const network = vi.fn(() => { throw new Error('unexpected network request'); });
    vi.stubGlobal('fetch', network);
    const dreamed = await runDreamer(db, { provider: 'ollama', model: 'synthetic-local' }, { project: 'work-project' });
    expect(dreamed.proposalsCreated).toBe(0);
    expect(dreamed.llmCalls).toBe(0);
    expect(provider).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM dream_proposals WHERE id = ?').get(staged.proposal_id)).toEqual(original);
    expect(db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(staged.proposal_id)).toMatchObject({ status: 'pending' });
    expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toEqual(rowsBefore);
    if (recovery) {
      expect(dreamed.skipped.some(skip => skip.reason.includes('pending proposal already exists'))).toBe(true);
      // Legacy recovery still retires legacy subsets; the human-owned package is excluded.
      expect(db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(narrowerLegacyId!)).toMatchObject({ status: 'rejected' });
    } else {
      expect(dreamed.skipped.some(skip => skip.reason.includes('overlaps pending proposal'))).toBe(true);
    }
  });
});

describe('transcript work_package', () => {
  let project: string;
  let transcriptDir: string;
  const digest = { name: 'transcript-decision', type: 'decision', observations: ['Use the parser selected in the discussion.'], tags: ['parser'] };
  const payload = (response: Awaited<ReturnType<typeof handleTool>>) => JSON.parse(response.content[0].text);
  const prepare = async () => payload(await handleTool('work_package', { action: 'prepare', kind: 'transcript', project }));
  const submit = (pkg: any, result = digest, extra: Record<string, unknown> = {}) => handleTool('work_package', {
    action: 'submit', package_id: pkg.id, ref: pkg.ref, result, ...extra,
  });
  const writeSession = (id: string, entries: unknown[], modified = new Date(Date.now() - 1000)) => {
    const file = path.join(transcriptDir, `${id}.jsonl`);
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    fs.utimesSync(file, modified, modified);
    return file;
  };
  const user = (text: string, cwd = tmpDir) => ({ type: 'user', cwd, message: { role: 'user', content: text } });

  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    project = getProjectName(tmpDir);
    vi.stubEnv('CLAUDE_PROJECTS_DIR', path.join(tmpDir, 'transcripts'));
    transcriptDir = path.join(tmpDir, 'transcripts', projectTranscriptSlug(tmpDir));
    fs.mkdirSync(transcriptDir, { recursive: true });
  });

  it('selects newest same-project sessions with deterministic tie-break and excludes hidden/tool content', async () => {
    writeSession('older', [user('Older conversation')], new Date(Date.now() - 4000));
    const newest = new Date(Date.now() - 1000);
    writeSession('b-session', [user('Tie-break second')], newest);
    const file = writeSession('a-session', [
      user('Choose a parser'),
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }, { type: 'tool_use', input: 'TOOL_INPUT' }, { type: 'text', text: 'Use the simpler parser.' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'TOOL_OUTPUT' }] } },
    ], newest);
    writeSession('wrong-project', [user('FOREIGN_DATA', path.join(tmpDir, 'sibling'))], new Date());
    const available = await prepare();
    expect(available.status).toBe('available');
    expect(available.package.ref.session_id).toBe('a-session');
    expect(available.package.ref.source_hash).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    expect(available.package.sources).toEqual([{ role: 'user', text: 'Choose a parser' }, { role: 'assistant', text: 'Use the simpler parser.' }]);
    expect(available.package.coverage).toEqual({ truncated: false, total_turns: 2, included_turns: 2 });
    expect(JSON.stringify(available)).not.toMatch(/PRIVATE_THOUGHT|TOOL_INPUT|TOOL_OUTPUT|FOREIGN_DATA/);
    expect(available.package.ref).not.toHaveProperty('path');
    expect(await prepare()).toEqual(available);
    // Legacy transcript rows also reserve their session, regardless of status or key label.
    const db = getDatabase();
    const legacy = db.prepare(`INSERT INTO dream_proposals
      (project, cluster_key, source_ids, proposed_digest, prompt_version, source_kind)
      VALUES (?, 'legacy-label', ?, '{}', 'transcript-v1', 'transcript')`).run(project, JSON.stringify({ sessionId: 'a-session' }));
    for (const status of ['pending', 'applied', 'rejected']) {
      db.prepare('UPDATE dream_proposals SET status = ? WHERE id = ?').run(status, legacy.lastInsertRowid);
      expect((await prepare()).package.ref.session_id).toBe('b-session');
    }
  });

  it('skips a transcript that becomes unreadable after discovery', async () => {
    writeSession('older-readable', [user('Use the readable fallback session.')], new Date(Date.now() - 4000));
    const newest = writeSession('newest-unreadable', [user('This session disappears during selection.')]);
    const realOpen = fs.openSync;
    let newestOpens = 0;
    const opened = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode) => {
      if (String(file) === newest && ++newestOpens === 2) {
        throw Object.assign(new Error('gone after discovery'), { code: 'ENOENT' });
      }
      return realOpen(file, flags);
    }) as typeof fs.openSync);
    try {
      const available = await prepare();
      expect(available.package.ref.session_id).toBe('older-readable');
      expect(newestOpens).toBe(2);
    } finally {
      opened.mockRestore();
    }
  });

  it('clips turns and bytes explicitly while preserving chronological order and skips unusable sessions', async () => {
    writeSession('many-turns', Array.from({ length: 120 }, (_, i) => user(`visible-${i}`)));
    let pkg = (await prepare()).package;
    expect(pkg.sources).toHaveLength(100);
    expect(pkg.sources[0].text).toBe('visible-20');
    expect(pkg.sources[99].text).toBe('visible-119');
    expect(pkg.coverage).toEqual({ truncated: true, total_turns: 120, included_turns: 100 });
    writeSession('many-turns', Array.from({ length: 30 }, (_, i) => user(`${i}:` + '界'.repeat(3000))));
    pkg = (await prepare()).package;
    expect(Buffer.byteLength(JSON.stringify(pkg.sources))).toBeLessThanOrEqual(49152);
    expect(Buffer.byteLength(JSON.stringify(pkg))).toBeLessThanOrEqual(65536);
    expect(pkg.coverage.truncated).toBe(true);
    expect(pkg.coverage.total_turns).toBe(30);
    expect(pkg.sources.map((turn: any) => Number(turn.text.split(':')[0]))).toEqual([25, 26, 27, 28, 29]);
    writeSession('many-turns', [user('x'.repeat(60000))]);
    expect(await prepare()).toMatchObject({ status: 'none_available' });
    writeSession('many-turns', [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private only' }] } }]);
    writeSession('', [user('No usable session identity')]);
    expect(await prepare()).toMatchObject({ status: 'none_available' });
  });

  it('prepares/defers without transactions and never enters generation, vectors, embeddings, messages or network', async () => {
    writeSession('offline', [user('One supported decision')]);
    const db = getDatabase();
    const forbidden = () => { throw new Error('forbidden provider path'); };
    const spies = [vi.spyOn(llmClient, 'callLLM').mockImplementation(forbidden),
      vi.spyOn(embedder, 'embedText').mockImplementation(forbidden), vi.spyOn(embedder, 'vectorSearch').mockImplementation(forbidden),
      vi.spyOn(embedder, 'scheduleEmbedAndStore').mockImplementation(forbidden),
      vi.spyOn(vectorIndex, 'hasVectorIndex').mockImplementation(forbidden),
      vi.spyOn(agentMessaging, 'sendAgentMessage').mockImplementation(forbidden), vi.fn(forbidden)];
    vi.stubGlobal('fetch', spies[spies.length - 1]);
    const transaction = vi.spyOn(db, 'transaction').mockImplementation(forbidden);
    const before = db.prepare('SELECT total_changes() AS n').get();
    const pkg = (await prepare()).package;
    expect(pkg).toBeDefined();
    const deferred = await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' });
    expect(payload(deferred)).toEqual({ status: 'deferred', durable_change: false, available_action: [] });
    expect((await prepare()).package).toEqual(pkg);
    expect(transaction).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    transaction.mockRestore();
    expect((await submit(pkg)).isError).toBeUndefined();
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it.each(['decision', 'lesson_learned', 'fact'])('stages one %s and preserves human additive apply plus all-status replay', async (type) => {
    const file = writeSession('review-session', [user('The visible evidence supports this memory.')]);
    const bytes = fs.readFileSync(file);
    const pkg = (await prepare()).package;
    const output = { ...digest, type };
    const staged = payload(await submit(pkg, output));
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM dream_proposals WHERE id = ?').get(staged.proposal_id) as any;
    expect(row).toMatchObject({ project, status: 'pending', source_kind: 'transcript', kind: 'digest', cluster_key: 'transcript:review-session', llm_model: null, prompt_version: 'work-package-v1' });
    expect(JSON.parse(row.proposed_digest)).toMatchObject({ ...output, work_package: { id: pkg.id, ref: pkg.ref } });
    expect(db.prepare('SELECT count(*) AS n FROM entities').get()).toMatchObject({ n: 0 });
    expect(payload(await submit(pkg, output))).toMatchObject({ status: 'existing', proposal_status: 'pending' });
    const deferBefore = db.prepare('SELECT total_changes() AS n').get();
    expect(payload(await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' })))
      .toEqual({ status: 'existing', proposal_id: staged.proposal_id, proposal_status: 'pending', available_action: [] });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(deferBefore);
    expect(await prepare()).toMatchObject({ status: 'none_available' });
    const kg = new KnowledgeGraph(db);
    const create = vi.spyOn(kg, 'createEntity');
    expect(applyProposal(db, staged.proposal_id, kg).sourcesArchived).toBe(0);
    expect(create).toHaveBeenCalledWith(output.name, type, expect.objectContaining({ trustOverride: 'untrusted' }));
    expect(db.prepare('SELECT type, status FROM entities').all()).toEqual([{ type, status: 'active' }]);
    expect(payload(await submit(pkg, output))).toMatchObject({ status: 'existing', proposal_status: 'applied' });
    expect(payload(await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' })))
      .toEqual({ status: 'existing', proposal_id: staged.proposal_id, proposal_status: 'applied', available_action: [] });
    db.prepare("UPDATE dream_proposals SET status = 'rejected' WHERE id = ?").run(staged.proposal_id);
    expect(payload(await submit(pkg, output))).toMatchObject({ status: 'existing', proposal_status: 'rejected' });
    expect(payload(await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' })))
      .toEqual({ status: 'existing', proposal_id: staged.proposal_id, proposal_status: 'rejected', available_action: [] });
    expect(await prepare()).toMatchObject({ status: 'none_available' });
    const conflict = await submit(pkg, { ...output, observations: ['Different result'] });
    expect(conflict.isError).toBe(true);
    expect(payload(conflict).error).toBe('submission_conflict');
    expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toMatchObject({ n: 1 });
    expect(fs.readFileSync(file)).toEqual(bytes);
    writeSession('review-session', [user('Changed after human review')]);
    expect(payload(await submit(pkg, output))).toMatchObject({ status: 'existing', proposal_status: 'rejected' });
  });

  it('rejects path injection, unknown fields, wrong kinds, tags, secrets and oversized output without writes', async () => {
    writeSession('strict', [user('Visible evidence')]);
    const pkg = (await prepare()).package;
    const invalid = [
      { extra: true }, { ref: { ...pkg.ref, path: '/not-authorized' } }, { ref: { ...pkg.ref, source_ids: [1] } },
      { result: { ...digest, type: 'digest' } }, { result: { ...digest, type: 'pattern' } },
      { result: { ...digest, extra: true } }, { result: { ...digest, observations: [] } },
      { result: { ...digest, tags: ['project:forged'] } }, { result: { ...digest, tags: [] } },
      { result: { ...digest, observations: ['sk-' + 'a'.repeat(40)] } },
      { result: { ...digest, observations: ['界'.repeat(3000), '界'.repeat(3000)] } },
    ];
    const db = getDatabase();
    const before = db.prepare('SELECT total_changes() AS n').get();
    for (const extra of invalid) expect((await submit(pkg, digest, extra)).isError).toBe(true);
    expect((await handleTool('work_package', { action: 'prepare', kind: 'transcript', project, path: 'forged' })).isError).toBe(true);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('revalidates pathless project/session/content/mtime/hash references for submit and defer', async () => {
    const file = writeSession('fresh', [user('Original content')]);
    const pkg = (await prepare()).package;
    const db = getDatabase();
    const before = db.prepare('SELECT total_changes() AS n').get();
    for (const ref of [{ ...pkg.ref, project: 'other' }, { ...pkg.ref, session_id: 'missing' },
      { ...pkg.ref, modified_at: new Date(0).toISOString() }, { ...pkg.ref, source_hash: '0'.repeat(64) }]) {
      expect((await submit(pkg, digest, { ref })).isError).toBe(true);
      expect((await handleTool('work_package', { action: 'defer', package_id: pkg.id, ref, reason: 'not_now' })).isError).toBe(true);
    }
    expect((await submit({ ...pkg, id: '0'.repeat(64) })).isError).toBe(true);
    writeSession('fresh', [user('Changed content')], new Date(pkg.ref.modified_at));
    expect((await submit(pkg)).isError).toBe(true);
    const updated = (await prepare()).package;
    fs.utimesSync(file, new Date(), new Date());
    expect((await submit(updated)).isError).toBe(true);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
});

// ── Remember ────────────────────────────────────────────────────────────

describe('source_host provenance', () => {
  it('stamps the MCP client name the transport hands over', async () => {
    // The third argument is the client's self-declared initialize name,
    // threaded by src/mcp/server.ts — NOT a tool parameter the model can set.
    await handleTool('remember', { name: 'prov-mcp', type: 'decision', observations: ['from codex'] }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-mcp' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'prov-mcp');
    expect(hit.metadata.provenance.source_host).toBe('codex');
  });

  it('records no source_host when the transport does not know one', async () => {
    await handleTool('remember', { name: 'prov-anon', type: 'decision', observations: ['origin unknown'] });
    const recall = await handleTool('recall', { query: 'prov-anon' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'prov-anon');
    expect(hit.metadata.provenance.source_host).toBeUndefined();
  });

  it('the model cannot smuggle source_host in as a tool argument', async () => {
    // Since every schema went strict, a spoofed sourceHost is REJECTED
    // outright — stronger than the old silent strip, and it names the key.
    // If this ever starts being accepted (a .passthrough() refactor),
    // provenance is no longer provenance.
    const result = await handleTool('remember', {
      name: 'prov-spoof', type: 'decision', observations: ['spoof attempt'],
      sourceHost: 'gemini-cli',
    } as Record<string, unknown>, 'codex');
    expect(JSON.stringify(result)).toMatch(/sourceHost|unrecognized/i);

    // And nothing was stored under the spoofed call.
    const recall = await handleTool('recall', { query: 'prov-spoof' });
    expect(recallEntities(recall).find((e: any) => e.name === 'prov-spoof')).toBeUndefined();
  });

  it('a smuggled sourceHost with NO transport name is rejected the same way', async () => {
    const result = await handleTool('remember', {
      name: 'prov-anon-spoof', type: 'decision', observations: ['anon spoof'],
      sourceHost: 'gemini-cli',
    } as Record<string, unknown>);
    expect(JSON.stringify(result)).toMatch(/sourceHost|unrecognized/i);
    const recall = await handleTool('recall', { query: 'prov-anon-spoof' });
    expect(recallEntities(recall).find((e: any) => e.name === 'prov-anon-spoof')).toBeUndefined();
  });

  it('re-remember from another host does NOT overwrite the first writer', async () => {
    // First-writer-wins, the same invariant the hook path enforces with
    // INSERT OR IGNORE and the CHANGELOG promises. Before the fix this
    // returned 'codex': buildLocalMetadata spreads overrides over the stored
    // provenance, so every cross-host append rewrote the attribution.
    await handleTool('remember', { name: 'prov-first', type: 'decision', observations: ['created here'] }, 'claude-code');
    await handleTool('remember', { name: 'prov-first', type: 'decision', observations: ['appended elsewhere'] }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-first' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'prov-first');
    expect(hit.metadata.provenance.source_host).toBe('claude-code');
  });

  it('learn threads the transport name through to the lesson entity', async () => {
    // learn → createExplicitLesson → remember is a two-hop pass-through —
    // exactly the kind of line a refactor silently drops. Without this test,
    // deleting `sourceHost:` in lesson-engine.ts or in operations.ts learn()
    // leaves the whole suite green.
    await handleTool('learn', { error: 'prov-lesson-unique-boom', fix: 'restart the flux capacitor' }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-lesson-unique-boom' });
    const hit = recallEntities(recall).find((e: any) => e.name.startsWith('lesson-'));
    expect(hit.metadata.provenance.source_host).toBe('codex');
  });
});

describe('normalizeClientHost', () => {
  // The initialize name is the one string that reaches metadata without a zod
  // schema; this is its entire validation surface.
  it('passes a normal client name through untouched', () => {
    expect(normalizeClientHost('codex')).toBe('codex');
  });
  it('preserves non-ASCII names (clamping is not ASCII-folding)', () => {
    expect(normalizeClientHost('克勞德')).toBe('克勞德');
  });
  it('strips control characters (ANSI escapes, newlines)', () => {
    expect(normalizeClientHost('bad\u001b[31mname\nhere')).toBe('bad[31mnamehere');
  });
  it('caps at 64 characters', () => {
    expect(normalizeClientHost('x'.repeat(1000))).toHaveLength(64);
  });
  it('empty string falls back to mcp — `?? "mcp"` alone missed this', () => {
    expect(normalizeClientHost('')).toBe('mcp');
  });
  it('undefined falls back to mcp', () => {
    expect(normalizeClientHost(undefined)).toBe('mcp');
  });
  it('an all-control-character name falls back to mcp, not empty string', () => {
    expect(normalizeClientHost('\u0000\u001f\u007f')).toBe('mcp');
  });
});

describe('remember', () => {
  it('stores an entity and returns confirmation', async () => {
    const result = await handleTool('remember', {
      name: 'auth-decision',
      type: 'decision',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.stored).toBe(true);
    expect(data.name).toBe('auth-decision');
    expect(data.type).toBe('decision');
  });

  it('stores tags and relations', async () => {
    // Create target entity first so relation can be established
    await handleTool('remember', { name: 'jwt-pattern', type: 'pattern' });

    const result = await handleTool('remember', {
      name: 'auth-decision',
      type: 'decision',
      tags: ['project:myapp', 'type:decision'],
      relations: [{ to: 'jwt-pattern', type: 'implements' }],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.tags).toBe(2);
    expect(data.relations).toBe(1);
  });

  it('returns validation error when name is missing', async () => {
    const result = await handleTool('remember', { type: 'decision' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('name');
  });

  it('does not prefix root-level validation errors with an empty path', async () => {
    const result = await handleTool('message', {
      action: 'poll',
      project: 'memesh',
      recipient: 'memesh',
      target_kind: 'principal',
      limit: 20,
      wait_ms: 0,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Unrecognized key: "target_kind"');
  });

  it('keeps the field path for path-specific validation errors', async () => {
    const result = await handleTool('remember', { name: '', type: 'decision' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^name: /);
  });

  it('rejects a whitespace-only observation instead of storing an empty memory (M-05)', async () => {
    const result = await handleTool('remember', {
      name: 'blank-mcp-test', type: 'note', observations: ['   '],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/whitespace-only/i);

    const recall = await handleTool('recall', { query: 'blank-mcp-test' });
    expect(recallEntities(recall)).toEqual([]);
  });

  it('returns validation error when name is empty', async () => {
    const result = await handleTool('remember', { name: '', type: 'decision' });

    expect(result.isError).toBe(true);
  });

  it('stores observations that are searchable', async () => {
    await handleTool('remember', {
      name: 'jwt-lesson',
      type: 'lesson',
      observations: ['Use RS256 for JWT signing', 'Rotate keys quarterly'],
    });

    const result = await handleTool('recall', { query: 'RS256' });
    const data = recallEntities(result);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('jwt-lesson');
    expect(data[0].observations).toContain('Use RS256 for JWT signing');
  });

  it('auto-archives entity when superseded by new remember', async () => {
    await handleTool('remember', { name: 'auth-v2', type: 'decision', observations: ['Use JWT'] });
    await handleTool('remember', {
      name: 'auth-v3', type: 'decision', observations: ['Use OAuth 2.0'],
      relations: [{ to: 'auth-v2', type: 'supersedes' }],
    });

    // auth-v2 should be auto-archived — must NOT appear in default recall.
    // (We don't assert []: if a neural embedder is configured, recallEnhanced
    // can supplement with vector hits, e.g. surfacing the related auth-v3.
    // The behavioural guarantee here is "archived rows stay hidden", not
    // "no results at all".)
    const recallOld = await handleTool('recall', { query: 'JWT' });
    const oldNames = recallEntities(recallOld).map((e: any) => e.name);
    expect(oldNames).not.toContain('auth-v2');

    // auth-v3 should be active and surfaced by an OAuth query.
    const recallNew = await handleTool('recall', { query: 'OAuth' });
    const data = recallEntities(recallNew);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.map((e: any) => e.name)).toContain('auth-v3');
    expect(data.map((e: any) => e.name)).not.toContain('auth-v2');

    // Both visible with include_archived
    const recallAll = await handleTool('recall', { include_archived: true });
    const allData = recallEntities(recallAll);
    const names = allData.map((e: any) => e.name);
    expect(names).toContain('auth-v2');
    expect(names).toContain('auth-v3');
  });

  it('reports relation errors without failing overall', async () => {
    const result = await handleTool('remember', {
      name: 'auth-decision',
      type: 'decision',
      relations: [{ to: 'nonexistent-entity', type: 'related-to' }],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.stored).toBe(true);
    expect(data.relations).toBe(0);
    expect(data.relationErrors).toHaveLength(1);
  });
});

// ── Recall ──────────────────────────────────────────────────────────────

describe('recall', () => {
  beforeEach(async () => {
    await handleTool('remember', {
      name: 'auth-pattern',
      type: 'pattern',
      observations: ['JWT tokens for stateless auth'],
      tags: ['project:myapp'],
    });
    await handleTool('remember', {
      name: 'db-decision',
      type: 'decision',
      observations: ['Use PostgreSQL for persistence'],
      tags: ['project:other'],
    });
  });

  it('finds entities by query', async () => {
    const result = await handleTool('recall', { query: 'auth' });
    const data = recallEntities(result);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.some((e: any) => e.name === 'auth-pattern')).toBe(true);
  });

  it('payload is an object envelope, never a bare array', async () => {
    // Gemini CLI JSON-parses the first text content item of a tool result and
    // assigns it to the MCP result's structuredContent, which the protocol
    // requires to be an OBJECT. When this payload was a bare array, every
    // recall issued from Gemini CLI failed with "structuredContent: expected
    // record, received array" (its session log pins this) while Claude Code
    // and Codex read the same payload fine.
    const result = await handleTool('recall', { query: 'auth' });
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed), 'bare-array payload breaks Gemini CLI').toBe(false);
    expect(Array.isArray(parsed.entities)).toBe(true);
    // R2: the envelope always says HOW it was answered — mode (fts|hybrid),
    // degraded (configured vector side could not run), truncated (window
    // filled). A caller must never have to guess whether keyword-only
    // results are the configured behaviour or a silent degradation.
    expect(['fts', 'hybrid']).toContain(parsed.retrieval.mode);
    expect(typeof parsed.retrieval.degraded).toBe('boolean');
    expect(typeof parsed.retrieval.truncated).toBe('boolean');
  });

  it('treats explicit null optional params as absent, the way Gemini CLI sends them', async () => {
    // Gemini CLI fills optional parameters its model leaves blank with null
    // instead of omitting the key. This exact shape failed against the live
    // server ("tag: Invalid input: expected string, received null") while the
    // same recall from Codex, which omits the keys, succeeded.
    const result = await handleTool('recall', {
      query: 'auth',
      tag: null,
      limit: null,
      namespace: null,
    } as Record<string, unknown>);
    expect(result.isError).toBeUndefined();
    const data = recallEntities(result);
    expect(data.some((e: any) => e.name === 'auth-pattern')).toBe(true);
  });

  it('still rejects a null ELEMENT inside an array — that is data, not a blank', async () => {
    const result = await handleTool('remember', {
      name: 'null-element',
      type: 'decision',
      observations: ['fine', null],
    } as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/observations/);
  });

  it('filters by tag', async () => {
    const result = await handleTool('recall', {
      query: 'auth',
      tag: 'project:myapp',
    });
    const data = recallEntities(result);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('auth-pattern');
  });

  it('lists recent when no query provided', async () => {
    const result = await handleTool('recall', {});
    const data = recallEntities(result);
    expect(data.length).toBe(2);
  });

  it('returns empty entities when nothing matches', async () => {
    const result = await handleTool('recall', { query: 'nonexistent-xyz-123' });
    const data = recallEntities(result);
    expect(data).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const result = await handleTool('recall', { limit: 1 });
    const data = recallEntities(result);
    expect(data.length).toBe(1);
  });

  it('rejects recall with limit=0', async () => {
    const result = await handleTool('recall', { limit: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('limit');
  });

  it('rejects recall with limit=101', async () => {
    const result = await handleTool('recall', { limit: 101 });
    expect(result.isError).toBe(true);
  });
});

// ── Forget ──────────────────────────────────────────────────────────────

describe('forget', () => {
  it('refuses the plural typo instead of archiving the whole entity', async () => {
    // `remember` calls the field `observations`; `forget` calls it
    // `observation`. Zod strips unknown keys by default, and `forget` branches
    // on whether `observation` is PRESENT — absent means "archive everything".
    // So the natural plural silently turned "remove one fact" into "archive
    // this memory", and answered `{"archived": true}`. Measured before the
    // fix: status became `archived`, both observations still there, and the
    // entity dropped out of recall and out of session-start injection.
    await handleTool('remember', {
      name: 'keeper', type: 'decision', observations: ['fact A', 'fact B'],
    });

    const result = await handleTool('forget', { name: 'keeper', observations: 'fact A' });
    expect(JSON.stringify(result)).toMatch(/observations|unrecognized|invalid/i);

    // The entity is untouched — still active, still recallable, both facts.
    const recall = await handleTool('recall', { query: 'fact' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'keeper');
    expect(hit).toBeTruthy();
    expect(hit.observations).toHaveLength(2);
  });

  it('archives an entity instead of deleting it', async () => {
    await handleTool('remember', {
      name: 'old-design', type: 'decision', observations: ['Use REST'],
    });

    const result = await handleTool('forget', { name: 'old-design' });
    const data = JSON.parse(result.content[0].text);
    expect(data.archived).toBe(true);
    expect(data.name).toBe('old-design');

    // Hidden from normal recall
    const recall = await handleTool('recall', { query: 'REST' });
    expect(recallEntities(recall)).toEqual([]);

    // Visible with include_archived
    const recallAll = await handleTool('recall', { query: 'REST', include_archived: true });
    const allData = recallEntities(recallAll);
    expect(allData).toHaveLength(1);
    expect(allData[0].archived).toBe(true);
  });

  it('removes a specific observation without archiving', async () => {
    await handleTool('remember', {
      name: 'design', type: 'decision', observations: ['Use JWT', 'Use RS256'],
    });

    const result = await handleTool('forget', { name: 'design', observation: 'Use JWT' });
    const data = JSON.parse(result.content[0].text);
    expect(data.observation_removed).toBe(true);
    expect(data.remaining_observations).toBe(1);

    // Entity still active and searchable
    const recall = await handleTool('recall', { query: 'RS256' });
    expect(recallEntities(recall)).toHaveLength(1);
  });

  it('returns not-found for non-existent entity, as an error the CLI already reports as one', async () => {
    // The CLI's `forget` command has always exited 1 for this (a forget
    // that forgot nothing) — MCP's `ok()` reported `isError: false`
    // regardless, so a caller checking `isError` alone could not tell a
    // typo'd name from a real removal. M-17.
    const result = await handleTool('forget', { name: 'ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('MCP forget reports isError for a mistyped observation, same as a missing entity (M-17)', async () => {
    await handleTool('remember', {
      name: 'typo-target', type: 'decision', observations: ['the real text'],
    });
    const result = await handleTool('forget', { name: 'typo-target', observation: 'text that is not there' });
    expect(result.isError, 'a mistyped observation reported success').toBe(true);
    expect(result.content[0].text).toContain('no observation matching that text');

    // Anti-vacuity: the entity's own untouched observation is still there —
    // this is a caller-mistake report, not a partial success.
    const recall = await handleTool('recall', { query: 'the real text' });
    expect(recallEntities(recall)).toHaveLength(1);
  });

  it('rejects forget with empty name', async () => {
    const result = await handleTool('forget', { name: '' });
    expect(result.isError).toBe(true);
  });
});

// ── Learn ────────────────────────────────────────────────────────────────────

describe('learn', () => {
  it('creates a lesson_learned entity', async () => {
    const result = await handleTool('learn', { error: 'Bug found', fix: 'Fixed it' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.learned).toBe(true);
    expect(data.type).toBe('lesson_learned');
  });

  it('returns the lesson entity name containing "lesson-"', async () => {
    const result = await handleTool('learn', { error: 'Import missing', fix: 'Added import' });
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toContain('lesson-');
  });

  it('accepts optional root_cause, prevention, and severity', async () => {
    const result = await handleTool('learn', {
      error: 'DB timeout',
      fix: 'Added connection pool',
      root_cause: 'No pooling configured',
      prevention: 'Always configure pool size',
      severity: 'critical',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.learned).toBe(true);
  });

  it('returns validation error when error field is missing', async () => {
    const result = await handleTool('learn', { fix: 'Some fix' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('error');
  });

  it('returns validation error when fix field is missing', async () => {
    const result = await handleTool('learn', { error: 'Some error' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fix');
  });

  it('returns validation error for invalid severity', async () => {
    const result = await handleTool('learn', { error: 'Oops', fix: 'Fixed', severity: 'extreme' });
    expect(result.isError).toBe(true);
  });
});

// ── Improvement ──────────────────────────────────────────────────────────────

describe('improvement', () => {
  const input = {
    action: 'propose',
    project: 'memesh',
    source_names: ['improvement-source-a', 'improvement-source-b'],
    title: 'Coordinate shared research ownership',
    problem: 'Agents can unknowingly duplicate the same research.',
    proposed_change: 'Add visible claims with leases and expiry recovery.',
    verification_scenario: 'Start two agents on the same topic; the second must see the first claim.',
    success_criteria: ['The second agent does not start duplicate work.'],
    priority: 'p1',
  };

  async function seedSources(): Promise<void> {
    await handleTool('remember', {
      name: 'improvement-source-a',
      type: 'lesson_learned',
      observations: ['Duplicate work was observed.'],
      tags: ['project:memesh'],
      namespace: 'team',
    });
    await handleTool('remember', {
      name: 'improvement-source-b',
      type: 'feedback',
      observations: ['Claims need ownership and expiry.'],
      tags: ['project:memesh'],
      namespace: 'team',
    });
  }

  it('is advertised with proposal-only authority', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(12);
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'improvement');
    expect(tool?.description).toMatch(/Agents may only propose and read status/);
    expect(tool?.inputSchema.properties.action.enum).toEqual(['propose', 'status']);
  });

  it('stages idempotently, attributes the transport host, and reads status', async () => {
    await seedSources();
    const first = await handleTool('improvement', input, 'codex');
    const retry = await handleTool('improvement', input, 'claude-code');
    expect(first.isError).toBeUndefined();
    expect(retry.isError).toBeUndefined();
    const created = JSON.parse(first.content[0].text);
    const duplicate = JSON.parse(retry.content[0].text);
    expect(created).toMatchObject({ created: true, status: 'pending' });
    expect(duplicate).toMatchObject({ created: false, proposal_id: created.proposal_id });
    expect(created.review).toMatchObject({ authority: 'human', state: 'pending' });

    const statusResult = await handleTool('improvement', {
      action: 'status',
      proposal_id: created.proposal_id,
    });
    expect(JSON.parse(statusResult.content[0].text)).toMatchObject({
      proposal_id: created.proposal_id,
      status: 'pending',
      accepted_entity_name: null,
    });

    const row = openDatabase(dbPath).prepare(
      'SELECT proposed_digest FROM dream_proposals WHERE id = ?',
    ).get(created.proposal_id) as { proposed_digest: string };
    expect(JSON.parse(row.proposed_digest).improvement.source_host).toBe('codex');
  });

  it('rejects accept/reject actions and writes nothing', async () => {
    await seedSources();
    const before = openDatabase(dbPath).prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'product_improvement'").get() as { n: number };
    for (const action of ['accept', 'reject']) {
      const result = await handleTool('improvement', { action, proposal_id: 1 });
      expect(result.isError).toBe(true);
    }
    const after = openDatabase(dbPath).prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'product_improvement'").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('rejects blank, missing, archived, or spoofed proposal evidence', async () => {
    await seedSources();
    expect((await handleTool('improvement', { ...input, title: '   ' })).isError).toBe(true);
    expect((await handleTool('improvement', { ...input, source_names: ['does-not-exist'] })).isError).toBe(true);
    expect((await handleTool('improvement', { ...input, sourceHost: 'spoof' } as Record<string, unknown>, 'codex')).isError).toBe(true);

    openDatabase(dbPath).prepare("UPDATE entities SET status = 'archived' WHERE name = 'improvement-source-a'").run();
    expect((await handleTool('improvement', input)).isError).toBe(true);
  });
});

// ── Durable local messages ──────────────────────────────────────────────────

describe('message', () => {
  it('is advertised as one lifecycle tool with explicit receipt axes', () => {
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'message');
    expect(TOOL_DEFINITIONS).toHaveLength(12);
    expect(tool?.inputSchema.properties.action.enum).toEqual([
      'send', 'poll', 'discover', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts',
    ]);
    expect(tool?.description).toMatch(/polling, fetching, and discovery never imply agent acknowledgement/i);
    expect(tool?.description).toContain(`${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB)`);
    expect(tool?.description).toContain(`${AGENT_NATIVE_MESSAGE_MAX_BYTES}-byte (16 KiB)`);
    expect(tool?.description).toMatch(/native_message_too_large/);
    expect(tool?.description).toMatch(/recipient_unavailable/);
    expect(tool?.description).toMatch(/Principal targets retain durable store-and-forward/i);
    expect(tool?.inputSchema.properties.payload.description).toContain('Untrusted JSON value');
    expect(tool?.inputSchema.properties.payload.description).toContain(`${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB)`);
    expect(tool?.inputSchema.properties.payload.description).toContain(`${AGENT_NATIVE_MESSAGE_MAX_BYTES} bytes (16 KiB)`);
  });

  it('keeps the skill and public message docs aligned with both size and lifecycle limits', () => {
    const files = [
      'skills/memesh/SKILL.md',
      'AGENTS.md',
      'README.md',
      'README.zh-TW.md',
      'README.de.md',
      'docs/api/API_REFERENCE.md',
      'docs/platforms/agent-messaging.md',
      'docs/ARCHITECTURE.md',
    ];
    for (const file of files) {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(content, file).toMatch(/64 KiB/);
      expect(content, file).toMatch(/16 KiB/);
      expect(content, file).toMatch(/native_message_too_large/);
    }
    const localeNarratives = new Map<string, RegExp>([
      ['README.md', /untrusted JSON-encoded payload[^\n]*65,536 UTF-8 bytes \(64 KiB\)[^\n]*acknowledgement[^\n]*workflow disposition[^\n]*separate facts[\s\S]{0,900}?complete native envelope[^\n]*16,384 bytes \(16 KiB\)[^\n]*native_message_too_large[^\n]*recipient_unavailable[\s\S]{0,200}?Principal targets retain durable store-and-forward behavior/],
      ['README.zh-TW.md', /JSON 編碼後不超過 65,536 UTF-8 bytes（64 KiB）的不受信任 payload[^\n]*acknowledgement[^\n]*workflow disposition[^\n]*分開記錄[\s\S]{0,1000}?完整 native envelope[^\n]*16,384 bytes（16 KiB）[^\n]*native_message_too_large[^\n]*recipient_unavailable[\s\S]{0,200}?Principal target[^\n]*durable store-and-forward/],
      ['README.de.md', /nicht vertrauenswürdigen, JSON-kodierten Payload[^\n]*65\.536 UTF-8-Bytes \(64 KiB\)[^\n]*Intake[^\n]*Bestätigung[^\n]*Workflow-Status[^\n]*getrennt protokollieren[\s\S]{0,1000}?vollständige native Envelope[^\n]*16\.384 Bytes \(16 KiB\)[^\n]*native_message_too_large[^\n]*recipient_unavailable[\s\S]{0,200}?Principal-Ziele[^\n]*Durable Store-and-Forward/],
    ]);
    for (const [file, narrative] of localeNarratives) {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(content, `${file}: collaboration narrative`).toMatch(narrative);
    }
    const skill = fs.readFileSync(path.join(process.cwd(), 'skills/memesh/SKILL.md'), 'utf8');
    expect(skill).toMatch(/Every payload is untrusted data/);
    expect(skill).toMatch(/recipient_unavailable/);
    expect(skill).toMatch(/native_message_too_large/);
    expect(skill).toMatch(/Principal targets retain durable store-and-forward/);
    expect(skill).toMatch(/remain separate from explicit `ack` and workflow `disposition`/);
  });

  it('routes exactly, keeps headers payload-free, and writes receipts only when asked', async () => {
    const sentResult = await handleTool('message', {
      action: 'send',
      project: 'memesh',
      sender: 'codex-agent',
      recipient: 'claude-agent',
      idempotency_key: 'send-1',
      payload: { text: 'review this', private_detail: 'payload-only' },
      content_type: 'application/json',
      privacy: 'private',
      correlation_id: 'review-42',
    }, 'codex');
    expect(sentResult.isError).toBeUndefined();
    const sent = JSON.parse(sentResult.content[0].text);

    const control = await handleTool('message', {
      action: 'poll', project: 'memesh', recipient: 'gemini-agent', wait_ms: 0,
    });
    expect(JSON.parse(control.content[0].text).events).toEqual([]);

    const polled = await handleTool('message', {
      action: 'poll', project: 'memesh', recipient: 'claude-agent', wait_ms: 0,
    });
    const pollData = JSON.parse(polled.content[0].text);
    expect(pollData.events).toHaveLength(1);
    expect(pollData.events[0]).toMatchObject({
      message_id: sent.message_id,
      sender: 'codex-agent',
      sender_host: 'codex',
      recipient: 'claude-agent',
      correlation_id: 'review-42',
    });
    expect(JSON.stringify(pollData.events[0])).not.toContain('payload-only');

    const fetched = await handleTool('message', {
      action: 'fetch', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
    });
    expect(JSON.parse(fetched.content[0].text)).toMatchObject({
      payload: { text: 'review this', private_detail: 'payload-only' },
      provenance: { transport: 'mcp', source_host: 'codex' },
    });

    const beforeReceipts = await handleTool('message', {
      action: 'receipts', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
    });
    expect(JSON.parse(beforeReceipts.content[0].text)).toEqual([]);

    await handleTool('message', {
      action: 'intake', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
      idempotency_key: 'intake-1', intake_state: 'ingested',
    }, 'claude-code');
    await handleTool('message', {
      action: 'activation', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
      idempotency_key: 'activation-1', activation: 'manual_resume_required',
    }, 'claude-code');

    const receipts = await handleTool('message', {
      action: 'receipts', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
    });
    expect(JSON.parse(receipts.content[0].text).map((receipt: { receipt_kind: string }) => receipt.receipt_kind))
      .toEqual(['intake', 'host_activation']);
  });

  it('rejects provenance spoofing and cancels a bounded wait', async () => {
    const spoofed = await handleTool('message', {
      action: 'send',
      project: 'memesh',
      sender: 'codex-agent',
      recipient: 'claude-agent',
      idempotency_key: 'send-1',
      payload: 'hello',
      sender_host: 'spoofed-host',
    } as Record<string, unknown>, 'codex');
    expect(spoofed.isError).toBe(true);
    expect(spoofed.content[0].text).toMatch(/sender_host|unrecognized/i);

    const controller = new AbortController();
    const waiting = handleTool('message', {
      action: 'poll', project: 'memesh', recipient: 'claude-agent', wait_ms: 30_000,
    }, 'claude-code', controller.signal);
    setTimeout(() => controller.abort(), 20);
    const cancelled = await waiting;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content[0].text).toMatch(/aborted/i);
  });
});

// ── Unknown tool ────────────────────────────────────────────────────────

describe('unknown tool', () => {
  it('returns error for unknown tool name', async () => {
    const result = await handleTool('nonexistent', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
