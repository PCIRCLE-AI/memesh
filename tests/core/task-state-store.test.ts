/**
 * task-state against a real database and through the real MCP tool.
 *
 * The unit tests in task-state.test.ts pin the field rules. These pin the
 * things only a database can be wrong about: that two projects do not share
 * one state, that the state survives a round trip through metadata, that a
 * re-statement writes nothing, and that the tool's read path is told apart
 * from its write path by which KEYS arrived rather than by their truthiness —
 * because `blocked: ""` is a write that clears, and reading it as "nothing to
 * do" would make a resolved blocker permanent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { handleTool } from '../../src/mcp/tools.js';
import { getTaskState, setTaskState } from '../../src/core/task-state-store.js';
import { taskStateName } from '../../src/core/task-state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-taskstate-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

describe('task-state store', () => {
  it('does not read or revive archived fields when a project starts a fresh state', async () => {
    setTaskState({ project: 'alpha', patch: { goal: 'forgotten goal', done: 'forgotten done' } });
    expect(payload(await handleTool('forget', { name: taskStateName('alpha') })).archived).toBe(true);
    expect(getTaskState('alpha').state).toEqual({});
    expect(payload(await handleTool('task_state', { project: 'alpha' })).state).toEqual({});
    expect(setTaskState({ project: 'alpha', patch: { blocked: '' } }).changed).toEqual([]);
    expect(getDatabase().prepare('SELECT status FROM entities WHERE name = ?').get(taskStateName('alpha')))
      .toEqual({ status: 'archived' });
    const fresh = setTaskState({ project: 'alpha', patch: { next: 'fresh next' } });
    expect(fresh.changed).toEqual(['next']);
    expect(fresh.state.goal).toBeUndefined();
    expect(fresh.state.done).toBeUndefined();
    expect(fresh.state.stated_at).toEqual({ next: fresh.state.updated_at });
    expect(getTaskState('alpha').state).toEqual(fresh.state);
    expect(getDatabase().prepare('SELECT status FROM entities WHERE name = ?').get(taskStateName('alpha')))
      .toEqual({ status: 'active' });
  });

  it.each(['next', 'goal'] as const)('merges a real peer %s commit made before acquiring the write lock', peerField => {
    setTaskState({ project: 'alpha', patch: { goal: 'old goal', next: 'old next' } });
    const db = getDatabase();
    const transaction = db.transaction.bind(db);
    const home = path.join(tmpDir, 'peer-home'); fs.mkdirSync(home);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ updateCheck: false }));
    let injected = false;
    let peerState: ReturnType<typeof getTaskState>['state'];
    db.transaction = fn => {
      if (!injected) {
        injected = true;
        const peer = spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'task', '--project', 'alpha', `--${peerField}`, 'peer value', '--json'], {
          env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MEMESH_DIR: tmpDir, MEMESH_DB_PATH: path.join(tmpDir, 'test.db'), MEMESH_AUTO_CAPTURE: 'false', MEMESH_UPDATE_CHECK: '0', MEMESH_AUTO_UPDATE: '0' },
          cwd: tmpDir, encoding: 'utf8', timeout: 20000,
        });
        expect(peer.signal).toBeNull(); expect(peer.status, peer.stderr).toBe(0);
        peerState = JSON.parse(peer.stdout).state;
        expect(peerState[peerField]).toBe('peer value');
      }
      return transaction(fn);
    };
    try {
      const written = setTaskState({ project: 'alpha', patch: { goal: 'parent goal' } });
      expect(injected).toBe(true);
      expect(written.changed).toEqual(['goal']);
      expect(written.state.goal).toBe('parent goal');
      expect(written.state.next).toBe(peerField === 'next' ? 'peer value' : 'old next');
      expect(written.state.stated_at?.next).toBe(peerState!.stated_at?.next);
      expect(written.state.stated_at?.goal).toBe(written.state.updated_at);
      expect(getTaskState('alpha').state).toEqual(written.state);
    } finally { db.transaction = transaction; }
  });

  it('rolls back observations and metadata when the final state write fails', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'old goal' } });
    const db = getDatabase();
    const snapshot = () => ['entities', 'observations', 'tags'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    db.exec("CREATE TRIGGER owned_state_failure BEFORE UPDATE OF metadata ON entities WHEN json_extract(NEW.metadata, '$.task_state.goal') = 'must roll back' BEGIN SELECT RAISE(ABORT, 'owned state failure'); END");
    expect(() => setTaskState({ project: 'alpha', patch: { goal: 'must roll back' } })).toThrow('owned state failure');
    expect(snapshot()).toEqual(before);
    expect(getTaskState('alpha').state.goal).toBe('old goal');
  });

  it('#406 preserves old field dates through a legacy SQL row, update, and readback', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'old goal', done: 'old release', next: 'old next' } });
    const old = '2026-09-01T08:00:00.000Z';
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run(
      JSON.stringify({ task_state: { goal: 'old goal', done: 'old release', next: 'old next', updated_at: old } }), taskStateName('alpha'));
    const written = setTaskState({ project: 'alpha', patch: { goal: 'new goal' } });
    expect(written.changed).toEqual(['goal']);
    expect(written.state).toMatchObject({ goal: 'new goal', done: 'old release', next: 'old next',
      legacy_updated_at: old, stated_at: { goal: written.state.updated_at } });
    expect(written.state.stated_at).toEqual({ goal: written.state.updated_at });
    expect(written.state.updated_at).not.toBe(old);
    expect(getTaskState('alpha').state).toEqual(written.state);
    expect(getTaskState('beta').state).toEqual({});
    const row = getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(taskStateName('alpha')) as { metadata: string };
    expect(JSON.parse(row.metadata).task_state).toEqual(written.state);
  });
  it('reports corrupted metadata as a failure instead of an empty state (#237)', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('{not json', taskStateName('alpha'));
    // Returning {} here would show "nothing stated" on the Project tab, the
    // CLI and the MCP tool for a record that is actually broken.
    expect(() => getTaskState('alpha')).toThrow(/not valid JSON/);
    // The message names the project, not the internal entity name.
    expect(() => getTaskState('alpha')).toThrow(/project "alpha"/);
    expect(() => getTaskState('alpha')).not.toThrow(/task-state:/);
    // The WRITE path is the recovery path: it overwrites the broken record.
    const written = setTaskState({ project: 'alpha', patch: { goal: 'recovered' } });
    expect(written.state).toEqual(expect.objectContaining({ goal: 'recovered' }));
    expect(getTaskState('alpha').state.goal).toBe('recovered');
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('{not json', taskStateName('alpha'));
    // A well-formed value of an unusable shape is still "nothing usable".
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('[1,2,3]', taskStateName('alpha'));
    expect(getTaskState('alpha').state).toEqual({});
  });

  it.each([false, true])('refuses an empty clear on unreadable state without writing (query-only=%s)', queryOnly => {
    setTaskState({ project: 'alpha', patch: { goal: 'old goal' } });
    const db = getDatabase();
    db.prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('{not json', taskStateName('alpha'));
    const snapshot = () => ({
      entities: db.prepare('SELECT * FROM entities ORDER BY id').all(),
      observations: db.prepare('SELECT * FROM observations ORDER BY id').all(),
      tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
    });
    const before = snapshot();
    if (queryOnly) db.pragma('query_only = ON');
    try {
      expect(() => setTaskState({ project: 'alpha', patch: { blocked: '' } })).toThrow(/not valid JSON/);
      if (queryOnly) {
        expect(() => setTaskState({ project: 'alpha', patch: { goal: 'recovered' } })).toThrow(/readonly/i);
      }
      expect(snapshot()).toEqual(before);
      expect(() => getTaskState('alpha')).toThrow(/not valid JSON/);
    } finally {
      if (queryOnly) db.pragma('query_only = OFF');
    }
  });

  it('keeps each project’s state separate', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    setTaskState({ project: 'beta', patch: { goal: 'ship beta' } });

    expect(getTaskState('alpha').state.goal).toBe('ship alpha');
    expect(getTaskState('beta').state.goal).toBe('ship beta');
  });

  it('survives the round trip through metadata, not through observation order', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'first goal' } });
    setTaskState({ project: 'alpha', patch: { goal: 'second goal', next: 'a step' } });

    // The current answer is one value in metadata. Reading it out of the
    // observation trail would mean guessing which line is newest.
    expect(getTaskState('alpha').state).toMatchObject({ goal: 'second goal', next: 'a step' });

    // The trail is still there — it is the history, and it holds BOTH goals.
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { id: number };
    const observations = getDatabase()
      .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
      .all(row.id) as Array<{ content: string }>;
    expect(observations.map((o) => o.content)).toEqual([
      'goal: first goal',
      'goal: second goal',
      'next: a step',
    ]);
  });

  it('writes nothing when a value is re-stated', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    const before = getTaskState('alpha').state.updated_at;

    const again = setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    expect(again.changed).toEqual([]);
    expect(getTaskState('alpha').state.updated_at).toBe(before);

    // No second observation either — this is what bounds the row's growth.
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { id: number };
    const count = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM observations WHERE entity_id = ?')
      .get(row.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it('preserves same-value no-ops on a query-only database while rejecting changes', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    const db = getDatabase();
    const snapshot = () => ({
      entities: db.prepare('SELECT * FROM entities ORDER BY id').all(),
      observations: db.prepare('SELECT * FROM observations ORDER BY id').all(),
      tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
    });
    const before = snapshot();
    const state = getTaskState('alpha').state;
    db.pragma('query_only = ON');
    try {
      expect(setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } }))
        .toEqual({ project: 'alpha', state, changed: [] });
      expect(setTaskState({ project: 'ghost', patch: { blocked: '' } }).changed).toEqual([]);
      expect(() => setTaskState({ project: 'alpha', patch: { goal: 'changed goal' } }))
        .toThrow(/readonly/i);
      expect(snapshot()).toEqual(before);
    } finally {
      db.pragma('query_only = OFF');
    }
  });

  it('creates nothing at all when the write turns out to be a no-op', () => {
    // Clearing a field that was never set changes nothing, so nothing should
    // exist afterwards. Without the early return this still reaches
    // `remember()`, which creates the row — and every project an agent merely
    // *asked* about would accumulate an empty task-state memory.
    const result = setTaskState({ project: 'ghost', patch: { blocked: '' } });
    expect(result.changed).toEqual([]);

    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('ghost'));
    expect(row).toBeUndefined();
  });

  it('carries the project tag, so session-start’s project query finds it', () => {
    // Without this tag the state exists but the hook that injects it never
    // sees it — a read path with an invisible writer.
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { id: number };
    const tags = getDatabase()
      .prepare('SELECT tag FROM tags WHERE entity_id = ?')
      .all(row.id) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toContain('project:alpha');
  });

  it('titles the memory with the goal instead of the machine key', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship the topology injection' } });
    const row = getDatabase()
      .prepare('SELECT title FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { title: string | null };
    expect(row.title).toBe('ship the topology injection');
  });

  it.each(['goal', 'next', 'blocked', 'done'] as const)('caps the generated %s title without shortening its task field', field => {
    const text = 'a'.repeat(198) + '😀' + 'b'.repeat(80);
    const written = setTaskState({ project: 'alpha', patch: { [field]: text } });
    const row = getDatabase().prepare('SELECT title FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { title: string };
    expect(row.title).toBe('a'.repeat(198) + '…');
    expect(written.state[field]).toBe(text);
    expect(getTaskState('alpha').state).toEqual(written.state);
  });
});

describe('task_state MCP tool', () => {
  it('#406 returns and persists per-field dates when a field is cleared', async () => {
    const initial = payload(await handleTool('task_state', { project: 'alpha', goal: 'goal', done: 'done' }));
    expect(initial.state.stated_at).toEqual({ goal: initial.state.updated_at, done: initial.state.updated_at });
    const cleared = payload(await handleTool('task_state', { project: 'alpha', done: '' }));
    expect(cleared.state.done).toBeUndefined();
    expect(cleared.state.stated_at).toEqual({ goal: initial.state.stated_at.goal });
    expect(payload(await handleTool('task_state', { project: 'alpha' })).state).toEqual(cleared.state);
  });
  it('reads with no arguments instead of writing an empty state', async () => {
    const read = payload(await handleTool('task_state', { project: 'alpha' }));
    expect(read.state).toEqual({});
    // A read must not create the row — otherwise every session start would
    // leave an empty task-state memory behind.
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha'));
    expect(row).toBeUndefined();
  });

  it('records what it was given and reads it back', async () => {
    await handleTool('task_state', { project: 'alpha', goal: 'ship A1b', next: 'open the PR' });
    const read = payload(await handleTool('task_state', { project: 'alpha' }));
    expect(read.state).toMatchObject({ goal: 'ship A1b', next: 'open the PR' });
  });

  it('treats an empty string as a clear, not as an absent field', async () => {
    // The whole reason the field exists: blockers get resolved. If `""` were
    // read as "nothing passed", this tool could add a blocker and never
    // remove it, and every future session would work around a phantom.
    await handleTool('task_state', { project: 'alpha', goal: 'ship A1b', blocked: 'CI is red' });
    expect(payload(await handleTool('task_state', { project: 'alpha' })).state.blocked).toBe('CI is red');

    const cleared = payload(await handleTool('task_state', { project: 'alpha', blocked: '' }));
    expect(cleared.changed).toEqual(['blocked']);

    const after = payload(await handleTool('task_state', { project: 'alpha' })).state;
    expect(after.blocked).toBeUndefined();
    expect(after.goal).toBe('ship A1b');
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    // additionalProperties: false — a model inventing `priority` must be told,
    // not quietly ignored while it believes the value was stored.
    const result = await handleTool('task_state', { project: 'alpha', priority: 'high' });
    expect(JSON.stringify(result)).toMatch(/priority|unrecognized|invalid/i);
  });
});
