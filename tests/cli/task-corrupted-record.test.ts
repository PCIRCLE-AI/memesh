/**
 * `memesh task` against a corrupted task-state record (#237).
 *
 * The store now refuses to read metadata that is not JSON. The CLI must turn
 * that into one sentence with the recovery step — not the fifteen-line Node
 * stack with the absolute install path that `withDatabase` was written to
 * stop for the open path. Spawns the built CLI, because this is about what a
 * user SEES.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

describe('memesh task on a corrupted record', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-task-corrupt-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh') };
    for (const key of ['MEMESH_DB_PATH', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
    const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env, timeout: 30000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  function corrupt(): void {
    const dir = path.join(home, '.memesh');
    const dbFile = fs.readdirSync(dir).find(f => f.endsWith('.db'));
    expect(dbFile, 'no database file was created by the write').toBeDefined();
    const db = new DatabaseSync(path.join(dir, dbFile!));
    const changed = db.prepare("UPDATE entities SET metadata = '{not json' WHERE name LIKE 'task-state:%'").run().changes;
    db.close();
    expect(changed, 'the task-state row was not found to corrupt').toBe(1);
  }

  it('says one sentence with the recovery step, exits 1, and shows no stack trace or install path', () => {
    expect(run(['task', '--project', 'alpha', '--goal', 'ship it']).status).toBe(0);
    corrupt();
    const r = run(['task', '--project', 'alpha']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
    expect(r.stderr).toContain('memesh task --goal');
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(r.stderr).not.toContain(CLI_PATH);
    expect(r.stderr).not.toContain('task-state:');
    // --json callers get the same failure as JSON on stdout.
    const j = run(['task', '--project', 'alpha', '--json']);
    expect(j.status).toBe(1);
    expect(JSON.parse(j.stdout)).toMatchObject({ project: 'alpha', error: expect.stringContaining('not valid JSON') });
  });

  it('a write replaces the broken record — the recovery the message promises', () => {
    expect(run(['task', '--project', 'alpha', '--goal', 'ship it']).status).toBe(0);
    corrupt();
    expect(run(['task', '--project', 'alpha', '--goal', 'recovered']).status).toBe(0);
    const r = run(['task', '--project', 'alpha', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).state.goal).toBe('recovered');
  });
});
