import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { handleTool } from '../../src/mcp/tools.js';
import { selectBriefingPools } from '../../src/core/briefing-pools.js';
import { app } from '../../src/transports/http/server.js';
import { runCliFromSource } from '../helpers/cli-source.js';
import { WorkPackageSchema } from '../../src/transports/schemas.js';

// Tags that start with `source:` record where MeMesh got a memory (a note file, its own
// capture). No caller can claim one, over MCP, HTTP or the CLI, so an agent cannot dress
// its own memory as something MeMesh imported.

let root: string;
let dbPath: string;
let previousDir: string | undefined;
const tagsOf = (name: string) =>
  (getDatabase().prepare('SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ? ORDER BY t.tag').all(name) as Array<{ tag: string }>).map(r => r.tag);
const exists = (name: string) => getDatabase().prepare('SELECT 1 FROM entities WHERE name = ?').get(name) !== undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-reserved-tag-')));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = root;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ updateCheck: false }));
  dbPath = path.join(root, 'kg.db');
  openDatabase(dbPath);
});
afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const FORGED = ['source:note-file', 'Source:Note-File', ' source:auto-capture'];

describe('a caller cannot write a source: tag', () => {
  it('MCP refuses it, names the reason, and stores nothing', async () => {
    for (const [i, tag] of FORGED.entries()) {
      const response = await handleTool('remember', { name: `forged-mcp-${i}`, type: 'feedback', observations: ['x'], tags: [tag], project: false });
      expect(response.isError, tag).toBe(true);
      expect(response.content[0].text).toMatch(/reserved for MeMesh/);
      expect(exists(`forged-mcp-${i}`)).toBe(false);
    }
  });

  it('HTTP refuses it with a 400 and stores nothing', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable');
      for (const [i, tag] of FORGED.entries()) {
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/remember`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `forged-http-${i}`, type: 'feedback', observations: ['x'], tags: [tag] }),
        });
        expect(response.status, tag).toBe(400);
        expect(JSON.stringify(await response.json())).toMatch(/reserved for MeMesh/);
        expect(exists(`forged-http-${i}`)).toBe(false);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it('the CLI refuses it, exits 1, and stores nothing', () => {
    closeDatabase();
    const result = runCliFromSource(['remember', '--name', 'forged-cli', '--type', 'feedback', '--obs', 'x', '--no-project', '--tags', 'source:note-file'], { cwd: root, memeshDir: root, dbPath });
    openDatabase(dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reserved for MeMesh/);
    expect(exists('forged-cli')).toBe(false);
  });

  it('any other tag is stored as before', async () => {
    const response = await handleTool('remember', { name: 'plain-tags', type: 'note', observations: ['x'], tags: ['origin:me', 'topic:style'], project: false });
    expect(response.isError, response.content[0].text).not.toBe(true);
    expect(tagsOf('plain-tags')).toEqual(['origin:me', 'topic:style']);
  });
});

describe('a backup that holds source: tags still restores', () => {
  it('export, delete, import: the tags come back, the memory is untrusted, and the shared pool ignores it', async () => {
    const created = await handleTool('remember', { name: 'backed-up', type: 'preference', observations: ['Prefer small diffs'], project: false });
    expect(created.isError, created.content[0].text).not.toBe(true);
    // What MeMesh itself writes (a hook, the note importer): a source: tag, a mark of trust and
    // note provenance. No tool, route or command can write these, so the test does.
    const db = getDatabase();
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('backed-up') as { id: number }).id;
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'source:auto-capture');
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'source:note-file');
    db.prepare("UPDATE entities SET metadata = json_set(json_set(COALESCE(metadata, '{}'), '$.trust', 'trusted'), '$.provenance.source', 'note-file') WHERE id = ?").run(id);

    const exported = await handleTool('export', {});
    expect(exported.isError, exported.content[0].text).not.toBe(true);
    const data = JSON.parse(exported.content[0].text);
    db.prepare('DELETE FROM entities WHERE id = ?').run(id);
    expect(exists('backed-up')).toBe(false);

    const restored = await handleTool('import', { data, merge_strategy: 'skip' });
    expect(restored.isError, restored.content[0].text).not.toBe(true);
    expect(exists('backed-up')).toBe(true);
    expect(tagsOf('backed-up')).toEqual(['source:auto-capture', 'source:note-file']);
    const meta = JSON.parse((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('backed-up') as { metadata: string }).metadata) as { trust: string; provenance: { source: string } };
    expect(meta.trust).toBe('untrusted');
    expect(meta.provenance.source).toBe('import');
    // The tag is kept, but it is only a tag: the briefing's pool reads provenance.
    const pools = selectBriefingPools(getDatabase(), 'some-project', { projectLimit: 10, global: false, foreign: false });
    expect(pools.shared.map(r => r.name)).not.toContain('backed-up');
  });
});

describe('a work package result cannot carry a source: tag either', () => {
  const submit = (tags: string[]) => WorkPackageSchema.safeParse({
    action: 'submit',
    package_id: 'a'.repeat(64),
    ref: { kind: 'digest', project: 'p', source_ids: [1, 2, 3, 4, 5], source_hash: 'b'.repeat(64) },
    result: { name: 'wp-digest', type: 'digest', observations: ['x'], tags },
  });
  it('is refused with the reason, in any spelling, and an ordinary tag still passes', () => {
    expect(submit(['origin:x']).success).toBe(true);
    for (const tag of ['source:note-file', 'Source:auto-capture', ' SOURCE:explicit']) {
      const parsed = submit(['origin:x', tag]);
      expect(parsed.success, tag).toBe(false);
      expect(parsed.success ? '' : parsed.error.issues[0].message).toMatch(/reserved for MeMesh/);
    }
  });
});
