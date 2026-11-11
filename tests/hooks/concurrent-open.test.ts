/**
 * Several hooks fire in the same second on a data folder that does not exist
 * yet (a new project, a fresh install, two sessions opening together). SQLite
 * answers "database is locked" to the WAL switch at once, whatever the busy
 * timeout, when a peer is in the middle of the same switch. Before the fix a
 * hook that lost the race gave up on its capture; now it retries inside its
 * 2 s budget, and a hook that still cannot open records WHY.
 *
 * The hooks are real child processes released together by a loader that spins
 * until one shared instant.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { withoutHostIdentity } from '../helpers/host-env.js';
import { runChild } from '../helpers/run-child.js';

const require = createRequire(import.meta.url);
const { openHookDb } = require('../../scripts/hooks/_shared.js');
const HOOK = path.resolve('scripts/hooks/pre-compact.js');
const HOOKS = 10;
const ROUNDS = 30;

function runHook(root: string, dbPath: string, loader: string, start: number, n: number): Promise<{ code: number | null; stderr: string }> {
  const env = { ...withoutHostIdentity(process.env), MEMESH_DB_PATH: dbPath, MEMESH_TEST_START: String(start) };
  return runChild(['--import', pathToFileURL(loader).href, HOOK], env, JSON.stringify({ session_id: `concurrent-${n}`, cwd: root, trigger: 'auto' }));
}

describe('hooks started together on a fresh data folder', () => {
  it(`${HOOKS} hooks per round record a write each and none a skip or error, ${ROUNDS} rounds in a row`, async () => {
    // Pin: a run with fewer than two hooks proves nothing about a race.
    expect(HOOKS).toBeGreaterThanOrEqual(2);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-concurrent-'));
    const loader = path.join(root, 'barrier.mjs');
    fs.writeFileSync(loader, 'const t = Number(process.env.MEMESH_TEST_START); while (Date.now() < t) { /* spin */ }\n');
    const problems: string[] = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const dir = path.join(root, `round-${round}`);
        const dbPath = path.join(dir, 'knowledge-graph.db');
        const start = Date.now() + 500;
        const results = await Promise.all(Array.from({ length: HOOKS }, (_, n) => runHook(root, dbPath, loader, start, n)));
        results.forEach((r, n) => { if (r.code !== 0) problems.push(`round ${round} hook ${n}: exit ${r.code} ${r.stderr.trim()}`); });
        const outcomesFile = path.join(dir, 'hook-outcomes.jsonl');
        const records = fs.existsSync(outcomesFile)
          ? fs.readFileSync(outcomesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { outcome: string; reason?: string })
          : [];
        const wrote = records.filter((r) => r.outcome === 'wrote').length;
        if (wrote !== HOOKS) {
          problems.push(`round ${round}: ${wrote}/${HOOKS} wrote; others: ${JSON.stringify(records.filter((r) => r.outcome !== 'wrote'))}`);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(problems).toEqual([]);
  }, 240_000);

  it('a hook that cannot get the database within its budget throws a locked error naming the folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-locked-'));
    const dbPath = path.join(root, 'knowledge-graph.db');
    const holder = require('../../scripts/hooks/_generated/sqlite.js').MemeshDatabase;
    const peer = new holder(dbPath);
    peer.exec('PRAGMA journal_mode = DELETE');
    peer.exec('CREATE TABLE t(x)');
    peer.exec('BEGIN EXCLUSIVE');
    const started = Date.now();
    try {
      let thrown: (Error & { code?: string }) | undefined;
      try { openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }); } catch (err) { thrown = err as Error & { code?: string }; }
      expect(thrown?.code).toBe('MEMESH_DB_LOCKED');
      expect(thrown?.message).toContain(root);
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      peer.exec('ROLLBACK');
      peer.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
