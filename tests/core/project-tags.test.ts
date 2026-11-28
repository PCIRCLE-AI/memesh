import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remember } from '../../src/core/operations.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { getDatabase } from '../../src/db.js';
import { hasRenameWork, listProjectTags, openReadOnlyForPreview, renameProjectTag } from '../../src/core/project-tags.js';
import { seedLegacyMessage } from '../helpers/agent-session-fixture.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const fixture = useTestDatabase('memesh-projtags-');

describe('project rename preserves proposal scope', () => {
  function proposal(project: string) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const source = kg.createEntity('proposal-source', 'note', { observations: ['owned source'], tags: [`project:${project}`] });
    return Number(db.prepare(`INSERT INTO dream_proposals(project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, 'owned', ?, ?, 'v1')`).run(project, JSON.stringify([source]), JSON.stringify({ name: 'proposal-result', type: 'digest', observations: ['owned digest'], tags: [] })).lastInsertRowid);
  }

  it('previews without writing, moves proposals and accepts into the renamed project', async () => {
    const id = proposal('alpha');
    const db = getDatabase();
    expect(renameProjectTag('alpha', 'beta', { apply: false })).toMatchObject({ proposalRows: 1, applied: false });
    expect(db.prepare('SELECT project FROM dream_proposals WHERE id = ?').get(id)).toMatchObject({ project: 'alpha' });
    expect(renameProjectTag('alpha', 'beta', { apply: true })).toMatchObject({ proposalRows: 1 });
    const { applyProposal } = await import('../../src/core/dreamer.js');
    applyProposal(db, id, new KnowledgeGraph(db));
    expect(projectTagsOf('proposal-result')).toEqual(['project:beta']);
  });

  it('recognizes work when only a proposal carries the old project', () => {
    proposal('alpha');
    getDatabase().prepare("UPDATE tags SET tag='project:other' WHERE tag='project:alpha'").run();
    expect(hasRenameWork('alpha')).toBe(true);
    expect(renameProjectTag('alpha', 'beta', { apply: true })).toMatchObject({ affectedEntities: 0, proposalRows: 1 });
    expect(hasRenameWork('alpha')).toBe(false);
  });

  it('rolls tags back if a trigger silently refuses the proposal move', () => {
    proposal('alpha');
    getDatabase().exec("CREATE TRIGGER refuse_proposal BEFORE UPDATE OF project ON dream_proposals BEGIN SELECT RAISE(IGNORE); END");
    expect(() => renameProjectTag('alpha', 'beta', { apply: true })).toThrow(/proposal.*not scoped/);
    expect(projectTagsOf('proposal-source')).toEqual(['project:alpha']);
    expect(getDatabase().prepare('SELECT project FROM dream_proposals').get()).toMatchObject({ project: 'alpha' });
  });

  it('rolls tags back when the proposal update fails', () => {
    proposal('alpha');
    getDatabase().exec("CREATE TRIGGER fail_proposal BEFORE UPDATE OF project ON dream_proposals BEGIN SELECT RAISE(ABORT, 'owned proposal failure'); END");
    expect(() => renameProjectTag('alpha', 'beta', { apply: true })).toThrow(/owned proposal failure/);
    expect(projectTagsOf('proposal-source')).toEqual(['project:alpha']);
    expect(getDatabase().prepare('SELECT project FROM dream_proposals').get()).toMatchObject({ project: 'alpha' });
  });

  it('still renames tags in a legacy database without the proposals table', () => {
    const db = getDatabase();
    new KnowledgeGraph(db).createEntity('legacy-note', 'note', { observations: ['owned'], tags: ['project:alpha'] });
    db.exec('DROP TABLE dream_proposals');
    expect(renameProjectTag('alpha', 'beta', { apply: true })).toMatchObject({ renamed: 1, proposalRows: 0 });
    expect(projectTagsOf('legacy-note')).toEqual(['project:beta']);
  });

  it('does not mistake a broken proposal source for an absent legacy table', () => {
    const db = getDatabase();
    new KnowledgeGraph(db).createEntity('broken-note', 'note', { observations: ['owned'], tags: ['project:alpha'] });
    db.exec('DROP TABLE dream_proposals; CREATE VIEW dream_proposals AS SELECT id, project FROM missing_proposal_source');
    expect(() => renameProjectTag('alpha', 'beta', { apply: true })).toThrow(/missing_proposal_source/);
    expect(projectTagsOf('broken-note')).toEqual(['project:alpha']);
  });
});

function projectTagsOf(name: string): string[] {
  const row = getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) return [];
  return (getDatabase().prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%'").all(row.id) as Array<{ tag: string }>).map(r => r.tag);
}

describe('project-tags: listProjectTags', () => {
  it('returns each project value with its entity count, most-used first', () => {
    remember({ name: 'a', type: 'note', tags: ['project:TIM'] });
    remember({ name: 'b', type: 'note', tags: ['project:TIM'] });
    remember({ name: 'c', type: 'note', tags: ['project:memesh'] });
    const tags = listProjectTags();
    expect(tags[0]).toEqual({ project: 'TIM', count: 2 });
    expect(tags).toContainEqual({ project: 'memesh', count: 1 });
  });
});

describe('project-tags: renameProjectTag', () => {
  it('dry-run reports affected entities and writes nothing', () => {
    remember({ name: 'a', type: 'note', tags: ['project:tim'] });
    remember({ name: 'b', type: 'note', tags: ['project:tim'] });
    const r = renameProjectTag('tim', 'TIM', { apply: false });
    expect(r.affectedEntities).toBe(2);
    expect(r.renamed).toBe(2);
    expect(r.merged).toBe(0);
    expect(r.applied).toBe(false);
    // Unchanged on disk.
    expect(projectTagsOf('a')).toEqual(['project:tim']);
  });

  it('apply renames the tag across all carrying entities', () => {
    remember({ name: 'a', type: 'note', tags: ['project:tim'] });
    remember({ name: 'b', type: 'note', tags: ['project:tim'] });
    const r = renameProjectTag('tim', 'TIM', { apply: true });
    expect(r.applied).toBe(true);
    expect(r.renamed).toBe(2);
    expect(projectTagsOf('a')).toEqual(['project:TIM']);
    expect(projectTagsOf('b')).toEqual(['project:TIM']);
    expect(listProjectTags()).toEqual([{ project: 'TIM', count: 2 }]);
  });

  it('merges (not duplicates) when an entity already has the target tag — respects UNIQUE(entity_id, tag)', () => {
    // Entity carries BOTH the old and new tag (the split case). remember()
    // refuses two project tags now, so the legacy split is seeded below it.
    new KnowledgeGraph(getDatabase()).createEntity('a', 'note', { tags: ['project:tim', 'project:TIM'] });
    remember({ name: 'b', type: 'note', tags: ['project:tim'] });
    const r = renameProjectTag('tim', 'TIM', { apply: true });
    expect(r.affectedEntities).toBe(2);
    expect(r.merged).toBe(1);   // 'a' already had project:TIM → project:tim removed
    expect(r.renamed).toBe(1);  // 'b' renamed
    expect(projectTagsOf('a')).toEqual(['project:TIM']); // no duplicate
    expect(projectTagsOf('b')).toEqual(['project:TIM']);
  });

  it('no-op when nothing carries the from tag', () => {
    remember({ name: 'a', type: 'note', tags: ['project:other'] });
    const r = renameProjectTag('ghost', 'TIM', { apply: true });
    expect(r.affectedEntities).toBe(0);
    expect(projectTagsOf('a')).toEqual(['project:other']);
  });
});

it('renames memory tags without rewriting historical message audit scopes', () => {
  remember({ name: 'current-memory', type: 'note', tags: ['project:old'] });
  seedLegacyMessage(getDatabase(), { project: 'old', sender: 'author', recipient: 'reviewer', payload: 'historical audit' });
  const rows = () => getDatabase().prepare('SELECT * FROM agent_messages').all();
  const before = rows();
  expect(renameProjectTag('old', 'new', { apply: false }).affectedEntities).toBe(1);
  expect(rows()).toEqual(before);
  renameProjectTag('old', 'new', { apply: true });
  expect(projectTagsOf('current-memory')).toEqual(['project:new']);
  expect(rows()).toEqual(before);
});

describe('Feature: #519 renaming a project cannot remove it by accident', () => {
  it('refuses to rename a project to itself and leaves every tag in place', () => {
    remember({ name: 'a', type: 'note', tags: ['project:acme'] });
    remember({ name: 'b', type: 'note', tags: ['project:acme'] });
    expect(() => renameProjectTag('acme', 'acme', { apply: true })).toThrow(/same project/);
    expect(() => renameProjectTag('acme', 'acme', { apply: false })).toThrow(/same project/);
    expect(projectTagsOf('a')).toEqual(['project:acme']);
    expect(projectTagsOf('b')).toEqual(['project:acme']);
  });

  it('preview and apply agree when the destination tag already exists', () => {
    const db = getDatabase();
    const id = db.prepare("INSERT INTO entities (name, type) VALUES ('merge', 'note')").run().lastInsertRowid;
    const tag = db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)');
    tag.run(id, 'project:old-scope');
    tag.run(id, 'project:new-scope');
    const preview = renameProjectTag('old-scope', 'new-scope', { apply: false });
    const applied = renameProjectTag('old-scope', 'new-scope', { apply: true });
    expect(preview.merged).toBe(1);
    expect(preview.merged).toBe(applied.merged);
    expect(projectTagsOf('merge')).toEqual(['project:new-scope']);
  });
});

describe('Feature: #519 previews preserve memory constraints without writing the source', () => {
  for (const [label, index, collides] of [
    ['partial unique', "CREATE UNIQUE INDEX extra_tags ON tags(tag) WHERE tag LIKE 'project:%'", true],
    ['collated unique', 'CREATE UNIQUE INDEX extra_tags ON tags(tag COLLATE NOCASE)', true],
    ['expression unique', 'CREATE UNIQUE INDEX extra_tags ON tags(lower(tag))', true],
    ['non-unique', 'CREATE INDEX extra_tags ON tags(tag)', false],
  ] as const) {
    it(`preview preserves the ${label} memory constraint and agrees with apply`, () => {
      remember({ name: 'index-old', type: 'note', tags: ['project:idx-old'] });
      remember({ name: 'index-new', type: 'note', tags: ['project:idx-new'] });
      const db = getDatabase();
      db.exec(index);
      const rows = () => db.prepare('SELECT * FROM tags ORDER BY id').all();
      const before = rows();
      if (collides) {
        expect(() => renameProjectTag('idx-old', 'idx-new')).toThrow(/UNIQUE constraint failed/);
        expect(rows()).toEqual(before);
        expect(() => renameProjectTag('idx-old', 'idx-new', { apply: true })).toThrow(/UNIQUE constraint failed/);
        expect(rows()).toEqual(before);
      } else {
        const preview = renameProjectTag('idx-old', 'idx-new');
        expect(rows()).toEqual(before);
        const applied = renameProjectTag('idx-old', 'idx-new', { apply: true });
        expect(applied.renamed).toBe(preview.renamed);
        expect(applied.renamed).toBe(1);
        expect(projectTagsOf('index-old')).toEqual(['project:idx-new']);
      }
    });
  }

  it('a dry run on a read-only database still reports the memory preview', () => {
    remember({ name: 'readonly', type: 'note', tags: ['project:ro-old'] });
    const readOnly = new MemeshDatabase(fixture.dbPath, { readOnly: true });
    try {
      const r = renameProjectTag('ro-old', 'ro-new', { apply: false, db: readOnly });
      expect(r.affectedEntities).toBe(1);
      expect(r.applied).toBe(false);
    } finally {
      readOnly.close();
    }
    expect(projectTagsOf('readonly')).toEqual(['project:ro-old']);
  });

  it('an apply that cannot write fails instead of reporting a successful rename', () => {
    remember({ name: 'readonly-write', type: 'note', tags: ['project:ro-old2'] });
    getDatabase().exec('PRAGMA query_only = ON');
    try {
      expect(() => renameProjectTag('ro-old2', 'ro-new2', { apply: true })).toThrow(/readonly|read-only|query_only/i);
    } finally {
      getDatabase().exec('PRAGMA query_only = OFF');
    }
    expect(projectTagsOf('readonly-write')).toEqual(['project:ro-old2']);
  });
});

describe('Feature: #519 only a missing table means "nothing to move"', () => {
  it('a proposal read error aborts before moving memory tags', () => {
    remember({ name: 'half-move', type: 'note', tags: ['project:io-old'] });
    const real = getDatabase();
    const faulty = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql === 'SELECT id FROM dream_proposals WHERE project = ?') {
              throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    expect(() => renameProjectTag('io-old', 'io-new', { apply: true, db: faulty })).toThrow('disk I/O error');
    expect(projectTagsOf('half-move')).toEqual(['project:io-old']);
  });
});

describe('Feature: #519 a preview that cannot make its copy says where and how much', () => {
  it('names the temporary folder and the space needed, and leaves no copy behind', () => {
    remember({ name: 'no-space', type: 'note', tags: ['project:ns-old'] });
    const real = getDatabase();
    const faulty = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql === 'VACUUM INTO ?') throw new Error('database or disk is full');
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nospace-'));
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
    const tmpVars = ['TMPDIR', 'TMP', 'TEMP'] as const;
    const saved = tmpVars.map((name) => process.env[name]);
    for (const name of tmpVars) process.env[name] = privateTmp;
    try {
      expect(() => renameProjectTag('ns-old', 'ns-new', { apply: false, db: faulty }))
        .toThrow(new RegExp(`preview copy under ${privateTmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*database or disk is full`, 's'));
      expect(fs.readdirSync(privateTmp)).toEqual([]);
    } finally {
      tmpVars.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
      fs.rmSync(privateTmp, { recursive: true, force: true });
    }
  });
});

describe('Feature: #519 the rename verifies what it did, not what a statement reported', () => {
  const carrier = (name: string, tags: string[]) => {
    const db = getDatabase();
    const entity = db.prepare("INSERT INTO entities (name, type) VALUES (?, 'note')").run(name);
    const add = db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)');
    for (const tag of tags) add.run(entity.lastInsertRowid, tag);
  };
  const state = () => ({
    tags: getDatabase().prepare('SELECT tag FROM tags ORDER BY tag').all(),
    entities: getDatabase().prepare('SELECT * FROM entities ORDER BY id').all(),
    observations: getDatabase().prepare('SELECT * FROM observations ORDER BY id').all(),
  });

  for (const [name, trigger, tags] of [
    ['an AFTER UPDATE trigger that puts the tag back', 'CREATE TRIGGER undo_rename AFTER UPDATE OF tag ON tags BEGIN UPDATE tags SET tag = OLD.tag WHERE id = NEW.id; END', ['project:vf-old']],
    ['an AFTER DELETE trigger that re-inserts the tag', 'CREATE TRIGGER undo_merge AFTER DELETE ON tags BEGIN INSERT INTO tags (entity_id, tag) VALUES (OLD.entity_id, OLD.tag); END', ['project:vf-old', 'project:vf-new']],
  ] as const) {
    it(`${name} fails and rolls back`, () => {
      carrier('vf', [...tags]);
      getDatabase().exec(trigger);
      const before = state();
      expect(() => renameProjectTag('vf-old', 'vf-new', { apply: true })).toThrow(/changed the result\)$/);
      expect(state()).toEqual(before);
    });
  }

  it('an update a trigger ABORTs is not counted as a unique collision, whatever the error text says', () => {
    carrier('h1', ['project:h1-old']);
    getDatabase().exec("CREATE TRIGGER refuse_move BEFORE UPDATE OF tag ON tags BEGIN SELECT RAISE(ABORT, 'refused ' || NEW.tag); END");
    const before = state();
    expect(() => renameProjectTag('h1-old', 'UNIQUE constraint failed', { apply: true })).toThrow(/refused/);
    expect(state()).toEqual(before);
  });

  it('a renamed tag that a trigger then deletes is refused and rolled back', () => {
    carrier('h3', ['project:h3-old']);
    getDatabase().exec('CREATE TRIGGER drop_renamed AFTER UPDATE OF tag ON tags BEGIN DELETE FROM tags WHERE id = NEW.id; END');
    const before = state();
    expect(() => renameProjectTag('h3-old', 'h3-new', { apply: true })).toThrow(/changed the result\)$/);
    expect(state()).toEqual(before);
  });

  it('a collision a trigger hits in tags aborts and preserves all memory data', () => {
    const db = getDatabase();
    carrier('same', ['project:same-old', 'other']);
    db.exec("CREATE TRIGGER same_write AFTER UPDATE OF tag ON tags BEGIN INSERT INTO tags (entity_id, tag) VALUES (NEW.entity_id, 'other'); END");
    const before = state();
    // The dry run runs the same rename on a copy, so it refuses the same way.
    expect(() => renameProjectTag('same-old', 'same-new', { apply: false })).toThrow(/UNIQUE constraint failed/);
    expect(() => renameProjectTag('same-old', 'same-new', { apply: true })).toThrow(/UNIQUE constraint failed/);
    expect(state()).toEqual(before);
  });

  it('a collision a trigger hits in another table is not taken for the destination holding the row', () => {
    carrier('t3', ['project:t3-old']);
    getDatabase().exec('CREATE TABLE side (a UNIQUE); INSERT INTO side VALUES (1); CREATE TRIGGER side_write AFTER UPDATE OF tag ON tags BEGIN INSERT INTO side VALUES (1); END');
    const before = state();
    expect(() => renameProjectTag('t3-old', 't3-new', { apply: true })).toThrow(/UNIQUE constraint failed: side\.a/);
    expect(state()).toEqual(before);
  });

  it('an ignored tag update is refused even when the destination name looks like a unique-constraint error', () => {
    carrier('uq', ['project:uq-old']);
    getDatabase().exec('CREATE TRIGGER ignore_move BEFORE UPDATE OF tag ON tags BEGIN SELECT RAISE(IGNORE); END');
    const before = state();
    expect(() => renameProjectTag('uq-old', 'UNIQUE constraint failed', { apply: true })).toThrow(/changed the result/);
    expect(state()).toEqual(before);
  });
});

describe('Feature: #519 the read-only preview falls back to immutable only when that is safe', () => {
  const stub = { prepare: () => ({ get: () => 1 }), close: () => {} } as unknown as MemeshDatabase;
  // Fails like SQLite does until asked for the immutable URI.
  const failing = (message: string) => {
    const targets: string[] = [];
    return {
      targets,
      open: (target: string): MemeshDatabase => {
        targets.push(target);
        if (target.startsWith('file:')) return stub;
        throw new Error(message);
      },
    };
  };
  const inTempDir = (fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ro-open-'));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it('retries as immutable when the file is read-only and has no write-ahead log', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    const f = failing('attempt to write a readonly database');
    expect(openReadOnlyForPreview(db, f.open)).toBe(stub);
    expect(f.targets).toHaveLength(2);
    expect(f.targets[1]).toMatch(/^file:.*a\.db\?immutable=1$/);
  }));

  it('retries as immutable when the write-ahead log is empty', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    fs.writeFileSync(`${db}-wal`, '');
    const f = failing('unable to open database file');
    expect(openReadOnlyForPreview(db, f.open)).toBe(stub);
    expect(f.targets).toHaveLength(2);
  }));

  it('does not retry when the write-ahead log has content', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    fs.writeFileSync(`${db}-wal`, Buffer.alloc(32));
    const f = failing('unable to open database file');
    expect(() => openReadOnlyForPreview(db, f.open)).toThrow('unable to open database file');
    expect(f.targets).toHaveLength(1);
  }));

  it('does not retry when a rollback journal holds a half-done transaction: an immutable read would show it as committed', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    fs.writeFileSync(`${db}-journal`, Buffer.alloc(512, 1));
    const f = failing('attempt to write a readonly database');
    expect(() => openReadOnlyForPreview(db, f.open)).toThrow('attempt to write a readonly database');
    expect(f.targets).toHaveLength(1);
  }));

  it('retries as immutable when the rollback journal is empty: it holds nothing to roll back', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    fs.writeFileSync(`${db}-journal`, '');
    const f = failing('attempt to write a readonly database');
    expect(openReadOnlyForPreview(db, f.open)).toBe(stub);
    expect(f.targets).toHaveLength(2);
  }));

  it('finds the write-ahead log beside the real file when given a symlink', () => inTempDir((dir) => {
    const db = path.join(dir, 'real.db');
    const link = path.join(dir, 'link.db');
    fs.writeFileSync(db, '');
    fs.writeFileSync(`${db}-wal`, Buffer.alloc(32));
    fs.symlinkSync(db, link);
    const f = failing('unable to open database file');
    expect(() => openReadOnlyForPreview(link, f.open)).toThrow('unable to open database file');
    expect(f.targets).toHaveLength(1);
  }));

  it('does not retry an error that is not about a read-only location', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    const f = failing('database is locked');
    expect(() => openReadOnlyForPreview(db, f.open)).toThrow('database is locked');
    expect(f.targets).toHaveLength(1);
  }));
});

describe('Feature: #520 the rename-project preview opens the database through the same permission guard', () => {
  const stub = { prepare: () => ({ get: () => 1 }), close: () => {} } as unknown as MemeshDatabase;
  const mode = (p: string) => fs.statSync(p).mode & 0o777;
  const inTempDir = (fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ro-guard-'));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it.skipIf(process.platform === 'win32')('refuses an empty -wal/-shm with fewer owner permissions instead of widening them', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    fs.chmodSync(db, 0o600);
    for (const s of ['-wal', '-shm']) { fs.writeFileSync(`${db}${s}`, ''); fs.chmodSync(`${db}${s}`, 0o400); }
    let error: (Error & { code?: string }) | undefined;
    try { openReadOnlyForPreview(db, () => stub); } catch (err) { error = err as Error & { code?: string }; }
    expect(error?.code).toBe('MEMESH_SIDECAR_PERMISSIONS');
    for (const s of ['-wal', '-shm']) expect(mode(`${db}${s}`), s).toBe(0o400);
  }));

  it.skipIf(process.platform === 'win32')("the preview's throwaway copy is owner-only, whatever umask the process had", () => {
    remember({ name: 'copy-mode', type: 'note', tags: ['project:cm-old'] });
    // The CLI's dry run opens only through openReadOnlyForPreview, so the
    // owner-only umask must come from there, not from an earlier openDatabase.
    const oldMask = process.umask(0o022);
    const modes: number[] = [];
    const realRm = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, opts?: fs.RmOptions) => {
      const copy = path.join(String(target), 'copy.db');
      if (String(target).includes('memesh-rename-preview-') && fs.existsSync(copy)) modes.push(fs.statSync(copy).mode & 0o777);
      return realRm(target, opts);
    }) as typeof fs.rmSync);
    try {
      const handle = openReadOnlyForPreview(fixture.dbPath);
      try { renameProjectTag('cm-old', 'cm-new', { apply: false, db: handle }); } finally { handle.close(); }
    } finally {
      spy.mockRestore();
      process.umask(oldMask);
    }
    expect(modes).toEqual([0o600]);
  });

  it.skipIf(process.platform === 'win32')('removes group and other access from the database, like every other open', () => inTempDir((dir) => {
    const db = path.join(dir, 'a.db');
    fs.writeFileSync(db, '');
    fs.chmodSync(db, 0o644);
    expect(openReadOnlyForPreview(db, () => stub)).toBe(stub);
    expect(mode(db)).toBe(0o600);
  }));
});
