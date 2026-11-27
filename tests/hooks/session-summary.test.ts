import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { createRequire } from 'module';
import { removeTempDir } from '../helpers/temp-dir.js';
import { withoutHostIdentity } from '../helpers/host-env.js';
import { makeWindowsPathsPrivate } from '../../src/core/windows-permissions.js';
import { expectPrivateFile } from '../helpers/permissions.js';

const require = createRequire(import.meta.url);
// Non-git identity = basename + real-path hash (tests/core/project-identity.test.ts).
const { getProjectName: mirrorProjectName, recallSessionPath } = require('../../scripts/hooks/_shared.js');
describe('Stop conversation capture', () => {
  let testDir: string;
  let dbPath: string;
  let transcriptPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-session-summary-test-'));
    dbPath = path.join(testDir, 'test.db');
    transcriptPath = path.join(testDir, 'transcript.jsonl');
  });

  afterEach(() => {
    removeTempDir(testDir);
  });

  function writeTranscript(entries: object[]): void {
    // Older successful-work fixtures omitted both tool IDs and results.
    // Give only those legacy calls explicit successful results. Calls with
    // IDs are kept verbatim, including the failed/missing-result regressions.
    const completed = structuredClone(entries).flatMap((entry, index) => {
      const content = (entry as { message?: { content?: Array<{ type?: string; id?: string }> } }).message?.content;
      if (!Array.isArray(content)) return [entry];
      const results = content.flatMap((block, i) => {
        if (block.type !== 'tool_use' || block.id !== undefined) return [];
        block.id = `legacy-fixture-${index}-${i}`;
        return [{ type: 'tool_result', tool_use_id: block.id, is_error: false, content: 'ok' }];
      });
      return results.length ? [entry, { type: 'user', message: { content: results } }] : [entry];
    });
    fs.writeFileSync(transcriptPath, completed.map(e => JSON.stringify({ timestamp: new Date().toISOString(), ...e })).join('\n'));
  }

  function runHook(input: object, env: Record<string, string> = {}): string {
    const hookPath = path.resolve('scripts/hooks/session-summary.js');
    const jsonInput = JSON.stringify(input);
    try {
      return execFileSync('node', [hookPath], {
        input: jsonInput,
        env: { ...withoutHostIdentity(process.env), MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: undefined, ...env },
        encoding: 'utf8',
        timeout: 60000,
      });
    } catch (err: any) {
      // Hook may exit 0 before reading all stdin — that's OK
      return err.stdout || '';
    }
  }

  // Like runHook but captures stderr regardless of exit code (execFileSync
  // only surfaces stderr when the process throws; the hook exits 0).
  function runHookCapturingStderr(input: object, env: Record<string, string> = {}): { stderr: string } {
    const hookPath = path.resolve('scripts/hooks/session-summary.js');
    const res = spawnSync('node', [hookPath], {
      input: JSON.stringify(input),
      env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: undefined, ...env },
      encoding: 'utf8',
      timeout: 60000,
    });
    return { stderr: res.stderr || '' };
  }

  /** One Edit tool_use per file, the shape every transcript below reuses. */
  function edits(files: string[]) {
    return files.map((f) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/' + f } }] },
    }));
  }

  /** A transcript with enough tool calls to clear the low-signal guard. */
  function writeQualifyingTranscript(): void {
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      ...edits(['parser.ts', 'lexer.ts', 'ast.ts', 'tokens.ts']),
    ]);
  }

  it('Scenario: citation accounting end to end — cited earns a hit, silence earns NOTHING', () => {
    // The whole loop against a real spawned hook: an injected-set record, a
    // transcript whose hook echoes carry `[mem:id]` handles (as every real
    // injection now does), and one explicit citation written by the agent.
    // Three claims are pinned at the database:
    //   1. the cited id is credited a recall_hit;
    //   2. the id that appears ONLY inside the hook echo gets nothing — the
    //      strip ran before the scan (skip it and every injection is a hit,
    //      the exact failure the two pre-2026 accountings shipped);
    //   3. the uncited id's recall_misses stays 0 — misses are FROZEN under
    //      self-reported markers, because silence is not yet evidence.
    const cwd = '/tmp/realproject';
    const projectName = mirrorProjectName(cwd);

    // Schema-complete seeding without duplicating migrations: let the hook
    // itself create the DB once (a plain qualifying capture), then insert
    // the two entities under test.
    writeQualifyingTranscript();
    runHook({ session_id: 'seed-session', transcript_path: transcriptPath, cwd });
    const db = new Database(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('cited-decision', 'decision')").run();
    db.prepare("INSERT INTO entities (name, type) VALUES ('silent-decision', 'decision')").run();
    const citedId = (db.prepare("SELECT id FROM entities WHERE name = 'cited-decision'").get() as { id: number }).id;
    const silentId = (db.prepare("SELECT id FROM entities WHERE name = 'silent-decision'").get() as { id: number }).id;
    db.close();

    // The injected-set record session-start would have written. The hook
    // derives its memesh dir from MEMESH_DB_PATH (env-only — the function
    // ignores arguments), which runHook sets to dbPath; mirror that here.
    const sessionsDir = path.join(path.dirname(dbPath), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const record = recallSessionPath(sessionsDir, 'cite-session', projectName);
    fs.writeFileSync(record, JSON.stringify({
      sessionId: 'cite-session',
      injectedAt: new Date().toISOString(),
      project: projectName,
      entityIds: [citedId, silentId],
      entityNames: ['cited-decision', 'silent-decision'],
      injectedContext: 'unused-by-the-accounting',
    }), { mode: 0o600 });
    if (process.platform === 'win32') makeWindowsPathsPrivate([sessionsDir, record]);

    // A transcript that (a) clears the low-signal guard, (b) carries the
    // silent entity's handle INSIDE a hook echo only, (c) cites the other.
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context', hookName: 'SessionStart',
          content: [`- [decision] silent thing [mem:${silentId}]\n- [decision] cited thing [mem:${citedId}]`],
        },
      },
      ...['parser.ts', 'lexer.ts', 'ast.ts', 'tokens.ts'].map((f) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/' + f } }] },
      })),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `per [mem:${citedId}] we keep the parser split` }] } },
    ]);

    runHook({ session_id: 'cite-session', transcript_path: transcriptPath, cwd });
    expectPrivateFile(record);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toMatchObject({ creditedIds: [citedId], sessionCounted: true });

    const check = new Database(dbPath, { readOnly: true });
    try {
      const row = (name: string) => check.prepare(
        'SELECT COALESCE(recall_hits, 0) AS hits, COALESCE(recall_misses, 0) AS misses FROM entities WHERE name = ?'
      ).get(name) as { hits: number; misses: number };
      expect(row('cited-decision')).toEqual({ hits: 1, misses: 0 });
      expect(row('silent-decision')).toEqual({ hits: 0, misses: 0 });

      const meta = (key: string) => (check.prepare(
        'SELECT value FROM memesh_metadata WHERE key = ?'
      ).get(key) as { value: string } | undefined)?.value;
      // The current era counts assistant citations or tool-result fetch markers
      // for this exact session's injected set.
      expect(meta('recall_accounting_mode')).toContain('citation-or-fetch-v3');
      expect(meta('citation_sessions_total')).toBe('1');
      expect(meta('citation_sessions_cited')).toBe('1');
    } finally {
      check.close();
    }
  });

  it('Scenario: a graph that counted under the previous accounting era starts the new one from zero', () => {
    // The stamp says which question the counters answer. The current era
    // credits assistant citations or tool fetches for this session's injected
    // ids. Carrying old totals forward would mix different measurements
    // under one label, so the change of stamp
    // resets the pair, and the discarded numbers go to stderr rather than
    // disappearing.
    const cwd = '/tmp/erachange';
    const projectName = mirrorProjectName(cwd);
    writeQualifyingTranscript();
    runHook({ session_id: 'seed-session', transcript_path: transcriptPath, cwd });

    const db = new Database(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('era-decision', 'decision')").run();
    const citedId = (db.prepare("SELECT id FROM entities WHERE name = 'era-decision'").get() as { id: number }).id;
    const put = db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
    put.run('recall_accounting_mode', 'citation-v1 since 2026-08-16');
    put.run('citation_sessions_total', '412');
    put.run('citation_sessions_cited', '37');
    db.close();

    const sessionsDir = path.join(path.dirname(dbPath), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const record = recallSessionPath(sessionsDir, 'era-session', projectName);
    fs.writeFileSync(record, JSON.stringify({
      sessionId: 'era-session',
      injectedAt: new Date().toISOString(),
      project: projectName,
      entityIds: [citedId],
      entityNames: ['era-decision'],
      injectedContext: 'unused-by-the-accounting',
    }));
    if (process.platform === 'win32') makeWindowsPathsPrivate([sessionsDir, record]);
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      ...['parser.ts', 'lexer.ts', 'ast.ts', 'tokens.ts'].map((f) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/' + f } }] },
      })),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `per [mem:${citedId}] we keep the split` }] } },
    ]);

    const { stderr } = runHookCapturingStderr({ session_id: 'era-session', transcript_path: transcriptPath, cwd });

    const check = new Database(dbPath, { readOnly: true });
    try {
      const meta = (key: string) => (check.prepare(
        'SELECT value FROM memesh_metadata WHERE key = ?'
      ).get(key) as { value: string } | undefined)?.value;
      expect(meta('recall_accounting_mode')).toBe('citation-or-fetch-v3 since 2026-11-01');
      // 1 and 1, not 413 and 38: this session is the whole current-era record so far.
      expect(meta('citation_sessions_total'), 'old totals were carried into the current era').toBe('1');
      expect(meta('citation_sessions_cited')).toBe('1');
      // The reset left a record of what it discarded.
      expect(stderr).toContain('citation accounting generation changed');
      expect(stderr).toContain('total=412');
      expect(stderr).toContain('cited=37');
    } finally {
      check.close();
    }

    // Idempotent: a second session in the SAME era keeps counting. It needs
    // its own SID-bound injected-set record; Stop retains the first session.
    const secondRecord = recallSessionPath(sessionsDir, 'era-session-2', projectName);
    fs.writeFileSync(secondRecord, JSON.stringify({
      sessionId: 'era-session-2',
      injectedAt: new Date().toISOString(),
      project: projectName,
      entityIds: [citedId],
      entityNames: ['era-decision'],
      injectedContext: 'unused-by-the-accounting',
    }));
    if (process.platform === 'win32') makeWindowsPathsPrivate([secondRecord]);
    // These are this second synthetic session's events, after its injection.
    writeTranscript(fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').map(line => {
      const entry = JSON.parse(line);
      delete entry.timestamp;
      return entry;
    }));
    runHook({ session_id: 'era-session-2', transcript_path: transcriptPath, cwd });
    const again = new Database(dbPath, { readOnly: true });
    try {
      expect((again.prepare(
        "SELECT value FROM memesh_metadata WHERE key = 'citation_sessions_total'"
      ).get() as { value: string }).value, 'the reset fired again inside one era').toBe('2');
    } finally {
      again.close();
    }
  });

  it('Scenario: the hook does not load sqlite-vec — it has never used it', () => {
    // Not a style rule. This hook runs two statements, neither of them a
    // vector query, and `captureEntity` touches no vectors either — but it
    // used to load sqlite-vec anyway, "for embedding-aware recall-effectiveness
    // tracking" that does not exist. sqlite-vec ships its engine as a
    // per-platform file, so on a platform it does not publish that load threw
    // and took the ENTIRE Stop capture with it. Measured: 0 entities against a
    // control run's 1, plus a `Require stack:` dump on stderr.
    //
    // A behavioural test would have to hide a package from node_modules, which
    // is global state in a serial suite. This asserts the thing that actually
    // regressed: the dependency coming back.
    // Comments stripped first: the invariant is about CODE. The block above
    // this test's subject explains the removal and names the very calls being
    // banned, and a naive match on the raw file flags that prose.
    const code = fs.readFileSync(path.resolve('scripts/hooks/session-summary.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'session-summary reached for sqlite-vec again').not.toMatch(/require\(['"`]sqlite-vec/);
    expect(code).not.toMatch(/sqliteVec\.load/);
    expect(code).not.toMatch(/enableLoadExtension/);
    // Anti-vacuity: the stripper must not have eaten the whole file.
    expect(code).toContain('openHookDb');
  });

  it('Scenario: no cwd in the payload -> nothing captured, and the reason is traced', () => {
    // `cwd` decides the project tag, and the project tag decides which sessions
    // session-start injects and which memories pre-edit-recall surfaces. The
    // old fallback to `process.cwd()` — the hook process's launch directory,
    // unspecified for a Stop hook — filed the session under whatever happened
    // to be current. Measured: a payload with no cwd tagged the whole session
    // `project:memesh-llm-memory`, leaking one project's files, commands and
    // errors into another project's context.
    writeQualifyingTranscript();
    const { stderr } = runHookCapturingStderr({
      session_id: 'no-cwd-session',
      transcript_path: transcriptPath,
    });
    expect(stderr).toContain('cwd absent');
    expect(fs.existsSync(dbPath), 'a session was filed under a guessed project').toBe(false);
  });

  it('Scenario: a payload WITH cwd still captures (the guard is not a blanket refusal)', () => {
    writeQualifyingTranscript();
    runHook({ last_assistant_message: 'Raw assistant reply', session_id: 'with-cwd-session', transcript_path: transcriptPath, cwd: '/tmp/realproject' });
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readOnly: true });
    try {
      const names = (db.prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map((r) => r.name);
      expect(names.length).toBeGreaterThanOrEqual(1);
      const tags = (db.prepare('SELECT DISTINCT tag FROM tags').all() as Array<{ tag: string }>).map((r) => r.tag);
      expect(tags).toContain(`project:${mirrorProjectName('/tmp/realproject')}`);
      // The provenance marker, asserted against the DATABASE rather than the
      // source text. `tests/auto-capture-provenance.test.ts` greps for the
      // constant, which the import line alone satisfies — mutation-verified:
      // dropping AUTO_CAPTURE_TAG from this hook's baseTags left that test and
      // all 19 hook files green. This is what `memesh doctor` counts to answer
      // "is the auto-capture loop alive"; without it this hook's captures stop
      // being counted and the row stays green on the other three writers.
      expect(tags, 'session-summary stopped marking what it writes as auto-captured')
        .toContain('source:auto-capture');
    } finally {
      db.close();
    }
  });

  it('Scenario: an unreadable transcript traces to stderr instead of silently emptying capture', () => {
    // A directory at the transcript path makes readFileSync throw EISDIR
    // (not ENOENT) — stands in for a permission/IO fault on a real file.
    const dirAsTranscript = path.join(testDir, 'transcript-is-a-dir');
    fs.mkdirSync(dirAsTranscript);
    const { stderr } = runHookCapturingStderr({
      session_id: 'test-unreadable',
      transcript_path: dirAsTranscript,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
    });
    expect(stderr).toContain('[memesh session-summary]');
    expect(stderr).toContain('unreadable');
  });

  it('Scenario: a MISSING transcript does not emit the unreadable trace (normal case)', () => {
    const { stderr } = runHookCapturingStderr({
      session_id: 'test-missing',
      transcript_path: path.join(testDir, 'never-created.jsonl'),
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
    });
    expect(stderr).not.toContain('unreadable');
  });

  function openDb(): Database {
    return new Database(dbPath, { readOnly: true });
  }

  it('Scenario: Non-agentic session is skipped (explicit was_in_agentic_loop: false)', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
    ]);

    runHook({
      session_id: 'test-sess-003',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: false,
    });

    // Nothing captured — but the bail is a CORRECT decision on a well-formed
    // payload, so it stamps the heartbeat: a user whose sessions are
    // consistently non-agentic must not read as "capture has stopped".
    const db = openDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number };
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(count.c).toBe(0);
    expect(run, 'a correct non-agentic bail must stamp the heartbeat').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: a transcript that VANISHED after the payload named it still stamps', () => {
    // Log-rotation race: the payload carried transcript_path but the file is
    // gone by the time the hook runs. The hook itself worked correctly —
    // this must stamp, unlike the schema-flip bail where the FIELD is
    // absent (no-cwd test pins that side: DB never even created).
    runHook({
      session_id: 'vanished-transcript',
      transcript_path: path.join(testDir, 'rotated-away.jsonl'),
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(run, 'a vanished transcript is a correct nothing-to-do decision').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))('Scenario: an UNREADABLE transcript leaves no heartbeat — capture was lost, not skipped', () => {
    // An I/O failure reading the only source of assistant text leaves no heartbeat.
    // Root reads through chmod 000; Windows maps it differently — same
    // skip guard as tests/hooks/session-start-unwritable.test.ts.
    writeQualifyingTranscript();
    fs.chmodSync(transcriptPath, 0o000);
    try {
      const { stderr } = runHookCapturingStderr({
        session_id: 'unreadable-session',
        transcript_path: transcriptPath,
        cwd: '/tmp/myproject',
        was_in_agentic_loop: true,
      });
      expect(stderr).toContain('unreadable');
      expect(fs.existsSync(dbPath), 'a lost capture must not create a DB just to stamp itself alive').toBe(false);
    } finally {
      fs.chmodSync(transcriptPath, 0o644);
    }
  });

  it('a well-formed Stop without assistant text still stamps the heartbeat', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);

    runHook({
      session_id: 'light-session',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number };
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(count.c, 'the transcript contains no assistant reply').toBe(0);
    expect(run, 'a correct nothing-to-do decision must stamp the heartbeat').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: a run that dies mid-capture leaves NO heartbeat', () => {
    // An entities table missing the `metadata` column survives openHookDb
    // (CREATE IF NOT EXISTS) and makes captureEntity throw; the outer catch
    // exits without reaching the end-of-run stamp. A crashed capture must
    // not look alive to doctor.
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

    writeQualifyingTranscript();
    runHook({
      session_id: 'poisoned-session',
      last_assistant_message: 'This write must fail',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number };
    const runs = db.prepare("SELECT hook FROM hook_runs WHERE hook = 'session-summary'").all();
    db.close();
    expect(count.c, 'precondition: capture must actually have failed').toBe(0);
    expect(runs, 'a crashed capture run must not look alive').toHaveLength(0);
  });

  it('a silently refused INSERT leaves no new heartbeat', () => {
    // A RAISE(IGNORE) trigger swallows the INSERT, so the conversation writer
    // must detect the missing row before recording a heartbeat.
    writeQualifyingTranscript();
    runHook({
      session_id: 'first-session',
      last_assistant_message: 'This write should succeed',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const setup = new Database(dbPath);
    setup.exec('CREATE TRIGGER block_inserts BEFORE INSERT ON entities BEGIN SELECT RAISE(IGNORE); END;');
    setup.close();

    runHook({
      session_id: 'swallowed-session',
      last_assistant_message: 'This write should fail',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const entity = db.prepare("SELECT id FROM observations WHERE content = ?").get('This write should fail');
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(entity, 'precondition: the trigger must actually have swallowed the write').toBeUndefined();
    expect(run!.run_count, 'a run that landed nothing must not stamp on top of the first run').toBe(1);
  });

  it('Scenario: Auto-capture opt-out skips processing', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'All passed' }] } },
    ]);

    runHook(
      {
        session_id: 'test-sess-005',
        last_assistant_message: 'This reply must stay out of the graph',
        transcript_path: transcriptPath,
        cwd: '/tmp/myproject',
        stop_reason: 'end_turn',
        was_in_agentic_loop: true,
      },
      { MEMESH_AUTO_CAPTURE: 'false' },
    );

    if (fs.existsSync(dbPath)) {
      const db = openDb();
      const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as any;
      expect(count.c).toBe(0);
      db.close();
    }
  });

});
