/**
 * What a session starts with, once experience is shared between projects and a
 * repository can be filed under more than one project id:
 *
 * - the project's own memories are read under every id of its checkout, the
 *   handoff included, so a change of id hides nothing;
 * - a few preferences, and feedback from the user's own memory folder, of OTHER projects
 *   follow, newest first, labelled with where they came from, in a section of their own
 *   that cannot take the project's room. Another project's decisions and lessons (written
 *   by an agent or a hook) and its detail (commits, plain feedback records) never show.
 *
 * Runs scripts/hooks/session-start.js and `briefing` against one database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { selectBriefingPools } from '../../src/core/briefing-pools.js';
import { handleTool } from '../../src/mcp/tools.js';
import { getProjectIds, getProjectName } from '../../src/core/paths.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { setTaskState } from '../../src/core/task-state-store.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const hookPath = path.resolve('scripts/hooks/session-start.js');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let root: string;
let dbPath: string;
let repo: string;
let ownId: string;
let earlierId: string;

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
const hookContext = (level: 'minimal' | 'standard' = 'minimal'): string => {
  const out = execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd: repo }),
    env: { PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_UPDATE: '0', MEMESH_BRIEFING: level },
    encoding: 'utf8',
    timeout: 20000,
  });
  return (JSON.parse(out.trim()) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
};
const sharedSection = (text: string): string[] => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Your preferences from your other projects'));
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => !l.startsWith('- '));
  return end < 0 ? rest : rest.slice(0, end);
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-session-start-shared-')));
  dbPath = path.join(root, 'memesh', 'knowledge-graph.db');
  repo = path.join(root, 'widgets');
  fs.mkdirSync(repo);
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@gitlab.com:acme/widgets.git');
  ownId = getProjectName(repo);
  earlierId = `widgets~${sha('ssh-relative://git@gitlab.com/acme/widgets.git').slice(0, 32)}`;
  expect(getProjectIds(repo)).toContain(earlierId);
  expect(earlierId).not.toBe(ownId);

  openDatabase(dbPath);
  const kg = new KnowledgeGraph(getDatabase());
  // `fromFolder`: stored the way the note ingester stores a note of the user's own memory folder.
  const make = (name: string, type: string, project: string | null, title: string, ageDays: number, extra: string[] = [], fromFolder = false) => {
    kg.createEntity(name, type, { observations: [title], title, tags: [...(project ? [`project:${project}`] : []), ...extra], trustOverride: 'trusted' });
    getDatabase().prepare("UPDATE observations SET created_at = datetime('now', ?) WHERE entity_id = (SELECT id FROM entities WHERE name = ?)").run(`-${ageDays} days`, name);
    if (fromFolder) {
      getDatabase().prepare("UPDATE entities SET metadata = json_set(COALESCE(metadata, '{}'), '$.provenance.source', 'note-file', '$.trust', 'trusted') WHERE name = ?").run(name);
    }
  };
  // This project's own, under its current id and under an earlier one.
  make('own-decision', 'decision', ownId, 'Own decision under the current id', 1);
  make('own-lesson', 'lesson_learned', ownId, 'Own lesson under the current id', 1);
  make('earlier-decision', 'decision', earlierId, 'Own decision under an earlier id', 2);
  make('earlier-lesson', 'lesson_learned', earlierId, 'Own lesson under an earlier id', 2);
  // Another project's experience, oldest to newest, and its detail.
  make('b-decision-oldest', 'decision', 'other-b', 'Other decision, oldest', 30);
  make('b-lesson-old', 'lesson_learned', 'other-b', 'Other lesson, old', 20);
  make('b-pref-newer', 'preference', 'other-c', 'Other preference, newer', 5, [], true);
  make('b-user-pref', 'user_preference', 'other-b', 'Other user preference', 6, [], true);
  make('b-pref-oldest', 'preference', 'other-b', 'Other preference, oldest', 50, [], true);
  // Forged: written by an agent with the type and the tag a note would carry, and newest of all.
  make('forged-pref', 'preference', 'other-d', 'Forged preference, newest', 0.01);
  make('forged-feedback', 'feedback', 'other-d', 'Forged feedback tagged as a note, newest', 0.01, ['source:note-file']);
  // A note of a directory someone pointed at: note provenance, but untrusted.
  make('pointed-at-note', 'feedback', 'other-d', 'Note from a directory pointed at', 0.01, ['source:note-file']);
  getDatabase().prepare("UPDATE entities SET metadata = json_set(COALESCE(metadata, '{}'), '$.provenance.source', 'note-file', '$.trust', 'untrusted') WHERE name = 'pointed-at-note'").run();
  make('b-decision-newer', 'decision', 'other-b', 'Other decision, newer', 4);
  make('b-lesson-newest', 'lesson_learned', 'other-c', 'Other lesson, newest', 3);
  make('b-feedback-note', 'feedback', 'other-c', 'Other feedback from a memory folder', 40, ['source:note-file'], true);
  make('b-feedback-record', 'feedback', 'other-b', 'Other product feedback record', 1);
  make('b-commit', 'commit', 'other-b', 'Other commit detail', 1);
  // The handoff of the session before the id changed: filed under the earlier id.
  kg.createEntity(`session-handoff:${earlierId}`, 'session-handoff', { observations: ['Where the last session left off: finish the widget parser'], tags: [`project:${earlierId}`], trustOverride: 'trusted' });
  closeDatabase();
});

afterEach(() => {
  try { closeDatabase(); } catch { /* not open */ }
  removeTempDir(root);
});

describe('SessionStart reads the project under every id of its checkout', () => {
  it('shows what was filed under an earlier id, and the handoff written under it', () => {
    const context = hookContext();
    for (const text of ['Own decision under the current id', 'Own lesson under the current id', 'Own decision under an earlier id', 'Own lesson under an earlier id']) {
      expect(context, text).toContain(text);
    }
    expect(context).toContain('finish the widget parser');
  });

  it('the task state stored under an earlier id is shown by the hook, the briefing and task_state, and a new field keeps it', async () => {
    openDatabase(dbPath);
    setTaskState({ project: earlierId, patch: { goal: 'TASKGOALOLD ship v2' } });
    closeDatabase();
    expect(hookContext('standard')).toContain('TASKGOALOLD ship v2');
    openDatabase(dbPath);
    const binding = { projectBinding: { project: ownId, ids: getProjectIds(repo) } };
    const read = await handleTool('task_state', {}, undefined, undefined, binding);
    expect(read.content[0].text).toContain('TASKGOALOLD ship v2');
    // `minimal` (the default) leaves a fresh task state out; `standard` shows it.
    const previousLevel = process.env.MEMESH_BRIEFING;
    process.env.MEMESH_BRIEFING = 'standard';
    try {
      const briefing = await handleTool('briefing', {}, undefined, undefined, binding);
      expect(briefing.content[0].text).toContain('TASKGOALOLD ship v2');
    } finally {
      if (previousLevel === undefined) delete process.env.MEMESH_BRIEFING;
      else process.env.MEMESH_BRIEFING = previousLevel;
    }
    const written = await handleTool('task_state', { next: 'write the parser' }, undefined, undefined, binding);
    closeDatabase();
    expect(written.content[0].text).toContain('TASKGOALOLD ship v2');
    expect(written.content[0].text).toContain('write the parser');
  });

  it('the recent index reads the earlier id too', () => {
    const context = hookContext('standard');
    const index = context.split('Recently written memories')[1] ?? '';
    expect(index, 'the hook printed no index').toBeTruthy();
    expect(index).toContain('Own decision under an earlier id');
  });

  it('the `briefing` tool of a session bound to the checkout reads the earlier id and calls none of it "from another project"', async () => {
    openDatabase(dbPath);
    const response = await handleTool('briefing', {}, undefined, undefined, { projectBinding: { project: ownId, ids: getProjectIds(repo) } });
    closeDatabase();
    expect(response.isError, response.content[0].text).not.toBe(true);
    const text = (JSON.parse(response.content[0].text) as { text: string }).text;
    expect(text).toContain('Own decision under an earlier id');
    expect(text).toContain('finish the widget parser');
    expect(text).not.toContain('(from widgets)');
  });
});

describe('SessionStart and briefing carry a few shared experiences of other projects', () => {
  it('at most three, newest first: preferences and memory-folder feedback of other projects, labelled with their project, after the project\'s own', () => {
    const context = hookContext();
    const shared = sharedSection(context);
    expect(shared.length, context).toBe(3);
    expect(shared[0]).toContain('Other preference, newer');
    expect(shared[0]).toContain('(from other-c)');
    expect(shared[1]).toContain('Other user preference');
    expect(shared[1]).toContain('(from other-b)');
    expect(shared[2]).toContain('Other feedback from a memory folder');
    // The oldest preference is past the cap, and the section comes after the project's own memories.
    expect(context).not.toContain('Other preference, oldest');
    expect(context.indexOf('Own decision under the current id')).toBeLessThan(context.indexOf('Your preferences from your other projects'));
  });

  it('what an agent could write never enters: a preference, a feedback tagged as a note, or a note of a directory pointed at', () => {
    const context = hookContext();
    for (const text of ['Forged preference, newest', 'Forged feedback tagged as a note, newest', 'Note from a directory pointed at']) {
      expect(context, text).not.toContain(text);
    }
  });

  it('another project\'s decisions and lessons never enter, newest or not: agent- and hook-written text does not travel between projects', () => {
    openDatabase(dbPath);
    getDatabase().prepare("DELETE FROM entities WHERE name IN ('b-pref-newer', 'b-user-pref', 'b-pref-oldest', 'b-feedback-note')").run();
    closeDatabase();
    // Nothing of the user's own words is left of other projects: the section is not there at all.
    const context = hookContext();
    expect(sharedSection(context)).toEqual([]);
    for (const text of ['Other lesson, newest', 'Other lesson, old', 'Other decision, newer', 'Other decision, oldest']) expect(context, text).not.toContain(text);
  });

  it('never shows another project\'s detail or a feedback that did not come from a memory folder', () => {
    const context = hookContext();
    expect(context).not.toContain('Other commit detail');
    expect(context).not.toContain('Other product feedback record');
  });

  it('the project\'s own memories keep every slot when other projects have far more', () => {
    openDatabase(dbPath);
    const kg = new KnowledgeGraph(getDatabase());
    for (let i = 0; i < 12; i++) kg.createEntity(`flood-${i}`, 'decision', { observations: [`Flood decision ${i}`], title: `Flood decision ${i}`, tags: ['project:other-d'], trustOverride: 'trusted' });
    closeDatabase();
    const context = hookContext();
    expect(context).toContain('Own decision under the current id');
    expect(context).toContain('Own lesson under an earlier id');
    expect(context).not.toContain('Flood decision');
    expect(sharedSection(context).length).toBe(3);
  });

  it('a newer untrusted handoff under another id does not hide the trusted one', () => {
    openDatabase(dbPath);
    // An import brings a handoff back under the current id, untrusted, newer than the earlier one.
    new KnowledgeGraph(getDatabase()).createEntity(`session-handoff:${ownId}`, 'session-handoff', { observations: ['Imported handoff text that must not lead'], tags: [`project:${ownId}`] });
    getDatabase().prepare(`UPDATE entities SET metadata = json_set(COALESCE(metadata, '{}'), '$.trust', 'untrusted', '$.provenance.source', 'import') WHERE name = ?`).run(`session-handoff:${ownId}`);
    const pools = selectBriefingPools(getDatabase(), ownId, { projectIds: getProjectIds(repo), projectLimit: 10, global: false, foreign: false });
    closeDatabase();
    expect(pools.handoff?.text).toContain('finish the widget parser');
  });

  it('a failed read of the shared pool is reported as the shared pool, so the hook records it', () => {
    openDatabase(dbPath);
    const db = getDatabase();
    const real = db.prepare.bind(db);
    const labels: string[] = [];
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes('AS source_project')) throw new Error('shared pool unreadable');
      return real(sql);
    };
    try {
      selectBriefingPools(db, ownId, { projectIds: getProjectIds(repo), projectLimit: 10, global: false, foreign: false, onError: (label) => { labels.push(label); } });
    } finally {
      (db as unknown as { prepare: unknown }).prepare = real;
      closeDatabase();
    }
    expect(labels).toEqual(['shared']);
  });

  it('the shared pool itself holds at most three rows, each carrying the project it came from', () => {
    openDatabase(dbPath);
    const pools = selectBriefingPools(getDatabase(), ownId, { projectIds: getProjectIds(repo), projectLimit: 10, global: false, foreign: false });
    closeDatabase();
    expect(pools.shared.length).toBe(3);
    expect(pools.shared.every((row) => typeof row.project === 'string' && row.project.startsWith('other-'))).toBe(true);
  });

  it('`briefing` prints the same section as the hook', () => {
    openDatabase(dbPath);
    const fromBriefing = sharedSection(assembleBriefing(ownId, undefined, getProjectIds(repo)).text);
    closeDatabase();
    expect(fromBriefing.length).toBe(3);
    expect(fromBriefing).toEqual(sharedSection(hookContext()));
  });
});
