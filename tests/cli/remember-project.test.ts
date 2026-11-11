import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { execFileSync } from 'node:child_process';
import { getProjectName, _clearProjectNameCache } from '../../src/core/paths.js';
import { handleTool } from '../../src/mcp/tools.js';
import { runCliFromSource } from '../helpers/cli-source.js';

// `memesh remember` files a memory under the directory's project, as the MCP tool
// does for its bound project. What it stores as detail (a commit, a note) must
// stay in that project; a decision, a lesson or a preference is found everywhere.

let root: string;
let dirA: string;
let dirB: string;
let dbPath: string;
let idA: string;
let idB: string;
let previousDir: string | undefined;

const remember = (cwd: string, ...args: string[]) => {
  closeDatabase();
  const result = runCliFromSource(['remember', ...args], { cwd, memeshDir: root, dbPath });
  openDatabase(dbPath);
  expect(result.status, result.stderr).toBe(0);
  return result;
};
const projectTags = (name: string) =>
  (getDatabase().prepare('SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ? AND t.tag LIKE ? ORDER BY t.tag').all(name, 'project:%') as Array<{ tag: string }>).map(r => r.tag);
const recallFrom = async (project: string, query: string) => {
  const response = await handleTool('recall', { query }, undefined, undefined, { projectBinding: { project } });
  expect(response.isError, response.content[0].text).not.toBe(true);
  const entities = JSON.parse(response.content[0].text).entities as Array<{ name: string; projects: string[] }>;
  // An empty answer would make every "not seen" check pass for nothing.
  expect(entities.length).toBeGreaterThan(0);
  return entities;
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-remember-')));
  dirA = path.join(root, 'projA');
  dirB = path.join(root, 'projB');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  dbPath = path.join(root, 'kg.db');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ updateCheck: false }));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = root;
  idA = getProjectName(dirA);
  idB = getProjectName(dirB);
  openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('memesh remember files the memory under the current directory\'s project', () => {
  it('a memory stored from a project directory carries that project, and only it', () => {
    remember(dirB, '--name', 'b-commit', '--type', 'commit', '--obs', 'stampword commit of B');
    remember(dirB, '--name', 'b-decision', '--type', 'decision', '--why', 'a fixed choice for this case; revisit if it changes', '--obs', 'stampword decision of B');
    remember(dirB, 'stampword a quick note of B');
    expect(projectTags('b-commit')).toEqual([`project:${idB}`]);
    expect(projectTags('b-decision')).toEqual([`project:${idB}`]);
    const quick = getDatabase().prepare("SELECT name FROM entities WHERE name LIKE 'stampword%'").get() as { name: string };
    expect(projectTags(quick.name)).toEqual([`project:${idB}`]);
  });

  it('--no-project files it under none, and a project tag in --tags is the one it gets', () => {
    remember(dirB, '--no-project', '--name', 'loose-pref', '--type', 'preference', '--obs', 'stampword preference');
    remember(dirB, '--name', 'tagged-note', '--type', 'note', '--obs', 'stampword tagged', '--tags', `project:${idA}`);
    expect(projectTags('loose-pref')).toEqual([]);
    expect(projectTags('tagged-note')).toEqual([`project:${idA}`]);
  });

  it('a commit stored in B is not seen from A, and a decision stored in B is, labelled with B', async () => {
    remember(dirB, '--name', 'b-commit', '--type', 'commit', '--obs', 'stampword commit of B');
    remember(dirB, '--name', 'b-decision', '--type', 'decision', '--why', 'a fixed choice for this case; revisit if it changes', '--obs', 'stampword decision of B');
    remember(dirA, '--name', 'a-commit', '--type', 'commit', '--obs', 'stampword commit of A');
    const fromA = await recallFrom(idA, 'stampword');
    expect(fromA.map(e => e.name).sort()).toEqual(['a-commit', 'b-decision']);
    expect(fromA.find(e => e.name === 'b-decision')?.projects).toEqual([idB]);
    const fromB = await recallFrom(idB, 'stampword');
    expect(fromB.map(e => e.name).sort()).toEqual(['b-commit', 'b-decision']);
  });
});

describe('a memory stored before the CLI filed memories under a project', () => {
  it('refusing to add to it from a project directory says how to: --no-project', () => {
    getDatabase().prepare("INSERT INTO entities (name, type) VALUES ('Legacy cli note', 'note')").run();
    closeDatabase();
    const refused = runCliFromSource(['remember', '--name', 'Legacy cli note', '--type', 'note', '--obs', 'more'], { cwd: dirA, memeshDir: root, dbPath });
    openDatabase(dbPath);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--no-project');
    remember(dirA, '--name', 'Legacy cli note', '--type', 'note', '--obs', 'more', '--no-project');
    expect(projectTags('Legacy cli note')).toEqual([]);
  });
});

describe('a memory the directory stored before its repository had a remote', () => {
  it('is added to from that directory, and keeps the project tag it was stored under', () => {
    execFileSync('git', ['-C', dirA, 'init', '-q']);
    _clearProjectNameCache();
    const pathId = getProjectName(dirA);
    remember(dirA, '--name', 'Widget plan', '--type', 'fact', '--obs', 'ship in May');
    execFileSync('git', ['-C', dirA, 'remote', 'add', 'origin', 'git@gitlab.com:acme/widgets.git']);
    remember(dirA, '--name', 'Widget plan', '--type', 'fact', '--obs', 'and a manual');
    expect(projectTags('Widget plan')).toEqual([`project:${pathId}`]);
    const obs = (getDatabase().prepare("SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'Widget plan' ORDER BY o.id").all() as Array<{ content: string }>).map(r => r.content);
    expect(obs).toEqual(['ship in May', 'and a manual']);
  });
});
