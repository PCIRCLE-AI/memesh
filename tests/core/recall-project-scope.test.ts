/**
 * The internal project scope a default recall uses: the current project's
 * memories OR eligible global ones, under every existing filter. An explicit
 * tag keeps its exact meaning and wins over the scope.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

let dir: string;
let kg: KnowledgeGraph;
const names = (rows: Array<{ name: string }>) => rows.map(r => r.name).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-recall-scope-'));
  openDatabase(path.join(dir, 'kg.db'));
  kg = new KnowledgeGraph(getDatabase());
  kg.createEntity('a-fact', 'fact', { observations: ['zebra in project A'], tags: ['project:A'] });
  kg.createEntity('a-old', 'fact', { observations: ['zebra old in project A'], tags: ['project:A'] });
  kg.createEntity('b-fact', 'fact', { observations: ['zebra in project B'], tags: ['project:B'] });
  kg.createEntity('g-fact', 'fact', { observations: ['zebra known everywhere'], namespace: 'global' });
  kg.createEntity('g-old', 'fact', { observations: ['zebra global but archived'], namespace: 'global' });
  kg.archiveEntity('a-old');
  kg.archiveEntity('g-old');
});
afterEach(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('project scope: current project OR eligible global', () => {
  it('a query returns A and global, not B; the global hit is labelled by its namespace', () => {
    const rows = kg.search('zebra', { projectScope: 'project:A' });
    expect(names(rows)).toEqual(['a-fact', 'g-fact']);
    expect(rows.find(r => r.name === 'g-fact')?.namespace).toBe('global');
    expect(rows.find(r => r.name === 'a-fact')?.namespace).toBe('personal');
  });

  it('the decisions, lessons and preferences of another project are in scope too, its facts are not', () => {
    kg.createEntity('b-decision', 'decision', { observations: ['zebra decided in project B'], tags: ['project:B'] });
    kg.createEntity('b-lesson', 'lesson_learned', { observations: ['zebra learned in project B'], tags: ['project:B'] });
    kg.createEntity('b-pref', 'preference', { observations: ['zebra preferred in project B'], tags: ['project:B'] });
    expect(names(kg.search('zebra', { projectScope: 'project:A' }))).toEqual(['a-fact', 'b-decision', 'b-lesson', 'b-pref', 'g-fact']);
    expect(names(kg.search('zebra', { projectScope: null }))).toEqual(['b-decision', 'b-lesson', 'b-pref', 'g-fact']);
    expect(names(kg.search('zebra', { projectScope: ['project:A', 'project:A-old-id'] }))).toEqual(['a-fact', 'b-decision', 'b-lesson', 'b-pref', 'g-fact']);
  });

  it('feedback of another project is shared only when it came from the user\'s own memory folder (source:note-file)', () => {
    kg.createEntity('b-feedback-note', 'feedback', { observations: ['zebra feedback from a memory folder'], tags: ['project:B', 'source:note-file'] });
    getDatabase().prepare("UPDATE entities SET metadata = json_set(COALESCE(metadata, '{}'), '$.provenance.source', 'note-file', '$.trust', 'trusted') WHERE name = 'b-feedback-note'").run();
    kg.createEntity('b-feedback-record', 'feedback', { observations: ['zebra product feedback record'], tags: ['project:B'] });
    // An agent can write the tag a note carries; the note's provenance it cannot write.
    kg.createEntity('b-feedback-forged', 'feedback', { observations: ['zebra feedback tagged as a note'], tags: ['project:B', 'source:note-file'] });
    expect(names(kg.search('zebra', { projectScope: 'project:A' }))).toEqual(['a-fact', 'b-feedback-note', 'g-fact']);
    expect(names(kg.search('zebra', { projectScope: null }))).toEqual(['b-feedback-note', 'g-fact']);
  });

  it('B sees its own and global, never A', () => {
    expect(names(kg.search('zebra', { projectScope: 'project:B' }))).toEqual(['b-fact', 'g-fact']);
  });

  it('archived rows stay hidden by default and return only with includeArchived', () => {
    expect(names(kg.search('zebra', { projectScope: 'project:A' }))).not.toContain('g-old');
    expect(names(kg.search('zebra', { projectScope: 'project:A', includeArchived: true })))
      .toEqual(['a-fact', 'a-old', 'g-fact', 'g-old']);
  });

  it('an empty query lists recent memories in scope', () => {
    expect(names(kg.search('', { projectScope: 'project:A' }))).toEqual(['a-fact', 'g-fact']);
  });

  it('an explicit tag keeps its exact meaning and wins over the scope', () => {
    expect(names(kg.search('zebra', { tag: 'project:A' }))).toEqual(['a-fact']);
    expect(names(kg.search('zebra', { tag: 'project:A', projectScope: 'project:B' }))).toEqual(['a-fact']);
    expect(names(kg.search('', { tag: 'project:A', projectScope: 'project:B' }))).toEqual(['a-fact']);
  });

  it('a namespace filter still narrows the scope', () => {
    expect(names(kg.search('zebra', { projectScope: 'project:A', namespace: 'personal' }))).toEqual(['a-fact']);
    expect(names(kg.search('zebra', { projectScope: 'project:A', namespace: 'global' }))).toEqual(['g-fact']);
  });

  it('no scope and no tag still searches every project', () => {
    expect(names(kg.search('zebra'))).toEqual(['a-fact', 'b-fact', 'g-fact']);
  });
});

describe('operations: recall and learn take the project from the transport', () => {
  it('recall with a project scope returns A and global; cross_project and an explicit tag ignore the scope', async () => {
    const ops = await import('../../src/core/operations.js');
    expect(names(ops.recall({ query: 'zebra', projectScope: 'project:A' }))).toEqual(['a-fact', 'g-fact']);
    expect(names(ops.recall({ query: 'zebra', projectScope: 'project:A', cross_project: true }))).toEqual(['a-fact', 'b-fact', 'g-fact']);
    expect(names(ops.recall({ query: 'zebra', projectScope: 'project:A', tag: 'project:B' }))).toEqual(['b-fact']);
  });

  it('learn files the lesson under the project it is given, not the process cwd', async () => {
    const ops = await import('../../src/core/operations.js');
    const r = ops.learn({ error: 'zebra broke', fix: 'fed the zebra', project: 'A' });
    expect(r.learned).toBe(true);
    const tags = (getDatabase().prepare('SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ?').all(r.name) as Array<{ tag: string }>).map(t => t.tag);
    expect(tags).toContain('project:A');
    expect(r.name.startsWith('lesson-A-')).toBe(true);
  });
});
