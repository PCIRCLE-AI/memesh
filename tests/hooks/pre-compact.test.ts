import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { expectValidHookOutput, HOOK_SPECIFIC_OUTPUT_EVENTS } from '../helpers/hook-output-contract.js';
import { withoutHostIdentity } from '../helpers/host-env.js';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

const require = createRequire(import.meta.url);
// Non-git identity = basename + real-path hash (tests/core/project-identity.test.ts).
const { getProjectName: mirrorProjectName } = require('../../scripts/hooks/_shared.js');

/**
 * The columns these assertions read off a `SELECT`. better-sqlite3 types
 * `.get()` and `.all()` as `unknown` — correctly, since it cannot know the
 * shape of an arbitrary query — so a test that reads columns has to say which
 * ones it is reading. Stating it here is the test declaring its own contract
 * with the schema; before this file was type-checked, it declared nothing and
 * `entity.typo` would have compiled.
 */
type Row = {
  id: number;
  name: string;
  type: string;
  title: string | null;
  content: string;
  tag: string;
};

describe('Feature: PreCompact Hook', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-precompact-test-'));
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runHook(input: object, env: Record<string, string> = {}): string {
    const hookPath = path.resolve('scripts/hooks/pre-compact.js');
    const jsonInput = JSON.stringify(input);
    return execFileSync('node', [hookPath], {
      input: jsonInput,
      env: { ...withoutHostIdentity(process.env), MEMESH_DB_PATH: dbPath, ...env },
      encoding: 'utf8',
      timeout: 60000,
    });
  }

  it('Scenario: repeated compaction preserves a forgotten memory and records a skip', () => {
    const payload = { session_id: 'forgotten', cwd: testDir, trigger: 'auto' };
    runHook(payload);
    const db = new Database(dbPath);
    try {
      new KnowledgeGraph(db).archiveEntity('pre-compact-forgotten');
      db.exec("DELETE FROM hook_runs WHERE hook = 'pre-compact'");
    } finally {
      db.close();
    }
    const output = JSON.parse(runHook({ ...payload, trigger: 'manual' }));
    expect(output.systemMessage).toContain('archived');
    expect(output.systemMessage).not.toContain('Saved');
    const after = openDb();
    try {
      expect(after.prepare("SELECT COUNT(*) AS n FROM entities_fts f JOIN entities e ON e.id=f.rowid WHERE e.status='archived'").get()).toEqual({ n: 0 });
      expect(after.prepare("SELECT * FROM hook_runs WHERE hook='pre-compact'").get()).toBeUndefined();
      expect(after.prepare("SELECT content FROM observations WHERE content='Compaction reason: manual'").all()).toEqual([]);
    } finally {
      after.close();
    }
    const records = fs.readFileSync(path.join(testDir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'capture target is archived', entity: 'pre-compact-forgotten' });
  });

  function openDb(): Database {
    return new Database(dbPath, { readOnly: true });
  }

  // spawnSync variant so stderr is visible regardless of exit code.
  function runHookStderr(input: object): string {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const res = spawnSync('node', [path.resolve('scripts/hooks/pre-compact.js')], {
      input: JSON.stringify(input),
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 60000,
    });
    return res.stderr || '';
  }

  it('Scenario: an unreadable transcript traces to stderr (not a silent "0 insights")', () => {
    // A directory at the transcript path makes readFileSync throw EISDIR after
    // existsSync passes — stands in for a permission/IO fault on a real file.
    const dirAsTranscript = path.join(testDir, 'transcript-is-a-dir');
    fs.mkdirSync(dirAsTranscript);
    const stderr = runHookStderr({
      session_id: 'sess-unreadable',
      transcript_path: dirAsTranscript,
      cwd: '/tmp/myproject',
      trigger: 'auto',
    });
    expect(stderr).toContain('[memesh pre-compact]');
    expect(stderr).toContain('unreadable');
  });

  describe('a transcript the payload names but the hook cannot read', () => {
    const entityRows = (name: string) => {
      const db = openDb();
      try {
        return {
          title: (db.prepare('SELECT title FROM entities WHERE name = ?').get(name) as { title: string | null } | undefined)?.title ?? null,
          observations: (db.prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ?').all(name) as Array<{ content: string }>).map((r) => r.content),
        };
      } finally { db.close(); }
    };

    it('does not store "Tool calls: 0" when the transcript is gone, says so, and records an error', () => {
      const output = JSON.parse(runHook({ session_id: 'sess-unread', transcript_path: path.join(testDir, 'no-such-transcript.jsonl'), cwd: testDir, trigger: 'auto' }));
      const stored = entityRows('pre-compact-sess-unread');
      expect(stored.observations).toContain('Tool calls: not recorded (the transcript could not be read)');
      expect(stored.observations.join('|')).not.toMatch(/Tool calls: 0/);
      expect(stored.title).not.toMatch(/0 tool calls/);
      expect(output.systemMessage).toMatch(/could not be read/);
      expect(output.systemMessage).not.toMatch(/^Saved/);
      expect(outcomes().at(-1)).toMatchObject({ hook: 'pre-compact', outcome: 'error', reason: 'the transcript could not be read', entity: 'pre-compact-sess-unread' });
    });

    it('still stores the real count for a transcript it can read', () => {
      const file = path.join(testDir, 't.jsonl');
      fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }, { type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: '/r/x.ts' } }] } })}\n`);
      const output = JSON.parse(runHook({ session_id: 'sess-read', transcript_path: file, cwd: testDir, trigger: 'auto' }));
      expect(entityRows('pre-compact-sess-read').observations).toContain('Tool calls: 2');
      expect(output.systemMessage).toMatch(/^Saved/);
      expect(outcomes().at(-1)).toMatchObject({ hook: 'pre-compact', outcome: 'wrote' });
    });
    const writeRows = (file: string, rows: number, rowBytes: number) => {
      const row = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'i', name: 'Read', input: { pad: 'x'.repeat(rowBytes - 120) } }] } })}\n`;
      const buffer = Buffer.from(row);
      const fd = fs.openSync(file, 'w');
      try { for (let i = 0; i < rows; i++) fs.writeSync(fd, buffer); } finally { fs.closeSync(fd); }
    };

    it('counts the tool calls of a transcript larger than a string can be (over 512 MiB), reading it in pieces', () => {
      const file = path.join(testDir, 'huge.jsonl');
      writeRows(file, 540, 1024 * 1024);
      expect(fs.statSync(file).size).toBeGreaterThan(0x1fffffe8);
      try {
        const output = JSON.parse(runHook({ session_id: 'sess-huge', transcript_path: file, cwd: testDir, trigger: 'auto' }));
        expect(output.systemMessage).toMatch(/^Saved/);
        expect(entityRows('pre-compact-sess-huge').observations).toContain('Tool calls: 540');
        expect(outcomes().at(-1)).toMatchObject({ hook: 'pre-compact', outcome: 'wrote' });
      } finally { fs.rmSync(file, { force: true }); }
    }, 120_000);

    it('counts rows that straddle the pieces it reads in', () => {
      const file = path.join(testDir, 'straddle.jsonl');
      writeRows(file, 20, 1024 * 1024 + 4097); // no row ends where a piece of 8 MiB does
      JSON.parse(runHook({ session_id: 'sess-straddle', transcript_path: file, cwd: testDir, trigger: 'auto' }));
      expect(entityRows('pre-compact-sess-straddle').observations).toContain('Tool calls: 20');
    }, 60_000);

    it('counts the rows around a legal line longer than 64 MiB: the long line is skipped, not a read failure, and the count says so (Q6_19 F5, G04 F3)', () => {
      const file = path.join(testDir, 'longline.jsonl');
      writeRows(file, 2, 1024);
      const compacted = JSON.stringify({ type: 'compacted', payload: { message: 'x'.repeat(100 * 1024 * 1024), replacement_history_metadata: [] } });
      fs.appendFileSync(file, `${compacted}\n`); // a Codex compacted record of 100 MiB: legal, and no tool call
      const fd = fs.openSync(file, 'a');
      try { fs.writeSync(fd, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z', name: 'Read', input: {} }] } })}\n`); } finally { fs.closeSync(fd); }
      const output = JSON.parse(runHook({ session_id: 'sess-long', transcript_path: file, cwd: testDir, trigger: 'auto' }));
      expect(entityRows('pre-compact-sess-long').observations).toContain('Tool calls: 3 (1 line(s) over 64 MiB were not read and may hold more)');
      expect(output.systemMessage).toMatch(/^Saved/);
      expect(outcomes().at(-1)).toMatchObject({ hook: 'pre-compact', outcome: 'wrote' });
    }, 60_000);

    it('stops counting at its own time budget and records why (Q6_19 F3): a read slowed past HOOK_BUDGET_MS.preCompact.read', () => {
      const file = path.join(testDir, 'slow.jsonl');
      writeRows(file, 48, 1024 * 1024); // six pieces of 8 MiB
      runHook({ session_id: 'sess-slow', transcript_path: file, cwd: testDir, trigger: 'auto' }); // the private check's verdict is now on disk
      expect(outcomes().at(-1)).toMatchObject({ hook: 'pre-compact', outcome: 'wrote' });
      // Every read of a piece (a buffer of 8 MiB) now takes 1.5 s, past the 6 s the hook gives itself after four of them.
      // The time is taken off a clock the preload moves forward, not waited for: the test does not depend on how fast the
      // machine is, and it takes no real seconds. Only a read of a piece is slowed: a preload that slows every `readSync`
      // slows the hook's own module loading too (about thirty reads, 43 s in all), which spends the hook's budget before
      // it starts, and whether the private check then still answered came down to one millisecond.
      const slow = `data:text/javascript,${encodeURIComponent("import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const real = fs.readSync; const now = Date.now; let skew = 0; Date.now = () => now() + skew; fs.readSync = (...a) => { if (a[1].length >= 4 * 1024 * 1024) skew += 1500; return real(...a); }; syncBuiltinESMExports();")}`;
      const output = JSON.parse(runHook({ session_id: 'sess-slow', transcript_path: file, cwd: testDir, trigger: 'manual' }, { NODE_OPTIONS: `--import=${slow}` }));
      expect(output.systemMessage).toMatch(/could not be read/);
      expect(outcomes().at(-1)).toMatchObject({ hook: 'pre-compact', outcome: 'error', reason: "the transcript could not be read within the hook's time, so its tool calls are not recorded" });
    }, 30_000);

    it('counts the tool calls and the edited files of a Codex rollout (it is not stored as 0 calls)', () => {
      const file = path.join(testDir, 'rollout.jsonl');
      const row = (payload: object) => JSON.stringify({ type: 'response_item', payload });
      fs.writeFileSync(file, [
        row({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }),
        row({ type: 'function_call_output', call_id: 'c1', output: 'ok' }),
        row({ type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'text(1)' }),
        row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f1', status: 'completed', changes: { '/r/src/a.ts': { type: 'update' }, '/r/src/new.ts': { type: 'add' }, '/r/src/old-name.ts': { type: 'update', move_path: '/r/src/renamed.ts' }, '/r/src/gone.ts': { type: 'delete' } } } } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f2', status: 'failed', changes: { '/r/src/failed.ts': { type: 'update' } } } } }),
      ].join('\n') + '\n');
      JSON.parse(runHook({ session_id: 'sess-codex', transcript_path: file, cwd: testDir, trigger: 'auto' }));
      const stored = entityRows('pre-compact-sess-codex');
      expect(stored.observations).toContain('Tool calls: 2');
      expect(stored.observations).toContain('Files edited: a.ts, new.ts, renamed.ts');
    });
  });

  it('Scenario: payload with neither session_id nor transcript -> no entity, no "Saved" claim', () => {
    // `{"foo":1}` used to write a junk entity whose only content was
    // "Compaction reason: auto", answer "Saved 2 observations to MeMesh",
    // and that junk then surfaced in the NEXT session's context as a recent
    // memory. Not-an-event must mean no write and no claim of one.
    const result = runHook({ foo: 1 });
    expect(result.trim(), 'no output — nothing was saved, nothing may claim to be').toBe('');

    // The strongest possible form of "no entity": the database file was
    // never even created, because the hook skipped before touching it.
    expect(fs.existsSync(dbPath), 'no database may be created for a non-event').toBe(false);
  });

  function outcomes(): Array<Record<string, unknown>> {
    const file = path.join(testDir, 'hook-outcomes.jsonl');
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  it('Scenario: #527 no cwd -> skipped and recorded, nothing written (never the hook process\'s own directory)', () => {
    const result = runHook({ session_id: 'sess-nocwd', transcript_path: '', trigger: 'auto' });
    expect(result.trim(), 'nothing was saved, nothing may claim to be').toBe('');
    expect(fs.existsSync(dbPath), 'no database may be created').toBe(false);
    expect(outcomes().at(-1)).toMatchObject({
      hook: 'pre-compact', outcome: 'skipped', reason: 'cwd absent in payload — cannot resolve project',
    });
  });

  it('Scenario: #527 no session_id (transcript present) -> skipped and recorded, no shared pre-compact-unknown memory', () => {
    const transcript = path.join(testDir, 't.jsonl');
    fs.writeFileSync(transcript, '');
    const result = runHook({ transcript_path: transcript, cwd: '/tmp/myproject', trigger: 'auto' });
    expect(result.trim()).toBe('');
    expect(fs.existsSync(dbPath), 'no database may be created').toBe(false);
    expect(outcomes().at(-1)).toMatchObject({
      hook: 'pre-compact', outcome: 'skipped', reason: 'no usable session_id in the payload',
    });
  });

  it.each([
    ['empty session_id', { session_id: '', cwd: '/tmp/myproject' }, 'no usable session_id in the payload'],
    ['blank session_id', { session_id: '   ', cwd: '/tmp/myproject' }, 'no usable session_id in the payload'],
    ['object session_id', { session_id: { a: 1 }, cwd: '/tmp/myproject' }, 'no usable session_id in the payload'],
    ['empty cwd', { session_id: 's1', cwd: '' }, 'cwd absent in payload — cannot resolve project'],
    ['blank cwd', { session_id: 's1', cwd: '  \t' }, 'cwd absent in payload — cannot resolve project'],
    ['object cwd', { session_id: 's1', cwd: { a: 1 } }, 'cwd absent in payload — cannot resolve project'],
  ])('Scenario: #527 %s -> skipped and recorded, no memory written', (_label, payload, reason) => {
    const transcript = path.join(testDir, 't2.jsonl');
    fs.writeFileSync(transcript, '');
    const result = runHook({ transcript_path: transcript, trigger: 'auto', ...payload });
    expect(result.trim()).toBe('');
    expect(fs.existsSync(dbPath), 'no database may be created').toBe(false);
    expect(outcomes().at(-1)).toMatchObject({ hook: 'pre-compact', outcome: 'skipped', reason });
  });

  it('Scenario: a pre-compact memory captured by a Codex hook run names codex as its source host', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-home-'));
    try {
      runHook({
        session_id: 'sess-codex-pc',
        transcript_path: '',
        cwd: '/tmp/myproject',
        hook_event_name: 'PreCompact',
        reason: 'auto',
      }, { CODEX_HOME: codexHome });
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
    const db = openDb();
    const entity = db.prepare('SELECT metadata FROM entities WHERE name = ?').get('pre-compact-sess-codex-pc') as { metadata: string } | undefined;
    db.close();
    expect(entity, 'the Codex run must still capture').toBeTruthy();
    expect(JSON.parse(entity!.metadata).provenance).toEqual({ source_host: 'codex' });
  });

  it('Scenario: Basic pre-compact event -> entity created with correct type and tags', () => {
    const input = {
      session_id: 'sess-abc123',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    const result = runHook(input);
    const parsed = JSON.parse(result.trim());

    // Output must satisfy the real Claude Code contract, not a hand-written
    // shape. PreCompact has no `hookSpecificOutput` variant (#53).
    expectValidHookOutput(result, 'pre-compact output');
    expect(parsed.systemMessage).toContain('MeMesh');

    // Entity created in DB
    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-abc123') as Row;
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('session-summary');

    // Tags present
    const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(entity.id) as Row[]).map((r) => r.tag);
    expect(tags).toContain('source:auto-capture');
    expect(tags).toContain('urgency:pre-compact');
    expect(tags).toContain(`project:${mirrorProjectName('/tmp/myproject')}`);

    // UX-1 title: date + project + what happened, marked heuristic. The raw
    // `pre-compact-<sessionId>` name was the clearest machine-key-as-label
    // case in the audit; the title is what the dashboard shows instead.
    const titled = db.prepare('SELECT title, metadata FROM entities WHERE name = ?')
      .get('pre-compact-sess-abc123') as { title: string | null; metadata: string | null };
    expect(titled.title).toMatch(/^\d{4}-\d{2}-\d{2} .+: auto compaction \(0 tool calls\)$/);
    expect(titled.title).toContain(mirrorProjectName('/tmp/myproject'));
    expect(JSON.parse(titled.metadata as string).title_source).toBe('heuristic');

    db.close();
  });

  it('Scenario: a successful run stamps the hook_runs heartbeat AFTER capture', () => {
    runHook({
      session_id: 'sess-heartbeat',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const db = openDb();
    const run = db.prepare("SELECT hook, run_count FROM hook_runs WHERE hook = 'pre-compact'").get() as
      { hook: string; run_count: number } | undefined;
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get('pre-compact-sess-heartbeat');
    db.close();

    expect(entity, 'capture itself must have happened for the stamp to mean anything').toBeTruthy();
    expect(run, 'a completed capture run must stamp the heartbeat').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: a write that fails WITHOUT throwing leaves no new heartbeat', () => {
    // captureEntity's silent failure mode: a RAISE(IGNORE) trigger swallows
    // the INSERT and it returns null without throwing — the crash test below
    // never reaches this path. The `if (written)` gate on the stamp is what
    // keeps a landed-nothing run from reporting itself alive.
    runHook({
      session_id: 'sess-first',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const setup = new Database(dbPath);
    setup.exec('CREATE TRIGGER block_inserts BEFORE INSERT ON entities BEGIN SELECT RAISE(IGNORE); END;');
    setup.close();

    runHook({
      session_id: 'sess-swallowed',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const db = openDb();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get('pre-compact-sess-swallowed');
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'pre-compact'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(entity, 'precondition: the trigger must actually have swallowed the write').toBeUndefined();
    expect(run!.run_count, 'a run that landed nothing must not stamp on top of the first run').toBe(1);
  });

  it('Scenario: a run that dies mid-capture leaves NO heartbeat', () => {
    // The heartbeat used to be stamped at openHookDb time, which made a hook
    // that opened the database and then crashed in captureEntity read as
    // "auto-capture is alive" in doctor for the next 24 hours — the exact
    // dead-loop-looks-healthy lie the hook_runs table exists to end.
    //
    // Poison the database so the run reaches captureEntity and throws there:
    // an entities table missing the `metadata` column survives openHookDb
    // (SCHEMA_SQL is CREATE IF NOT EXISTS; the migration chain only backfills
    // the columns it knows) and fails on captureEntity's INSERT.
    const poisoned = new Database(dbPath);
    poisoned.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    poisoned.close();

    const stderr = runHookStderr({
      session_id: 'sess-dies-mid-capture',
      transcript_path: '',
      cwd: '/tmp/myproject',
      trigger: 'auto',
    });
    expect(stderr, 'the capture failure must be visible, not swallowed').toContain('metadata');

    const db = openDb();
    const runs = db.prepare('SELECT hook FROM hook_runs').all();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get('pre-compact-sess-dies-mid-capture');
    db.close();

    expect(entity, 'precondition: capture must actually have failed').toBeUndefined();
    expect(runs, 'a crashed capture run must not look alive').toHaveLength(0);
  });

  it('Scenario: trigger (the real Claude Code field) stored as reason observation', () => {
    // Claude Code's PreCompact payload names the field `trigger`, not `reason`.
    // Feeding the REAL field proves the hook reads it; before the fix (which
    // read data.reason) this asserted 'auto' and the manual/auto distinction
    // was silently lost on every compaction.
    const input = {
      session_id: 'sess-manual1',
      transcript_path: '',
      cwd: '/tmp/testproject',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-manual1') as Row;
    expect(entity).toBeTruthy();
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity.id) as { content: string }[];
    const reasonObs = obs.find(o => o.content.startsWith('Compaction reason:'));
    expect(reasonObs?.content).toBe('Compaction reason: manual');
    db.close();
  });

  it('Scenario: Transcript with tool uses -> tool call count stored', () => {
    // Write a minimal transcript JSONL with tool_use blocks
    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/foo.ts' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/tmp/bar.ts' } },
          { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/tmp/baz.ts' } },
        ],
      },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(assistantMsg) + '\n');

    const input = {
      session_id: 'sess-transcript1',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-transcript1') as Row;
    expect(entity).toBeTruthy();
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity.id) as { content: string }[];

    // Tool call count observation
    const toolObs = obs.find(o => o.content.startsWith('Tool calls:'));
    expect(toolObs?.content).toBe('Tool calls: 3');

    // Files edited observation (Edit + Write = 2 unique files)
    const filesObs = obs.find(o => o.content.startsWith('Files edited:'));
    expect(filesObs).toBeTruthy();
    expect(filesObs?.content).toContain('bar.ts');
    expect(filesObs?.content).toContain('baz.ts');

    db.close();
  });

  it('Scenario: MEMESH_AUTO_CAPTURE=false -> exits cleanly, no DB created', () => {
    const input = {
      session_id: 'sess-optout',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input, { MEMESH_AUTO_CAPTURE: 'false' });

    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Missing transcript path -> exits cleanly, entity still created', () => {
    const input = {
      session_id: 'sess-notranscript',
      transcript_path: '/nonexistent/path/transcript.jsonl',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-notranscript') as Row;
    expect(entity).toBeTruthy();
    db.close();
  });

  it('Scenario: Invalid JSON input -> exits cleanly (exit 0)', () => {
    const hookPath = path.resolve('scripts/hooks/pre-compact.js');
    // Must not throw
    execFileSync('node', [hookPath], {
      input: 'not-json-at-all',
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 60000,
    });
    // DB should not exist (errored before db open)
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Duplicate session_id -> no duplicate entities', () => {
    const input = {
      session_id: 'sess-dup',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input);
    runHook(input);

    const db = openDb();
    const entities = db.prepare('SELECT * FROM entities WHERE name = ?').all('pre-compact-sess-dup') as Row[];
    expect(entities).toHaveLength(1);
    db.close();
  });

  it('Scenario: Output JSON satisfies the Claude Code hook-output contract', () => {
    const input = {
      session_id: 'sess-output-check',
      transcript_path: '',
      cwd: '/tmp/someproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    const result = runHook(input);
    expectValidHookOutput(result, 'pre-compact output');

    const parsed = JSON.parse(result.trim());
    expect(typeof parsed.systemMessage).toBe('string');
  });

  // Regression guard for #53. Claude Code has no `hookSpecificOutput` variant
  // for PreCompact, so emitting one fails validation at the root and surfaces
  // an error to the user on every single compaction. The previous version of
  // this test asserted the broken shape, which is why CI stayed green while
  // the bug shipped — assert the absence explicitly so it cannot come back.
  it('Scenario: Output never contains hookSpecificOutput (no PreCompact variant exists)', () => {
    const input = {
      session_id: 'sess-no-hso',
      transcript_path: '',
      cwd: '/tmp/someproject',
      hook_event_name: 'PreCompact',
      reason: 'manual',
    };

    const result = runHook(input);
    const parsed = JSON.parse(result.trim());

    expect(parsed).not.toHaveProperty('hookSpecificOutput');
    expect(HOOK_SPECIFIC_OUTPUT_EVENTS).not.toHaveProperty('PreCompact');
  });

  it('Scenario: says it could not save, rather than announcing a save that failed', () => {
    // `captureEntity` returns null when the entity row cannot be resolved after
    // its INSERT. The message used to print "Saved N insights" regardless, with
    // N derived from the transcript instead of from what was written — a
    // success-shaped report for a save that did not happen, which is the exact
    // class this release exists to remove.
    //
    // Forced with a CHECK constraint: `INSERT OR IGNORE` skips a row that
    // violates one, so the insert is silently dropped and the follow-up SELECT
    // finds nothing — captureEntity's null path, reached without stubbing it.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type <> 'session-summary'),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSON,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    seed.close();

    const result = runHook({
      session_id: 'sess-cannot-save',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const parsed = JSON.parse(result.trim());
    expect(parsed.systemMessage).toContain('could not save');
    expect(parsed.systemMessage).not.toMatch(/^Saved /);
  });
  /**
   * #240, widened. The Stop hook got a duplicate guard in 4.8.2; this hook did
   * not, and it is the one that runs MOST often per session — a session
   * compacts many times. On the maintainer's real graph that produced 2,188
   * duplicate observation rows across 58 `pre-compact-<sessionId>` entities
   * (worst: 220 observations, 2 distinct), and the entity for the session that
   * found the defect was still growing while it was being read.
   *
   * The guard is on CONTENT, not on "this session already has an entity",
   * because a session legitimately compacts more than once — the second test
   * below is the one an existence guard would fail.
   */
  it('Scenario: a second compaction of the same session appends no duplicate observation', () => {
    const input = {
      session_id: 'sess-repeat',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      trigger: 'auto',
    };
    runHook(input);
    runHook(input);
    runHook(input);

    const db = openDb();
    const rows = db.prepare(
      'SELECT o.content AS content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
    ).all('pre-compact-sess-repeat') as Row[];
    const entities = db.prepare('SELECT COUNT(*) AS n FROM entities WHERE name = ?').get('pre-compact-sess-repeat') as { n: number };
    db.close();

    expect(entities.n).toBe(1);
    expect(rows.map((r) => r.content)).toEqual(['Compaction reason: auto', 'Tool calls: 0']);
  });

  it('Scenario: a later compaction that recorded DIFFERENT work is still stored', () => {
    // What a per-session existence guard would have thrown away. The first
    // compaction saw nothing; the second saw a real transcript. Both are true,
    // and only the repeated line is dropped.
    const transcript = path.join(testDir, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/auth.ts' } }] },
    }) + '\n');

    runHook({ session_id: 'sess-grows', transcript_path: '', cwd: '/tmp/myproject', trigger: 'auto' });
    runHook({ session_id: 'sess-grows', transcript_path: transcript, cwd: '/tmp/myproject', trigger: 'manual' });

    const db = openDb();
    const rows = db.prepare(
      'SELECT o.content AS content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
    ).all('pre-compact-sess-grows') as Row[];
    db.close();

    expect(rows.map((r) => r.content)).toEqual([
      'Compaction reason: auto',
      'Tool calls: 0',
      'Compaction reason: manual',
      'Tool calls: 1',
      'Files edited: auth.ts',
    ]);
  });

  it('Scenario: a no-op re-capture does not claim "Saved 2 observations"', () => {
    // The message read `Saved ${obsLines.length}` — the count BUILT, not the
    // count stored. With the dedupe in place that sentence would announce a
    // save on a run that wrote nothing: a success-shaped lie of exactly the
    // kind this hook's own comments exist to prevent.
    const input = {
      session_id: 'sess-message',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      trigger: 'auto',
    };
    const first = JSON.parse(runHook(input).trim());
    expect(first.systemMessage).toBe('Saved 2 observations to MeMesh before compaction');

    const second = JSON.parse(runHook(input).trim());
    expect(second.systemMessage).not.toMatch(/^Saved /);
    expect(second.systemMessage).toContain('already captured');
  });

  it('a legacy `reason` carrying a long credential is redacted before the title is cut (#523)', () => {
    // The title is `<date> <project>: <reason> compaction (…)`, cut at 200
    // characters. A password longer than the cut lost its `@` and stopped
    // matching, so `postgres://reviewer:pppp…` was stored as the title.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-precompact-redact-'));
    try {
      const credential = ['postgres://reviewer', `${'p'.repeat(400)}@db.example/memory`].join(':');
      runHook({
        session_id: 'redact-reason',
        transcript_path: '',
        cwd: projectDir,
        hook_event_name: 'PreCompact',
        reason: credential,
      });
      const db = openDb();
      const entity = db.prepare('SELECT id, title FROM entities WHERE name = ?').get('pre-compact-redact-reason') as Row;
      const observations = (db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity.id) as Row[]).map((r) => r.content);
      db.close();
      expect(entity.title).not.toContain('postgres://reviewer:');
      expect(entity.title).not.toContain('pppp');
      expect(entity.title).toContain('***REDACTED***');
      expect(observations.join('\n')).not.toContain('pppp');
      expect(observations.join('\n')).toContain('***REDACTED***');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
