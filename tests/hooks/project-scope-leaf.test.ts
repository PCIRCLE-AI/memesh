/**
 * The scope of a project's reads is one SQL fragment, mirrored next to the hooks
 * (scripts/hooks/_generated/project-scope.js): the copy must say exactly what
 * recall's scope says.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { projectScopeFilter as coreFilter } from '../../src/core/project-scope.js';

let dir: string;
let db: MemeshDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-scope-leaf-'));
  db = new MemeshDatabase(path.join(dir, 'kg.db'));
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT, type TEXT, namespace TEXT DEFAULT 'personal', metadata TEXT);
           CREATE TABLE tags (entity_id INTEGER, tag TEXT);`);
  const fromFolder = JSON.stringify({ trust: 'trusted', provenance: { source: 'note-file' } });
  const add = (name: string, type: string, tags: string[], namespace = 'personal', metadata: string | null = null) => {
    const id = Number(db.prepare('INSERT INTO entities (name, type, namespace, metadata) VALUES (?, ?, ?, ?)').run(name, type, namespace, metadata).lastInsertRowid);
    for (const tag of tags) db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, tag);
  };
  add('own-commit', 'commit', ['project:a-new']);
  add('own-under-earlier-id', 'commit', ['project:a-old']);
  add('other-commit', 'commit', ['project:b']);
  add('other-decision', 'decision', ['project:b']);
  add('other-note-feedback', 'feedback', ['project:b', 'source:note-file'], 'personal', fromFolder);
  add('other-forged-feedback', 'feedback', ['project:b', 'source:note-file']);
  add('other-feedback-record', 'feedback', ['project:b']);
  add('other-untrusted-note-feedback', 'feedback', ['project:b', 'source:note-file'], 'personal', JSON.stringify({ trust: 'untrusted', provenance: { source: 'note-file' } }));
  add('other-untrusted-decision', 'decision', ['project:b'], 'personal', JSON.stringify({ trust: 'untrusted' }));
  add('other-bad-metadata-feedback', 'feedback', ['project:b'], 'personal', '{not json');
  add('other-bad-metadata-decision', 'decision', ['project:b'], 'personal', '{not json');
  add('other-note-file-decision', 'decision', ['project:b', 'source:note-file'], 'personal', fromFolder);
  add('other-missing-note-feedback', 'feedback', ['project:b', 'source:note-file', 'source:note-file:missing'], 'personal', fromFolder);
  add('no-project', 'note', []);
  add('global', 'note', ['project:b'], 'global');
  // Global is no exception to trust: an untrusted global memory (an imported bundle's) is not shared.
  add('global-untrusted', 'decision', ['project:b'], 'global', JSON.stringify({ trust: 'untrusted', provenance: { source: 'import' } }));
  add('global-untrusted-no-project', 'decision', [], 'global', JSON.stringify({ trust: 'untrusted', provenance: { source: 'import' } }));
  add('own-global-untrusted', 'decision', ['project:a-new'], 'global', JSON.stringify({ trust: 'untrusted' }));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const read = (filter: (scope: string[] | null, alias?: string) => { sql: string; params: string[] }, scope: string[] | null) => {
  const { sql, params } = filter(scope);
  return (db.prepare(`SELECT e.name FROM entities e WHERE 1=1 ${sql} ORDER BY e.name`).all(...params) as Array<{ name: string }>).map((r) => r.name);
};

describe('the mirrored scope fragment', () => {
  it('a hook reads the project under every id, plus shared experience, no project and global', async () => {
    const mirrored = await import(pathToFileURL(path.resolve('scripts/hooks/_generated/project-scope.js')).href) as { projectScopeFilter: typeof coreFilter };
    const expected = ['global', 'no-project', 'other-decision', 'other-note-feedback', 'own-commit', 'own-global-untrusted', 'own-under-earlier-id'];
    // Another project's commit, plain feedback record, untrusted memories (global ones too), unreadable
    // metadata, and its memory folder's decisions and deleted notes are not in scope.
    expect(read(mirrored.projectScopeFilter, ['project:a-new', 'project:a-old'])).toEqual(expected);
  });

  it('is the same fragment core uses', async () => {
    const mirrored = await import(pathToFileURL(path.resolve('scripts/hooks/_generated/project-scope.js')).href) as { projectScopeFilter: typeof coreFilter };
    for (const scope of [null, ['project:a-new'], ['project:a-new', 'project:a-old']]) {
      expect(mirrored.projectScopeFilter(scope, 'x')).toEqual(coreFilter(scope, 'x'));
    }
  });

  it('with no project it keeps shared experience, no-project and global memories only', () => {
    expect(read(coreFilter, null)).toEqual(['global', 'no-project', 'other-decision', 'other-note-feedback']);
  });
});
