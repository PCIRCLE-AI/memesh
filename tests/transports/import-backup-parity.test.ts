import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { exportMemories } from '../../src/core/serializer.js';
import { app } from '../../src/transports/http/server.js';
import type { ExportResult } from '../../src/core/types.js';

// Build the actual process entry points from source so removing a schema
// field makes these tests fail without needing to rebuild tracked dist/.
const root = path.resolve(__dirname, '../..');
const transports = ['cli', 'mcp', 'http'] as const;
type Transport = typeof transports[number];
let built: string;
let dir: string;
let savedDir: string | undefined;
let server: ReturnType<typeof app.listen>;
let port: number;

beforeAll(async () => {
  built = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-import-source-'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(built, 'package.json'));
  await build({
    absWorkingDir: root,
    entryPoints: {
      'dist/transports/cli/cli': 'src/transports/cli/cli.ts',
      'dist/mcp/server': 'src/mcp/server.ts',
    },
    outdir: built, bundle: true, platform: 'node', format: 'esm', target: 'node22.13',
    packages: 'bundle', external: ['node:*'], legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
});

afterAll(() => fs.rmSync(built, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-import-parity-'));
  savedDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  openDatabase(path.join(dir, 'knowledge-graph.db'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase();
  if (savedDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = savedDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function importVia(transport: Transport, data: unknown, strategy = 'skip', restore = false) {
  const args = { data, merge_strategy: strategy, ...(restore ? { restore_archived: true } : {}) };
  if (transport === 'http') {
    const response = await fetch(`http://127.0.0.1:${port}/v1/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    const body = await response.json();
    return { ok: response.ok && body.success === true && !body.data?.errors?.length, text: JSON.stringify(body) };
  }
  const env = {
    HOME: dir, USERPROFILE: dir, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'knowledge-graph.db'),
    MEMESH_AUTO_UPDATE: '0', MEMESH_UPDATE_CHECK: '0', PATH: path.dirname(process.execPath),
  };
  if (transport === 'cli') {
    const file = path.join(dir, 'backup.json');
    fs.writeFileSync(file, JSON.stringify(data));
    const result = spawnSync(process.execPath, [path.join(built, 'dist/transports/cli/cli.js'),
      'import', file, '--merge', strategy, ...(restore ? ['--restore-archived'] : [])],
    { env, cwd: dir, encoding: 'utf8', timeout: 30_000 });
    return { ok: result.status === 0, text: result.stdout + result.stderr };
  }
  const client = new Client({ name: 'import-parity-test', version: '1' });
  const connection = new StdioClientTransport({
    command: process.execPath, args: [path.join(built, 'dist/mcp/server.js')], cwd: dir, env, stderr: 'pipe',
  });
  try {
    await client.connect(connection);
    const result = await client.callTool({ name: 'import', arguments: args });
    const first = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    if (result.isError) return { ok: false, text: first };
    const body = JSON.parse(first);
    return { ok: !result.isError && !body.errors?.length, text: first };
  } finally {
    await client.close();
  }
}

function bundle(): ExportResult {
  const kg = new KnowledgeGraph(getDatabase());
  for (const name of ['active-backup', 'archived-backup']) {
    kg.createEntity(name, 'note', { observations: ['original fact'], tags: ['project:backup'],
      metadata: { source_kind: 'note-file', previous_namespace: 'team',
        guard: { enabled: true, pattern: '.*' }, trust: 'trusted', task_state: { goal: 'not authority' } } });
    getDatabase().prepare('UPDATE entities SET created_at = ? WHERE name = ?').run('2024-01-02 03:04:05', name);
  }
  kg.archiveEntity('archived-backup');
  const data = exportMemories({});
  expect(data.entities).toHaveLength(2);
  getDatabase().exec('DELETE FROM entities');
  return data;
}

describe.each(transports)('#594 backup restore over %s', (transport) => {
  it.each([false, true])('append restores a relation to an existing target with new text=%s', async (withText) => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('append-source', 'note', { observations: ['local fact'], tags: ['local-tag'] });
    kg.createEntity('append-target', 'note', { observations: ['target fact'] });
    const data = { version: '4.10.12', exported_at: '2026-10-08T00:00:00.000Z', entity_count: 1,
      entities: [{ name: 'append-source', type: 'note', namespace: 'personal',
        observations: withText ? ['local fact', 'bundle fact'] : ['local fact'], tags: [],
        relations: [{ to: 'append-target', type: 'depends-on' }] }] };
    const result = await importVia(transport, data, 'append');
    expect(result.ok, result.text).toBe(true);
    expect(kg.getRelations('append-source')).toEqual([
      { from: 'append-source', to: 'append-target', type: 'depends-on' },
    ]);
    expect(kg.getEntity('append-source')?.observations).toEqual(withText ? ['local fact', 'bundle fact'] : ['local fact']);
    expect(kg.getEntity('append-source')?.tags).toEqual(['local-tag']);
  });

  it.each(['skip', 'append', 'overwrite'])('keeps archived state, creation time and safe metadata (%s)', async (strategy) => {
    const result = await importVia(transport, bundle(), strategy);
    expect(result.ok, result.text).toBe(true);
    const kg = new KnowledgeGraph(getDatabase());
    for (const name of ['active-backup', 'archived-backup']) {
      const entity = kg.getEntity(name)!;
      expect(entity.created_at).toBe('2024-01-02 03:04:05');
      expect(Boolean(entity.archived)).toBe(name === 'archived-backup');
      expect(entity.metadata).toMatchObject({ source_kind: 'note-file', previous_namespace: 'team', trust: 'untrusted' });
      expect(entity.metadata?.provenance).toMatchObject({ source: 'import' });
      expect(entity.metadata?.guard).toBeUndefined();
      expect(entity.metadata?.task_state).toBeUndefined();
    }
    // Restored archived text must not come back through search.
    expect(kg.search('original', { limit: 10, countAsAccess: false }).map((entity) => entity.name)).toEqual(['active-backup']);
  });

  it('accepts legacy fields and leaves future unknown fields inert', async () => {
    const data = { version: '3.0.0', exported_at: '2024-01-02T03:04:05Z', entity_count: 1,
      entities: [{ name: 'legacy', type: 'note', namespace: 'personal', observations: ['old fact'],
        tags: [], relations: [], future_field: { guard: true } }] };
    const result = await importVia(transport, data);
    expect(result.ok, result.text).toBe(true);
    const entity = new KnowledgeGraph(getDatabase()).getEntity('legacy')!;
    expect(entity.archived).toBeUndefined();
    expect(entity.metadata?.future_field).toBeUndefined();
    expect(entity.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it.each(['append', 'overwrite'])('respects local archives until explicitly restored (%s)', async (strategy) => {
    const data = bundle();
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('active-backup', 'note', { observations: ['local fact'] });
    kg.archiveEntity('active-backup');
    const first = await importVia(transport, data, strategy);
    expect(first.ok, first.text).toBe(true);
    expect(kg.getEntity('active-backup')?.archived).toBe(true);
    expect(kg.getEntity('active-backup')?.observations).toEqual(['local fact']);
    const restored = await importVia(transport, data, strategy, true);
    expect(restored.ok, restored.text).toBe(true);
    expect(kg.getEntity('active-backup')?.archived).toBeUndefined();
    expect(kg.getEntity('active-backup')?.observations).toContain('original fact');
  });

  it.each([{ status: 7 }, { created_at: 7 }, { metadata: [] }])('refuses malformed backup fields without creating the entry: %j', async (fields) => {
    const data = { version: '4', exported_at: '2024-01-02T03:04:05Z', entity_count: 1,
      entities: [{ name: 'invalid', type: 'note', namespace: 'personal', observations: ['bad'], tags: [], relations: [], ...fields }] };
    const result = await importVia(transport, data);
    expect(result.ok, result.text).toBe(false);
    expect(new KnowledgeGraph(getDatabase()).getEntity('invalid')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('refuses a write to a read-only backup without changing it', async () => {
    const data = bundle();
    closeDatabase();
    const file = path.join(dir, 'knowledge-graph.db');
    fs.chmodSync(file, 0o444);
    const digest = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = digest();
    try {
      const result = await importVia(transport, data);
      expect(result.ok, result.text).toBe(false);
      expect(digest()).toBe(before);
      expect(fs.statSync(file).mode & 0o222).toBe(0);
    } finally {
      closeDatabase();
      fs.chmodSync(file, 0o600);
    }
  });
});
