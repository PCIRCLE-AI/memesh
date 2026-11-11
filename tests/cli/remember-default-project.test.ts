/**
 * `memesh remember` files a memory under the current directory's project, the
 * same default `memesh learn` and the MCP tools use. `--no-project` stores one
 * with no project. Spawns a bundle of the SOURCE, not dist.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProjectName } from '../../src/core/paths.js';
import { bundleCliFromSource, runBundledCli } from '../helpers/cli-source-bundle.js';
import { removeTempDir } from '../helpers/temp-dir.js';

let bundleDir: string;
let CLI_PATH: string;

describe('memesh remember: default project', () => {
  let home: string;
  let repo: string;

  beforeAll(async () => { ({ cliPath: CLI_PATH, dir: bundleDir } = await bundleCliFromSource()); }, 120_000);
  afterAll(() => { fs.rmSync(bundleDir, { recursive: true, force: true }); });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-rdp-home-'));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-rdp-repo-')));
  });
  afterEach(() => {
    removeTempDir(home);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const run = (args: string[]) => runBundledCli(CLI_PATH, args, home, repo);

  function projectTagsOf(name: string): string[] {
    const db = new DatabaseSync(path.join(home, '.memesh', 'knowledge-graph.db'), { readOnly: true });
    try {
      return (db.prepare("SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ? AND t.tag LIKE 'project:%' ORDER BY t.tag")
        .all(name) as Array<{ tag: string }>).map((r) => r.tag);
    } finally { db.close(); }
  }

  it('without --project, files the memory under the current directory project (the one learn uses)', () => {
    const id = getProjectName(repo);
    const r = run(['remember', '--name', 'rdp-a', '--type', 'note', '--obs', 'o']);
    expect(r.status, r.stderr).toBe(0);
    expect(projectTagsOf('rdp-a')).toHaveLength(1);
    expect(projectTagsOf('rdp-a')).toEqual([`project:${id}`]);
    expect(r.stdout).toContain(`project ${id}`);
    expect(r.stdout).toContain('--no-project');

    const l = run(['learn', '--error', 'e', '--fix', 'f']);
    expect(l.status, l.stderr).toBe(0);
    expect(projectTagsOf(l.stdout.replace('Lesson recorded: ', '').trim())).toEqual([`project:${id}`]);
  });

  it('quick text is filed under the project too', () => {
    const r = run(['remember', 'Use SQLite for local state']);
    expect(r.status, r.stderr).toBe(0);
    const name = /Stored "([^"]+)"/.exec(r.stdout)![1];
    expect(projectTagsOf(name)).toEqual([`project:${getProjectName(repo)}`]);
  });

  it('--no-project stores a memory with no project', () => {
    const r = run(['remember', '--name', 'rdp-none', '--type', 'note', '--obs', 'o', '--no-project']);
    expect(r.status, r.stderr).toBe(0);
    expect(projectTagsOf('rdp-none')).toEqual([]);
  });

  it('--no-project declares "no project": it cannot change a memory that belongs to one, as over MCP', () => {
    expect(run(['remember', '--name', 'rdp-owned', '--type', 'note', '--obs', 'o']).status).toBe(0);
    const r = run(['remember', '--name', 'rdp-owned', '--type', 'note', '--obs', 'more', '--no-project']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a write without a project cannot change it');
  });

  it('--project names the project explicitly', () => {
    const r = run(['remember', '--name', 'rdp-x', '--type', 'note', '--obs', 'o', '--project', 'other-proj']);
    expect(r.status, r.stderr).toBe(0);
    expect(projectTagsOf('rdp-x')).toEqual(['project:other-proj']);
  });

  it('an explicit project: tag decides, no second project is added', () => {
    const r = run(['remember', '--name', 'rdp-t', '--type', 'note', '--obs', 'o', '--tags', 'project:tagged-proj']);
    expect(r.status, r.stderr).toBe(0);
    expect(projectTagsOf('rdp-t')).toEqual(['project:tagged-proj']);
  });
});
