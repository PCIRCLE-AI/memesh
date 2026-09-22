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

// The project id ends in a 32-hex routing hash. The lines `memesh task` prints
// to a person name the project by its label; `--json` keeps the full id, which
// identifies the record.
describe('memesh task names the project by its label, not its hashed id', () => {
  const HASH = '2c0fe491888c8efb9a4894828bbc2733';
  const ID = `memesh~${HASH}`;
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-task-label-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh') };
    for (const key of ['MEMESH_DB_PATH', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
    const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env, timeout: 30000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('the empty state, the write confirmation, the no-change line and the read-back', () => {
    const empty = run(['task', '--project', ID]);
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toContain('Nothing recorded for "memesh" yet.');
    expect(empty.stdout).not.toContain(HASH);

    const wrote = run(['task', '--project', ID, '--goal', 'ship it']);
    expect(wrote.status, wrote.stderr).toBe(0);
    expect(wrote.stdout).toContain('Updated goal for "memesh".');
    expect(wrote.stdout).toContain('Stated about "memesh" today');
    expect(wrote.stdout).not.toContain(HASH);

    const same = run(['task', '--project', ID, '--goal', 'ship it']);
    expect(same.stdout).toContain('No change — "memesh" already said exactly that.');
    expect(same.stdout).not.toContain(HASH);

    const read = run(['task', '--project', ID]);
    expect(read.stdout).toContain('Stated about "memesh" today');
    expect(read.stdout).not.toContain(HASH);
  });

  it('--json keeps the full id: it identifies the record', () => {
    expect(run(['task', '--project', ID, '--goal', 'ship it']).status).toBe(0);
    const json = JSON.parse(run(['task', '--project', ID, '--json']).stdout);
    expect(json.project).toBe(ID);
    expect(JSON.parse(run(['task', '--project', ID, '--goal', 'ship it', '--json']).stdout).project).toBe(ID);
  });

  it('an unreadable record: the message names the label, `project` in --json keeps the id', () => {
    expect(run(['task', '--project', ID, '--goal', 'ship it']).status).toBe(0);
    const dir = path.join(home, '.memesh');
    const dbFile = fs.readdirSync(dir).find((f) => f.endsWith('.db'))!;
    const db = new DatabaseSync(path.join(dir, dbFile));
    db.prepare("UPDATE entities SET metadata = '{not json' WHERE name LIKE 'task-state:%'").run();
    db.close();

    const r = run(['task', '--project', ID]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('task state for project "memesh" is not readable');
    expect(r.stderr).not.toContain(HASH);
    const j = JSON.parse(run(['task', '--project', ID, '--json']).stdout);
    expect(j.project).toBe(ID);
    expect(j.error).toContain('project "memesh"');
    expect(j.error).not.toContain(HASH);
  });
});
