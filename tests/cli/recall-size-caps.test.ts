/**
 * #494 — `memesh recall` (including `--json`) caps the agent-facing result:
 * 8 KB of observations+tags per entity, 32 KB for the whole response,
 * `file:*` tags omitted. Loads src/transports/cli/cli.ts directly via
 * Vite's ssrLoadModule (the pattern tests/cli/briefing-index.test.ts already
 * uses) instead of spawning dist/transports/cli/cli.js, so this exercises
 * the actual source change without requiring `npm run build`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { RECALL_ENTITY_CONTENT_MAX_BYTES, RECALL_RESPONSE_MAX_BYTES } from '../../src/core/recall-agent-view.js';
import { filler, seedOversizedEntity } from '../helpers/recall-size-fixture.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const cliLoader = `
  import { createServer } from 'vite';
  const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts');
    await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]);
  } finally {
    await server.close();
  }
`;

function runCli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', cliLoader, ...args], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_AUTO_CAPTURE: 'false' },
    timeout: 120_000,
  });
}

// Seed directly via KnowledgeGraph — RememberSchema (and so `memesh remember`)
// caps observations at 100 and tags at 50 per call, well under what these
// fixtures need to reproduce the real-graph shape from #494 (157
// observations, 71 tags on one entity).
function seed(home: string, fn: (kg: KnowledgeGraph) => void): void {
  const dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  openDatabase(dbPath);
  try {
    fn(new KnowledgeGraph(getDatabase()));
  } finally {
    closeDatabase();
  }
}

describe('memesh recall size caps (#494)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-recall-size-cli-'));
  });
  afterEach(() => removeTempDir(home));

  it('--json: a large-observation, many-file-tag entity is capped, marked, and file: tags are omitted', () => {
    let observations: string[] = [];
    seed(home, (kg) => {
      observations = seedOversizedEntity(kg, 'recall-size-fixture', 'project:recallsizecli');
    });

    const r = runCli(home, 'recall', '--tag', 'project:recallsizecli', '--json');
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const entity = parsed.entities.find((e: any) => e.name === 'recall-size-fixture');
    expect(entity, 'fixture entity must come back').toBeTruthy();

    expect(entity.tags.some((t: string) => t.startsWith('file:'))).toBe(false);
    expect(entity.tags).toContain('project:recallsizecli');

    const contentBytes = Buffer.byteLength(JSON.stringify(entity.observations)) + Buffer.byteLength(JSON.stringify(entity.tags));
    expect(contentBytes).toBeLessThanOrEqual(RECALL_ENTITY_CONTENT_MAX_BYTES);

    expect(entity.truncated?.observations?.total).toBe(157);
    expect(entity.truncated.observations.shown).toBeGreaterThan(0);
    expect(entity.truncated.observations.shown).toBeLessThan(157);
    expect(entity.observations[0]).toBe(observations[0]);
    expect(parsed.truncated).toBe(true);
  });

  it('--json: a single observation larger than the whole per-entity cap is cut mid-way and marked', () => {
    const huge = filler('huge', 20_000);
    seed(home, (kg) => {
      kg.createEntity('recall-size-single-huge', 'note', {
        observations: [huge],
        tags: ['project:recallsizeclihuge'],
      });
    });

    const r = runCli(home, 'recall', '--tag', 'project:recallsizeclihuge', '--json');
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const entity = parsed.entities.find((e: any) => e.name === 'recall-size-single-huge');
    expect(entity).toBeTruthy();

    expect(entity.observations).toHaveLength(1);
    expect(entity.observations[0].length).toBeLessThan(huge.length);
    expect(entity.observations[0]).toContain('more bytes)');
    expect(entity.truncated.observations).toEqual({ shown: 1, total: 1 });
  });

  // The cap is on JSON bytes: a newline costs 2 once serialized, so an
  // observation cut to 8 KB of raw text would still be ~16 KB of JSON.
  it('--json: a newline-dense observation is cut to 8 KB of JSON, not 8 KB of raw text', () => {
    seed(home, (kg) => {
      kg.createEntity('recall-size-newlines', 'note', {
        observations: ['line\n'.repeat(8000)],
        tags: ['project:recallsizeclinl'],
      });
    });

    const r = runCli(home, 'recall', '--tag', 'project:recallsizeclinl', '--json');
    expect(r.status, r.stderr).toBe(0);
    const entity = JSON.parse(r.stdout).entities.find((e: any) => e.name === 'recall-size-newlines');
    expect(entity).toBeTruthy();

    const contentBytes = Buffer.byteLength(JSON.stringify(entity.observations)) + Buffer.byteLength(JSON.stringify(entity.tags));
    expect(contentBytes).toBeLessThanOrEqual(RECALL_ENTITY_CONTENT_MAX_BYTES);
    expect(entity.observations[0]).toMatch(/^line\n/);
    expect(entity.observations[0]).toContain('more bytes)');
  });

  it('--json: whole entities are dropped from the end once the 32 KB response budget is exceeded', () => {
    const SEEDED = 6;
    seed(home, (kg) => {
      for (let i = 0; i < SEEDED; i++) {
        const observations = Array.from({ length: 30 }, (_, j) => filler(`e${i}o${j}`, 400));
        kg.createEntity(`recall-size-many-${i}`, 'note', {
          observations,
          tags: ['project:recallsizeclimany'],
        });
      }
    });

    const r = runCli(home, 'recall', '--tag', 'project:recallsizeclimany', '--limit', String(SEEDED), '--json');
    expect(r.status, r.stderr).toBe(0);
    expect(Buffer.byteLength(r.stdout.trim())).toBeLessThanOrEqual(RECALL_RESPONSE_MAX_BYTES);
    const parsed = JSON.parse(r.stdout);

    expect(parsed.entities_omitted).toBeTruthy();
    expect(parsed.entities_omitted.total).toBe(SEEDED);
    expect(parsed.entities_omitted.shown).toBe(parsed.entities.length);
    expect(parsed.entities.length).toBeLessThan(SEEDED);
    expect(parsed.truncated).toBe(true);
  });

  it('human-readable output: the "+N more" count is the TRUE total, not the already-capped remainder', () => {
    const observations = Array.from({ length: 157 }, (_, i) => filler(`obs${i}`, 400));
    seed(home, (kg) => {
      kg.createEntity('recall-size-human', 'note', {
        observations,
        tags: ['project:recallsizeclihuman'],
      });
    });

    const r = runCli(home, 'recall', '--tag', 'project:recallsizeclihuman');
    expect(r.status, r.stderr).toBe(0);
    // 157 total, 3 shown inline — the count must read "+154 more", not a
    // count derived from whatever the size cap already trimmed the array
    // to server-side.
    expect(r.stdout).toContain('+154 more');
  });

  it('human-readable output: when every match is too large to show, it says so instead of "No results found."', () => {
    seed(home, (kg) => {
      kg.createEntity('recall-size-huge-metadata', 'note', {
        observations: ['small'],
        tags: ['project:recallsizeclimeta'],
        metadata: { blob: 'm'.repeat(40_000) },
      });
    });

    const r = runCli(home, 'recall', '--tag', 'project:recallsizeclimeta');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 result(s) found, all omitted to keep the response under size');
    expect(r.stdout).not.toContain('No results found');
  });
});
