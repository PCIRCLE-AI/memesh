/**
 * #511: `memesh remember --tags project:<name>`, run in a directory whose
 * project id is `<name>~<hash>`, used to file the memory under a separate
 * project that no briefing for that directory reads. It is now stored under
 * the id, and the output says which tag was rewritten. Spawns the built CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProjectName } from '../../src/core/paths.js';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

describe('#511 memesh remember with a plain-name project tag', () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-511-home-'));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-511-repo-')));
  });
  afterEach(() => {
    for (const d of [home, repo]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh') };
    for (const key of ['MEMESH_DB_PATH', 'MEMESH_PROJECT_ROOT', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
    const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env, cwd: repo, timeout: 30000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  function tagsOf(name: string): string[] {
    const dir = path.join(home, '.memesh');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.db'));
    expect(file, 'no database was created').toBeDefined();
    const db = new DatabaseSync(path.join(dir, file!), { readOnly: true });
    try {
      return (db.prepare('SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ? ORDER BY t.tag')
        .all(name) as Array<{ tag: string }>).map((r) => r.tag);
    } finally {
      db.close();
    }
  }

  it('stores the full project id and says which tag it rewrote', () => {
    const id = getProjectName(repo);
    const plain = `project:${id.slice(0, id.lastIndexOf('~'))}`;
    const r = run(['remember', '--name', 'cli-511', '--type', 'decision', '--obs', 'o', '--tags', plain, 'topic:x']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`tag ${plain} names this project; stored as project:${id}`);
    expect(tagsOf('cli-511')).toEqual([`project:${id}`, 'topic:x']);
  });

  it('--json carries the rewrite', () => {
    const id = getProjectName(repo);
    const plain = `project:${id.slice(0, id.lastIndexOf('~'))}`;
    const r = run(['remember', '--name', 'cli-511-json', '--type', 'decision', '--obs', 'o', '--tags', plain, '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).retagged).toEqual({ from: plain, to: `project:${id}` });
  });
});
