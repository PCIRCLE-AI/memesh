import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { _clearProjectNameCache, getProjectIds, getProjectName } from '../../src/core/paths.js';
import { resolveMcpProject } from '../../src/transports/mcp/project-context.js';
import { handleTool } from '../../src/mcp/tools.js';
import { runCliFromSource } from '../helpers/cli-source.js';

// One checkout can have been written under more than one project id: the id of
// its path (before it had a remote, or in the earlier 8-character form) and the
// id of its remote. A read must see all of them, by exact derivation only; a write
// uses the one current id.

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

let base: string;
let repo: string;
let previousDir: string | undefined;
let remoteId: string;
let pathId: string;
let shortPathId: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-read-ids-')));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = path.join(base, 'data');
  fs.mkdirSync(process.env.MEMESH_DIR);
  fs.writeFileSync(path.join(process.env.MEMESH_DIR, 'config.json'), JSON.stringify({ updateCheck: false }));
  repo = path.join(base, 'Widgets');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  pathId = `Widgets~${sha(repo).slice(0, 32)}`;
  shortPathId = `Widgets-${sha(repo).slice(0, 8)}`;
  remoteId = `widgets~${sha('github.com/acme/widgets').slice(0, 32)}`;
  _clearProjectNameCache();
  openDatabase(path.join(base, 'kg.db'));
});

afterEach(() => {
  closeDatabase();
  _clearProjectNameCache();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('getProjectIds', () => {
  it('a checkout without a remote reads its path id and the earlier short form, and writes the path id', () => {
    expect(getProjectName(repo)).toBe(pathId);
    expect(getProjectIds(repo)).toEqual([pathId, shortPathId]);
  });

  it('a checkout with a remote reads the remote id and the path ids, and writes the remote id', () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    _clearProjectNameCache();
    expect(getProjectName(repo)).toBe(remoteId);
    expect(getProjectIds(repo)).toEqual([remoteId, pathId, shortPathId]);
  });

  it('a subdirectory and a linked worktree read the same ids as the checkout', () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', 'a.txt');
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'a');
    const linked = path.join(base, 'linked');
    git(repo, 'worktree', 'add', '-q', linked);
    fs.mkdirSync(path.join(repo, 'sub'));
    _clearProjectNameCache();
    expect(getProjectIds(path.join(repo, 'sub'))).toEqual([remoteId, pathId, shortPathId]);
    expect(getProjectIds(linked)).toEqual([remoteId, pathId, shortPathId]);
  });

  it('a directory that is not a repository has its path ids only', () => {
    const plain = path.join(base, 'notes');
    fs.mkdirSync(plain);
    expect(getProjectIds(plain)).toEqual([`notes~${sha(plain).slice(0, 32)}`, `notes-${sha(plain).slice(0, 8)}`]);
    expect(getProjectIds(plain).length).toBeGreaterThanOrEqual(2);
  });
});

// Before the spellings of one remote converged, a clone made with `git@host:path` and one
// made with `https://host/path.git` got different ids, so did `.git` and no `.git`. What was
// stored under those ids must stay readable from every clone of the repository.
describe('earlier spellings of one remote stay readable', () => {
  const earlier = (locator: string) => `widgets~${sha(locator).slice(0, 32)}`;
  const OLD_LOCATORS = [
    'https://gitlab.com/acme/widgets',
    'ssh-relative://git@gitlab.com/acme/widgets.git',
    'ssh-relative://git@gitlab.com/acme/widgets',
    'ssh-absolute://git@gitlab.com/acme/widgets.git',
    'ssh-absolute://git@gitlab.com/acme/widgets',
  ];
  const canonicalId = earlier('https://gitlab.com/acme/widgets.git');
  const withRemote = (remote: string) => {
    git(repo, 'remote', 'add', 'origin', remote);
    _clearProjectNameCache();
  };

  it('the id a write uses is the same whichever way the remote is spelled', () => {
    withRemote('git@gitlab.com:acme/widgets.git');
    expect(getProjectName(repo)).toBe(canonicalId);
  });

  it('a clone made with git@host:path reads the ids of the https and the no-.git spellings, and the other way round', () => {
    withRemote('git@gitlab.com:acme/widgets.git');
    const viaScp = getProjectIds(repo);
    expect(viaScp.slice(0, 1)).toEqual([canonicalId]);
    for (const locator of [...OLD_LOCATORS, 'https://gitlab.com/acme/widgets.git']) {
      if (earlier(locator) !== canonicalId) expect(viaScp, locator).toContain(earlier(locator));
    }
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets');
    _clearProjectNameCache();
    const viaHttps = getProjectIds(repo);
    expect(viaHttps[0]).toBe(canonicalId);
    for (const locator of OLD_LOCATORS) expect(viaHttps, locator).toContain(earlier(locator));
  });

  it('a remote on any other host has no other spelling to read: its id is the one id, plus the path\'s', () => {
    withRemote('git@selfhosted.test:acme/widgets.git');
    const ids = getProjectIds(repo);
    const literal = `widgets~${sha('ssh-relative://git@selfhosted.test/acme/widgets.git').slice(0, 32)}`;
    expect(ids).toEqual([literal, pathId, shortPathId]);
    // The https address of the same path on that host is not assumed to be the same repository.
    expect(ids).not.toContain(`widgets~${sha('https://selfhosted.test/acme/widgets.git').slice(0, 32)}`);
    expect(ids).not.toContain(`widgets~${sha('ssh-relative://alice@selfhosted.test/acme/widgets.git').slice(0, 32)}`);
  });

  it('never derives a bare name or another repository\'s id', () => {
    withRemote('git@gitlab.com:acme/widgets.git');
    const ids = getProjectIds(repo);
    expect(ids).not.toContain('widgets');
    expect(ids).not.toContain(earlier('https://gitlab.com/acme/gadgets.git'));
    expect(ids).not.toContain(earlier('https://other.test/acme/widgets.git'));
  });

  it('a session bound to the checkout finds memories filed under each earlier spelling, and not another repository\'s', async () => {
    withRemote('https://gitlab.com/acme/widgets.git');
    const kg = new KnowledgeGraph(getDatabase());
    OLD_LOCATORS.forEach((locator, i) => kg.createEntity(`earlier-${i}`, 'note', { observations: ['spellword'], tags: [`project:${earlier(locator)}`] }));
    kg.createEntity('current', 'note', { observations: ['spellword'], tags: [`project:${canonicalId}`] });
    kg.createEntity('other-repo', 'note', { observations: ['spellword'], tags: [`project:${earlier('https://gitlab.com/acme/gadgets.git')}`] });
    const binding = resolveMcpProject(repo, []);
    const response = await handleTool('recall', { query: 'spellword' }, undefined, undefined, { projectBinding: binding as never });
    expect(response.isError, response.content[0].text).not.toBe(true);
    const names = (JSON.parse(response.content[0].text).entities as Array<{ name: string }>).map(e => e.name).sort();
    expect(names).toEqual(['current', ...OLD_LOCATORS.map((_, i) => `earlier-${i}`)].sort());
  });
});

describe('resolveMcpProject carries every id of the root', () => {
  it('names the id writes use first', () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    _clearProjectNameCache();
    expect(resolveMcpProject(repo, [])).toEqual({ project: remoteId, ids: [remoteId, pathId, shortPathId] });
  });
});

describe('recall and remember through an MCP session bound to the checkout', () => {
  const kgNow = () => new KnowledgeGraph(getDatabase());
  const recall = async (binding: unknown, args: Record<string, unknown>) => {
    const response = await handleTool('recall', args, undefined, undefined, { projectBinding: binding as never });
    expect(response.isError, response.content[0].text).not.toBe(true);
    return (JSON.parse(response.content[0].text).entities as Array<{ name: string }>).map(e => e.name).sort();
  };

  it('finds what was written under either id and nothing that merely shares a name', async () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    _clearProjectNameCache();
    const kg = kgNow();
    kg.createEntity('under-path', 'note', { observations: ['idword one'], tags: [`project:${pathId}`] });
    kg.createEntity('under-short', 'note', { observations: ['idword two'], tags: [`project:${shortPathId}`] });
    kg.createEntity('under-remote', 'note', { observations: ['idword three'], tags: [`project:${remoteId}`] });
    kg.createEntity('bare-name', 'note', { observations: ['idword four'], tags: ['project:widgets'] });
    kg.createEntity('same-label-other-hash', 'note', { observations: ['idword five'], tags: [`project:widgets~${'0'.repeat(32)}`] });
    kg.createEntity('other-checkout', 'note', { observations: ['idword six'], tags: [`project:Widgets~${sha(path.join(base, 'other')).slice(0, 32)}`] });
    const binding = resolveMcpProject(repo, []);
    expect(await recall(binding, { query: 'idword' })).toEqual(['under-path', 'under-remote', 'under-short']);
  });

  it('CLI recall --ids reads every id of the repository it runs in, and not another repository\'s memory', () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    _clearProjectNameCache();
    const kg = kgNow();
    kg.createEntity('cli-under-path', 'note', { observations: ['idword a'], tags: [`project:${pathId}`] });
    kg.createEntity('cli-under-remote', 'note', { observations: ['idword b'], tags: [`project:${remoteId}`] });
    kg.createEntity('cli-other', 'note', { observations: ['idword c'], tags: [`project:other~${'1'.repeat(32)}`] });
    const ids = ['cli-under-path', 'cli-under-remote', 'cli-other'].map(n => (getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(n) as { id: number }).id);
    closeDatabase();
    const result = runCliFromSource(['recall', '--ids', ids.join(','), '--json'], { cwd: repo, memeshDir: path.join(base, 'data'), dbPath: path.join(base, 'kg.db') });
    openDatabase(path.join(base, 'kg.db'));
    expect(result.status, result.stderr).toBe(0);
    const statuses = (JSON.parse(result.stdout).results as Array<{ status: string }>).map(r => r.status);
    expect(statuses).toEqual(['found', 'found', 'unavailable']);
  });

  it('writes under one id only', async () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    _clearProjectNameCache();
    const binding = resolveMcpProject(repo, []);
    const response = await handleTool('remember', { name: 'written-now', type: 'note', observations: ['idword now'] }, undefined, undefined, { projectBinding: binding as never });
    expect(response.isError, response.content[0].text).not.toBe(true);
    const tags = (kgNow().getEntity('written-now')?.tags ?? []).filter(t => t.startsWith('project:'));
    expect(tags).toEqual([`project:${remoteId}`]);
  });
});
