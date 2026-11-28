import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { handleTool } from '../../src/mcp/tools.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-ac57-mcp-');
const binding = (project: string) => ({ projectBinding: { project, ids: [project] } });
const call = (name: string, args: Record<string, unknown>, project = 'p') =>
  handleTool(name, args, undefined, undefined, binding(project));
const remember = (args: Record<string, unknown>, project = 'p') => call('remember', args, project);
const state = (name: string) => {
  const db = getDatabase();
  const rows = db.prepare('SELECT id, type, status FROM entities WHERE name = ?').all(name) as Array<{ id: number; type: string; status: string }>;
  if (!rows.length) return { rows, observations: [], tags: [], relations: [] };
  const id = rows[0].id;
  const observations = (db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(id) as Array<{ content: string }>).map(r => r.content);
  const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ? ORDER BY tag').all(id) as Array<{ tag: string }>).map(r => r.tag);
  const relations = db.prepare('SELECT * FROM relations WHERE from_entity_id = ? OR to_entity_id = ?').all(id, id);
  return { rows, observations, tags, relations };
};
const ok = (r: Awaited<ReturnType<typeof remember>>) => expect(r.isError, r.content[0].text).not.toBe(true);
const refused = (r: Awaited<ReturnType<typeof remember>>) => expect(r.isError, r.content[0].text).toBe(true);

describe('AC57 MCP append to an unfiled memory', () => {
  it('appends without a type from two bound projects and recalls one unfiled memory', async () => {
    ok(await remember({ name: 'shared-ac57', type: 'note', observations: ['original'], project: false }));
    const before = state('shared-ac57');
    ok(await remember({ name: 'shared-ac57', observations: ['from p'] }, 'p'));
    ok(await remember({ name: 'shared-ac57', observations: ['from q'] }, 'q'));
    const after = state('shared-ac57');
    expect(after.rows).toEqual(before.rows);
    expect(after.observations).toEqual(['original', 'from p', 'from q']);
    expect(after.tags).toEqual([]);
    for (const project of ['p', 'q']) {
      const result = await call('recall', { query: 'shared-ac57' }, project);
      ok(result);
      const entities = JSON.parse(result.content[0].text).entities as Array<{ id: number; name: string; observations: unknown[]; projects: string[] }>;
      const match = entities.filter(e => e.name === 'shared-ac57');
      expect(match).toHaveLength(1);
      expect(match[0].id).toBe(after.rows[0].id);
      expect(match[0].projects).toEqual([]);
      expect(JSON.stringify(match[0].observations)).toContain('original');
      expect(JSON.stringify(match[0].observations)).toContain('from q');
    }
  });

  it('keeps explicit scope, replace and foreign ownership guards and rejects internal flags', async () => {
    ok(await remember({ name: 'unfiled', type: 'note', observations: ['original'], project: false }));
    ok(await remember({ name: 'foreign', type: 'note', observations: ['foreign original'], project: 'q' }));
    const original = state('unfiled');
    const foreign = state('foreign');
    for (const args of [
      { name: 'unfiled', observations: ['bad scope'], project: 'p' },
      { name: 'unfiled', observations: ['bad tag'], tags: ['project:p'] },
      { name: 'unfiled', observations: ['bad replace'], replace: true },
      { name: 'foreign', observations: ['bad foreign'] },
      { name: 'unfiled', observations: ['bad flag'], projectIsDefault: true },
      { name: 'unfiled', observations: ['bad relation'], relations: [{ to: 'foreign', type: 'supersedes' }] },
      { name: 'new-without-type', observations: ['bad new'] },
    ]) refused(await remember(args));
    expect(state('unfiled')).toEqual(original);
    expect(state('foreign')).toEqual(foreign);
    expect(state('new-without-type').rows).toHaveLength(0);
  });
});
