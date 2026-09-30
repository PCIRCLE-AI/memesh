import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remember } from '../../src/core/operations.js';
import { getDatabase } from '../../src/db.js';
import { listProjectTags, openReadOnlyForPreview, renameProjectTag } from '../../src/core/project-tags.js';
import { sendAgentMessage, pollAgentEvents } from '../../src/core/agent-messaging.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const fixture = useTestDatabase('memesh-projtags-');

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
    // Entity carries BOTH the old and new tag (the split case).
    remember({ name: 'a', type: 'note', tags: ['project:tim', 'project:TIM'] });
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

/**
 * A project identity lives in two places: `project:<name>` tags on entities,
 * and the `project` column of the durable-message tables — half the key of an
 * inbox. Renaming only the tags left the messages in a scope nobody polls,
 * which is how `memesh` and `memesh-llm-memory` (one repository, renamed on
 * GitHub) came to hold 38 and 28 messages in two separate inboxes on the
 * maintainer's graph. This is the owner-driven half of that fix: the one-shot
 * repair deliberately will not merge two project NAMES, because only a network
 * call proves they are the same repo. This command can, because a person asked.
 */
describe('project-tags: renameProjectTag moves durable message scopes too', () => {
  function send(project: string, key: string): void {
    sendAgentMessage(getDatabase(), {
      project, sender: 'author', recipient: 'reviewer', idempotency_key: key,
      content_type: 'text/plain', payload: 'x',
    });
  }

  it('dry-run counts the message rows and writes nothing', () => {
    send('memesh-llm-memory', 'k1');
    const r = renameProjectTag('memesh-llm-memory', 'memesh', { apply: false });
    expect(r.messageRows).toBeGreaterThan(0);
    expect(r.applied).toBe(false);
    expect(pollAgentEvents(getDatabase(), { project: 'memesh-llm-memory', recipient: 'reviewer' }).events).toHaveLength(1);
    expect(pollAgentEvents(getDatabase(), { project: 'memesh', recipient: 'reviewer' }).events).toHaveLength(0);
  });

  it('apply moves the message rows, so the destination inbox holds both', () => {
    send('memesh-llm-memory', 'k1');
    send('memesh', 'k2');
    const r = renameProjectTag('memesh-llm-memory', 'memesh', { apply: true });
    expect(r.messageRowsBlocked).toBe(0);
    expect(pollAgentEvents(getDatabase(), { project: 'memesh-llm-memory', recipient: 'reviewer' }).events).toHaveLength(0);
    expect(pollAgentEvents(getDatabase(), { project: 'memesh', recipient: 'reviewer' }).events).toHaveLength(2);
  });

  it('a project with messages but no tagged entities is still renameable', () => {
    // The CLI used to stop at "no entities carry project:<x>", which would
    // have refused exactly the case this fix exists for.
    send('memesh-llm-memory', 'k1');
    const r = renameProjectTag('memesh-llm-memory', 'memesh', { apply: false });
    expect(r.affectedEntities).toBe(0);
    expect(r.messageRows).toBeGreaterThan(0);
  });
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

  it('the dry run reports the same blocked message rows the apply will refuse', () => {
    const send = (project: string, key: string) => sendAgentMessage(getDatabase(), {
      project, sender: 'author', recipient: 'reviewer', idempotency_key: key,
      content_type: 'text/plain', payload: 'x',
    });
    // Same sender and key in both scopes: moving the old row collides.
    send('old-scope', 'shared-key');
    send('new-scope', 'shared-key');
    const preview = renameProjectTag('old-scope', 'new-scope', { apply: false });
    const applied = renameProjectTag('old-scope', 'new-scope', { apply: true });
    expect(applied.messageRowsBlocked).toBeGreaterThan(0);
    expect(preview.messageRowsBlocked).toBe(applied.messageRowsBlocked);
  });
});

describe('Feature: #519 the dry run never writes, and only a real collision is "left in place"', () => {
  it('a dry run on a read-only database still reports the preview, with nothing blocked', () => {
    sendAgentMessage(getDatabase(), {
      project: 'ro-old', sender: 'author', recipient: 'reviewer', idempotency_key: 'ro-k',
      content_type: 'text/plain', payload: 'x',
    });
    const readOnly = new MemeshDatabase(fixture.dbPath, { readOnly: true });
    try {
      const r = renameProjectTag('ro-old', 'ro-new', { apply: false, db: readOnly });
      expect(r.messageRows).toBeGreaterThan(0);
      expect(r.messageRowsBlocked).toBe(0);
      expect(r.applied).toBe(false);
    } finally {
      readOnly.close();
    }
    expect(pollAgentEvents(getDatabase(), { project: 'ro-old', recipient: 'reviewer' }).events).toHaveLength(1);
  });

  it('an apply that cannot write fails instead of reporting every row as left in place', () => {
    sendAgentMessage(getDatabase(), {
      project: 'ro-old2', sender: 'author', recipient: 'reviewer', idempotency_key: 'ro-k2',
      content_type: 'text/plain', payload: 'x',
    });
    getDatabase().exec('PRAGMA query_only = ON');
    try {
      expect(() => renameProjectTag('ro-old2', 'ro-new2', { apply: true })).toThrow(/readonly|read-only|query_only/i);
    } finally {
      getDatabase().exec('PRAGMA query_only = OFF');
    }
    expect(pollAgentEvents(getDatabase(), { project: 'ro-old2', recipient: 'reviewer' }).events).toHaveLength(1);
  });

  it('a collision on the composite primary key of the idempotency table counts as left in place', () => {
    const send = (project: string) => sendAgentMessage(getDatabase(), {
      project, sender: 'author', recipient: 'reviewer', idempotency_key: 'pk-shared',
      content_type: 'text/plain', payload: project,
    });
    send('pk-old');
    send('pk-new');
    const r = renameProjectTag('pk-old', 'pk-new', { apply: true });
    expect(r.messageRowsBlocked).toBeGreaterThan(0);
  });
});

describe('Feature: #519 only a missing table means "nothing to move"', () => {
  it('a read error on a message table aborts the rename instead of moving half of a message', () => {
    remember({ name: 'half-move', type: 'note', tags: ['project:io-old'] });
    const sent = sendAgentMessage(getDatabase(), {
      project: 'io-old', sender: 'author', recipient: 'reviewer', idempotency_key: 'io-k',
      content_type: 'text/plain', payload: 'x',
    });
    const real = getDatabase();
    const faulty = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql === 'SELECT rowid AS rid FROM agent_message_deliveries WHERE project = ?') {
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
    const scope = (table: string) => (real.prepare(`SELECT project FROM ${table} WHERE message_id = ?`).get(sent.message_id) as { project: string }).project;
    expect(scope('agent_messages')).toBe('io-old');
    expect(scope('agent_message_deliveries')).toBe('io-old');
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
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = privateTmp;
    try {
      expect(() => renameProjectTag('ns-old', 'ns-new', { apply: false, db: faulty }))
        .toThrow(new RegExp(`preview copy under ${privateTmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*database or disk is full`, 's'));
      expect(fs.readdirSync(privateTmp)).toEqual([]);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
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
    messages: getDatabase().prepare('SELECT project FROM agent_messages ORDER BY project').all(),
  });
  const send = (project: string) => sendAgentMessage(getDatabase(), {
    project, sender: 'author', recipient: 'reviewer', idempotency_key: `v-${project}`,
    content_type: 'text/plain', payload: 'x',
  });

  for (const [name, trigger, tags] of [
    ['an AFTER UPDATE trigger that puts the tag back', 'CREATE TRIGGER undo_rename AFTER UPDATE OF tag ON tags BEGIN UPDATE tags SET tag = OLD.tag WHERE id = NEW.id; END', ['project:vf-old']],
    ['an AFTER DELETE trigger that re-inserts the tag', 'CREATE TRIGGER undo_merge AFTER DELETE ON tags BEGIN INSERT INTO tags (entity_id, tag) VALUES (OLD.entity_id, OLD.tag); END', ['project:vf-old', 'project:vf-new']],
  ] as const) {
    it(`${name} fails and rolls back`, () => {
      carrier('vf', [...tags]);
      send('vf-old');
      getDatabase().exec(trigger);
      const before = state();
      expect(() => renameProjectTag('vf-old', 'vf-new', { apply: true })).toThrow(/was not kept/);
      expect(state()).toEqual(before);
    });
  }

  it('an update a trigger ABORTs is not counted as a unique collision, whatever the error text says', () => {
    carrier('h1', ['project:h1-old']);
    send('h1-old');
    getDatabase().exec("CREATE TRIGGER refuse_move BEFORE UPDATE OF project ON agent_messages BEGIN SELECT RAISE(ABORT, 'refused ' || NEW.project); END");
    const before = state();
    expect(() => renameProjectTag('h1-old', 'UNIQUE constraint failed', { apply: true })).toThrow(/refused/);
    expect(state()).toEqual(before);
  });

  it('a message row that a trigger moves back is refused and rolled back', () => {
    carrier('h2', ['project:h2-old']);
    send('h2-old');
    getDatabase().exec('CREATE TRIGGER undo_move AFTER UPDATE OF project ON agent_messages BEGIN UPDATE agent_messages SET project = OLD.project WHERE rowid = NEW.rowid; END');
    const before = state();
    expect(() => renameProjectTag('h2-old', 'h2-new', { apply: true })).toThrow(/is not scoped to h2-new.*was not kept/);
    expect(state()).toEqual(before);
  });

  it('a renamed tag that a trigger then deletes is refused and rolled back', () => {
    carrier('h3', ['project:h3-old']);
    send('h3-old');
    getDatabase().exec('CREATE TRIGGER drop_renamed AFTER UPDATE OF tag ON tags BEGIN DELETE FROM tags WHERE id = NEW.id; END');
    const before = state();
    expect(() => renameProjectTag('h3-old', 'h3-new', { apply: true })).toThrow(/was not kept/);
    expect(state()).toEqual(before);
  });

  it('a real collision on a unique index is counted as left in place, and the other rows move', () => {
    const cursor = getDatabase().prepare('INSERT INTO agent_message_cursors (cursor_token, project, recipient, event_sequence) VALUES (?, ?, ?, ?)');
    cursor.run('c-old', 'cur-old', 'reviewer', 7);
    cursor.run('c-new', 'cur-new', 'reviewer', 7);
    cursor.run('c-other', 'cur-old', 'reviewer', 8);
    const r = renameProjectTag('cur-old', 'cur-new', { apply: true });
    expect(r.messageRowsBlocked).toBe(1);
    expect(getDatabase().prepare('SELECT cursor_token, project FROM agent_message_cursors ORDER BY cursor_token').all()).toEqual([
      { cursor_token: 'c-new', project: 'cur-new' },
      { cursor_token: 'c-old', project: 'cur-old' },
      { cursor_token: 'c-other', project: 'cur-new' },
    ]);
  });

  it('a collision a trigger hits in another table is not taken for the destination holding the row', () => {
    carrier('t3', ['project:t3-old']);
    send('t3-old');
    getDatabase().exec('CREATE TABLE side (a UNIQUE); INSERT INTO side VALUES (1); CREATE TRIGGER side_write AFTER UPDATE OF project ON agent_messages BEGIN INSERT INTO side VALUES (1); END');
    const before = state();
    expect(() => renameProjectTag('t3-old', 't3-new', { apply: true })).toThrow(/UNIQUE constraint failed: side\.a/);
    expect(state()).toEqual(before);
  });

  it('an ignored message update is refused even when the destination name looks like a unique-constraint error', () => {
    send('uq-old');
    getDatabase().exec('CREATE TRIGGER ignore_move BEFORE UPDATE OF project ON agent_messages BEGIN SELECT RAISE(IGNORE); END');
    const before = state();
    expect(() => renameProjectTag('uq-old', 'UNIQUE constraint failed', { apply: true })).toThrow(/is not scoped to/);
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
