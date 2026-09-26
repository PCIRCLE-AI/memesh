/**
 * #407 — `--trust` is a second argument to `importMemories`, never a field
 * of `ImportInput`/`ImportSchema`. `handleTool('import', ...)` validates the
 * raw tool call against `ImportSchema` (`.strict()`) before ever reaching
 * `importMemories`, so an MCP caller naming `trust` in the call is refused
 * at the same boundary `tests/transports/forget-selector-safety.test.ts`
 * pins for unknown keys generally — this file is the one case (#407) that
 * matters enough to name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';

let dir: string;
let savedHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-import-mcp-trust-'));
  savedHome = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
  openDatabase(path.join(dir, 'test.db'));
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (savedHome === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = savedHome;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function metadataOf(name: string): Record<string, unknown> {
  const raw = (getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as { metadata: string } | undefined)?.metadata;
  return raw ? JSON.parse(raw) : {};
}

const bundleFor = (name: string) => ({
  version: '3.1.0',
  exported_at: '2026-09-20T00:00:00.000Z',
  entity_count: 1,
  entities: [{ name, type: 'note', namespace: 'personal', observations: ['bundle text'], tags: [], relations: [] }],
});

describe('MCP `import` cannot reach --trust (#407)', () => {
  it('rejects an extra `trust: true` field the same way it rejects any unknown key, and writes nothing', async () => {
    const res = await handleTool('import', { data: bundleFor('mcp-import-trust-refused'), merge_strategy: 'skip', trust: true });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/nrecognized key/);
    expect(getDatabase().prepare('SELECT 1 FROM entities WHERE name = ?').get('mcp-import-trust-refused')).toBeUndefined();
  });

  it('a normal import through the MCP tool stays untrusted', async () => {
    const res = await handleTool('import', { data: bundleFor('mcp-import-normal-untrusted'), merge_strategy: 'skip' });

    expect(res.isError).toBeFalsy();
    const meta = metadataOf('mcp-import-normal-untrusted');
    expect(meta.trust).toBe('untrusted');
    expect((meta.provenance as Record<string, unknown>).source).toBe('import');
  });
});
