import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import {
  RECENT_INDEX_SIZE,
  RECENT_TITLE_CHARS,
  STALE_PENDING_MAX_DAYS,
  STALE_SUPERSEDE_TAU,
  buildRecentIndex,
} from '../../src/core/recent-index.js';
import { PROMPT_RECALL_MAX_LINES, selectPromptRecall } from '../../src/core/prompt-recall.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-recent-index-');

const PROJECT = 'proj~0123456789abcdef0123456789abcdef';
/** Another repository whose folder happens to have the same name: not this project. */
const SAME_NAME = 'proj~fedcba9876543210fedcba9876543210';
/** The same name in another case: not this project either. */
const OTHER_CASE = 'Proj~0123456789abcdef0123456789abcdef';
/** The id written before ids carried a hash: still this project. */
const LEGACY = 'proj';
const OTHER = 'other~0123456789abcdef0123456789abcdef';
const AS_OF = Date.parse('2026-11-03T00:00:00Z');

/** A git checkout named `proj` with a GitHub remote, and the two ids it is known by (computed here, not by the product). */
function checkout(): { dir: string; remoteId: string; pathId: string; cleanup: () => void } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-recent-checkout-'));
  const dir = path.join(parent, 'proj');
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/proj.git']);
  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
  return {
    dir,
    remoteId: `proj~${hash('github.com/acme/proj')}`,
    pathId: `proj~${hash(fs.realpathSync.native(dir))}`,
    cleanup: () => fs.rmSync(parent, { recursive: true, force: true }),
  };
}

interface Row {
  id: number;
  type?: string;
  title?: string | null;
  name?: string;
  created: string;
  observed?: string[];
  tags?: string[];
  namespace?: string;
  metadata?: string | null;
  status?: string;
}

/** A memory written exactly as a stored graph holds it: id, times, tags, namespace and metadata as given. */
function put(row: Row): void {
  const db = getDatabase();
  db.prepare('INSERT INTO entities (id, name, type, title, created_at, status, namespace, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.name ?? String(row.id), row.type ?? 'reference', row.title === undefined ? `Memory ${row.id}` : row.title,
      row.created, row.status ?? 'active', row.namespace ?? 'personal', row.metadata ?? null);
  for (const at of row.observed ?? [row.created]) {
    db.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)').run(row.id, `text of ${row.id}`, at);
  }
  for (const tag of row.tags ?? [`project:${PROJECT}`]) db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(row.id, tag);
}

const shownIds = (asOf = AS_OF, project: string | null = PROJECT) => buildRecentIndex(getDatabase(), project, asOf).shown.map((r) => r.id);

describe('the session-start recent index', () => {
  it('lists the 30 most recently written memories, newest observation first, ties by id', () => {
    // 35 memories, one written a minute apart; 5 and 6 share a second.
    for (let i = 1; i <= 35; i++) {
      const at = `2026-11-01 10:${String(i).padStart(2, '0')}:00`;
      put({ id: i, title: `Topic number ${i} alpha${i}`, created: '2026-10-01 00:00:00', observed: [i === 6 ? '2026-11-01 10:05:00' : at] });
    }
    const ids = shownIds();
    expect(RECENT_INDEX_SIZE).toBe(30);
    expect(ids).toHaveLength(30);
    // Newest first: 35..7 (29 of them), then the tie at 10:05 broken by id: 5 makes 30, 6 is cut.
    expect(ids).toEqual([...Array.from({ length: 29 }, (_, i) => 35 - i), 5]);
  });

  it('a memory with no observation yet at the time asked about is not listed', () => {
    put({ id: 1, created: '2026-11-01 00:00:00', observed: ['2026-11-05 00:00:00'] });
    put({ id: 2, created: '2026-11-01 00:00:00' });
    expect(shownIds()).toEqual([2]);
  });

  it('superseded: a newer decision of the same project with the same topic words replaces the older memory', () => {
    // A newer decision sharing 2 of 8 topic words (0.25 >= 0.2) replaces the older one.
    put({ id: 29898, type: 'decision', title: 'Upgrade plan: Codex implements reviews', created: '2026-11-01 12:29:25' });
    put({ id: 30405, type: 'decision', title: 'Upgrade plan moves to Claude now', created: '2026-11-02 04:25:07' });
    // 2 of 12 shared (0.17): kept at tau 0.2.
    put({ id: 30078, type: 'decision', title: 'Local cloud link starts after phases one to three', created: '2026-11-01 17:39:56', observed: ['2026-11-01 17:44:13'] });
    put({ id: 37161, type: 'decision', title: 'Stop cloud work; local does not depend on it', created: '2026-11-02 19:22:27' });
    const index = buildRecentIndex(getDatabase(), PROJECT, AS_OF);
    expect(STALE_SUPERSEDE_TAU).toBe(0.2);
    expect(index.removed).toEqual([{ id: 29898, reason: 'superseded' }]);
    expect(index.shown.map((r) => r.id)).toEqual([37161, 30405, 30078]);
    // The pool keeps it: a prompt's top-2 is compared with the unfiltered 30.
    expect(index.poolIds).toContain(29898);
  });

  it('superseded only counts a newer DECISION of the SAME project', () => {
    put({ id: 1, type: 'decision', title: 'Upgrade plan: Codex implements reviews', created: '2026-11-01 12:29:25' });
    put({ id: 2, type: 'lesson_learned', title: 'Upgrade plan moves to Claude now', created: '2026-11-02 04:25:07' });
    put({ id: 3, type: 'decision', title: 'Upgrade plan moves to Claude now', created: '2026-11-02 05:00:00', tags: [] });
    expect(shownIds().sort()).toEqual([1, 2, 3]);
  });

  it('waiting: a waiting or temporary title nothing was written to since is out of date, at any age', () => {
    // The wordings the filter knows: 等 KT, 暫維持, 未解.
    put({ id: 17338, title: 'Slice 0 完成，等 KT 合併進 main', created: '2026-10-03 14:40:17', observed: ['2026-10-07 14:24:02'] });
    put({ id: 26262, title: 'Slice 1 完成，等 KT 合併與裁決起點', created: '2026-10-08 01:42:19' });
    put({ id: 26666, title: '派單改成推薦候選清單；第一版暫維持人工派單', created: '2026-10-08 19:25:56' });
    put({ id: 5102, title: 'B1-B4 出貨。未解：分群按週不按語意', created: '2026-09-19 17:00:38' });
    // Written to one hour before: still more than 0 days.
    put({ id: 9, title: 'Release is pending review', created: '2026-11-02 23:00:00' });
    put({ id: 10, title: 'Release shipped', created: '2026-11-02 22:00:00' });
    const index = buildRecentIndex(getDatabase(), PROJECT, AS_OF);
    expect(STALE_PENDING_MAX_DAYS).toBe(0);
    expect(index.removed.map((r) => [r.id, r.reason]).sort()).toEqual([[17338, 'waiting'], [26262, 'waiting'], [26666, 'waiting'], [5102, 'waiting'], [9, 'waiting']].sort());
    expect(index.shown.map((r) => r.id)).toEqual([10]);
  });

  it('what the filter removes is not replaced by the next memory', () => {
    for (let i = 1; i <= 31; i++) put({ id: i, title: i === 31 ? 'waiting for review' : `Distinct subject q${i}`, created: `2026-11-01 10:${String(i).padStart(2, '0')}:00` });
    const index = buildRecentIndex(getDatabase(), PROJECT, AS_OF);
    expect(index.poolIds).toHaveLength(30);
    expect(index.shown).toHaveLength(29);
    expect(index.shown.map((r) => r.id)).not.toContain(1);
  });

  it('scope: this project and its id from before hashes, and no-project memories; never another project (global or not), a host-scoped, untrusted, feedback, captured or archived one', () => {
    const at = '2026-11-01 10:00:00';
    put({ id: 1, created: at, title: 'Mine' });
    put({ id: 2, created: at, title: 'Same repository, id from before hashes', tags: [`project:${LEGACY}`] });
    put({ id: 3, created: at, title: 'No project', tags: [] });
    put({ id: 4, created: at, title: 'Global, other project', tags: [`project:${OTHER}`], namespace: 'global' });
    put({ id: 5, created: at, title: 'Another project', tags: [`project:${OTHER}`] });
    put({ id: 6, created: at, title: 'Host scoped', tags: ['platform:hermes'] });
    put({ id: 7, created: at, title: 'Untrusted', metadata: JSON.stringify({ trust: 'untrusted' }) });
    put({ id: 8, created: at, title: 'Imported', metadata: JSON.stringify({ provenance: { source: 'import' } }) });
    put({ id: 9, created: at, title: 'Unreadable metadata', metadata: '{not json' });
    put({ id: 10, created: at, title: 'Writing style', type: 'feedback' });
    put({ id: 11, created: at, title: 'A commit', type: 'commit' });
    put({ id: 12, created: at, title: 'Captured', tags: [`project:${PROJECT}`, 'source:auto-capture'] });
    put({ id: 13, created: at, title: 'Archived', status: 'archived' });
    put({ id: 14, created: at, title: 'Task', type: 'task-state' });
    expect(shownIds()).toEqual([1, 2, 3]);
    // From the other project's side, only its own (the global one included) and the no-project one.
    expect(shownIds(AS_OF, OTHER)).toEqual([3, 4, 5]);
  });

  it('a project whose folder has the same name is another project: neither index shows the other one\'s memories', () => {
    const at = '2026-11-01 10:00:00';
    put({ id: 1, created: at, title: 'Mine' });
    put({ id: 2, created: at, title: 'Theirs, same folder name', tags: [`project:${SAME_NAME}`] });
    put({ id: 3, created: at, title: 'Same name in another case', tags: [`project:${OTHER_CASE}`] });
    put({ id: 4, created: at, title: 'Legacy id in another case', tags: ['project:Proj'] });
    expect(shownIds()).toEqual([1]);
    expect(shownIds(AS_OF, SAME_NAME)).toEqual([2]);
    // A hash-less id is the project's own id from before hashes, so it stays legacy-only: no hashed id comes with it.
    put({ id: 5, created: at, title: 'Legacy', tags: [`project:${LEGACY}`] });
    expect(shownIds(AS_OF, LEGACY)).toEqual([5]);
  });

  it('with the current folder, both ids that checkout is known by (remote and path) are this project; another same-name id is not', () => {
    const repo = checkout();
    try {
      const at = '2026-11-01 10:00:00';
      put({ id: 1, created: at, title: 'Under the remote id', tags: [`project:${repo.remoteId}`] });
      put({ id: 2, created: at, title: 'Under the path id', tags: [`project:${repo.pathId}`] });
      put({ id: 3, created: at, title: 'Under the legacy id', tags: [`project:${LEGACY}`] });
      put({ id: 4, created: at, title: 'Another proj repository', tags: [`project:${SAME_NAME}`] });
      expect(buildRecentIndex(getDatabase(), repo.remoteId, AS_OF, repo.dir).shown.map((r) => r.id)).toEqual([1, 2, 3]);
      // Without the folder only the id itself and its legacy form are known.
      expect(shownIds(AS_OF, repo.remoteId)).toEqual([1, 3]);
      // A folder that is not the asked project's checkout adds nothing (the hash-less id is every `proj~` id's legacy form).
      expect(buildRecentIndex(getDatabase(), SAME_NAME, AS_OF, repo.dir).shown.map((r) => r.id)).toEqual([3, 4]);
    } finally {
      repo.cleanup();
    }
  });

  it('superseded treats every id of one checkout, and its legacy id, as one project', () => {
    const repo = checkout();
    try {
      put({ id: 1, type: 'decision', title: 'Upgrade plan: Codex implements reviews', created: '2026-11-01 12:29:25', tags: [`project:${repo.pathId}`] });
      put({ id: 2, type: 'decision', title: 'Upgrade plan moves to Claude now', created: '2026-11-02 04:25:07', tags: [`project:${repo.remoteId}`] });
      put({ id: 3, type: 'decision', title: 'Cloud link starts after phase three', created: '2026-11-01 12:00:00', tags: [`project:${LEGACY}`] });
      put({ id: 4, type: 'decision', title: 'Cloud link waits for phase three review', created: '2026-11-02 05:00:00', tags: [`project:${repo.remoteId}`] });
      expect(buildRecentIndex(getDatabase(), repo.remoteId, AS_OF, repo.dir).removed.sort((a, b) => a.id - b.id))
        .toEqual([{ id: 1, reason: 'superseded' }, { id: 3, reason: 'superseded' }]);
    } finally {
      repo.cleanup();
    }
  });

  it('renders `- <title> [mem:<id>]`: title else name, no type label, cut to 120 characters', () => {
    put({ id: 1, created: '2026-11-01 10:00:00', type: 'lesson_learned', title: 'Plain title' });
    put({ id: 2, created: '2026-11-01 09:00:00', title: null, name: 'name-used-when-no-title' });
    put({ id: 3, created: '2026-11-01 08:00:00', title: 'x'.repeat(200) });
    const { lines } = buildRecentIndex(getDatabase(), PROJECT, AS_OF);
    expect(lines).toEqual([
      'Recently written memories in "proj" (newest first; recall a [mem:id] to read one):',
      '- Plain title [mem:1]',
      '- name-used-when-no-title [mem:2]',
      `- ${'x'.repeat(RECENT_TITLE_CHARS)} [mem:3]`,
    ]);
  });

  it('is bounded: 30 lines of at most 139 characters (10-digit ids), 4,199 with line breaks, plus the heading', () => {
    // It sits outside the ranked block's 4000-character limit, so its own ceiling is pinned here.
    for (let i = 0; i < 31; i++) put({ id: 9_999_999_969 + i, title: `${'長'.repeat(150)} ${i}`, created: `2026-11-01 10:${String(i).padStart(2, '0')}:00` });
    const { lines } = buildRecentIndex(getDatabase(), PROJECT, AS_OF);
    const body = lines.slice(1);
    const maxLine = '- '.length + RECENT_TITLE_CHARS + ' [mem:'.length + 10 + ']'.length;
    expect(maxLine).toBe(139);
    expect(body).toHaveLength(RECENT_INDEX_SIZE);
    expect(Math.max(...body.map((l) => l.length))).toBe(maxLine);
    expect(body.join('\n').length).toBe(RECENT_INDEX_SIZE * maxLine + RECENT_INDEX_SIZE - 1);
    expect(RECENT_INDEX_SIZE * maxLine + RECENT_INDEX_SIZE - 1).toBe(4199);
  });

  it('never cuts a character in half', () => {
    put({ id: 1, created: '2026-11-01 10:00:00', title: `${'a'.repeat(119)}😀😀` });
    expect(buildRecentIndex(getDatabase(), PROJECT, AS_OF).lines[1]).toBe(`- ${'a'.repeat(119)} [mem:1]`);
  });

  it('redacts a secret in a title before it is shown', () => {
    const secret = ['postgres://appuser', 'hunter2hunter2@db:5432/app'].join(':');
    put({ id: 1, created: '2026-11-01 10:00:00', title: `Database at ${secret}` });
    const text = buildRecentIndex(getDatabase(), PROJECT, AS_OF).lines.join('\n');
    expect(text).toContain('[mem:1]');
    expect(text).not.toContain('hunter2hunter2');
  });

  it('an empty graph gives no section at all', () => {
    const index = buildRecentIndex(getDatabase(), PROJECT, AS_OF);
    expect(index).toEqual({ poolIds: [], shown: [], removed: [], lines: [] });
  });

  it('when every recent memory is out of date it says so instead of listing nothing', () => {
    put({ id: 1, created: '2026-11-01 10:00:00', title: 'Still waiting for KT' });
    expect(buildRecentIndex(getDatabase(), PROJECT, AS_OF).lines[1]).toMatch(/^- The 1 most recent memories all look out of date/);
  });
});

describe('the per-prompt top-2', () => {
  const kg = () => new KnowledgeGraph(getDatabase());
  const tags = [`project:${PROJECT}`];

  it('brings along at most two memories, even when three match strongly', () => {
    for (const n of ['one', 'two', 'three']) kg().createEntity(`zebra-${n}`, 'reference', { title: `Zebrafish quokka ${n}`, observations: [`zebrafish quokka marmot ${n}`], tags });
    const hit = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT });
    expect(PROMPT_RECALL_MAX_LINES).toBe(2);
    expect(hit.ids).toHaveLength(2);
    expect(hit.text.split('\n').filter((l) => /^- .* \[mem:\d+\]$/.test(l))).toHaveLength(2);
  });

  it('a waiting match is dropped and not replaced by the third match', () => {
    kg().createEntity('a', 'reference', { title: 'Zebrafish quokka is pending', observations: ['zebrafish quokka marmot pending'], tags });
    kg().createEntity('b', 'reference', { title: 'Zebrafish quokka notes', observations: ['zebrafish quokka marmot notes'], tags });
    kg().createEntity('c', 'reference', { title: 'Zebrafish quokka extra', observations: ['zebrafish quokka marmot extra'], tags });
    getDatabase().prepare("UPDATE entities SET created_at = '2026-01-01 00:00:00'").run();
    getDatabase().prepare("UPDATE observations SET created_at = '2026-01-01 00:00:00'").run();
    const all = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT, maxLines: 3 });
    const top = all.ids.slice(0, 2);
    const hit = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT });
    const pendingId = (getDatabase().prepare("SELECT id FROM entities WHERE name = 'a'").get() as { id: number }).id;
    if (top.includes(pendingId)) {
      expect(hit.ids).toEqual(top.filter((id) => id !== pendingId));
      expect(hit.removed).toEqual([{ id: pendingId, reason: 'waiting' }]);
    } else {
      expect(hit.ids).toEqual(top);
    }
    expect(hit.ids).toHaveLength(top.includes(pendingId) ? 1 : 2);
  });

  it('a match a newer decision in the session index replaces is dropped', () => {
    put({ id: 900, type: 'decision', title: 'Upgrade plan moves to Claude now', created: '2026-11-02 04:25:07' });
    kg().createEntity('codex-implements', 'decision', { title: 'Upgrade plan: Codex implements reviews', observations: ['zebrafish quokka marmot plan'], tags });
    getDatabase().prepare("UPDATE entities SET created_at = '2026-11-01 12:29:25' WHERE name = 'codex-implements'").run();
    getDatabase().prepare("UPDATE observations SET created_at = '2026-11-01 12:29:25' WHERE entity_id = (SELECT id FROM entities WHERE name = 'codex-implements')").run();
    const without = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT, minCoverage: 0.1, createdBefore: AS_OF });
    expect(without.ids).toHaveLength(1);
    const withPool = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT, minCoverage: 0.1, createdBefore: AS_OF, recentPool: [900] });
    expect(withPool.ids).toEqual([]);
    expect(withPool.reason).toBe('stale');
  });

  it('an already shown match is dropped and not replaced', () => {
    for (const n of ['one', 'two', 'three']) kg().createEntity(`zebra-${n}`, 'reference', { title: `Zebrafish quokka ${n}`, observations: [`zebrafish quokka marmot ${n}`], tags });
    const first = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT });
    const again = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT, exclude: new Set([first.ids[0]]) });
    expect(again.ids).toEqual([first.ids[1]]);
  });

  it('a line is `- <title> [mem:<id>]` with no type label', () => {
    kg().createEntity('zebra-one', 'decision', { title: 'Zebrafish quokka rule', observations: ['zebrafish quokka marmot'], tags });
    const hit = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT });
    expect(hit.text).toContain(`- Zebrafish quokka rule [mem:${hit.ids[0]}]`);
    expect(hit.text).not.toContain('[decision]');
  });

  it('searches this project and its id from before hashes, never another project, global or not, nor one whose folder has the same name', () => {
    kg().createEntity('legacy-one', 'reference', { title: 'Zebrafish quokka legacy', observations: ['zebrafish quokka marmot'], tags: [`project:${LEGACY}`] });
    kg().createEntity('same-name', 'reference', { title: 'Zebrafish quokka same name', observations: ['zebrafish quokka marmot'], tags: [`project:${SAME_NAME}`] });
    kg().createEntity('other-case', 'reference', { title: 'Zebrafish quokka other case', observations: ['zebrafish quokka marmot'], tags: [`project:${OTHER_CASE}`] });
    kg().createEntity('other-one', 'reference', { title: 'Zebrafish quokka other', observations: ['zebrafish quokka marmot'], tags: [`project:${OTHER}`] });
    kg().createEntity('global-other', 'reference', { title: 'Zebrafish quokka global', observations: ['zebrafish quokka marmot'], tags: [`project:${OTHER}`], namespace: 'global' });
    const hit = selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: PROJECT });
    expect(hit.scored.map((m) => m.name)).toEqual(['legacy-one']);
    // From the same-name repository's side, its own and the hash-less legacy id, never this project's.
    expect(selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: SAME_NAME }).scored.map((m) => m.name).sort()).toEqual(['legacy-one', 'same-name']);
  });

  it('with the current folder, searches both ids of that checkout, and not a same-name repository', () => {
    const repo = checkout();
    try {
      kg().createEntity('by-remote', 'reference', { title: 'Zebrafish quokka remote', observations: ['zebrafish quokka marmot'], tags: [`project:${repo.remoteId}`] });
      kg().createEntity('by-path', 'reference', { title: 'Zebrafish quokka path', observations: ['zebrafish quokka marmot'], tags: [`project:${repo.pathId}`] });
      kg().createEntity('same-name', 'reference', { title: 'Zebrafish quokka same name', observations: ['zebrafish quokka marmot'], tags: [`project:${SAME_NAME}`] });
      const names = (cwd?: string) => selectPromptRecall(getDatabase(), 'zebrafish quokka marmot', { project: repo.remoteId, cwd }).scored.map((m) => m.name).sort();
      expect(names(repo.dir)).toEqual(['by-path', 'by-remote']);
      expect(names()).toEqual(['by-remote']);
    } finally {
      repo.cleanup();
    }
  });
});
