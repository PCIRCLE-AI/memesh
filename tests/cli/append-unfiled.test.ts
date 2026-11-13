import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { runCliFromSource } from '../helpers/cli-source.js';

const fixture = useTestDatabase('memesh-ac57-cli-');

describe('AC57 CLI append to an unfiled memory', () => {
  it('preserves unfiled scope across two git projects and refuses explicit scope changes', () => {
    const a = path.join(fixture.tmpDir, 'a');
    const b = path.join(fixture.tmpDir, 'b');
    for (const dir of [a, b]) {
      fs.mkdirSync(dir);
      execFileSync('git', ['-C', dir, 'init', '-q']);
    }
    const cli = (cwd: string, args: string[]) => {
      closeDatabase();
      try { return runCliFromSource(args, { cwd, memeshDir: fixture.tmpDir, dbPath: fixture.dbPath }); }
      finally { openDatabase(fixture.dbPath); }
    };
    const run = (cwd: string, args: string[]) => {
      const result = cli(cwd, args);
      expect(result.status, result.stderr).toBe(0);
      return result;
    };
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

    run(a, ['remember', '--name', 'shared-ac57', '--type', 'note', '--obs', 'original', '--no-project']);
    const before = state('shared-ac57');
    run(a, ['remember', '--name', 'shared-ac57', '--obs', 'from a']);
    run(b, ['remember', '--name', 'shared-ac57', '--obs', 'from b']);
    const after = state('shared-ac57');
    expect(after.rows).toEqual(before.rows);
    expect(after.observations).toEqual(['original', 'from a', 'from b']);
    expect(after.tags).toEqual([]);
    for (const cwd of [a, b]) {
      const output = run(cwd, ['recall', 'shared-ac57', '--json']).stdout;
      const entities = JSON.parse(output).entities as Array<{ id: number; name: string; observations: unknown[] }>;
      const found = entities.filter(e => e.name === 'shared-ac57');
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(after.rows[0].id);
      expect(JSON.stringify(found[0].observations)).toContain('original');
      expect(JSON.stringify(found[0].observations)).toContain('from b');
    }

    run(b, ['remember', '--name', 'foreign-ac57', '--type', 'note', '--obs', 'foreign original']);
    const foreign = state('foreign-ac57');
    for (const args of [
      ['remember', '--name', 'shared-ac57', '--obs', 'bad scope', '--project', 'explicit-p'],
      ['remember', '--name', 'shared-ac57', '--obs', 'bad tag', '--tags', 'project:explicit-p'],
      ['remember', '--name', 'shared-ac57', '--obs', 'bad replace', '--replace'],
      ['remember', '--name', 'foreign-ac57', '--obs', 'bad foreign'],
      ['remember', '--name', 'shared-ac57', '--obs', 'bad relation', '--supersedes', 'foreign-ac57'],
      ['remember', '--name', 'new-without-type', '--obs', 'bad new'],
    ]) {
      const result = cli(a, args);
      expect(result.status, `${args.join(' ')}: ${result.stdout}`).not.toBe(0);
    }
    expect(state('shared-ac57')).toEqual(after);
    expect(state('foreign-ac57')).toEqual(foreign);
    expect(state('new-without-type').rows).toHaveLength(0);
  }, 90_000);
});
