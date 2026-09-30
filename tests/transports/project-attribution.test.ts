/**
 * #527: a memory must land under the project the caller means.
 *
 * - `learn` takes an optional `project` (like `task_state`); a caller that
 *   names none is attributed the way `task_state` and `briefing` attribute it.
 * - An empty project, or one spelled as a filesystem path, is refused on every
 *   surface (MCP, HTTP, CLI) with a message that names the field.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { app } from '../../src/transports/http/server.js';
import { getDatabase, openDatabase, closeDatabase } from '../../src/db.js';
import { getProjectName } from '../../src/core/paths.js';
import { getTaskState, setTaskState } from '../../src/core/task-state-store.js';
import { remember } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

function tagsOf(name: string): string[] {
  const rows = getDatabase()
    .prepare('SELECT tag FROM tags WHERE entity_id = (SELECT id FROM entities WHERE name = ?)')
    .all(name) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

describe('#527 MCP: learn takes an optional project', () => {
  useTestDatabase('memesh-project-attr-mcp-');

  it('files the lesson under the explicit project', async () => {
    const r = await handleTool('learn', { error: 'e1', fix: 'f1', project: 'proj-explicit' }, 'claude-code');
    expect(r.isError).toBeUndefined();
    const { name } = JSON.parse(textOf(r)) as { name: string };
    expect(tagsOf(name)).toContain('project:proj-explicit');
    expect(name).toContain('proj-explicit');
  });

  it('without a project, uses the same project task_state uses', async () => {
    const r = await handleTool('learn', { error: 'e2', fix: 'f2' }, 'claude-code');
    expect(r.isError).toBeUndefined();
    const { name } = JSON.parse(textOf(r)) as { name: string };
    expect(tagsOf(name)).toContain(`project:${getProjectName()}`);
    const t = await handleTool('task_state', { goal: 'g' }, 'claude-code');
    expect(JSON.parse(textOf(t)).project).toBe(getProjectName());
  });

  it.each([
    ['learn', { error: 'e', fix: 'f', project: '' }],
    ['learn', { error: 'e', fix: 'f', project: '/Users/x/proj' }],
    ['task_state', { project: '', goal: 'g' }],
    ['task_state', { project: '' }],
    ['task_state', { project: '/Users/x/proj', goal: 'g' }],
    ['task_state', { project: 'C:\\Users\\x\\proj', goal: 'g' }],
    ['briefing', { project: '' }],
    ...['a/b', './foo', '../foo', '~/foo', 'a\\b'].flatMap((project): Array<[string, Record<string, unknown>]> => [
      ['learn', { error: 'e', fix: 'f', project }],
      ['task_state', { project, goal: 'g' }],
      ['briefing', { project }],
    ]),
  ])('%s refuses %j and names the field', async (tool, args) => {
    const r = await handleTool(tool, args, 'claude-code');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/project/);
  });

  it('a bare dotted name such as .ssh is still a valid project', async () => {
    const r = await handleTool('task_state', { project: '.ssh', goal: 'g' }, 'claude-code');
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(textOf(r)).project).toBe('.ssh');
  });

  it('task_state keeps reaching a state stored under a decomposed-Unicode key (no canonicalising)', async () => {
    const nfd = 'café-proj';
    expect(nfd).not.toBe(nfd.normalize('NFC'));
    setTaskState({ project: nfd, patch: { goal: 'old goal' } });
    const read = await handleTool('task_state', { project: nfd }, 'claude-code');
    expect(read.isError).toBeUndefined();
    expect(JSON.parse(textOf(read)).state.goal).toBe('old goal');
    await handleTool('task_state', { project: nfd, next: 'n' }, 'claude-code');
    const rows = getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE name LIKE 'task-state:%'").get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    expect(rows.n).toBe(1);
  });

  it('a refused task_state path project writes nothing', async () => {
    const count = () => (getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE name LIKE 'task-state:%'").get() as { n: number }).n;
    await handleTool('task_state', { project: '/Users/x/proj', goal: 'g' }, 'claude-code');
    expect(count()).toBe(0);
    // The query does see a task-state row when one is legitimately written.
    await handleTool('task_state', { project: 'proj-ok', goal: 'g' }, 'claude-code');
    expect(count()).toBeGreaterThan(0);
  });
});

describe('#527 HTTP: POST /v1/learn', () => {
  let server: ReturnType<typeof app.listen>;
  let base = '';
  let tmpDir = '';
  let serverCwd = '';
  const originalCwd = process.cwd();
  let previousMemeshDir: string | undefined;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-project-attr-http-'));
    serverCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-elsewhere-'));
    previousMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = tmpDir;
    openDatabase(path.join(tmpDir, 'test.db'));
    // The server was started somewhere unrelated to the caller's project.
    process.chdir(serverCwd);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    if (previousMemeshDir === undefined) delete process.env.MEMESH_DIR; else process.env.MEMESH_DIR = previousMemeshDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(serverCwd, { recursive: true, force: true });
  });

  async function post(body: unknown): Promise<{ status: number; json: { success: boolean; data?: { name: string }; error?: string } }> {
    const res = await fetch(`${base}/v1/learn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  const entityCount = () => (getDatabase().prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
  const tagCount = () => (getDatabase().prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n;

  it('files the lesson under the caller\'s explicit project, not the server\'s working directory', async () => {
    const r = await post({ error: 'http e', fix: 'http f', project: 'caller-proj' });
    expect(r.status).toBe(200);
    const tags = tagsOf(r.json.data!.name);
    expect(tags).toContain('project:caller-proj');
    expect(tags).not.toContain(`project:${getProjectName(serverCwd)}`);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['non-string', 42],
    ['object', { a: 1 }],
    ['null', null],
    ['absolute path', '/Users/x/proj'],
    ['relative path', '../proj'],
    ['too long', 'x'.repeat(201)],
  ])('refuses a %s project with 400 and changes nothing (no server-cwd fallback)', async (_label, project) => {
    const entitiesBefore = entityCount();
    const tagsBefore = tagCount();
    const body: Record<string, unknown> = { error: 'never stored', fix: 'never stored' };
    if (project !== undefined) body.project = project;
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(r.json.error).toMatch(/^project/);
    expect(r.json.error).not.toContain('\n');
    expect(entityCount()).toBe(entitiesBefore);
    expect(tagCount()).toBe(tagsBefore);
    expect(entitiesBefore).toBeGreaterThan(0);
  });

  describe('GET routes still read a legacy path-shaped project key, exactly as stored', () => {
    const LEGACY = '/Users/legacy/proj';

    it('/v1/task-state and /v1/briefing-index return what is stored under it', async () => {
      setTaskState({ project: LEGACY, patch: { goal: 'legacy goal' } });
      remember({ name: 'legacy-decision', type: 'decision', observations: ['kept'], tags: [`project:${LEGACY}`] });
      const ts = await (await fetch(`${base}/v1/task-state?project=${encodeURIComponent(LEGACY)}`)).json();
      expect(ts.success).toBe(true);
      expect(ts.data.project).toBe(LEGACY);
      expect(ts.data.state.goal).toBe('legacy goal');
      const bi = await (await fetch(`${base}/v1/briefing-index?project=${encodeURIComponent(LEGACY)}`)).json();
      expect(bi.success).toBe(true);
      expect(bi.data.project).toBe(LEGACY);
      expect(JSON.stringify(bi.data.lines)).toContain('[decision] kept');
    });

    it('does not trim or otherwise rewrite the key, and still refuses missing, blank and over-long', async () => {
      const padded = await (await fetch(`${base}/v1/task-state?project=${encodeURIComponent(' ' + LEGACY)}`)).json();
      expect(padded.data.project).toBe(' ' + LEGACY);
      expect(padded.data.state).toEqual({});
      for (const q of ['', '%20%20', 'x'.repeat(201)]) {
        for (const route of ['task-state', 'briefing-index']) {
          expect((await fetch(`${base}/v1/${route}?project=${q}`)).status, `${route} ${q.slice(0, 5)}`).toBe(400);
        }
      }
      expect((await fetch(`${base}/v1/task-state`)).status).toBe(400);
    });

    it('a write to that legacy key is refused and the stored state is unchanged', async () => {
      setTaskState({ project: LEGACY, patch: { goal: 'legacy goal' } });
      const before = JSON.stringify(getTaskState(LEGACY));
      const r = await handleTool('task_state', { project: LEGACY, goal: 'overwritten' }, 'claude-code');
      expect(r.isError).toBe(true);
      expect(JSON.stringify(getTaskState(LEGACY))).toBe(before);
      expect(JSON.parse(before).state.goal).toBe('legacy goal');
    });
  });
});

describe('#527 CLI: an empty or path-shaped project is refused', () => {
  let home = '';
  let notes = '';
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-project-attr-cli-'));
    notes = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-project-attr-notes-'));
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(notes, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh') };
    for (const key of ['MEMESH_DB_PATH', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
    const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env, timeout: 30000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  const cases: Array<[string, string[]]> = [
    ['learn, empty', ['learn', '--error', 'e', '--fix', 'f', '--project', '']],
    ['learn, path', ['learn', '--error', 'e', '--fix', 'f', '--project', '/Users/x/proj']],
    ['task write, empty',['task', '--project', '', '--goal', 'g']],
    ['task read, empty', ['task', '--project', '']],
    ['task write, path', ['task', '--project', '/Users/x/proj', '--goal', 'g']],
    ['task read, path', ['task', '--project', '/Users/x/proj']],
    ['briefing, empty', ['briefing', '--project', '']],
    ['briefing --index, empty', ['briefing', '--project', '', '--index']],
    ['import --notes, empty', ['import', '--notes', '__NOTES__', '--project', '']],
    ['import --notes, path', ['import', '--notes', '__NOTES__', '--project', '/Users/x/proj']],
  ];

  it.each(cases)('%s: exit 1, names --project, no stack trace', (_label, args) => {
    const r = run(args.map((a) => (a === '__NOTES__' ? notes : a)));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('--project');
    expect(r.stderr).not.toMatch(/^\s+at /m);
  });

  it.each(['a/b', './foo', '../foo', '~/foo'])('task and learn refuse the relative path %s', (project) => {
    for (const args of [['task', '--project', project, '--goal', 'g'], ['learn', '--error', 'e', '--fix', 'f', '--project', project]]) {
      const r = run(args);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toContain('--project');
    }
  });

  it('a bare .ssh is allowed, and a decomposed-Unicode project is stored and read back exactly as given', () => {
    expect(run(['task', '--project', '.ssh', '--goal', 'g']).status).toBe(0);
    const nfd = 'café-cli';
    expect(run(['task', '--project', nfd, '--goal', 'g']).status).toBe(0);
    const r = run(['task', '--project', nfd, '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).project).toBe(nfd);
  });

  it('a normal project still works', () => {
    expect(run(['task', '--project', 'alpha', '--goal', 'g']).status).toBe(0);
    expect(run(['task', '--project', 'alpha']).status).toBe(0);
    const learned = run(['learn', '--error', 'e', '--fix', 'f', '--project', 'alpha', '--json']);
    expect(learned.status, learned.stderr).toBe(0);
    expect(JSON.parse(learned.stdout).name).toContain('alpha');
  });
});
