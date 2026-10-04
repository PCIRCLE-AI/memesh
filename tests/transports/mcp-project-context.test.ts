import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectName } from '../../src/core/paths.js';
import { resolveMcpProject } from '../../src/transports/mcp/project-context.js';

const dirs: string[] = [];
function dir(name: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mcp-ctx-${name}-`)));
  dirs.push(d);
  return d;
}
const uri = (d: string) => pathToFileURL(d).href;
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('resolveMcpProject: the project an MCP call belongs to when it names none', () => {
  it('one workspace root is that root\'s project', () => {
    const a = dir('a');
    expect(resolveMcpProject(undefined, [uri(a)])).toEqual({ project: getProjectName(a) });
  });

  it('no root and no launch root is unbound', () => {
    expect(resolveMcpProject(undefined, [])).toMatchObject({ error: 'workspace_unavailable', unbound: true });
  });

  it('roots naming two projects are ambiguous; two roots of one project are not', () => {
    const a = dir('a'); const b = dir('b');
    expect(resolveMcpProject(undefined, [uri(a), uri(b)])).toMatchObject({ error: 'workspace_ambiguous' });
    const sub = path.join(a, 'sub'); fs.mkdirSync(sub);
    // A non-git directory is its own project, so a subdirectory is a different one.
    expect(getProjectName(sub)).not.toBe(getProjectName(a));
    expect(resolveMcpProject(undefined, [uri(a), uri(a)])).toEqual({ project: getProjectName(a) });
  });

  it('the launch root alone binds the call (a host that sends no roots)', () => {
    const a = dir('a');
    expect(resolveMcpProject(a, [])).toEqual({ project: getProjectName(a) });
  });

  it('an unusable launch root is refused, never replaced by the roots or the server cwd', () => {
    const a = dir('a');
    const file = path.join(a, 'f.txt'); fs.writeFileSync(file, 'x');
    for (const bad of ['relative/dir', path.join(a, 'missing'), file, '']) {
      const r = resolveMcpProject(bad, [uri(a)]);
      expect(r).toMatchObject({ error: 'workspace_unavailable' });
      expect('reason' in r && r.reason).toMatch(/MEMESH_PROJECT_ROOT/);
      // Set but unusable is not unbound: recall must not fall back on it.
      expect('unbound' in r).toBe(false);
    }
  });

  it('a launch root and a workspace root naming different projects is a conflict', () => {
    const a = dir('a'); const b = dir('b');
    const r = resolveMcpProject(a, [uri(b)]);
    expect(r).toMatchObject({ error: 'workspace_ambiguous' });
    expect('reason' in r && r.reason).toMatch(/MEMESH_PROJECT_ROOT/);
    expect(resolveMcpProject(a, [uri(a)])).toEqual({ project: getProjectName(a) });
  });

  it('roots the client advertised but did not return bind nothing, not even with a launch root', () => {
    const a = dir('a');
    for (const launch of [undefined, a]) {
      const r = resolveMcpProject(launch, null);
      expect(r).toMatchObject({ error: 'workspace_unavailable' });
      expect('reason' in r && r.reason).toMatch(/did not return them/);
      expect('unbound' in r).toBe(false);
    }
  });

  it('a root that is not an existing local directory makes the binding unavailable, never skipped', () => {
    const a = dir('a');
    const missing = path.join(a, 'missing');
    for (const bad of ['https://example.com/x', 'not a uri', 'file:', 'file://', uri(missing)]) {
      const r = resolveMcpProject(undefined, [uri(a), bad]);
      expect(r, bad).toMatchObject({ error: 'workspace_unavailable' });
      expect('reason' in r && r.reason).toMatch(/not an existing local directory/);
      expect('unbound' in r).toBe(false);
    }
    // Nor does a valid launch root paper over it.
    expect(resolveMcpProject(a, [uri(missing)])).toMatchObject({ error: 'workspace_unavailable' });
  });

  it('the server process cwd is never the answer', () => {
    const cwd = process.cwd();
    const elsewhere = dir('cwd');
    process.chdir(elsewhere);
    try {
      expect(resolveMcpProject(undefined, [])).toMatchObject({ error: 'workspace_unavailable' });
      expect(resolveMcpProject('', [])).toMatchObject({ error: 'workspace_unavailable' });
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('task_state and briefing without a project use the bound project, never the server cwd', () => {
  // Imported lazily so the resolver tests above need no database.
  let db: typeof import('../../src/db.js');
  let tools: typeof import('../../src/mcp/tools.js');
  let names: typeof import('../../src/core/task-state.js');
  let home: string;
  const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
  // Every entity, not one type: a refusal must write nothing at all.
  const rows = () => (db.getDatabase().prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
  const call = (name: string, args: Record<string, unknown>, launch: string | undefined, roots: string[]) =>
    tools.handleTool(name, args, 'codex', undefined, { workspaceRootUris: roots, projectBinding: resolveMcpProject(launch, roots) });

  beforeEach(async () => {
    db = await import('../../src/db.js');
    tools = await import('../../src/mcp/tools.js');
    names = await import('../../src/core/task-state.js');
    home = dir('db');
    db.openDatabase(path.join(home, 'kg.db'));
  });
  afterEach(() => { db.closeDatabase(); });

  it('unbound: refused, and nothing is written', async () => {
    const before = rows();
    const r = await call('task_state', { goal: 'g' }, undefined, []);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^workspace_unavailable: /);
    const b = await call('briefing', {}, undefined, []);
    expect(b.isError).toBe(true);
    // The refusal is returned instead of a briefing: no briefing payload at all,
    // so the consumer (and its cwd fallback) never ran.
    expect(text(b)).toMatch(/^workspace_unavailable: /);
    expect(() => JSON.parse(text(b))).toThrow();
    expect(rows()).toBe(before);
  });

  it('launch root A then launch root B (stale A overwritten): each call lands in its own project', async () => {
    const a = dir('a'); const b = dir('b');
    expect((await call('task_state', { goal: 'ship A' }, a, [])).isError).toBeFalsy();
    const readB = JSON.parse(text(await call('task_state', {}, b, [])));
    expect(readB.state.goal).toBeUndefined();
    const readA = JSON.parse(text(await call('task_state', {}, a, [])));
    expect(readA.state.goal).toBe('ship A');
    expect(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM entities WHERE name = ?').get(names.taskStateName(getProjectName(a)))).toEqual({ n: 1 });
  });

  it('a launch root that conflicts with the workspace root is refused before any write', async () => {
    const a = dir('a'); const b = dir('b');
    const before = rows();
    const r = await call('task_state', { goal: 'g' }, a, [uri(b)]);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^workspace_ambiguous: .*MEMESH_PROJECT_ROOT/);
    expect(rows()).toBe(before);
  });

  it('an explicit project is honoured even when the session is bound to another', async () => {
    const a = dir('a');
    expect((await call('task_state', { project: 'other', goal: 'g' }, a, [])).isError).toBeFalsy();
    expect(JSON.parse(text(await call('task_state', { project: 'other' }, undefined, []))).state.goal).toBe('g');
  });

  it('briefing without a project briefs the bound project', async () => {
    const a = dir('a');
    const r = await call('briefing', {}, undefined, [uri(a)]);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).project).toBe(getProjectName(a));
  });
});
