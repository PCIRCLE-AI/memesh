import { describe, it, expect } from 'vitest';
import { remember } from '../../src/core/operations.js';
import { getDatabase } from '../../src/db.js';
import { listProjectTags, renameProjectTag } from '../../src/core/project-tags.js';
import { sendAgentMessage, pollAgentEvents } from '../../src/core/agent-messaging.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-projtags-');

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
    getDatabase().exec('PRAGMA query_only = ON');
    try {
      const r = renameProjectTag('ro-old', 'ro-new', { apply: false });
      expect(r.messageRows).toBeGreaterThan(0);
      expect(r.messageRowsBlocked).toBe(0);
    } finally {
      getDatabase().exec('PRAGMA query_only = OFF');
    }
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
