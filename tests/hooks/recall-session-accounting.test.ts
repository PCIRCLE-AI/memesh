/** Persisted hook accounting; all data and HOME are disposable, never the owner DB. */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { isTriggeredRecord, SKIP_REASONS as CORE_SKIP_REASONS } from '../../src/core/capture-liveness.js';

const require = createRequire(import.meta.url);
const { getProjectName, SKIP_REASONS, writePrivateJsonAtomic } = require('../../scripts/hooks/_shared.js');

describe('session citation-or-fetch accounting persists through actual Stop hooks', () => {
  let home: string;
  let cwd: string;
  let dbPath: string;
  let sessions: string;
  let ids: number[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-session-accounting-'));
    cwd = path.join(home, 'project');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(home, '.memesh'));
    fs.writeFileSync(path.join(home, '.memesh/config.json'), JSON.stringify({ updateCheck: false }));
    dbPath = path.join(home, 'graph.db');
    sessions = path.join(home, 'sessions');
    fs.mkdirSync(sessions);
    const db = openDatabase(dbPath);
    ids = ['first', 'third', 'foreign'].map((name) => {
      const result = db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(name, 'note');
      const id = Number(result.lastInsertRowid);
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'A bounded test memory.');
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, `project:${getProjectName(cwd)}`);
      return id;
    });
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    removeTempDir(home);
  });

  function hook(file: string, payload: object) {
    const result = spawnSync(process.execPath, [path.resolve('scripts/hooks', file)], {
      input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh'), MEMESH_DB_PATH: dbPath,
        MEMESH_AUTO_CAPTURE: undefined, MEMESH_RECIPIENT: '', MEMESH_BRIEFING: 'minimal' },
    });
    expect(result.error, 'the hook process must run before accounting assertions').toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result;
  }

  // Obtain the file through real SessionStart, rather than teaching the
  // harness the implementation's filename algorithm.
  function inject(sessionId: string, entityIds = ids.slice(0, 2)): string {
    hook('session-start.js', { session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' });
    const files = fs.readdirSync(sessions).filter(f => f.endsWith('.json'));
    const file = files.find(f => JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8')).sessionId === sessionId)
      ?? files.find(f => !JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8')).sessionId);
    expect(file, 'real SessionStart must produce the injection fixture').toBeDefined();
    const filename = path.join(sessions, file!);
    fs.writeFileSync(filename, JSON.stringify({ sessionId, injectedAt: new Date().toISOString(),
      project: getProjectName(cwd), entityIds, entityNames: entityIds.map(String),
      injectedContext: entityIds.map(id => `[mem:${id}]`).join('\n') }), { mode: 0o600 });
    return filename;
  }

  function assistant(text: string): object {
    return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  }

  function tool(text: string): object {
    return { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'bounded-tool', content: [{ type: 'text', text }] },
    ] } };
  }

  // The helpers above are bounded Claude variants. Native source shapes are
  // loaded separately below; new marker text is an explicit test variant.
  function stop(sessionId: string | undefined, entries: object[], toolCount = 3, stampRows = true): void {
    const transcriptPath = path.join(home, 'transcript.jsonl');
    const calls = Array.from({ length: toolCount }, (_, i) => ({ type: 'assistant', message: {
      role: 'assistant', content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: '/test/readme' } }],
    } }));
    fs.writeFileSync(transcriptPath, [...calls, ...entries].map(e => JSON.stringify(stampRows ? { timestamp: new Date().toISOString(), ...e } : e)).join('\n'));
    hook('session-summary.js', { session_id: sessionId, transcript_path: transcriptPath, was_in_agentic_loop: true });
  }

  function read<T>(sql: string, ...args: (string | number)[]): T {
    const db = new Database(dbPath, { readOnly: true });
    try { return db.prepare(sql).get(...args) as T; } finally { db.close(); }
  }
  const hits = (id: number) => read<{ n: number }>('SELECT COALESCE(recall_hits, 0) AS n FROM entities WHERE id = ?', id).n;
  const meta = (key: string) => read<{ value: string } | undefined>('SELECT value FROM memesh_metadata WHERE key = ?', key)?.value;

  function doctorCaptureWarning(hookName: string, reason: string): void {
    const result = spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'doctor', '--json'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh'),
        MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: undefined, MEMESH_RECIPIENT: '' },
    });
    expect(result.error, 'the real doctor command must complete').toBeUndefined();
    const report = JSON.parse(result.stdout);
    const check = report.checks.find((row: { id: string }) => row.id === 'capture-liveness');
    expect(check.status, 'accounting failure must be visible through doctor').toBe('warn');
    expect(check.summary).toContain(hookName);
    expect(check.summary).toContain(reason);
    expect(check.summary).toContain('error');
  }

  it.skipIf(process.platform === 'win32')('atomic session writes preserve an existing owner write-only mode', () => {
    const filename = path.join(home, 'write-only-session.json');
    fs.writeFileSync(filename, '{}', { mode: 0o200 });
    fs.chmodSync(filename, 0o200);
    writePrivateJsonAtomic(filename, { sessionId: 'write-only-session' });
    expect(fs.statSync(filename).mode & 0o777).toBe(0o200);
    // Restore only our disposable file's readability to inspect the write.
    fs.chmodSync(filename, 0o600);
    expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual({ sessionId: 'write-only-session' });
  });

  function nativeVariant(host: 'claude' | 'codex', kind: 'assistant' | 'tool' | 'function', text: string): object {
    const entries = fs.readFileSync(path.resolve('tests/fixtures/recall-accounting-native', `${host}.jsonl`), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    if (host === 'claude') {
      const entry = entries.find(row => row.type === (kind === 'assistant' ? 'assistant' : 'user'));
      expect(entry, 'sanitized native sample must contain the intended source shape').toBeDefined();
      const block = entry.message.content[0];
      entry.timestamp = new Date().toISOString();
      if (kind === 'assistant') block.text = text;
      else block.content = text;
      return entry;
    }
    const type = kind === 'assistant' ? 'message' : kind === 'function' ? 'function_call_output' : 'custom_tool_call_output';
    const entry = entries.find(row => row.payload.type === type);
    expect(entry, 'sanitized native sample must contain the intended source shape').toBeDefined();
    entry.timestamp = new Date().toISOString();
    for (const block of kind === 'assistant' ? entry.payload.content : entry.payload.output) block.text = text;
    return entry;
  }

  describe.each(['claude', 'codex'] as const)('%s sanitized native transcript shape', (host) => {
    // Codex samples contain output records, not the preceding call records.
    // Keep that real shape pure; the low-activity accounting requirement is
    // independently pinned below rather than adding fake Claude calls to it.
    const activityCalls = host === 'codex' ? 0 : 3;
    it('credits assistant-authored citations in the native text field', () => {
      inject('native-citation');
      stop('native-citation', [nativeVariant(host, 'assistant', `[mem:${ids[0]}]`)], activityCalls);
      expect.soft(hits(ids[0])).toBe(1);
      expect.soft(meta('citation_sessions_total')).toBe('1');
      expect.soft(meta('citation_sessions_cited')).toBe('1');
    });
    it('credits the explicitly substituted fetch marker in native tool-result text', () => {
      inject('native-fetch');
      stop('native-fetch', [nativeVariant(host, 'tool', `[mem-fetched:${ids[0]}]`)], activityCalls);
      expect.soft(hits(ids[0])).toBe(1);
      expect.soft(meta('citation_sessions_cited')).toBe('1');
    });
    it('does not count ordinary tool-output citation markers as agent-authored', () => {
      inject('native-tool-citation');
      stop('native-tool-citation', [nativeVariant(host, 'tool', `[mem:${ids[0]}]`)], activityCalls);
      expect.soft(hits(ids[0])).toBe(0);
      expect.soft(meta('citation_sessions_total')).toBe('1');
      expect.soft(meta('citation_sessions_cited')).toBe('0');
    });
    it('does not accept the fetch marker from assistant text', () => {
      inject('native-agent-fetch');
      stop('native-agent-fetch', [nativeVariant(host, 'assistant', `[mem-fetched:${ids[0]}]`)], activityCalls);
      expect.soft(hits(ids[0])).toBe(0);
      expect.soft(meta('citation_sessions_cited')).toBe('0');
    });
  });

  it('credits Codex function_call_output as well as custom_tool_call_output', () => {
    inject('native-function');
    stop('native-function', [nativeVariant('codex', 'function', `[mem-fetched:${ids[0]}]`)], 0);
    expect.soft(hits(ids[0])).toBe(1);
    expect.soft(meta('citation_sessions_cited')).toBe('1');
  });

  it('credits fetched injected ids in rounds one and three; repeats/foreign ids earn nothing', () => {
    inject('multi-round');
    const first = tool(`[mem-fetched:${ids[0]}]`);
    stop('multi-round', [first]);
    expect.soft(hits(ids[0]), 'round one fetch must persist a hit').toBe(1);
    stop('multi-round', [first, tool(`[mem-fetched:${ids[0]}] [mem-fetched:${ids[2]}]`)]);
    expect.soft(hits(ids[0]), 'the same id must only count once per session').toBe(1);
    expect.soft(hits(ids[2]), 'un-injected memory must never receive credit').toBe(0);
    stop('multi-round', [first, tool(`[mem-fetched:${ids[1]}]`)]);
    expect.soft(hits(ids[1]), 'round three must still have its injection record').toBe(1);
    expect.soft(meta('citation_sessions_total')).toBe('1');
    expect.soft(meta('citation_sessions_cited')).toBe('1');
  });

  it('keeps the record and counts five Stop events as one session', () => {
    const filename = inject('five-stops');
    for (let n = 0; n < 5; n++) stop('five-stops', [assistant(`[mem:${ids[0]}]`)]);
    expect.soft(hits(ids[0])).toBe(1);
    expect.soft(meta('citation_sessions_total')).toBe('1');
    expect.soft(meta('citation_sessions_cited')).toBe('1');
    expect(fs.existsSync(filename), 'Stop must retain per-session credit state').toBe(true);
  });

  it('selects the exact session among interleaved sessions in the same project', () => {
    const a = inject('session-a', [ids[0]]);
    const b = inject('session-b', [ids[1]]);
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(a, old, old);
    stop('session-a', [assistant(`[mem:${ids[0]}] [mem:${ids[1]}]`)]);
    expect.soft(hits(ids[0]), 'session A must use its own older record').toBe(1);
    expect.soft(hits(ids[1]), 'session A must not spend session B injection').toBe(0);
    stop('session-b', [assistant(`[mem:${ids[1]}]`)]);
    expect.soft(hits(ids[1])).toBe(1);
    expect.soft(meta('citation_sessions_total')).toBe('2');
    expect(fs.existsSync(b)).toBe(true);
  });

  it('credits a session older than an hour and refreshes its record on every Stop', () => {
    const filename = inject('long-session');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(filename, old, old);
    stop('long-session', [assistant(`[mem:${ids[0]}]`)]);
    expect.soft(hits(ids[0]), 'live sessions do not expire after one hour').toBe(1);
    expect.soft(fs.statSync(filename).mtimeMs).toBeGreaterThan(old.getTime());
    const before = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(filename, before, before);
    stop('long-session', [assistant(`[mem:${ids[0]}]`)]);
    expect.soft(fs.statSync(filename).mtimeMs, 'even a Stop with no new credit keeps the session alive').toBeGreaterThan(before.getTime());
  });

  it.each([
    ['plain tool citation', (id: number) => tool(`[mem:${id}]`)],
    ['user citation', (id: number) => ({ type: 'user', message: { role: 'user', content: `[mem:${id}]` } })],
    ['assistant fetch marker', (id: number) => assistant(`[mem-fetched:${id}]`)],
    ['reasoning citation', (id: number) => ({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: `[mem:${id}]` }] } })],
    ['hook echo', (id: number) => ({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [`[mem:${id}]`] } })],
  ])('does not credit %s', (_label, entry) => {
    inject('role-filter');
    stop('role-filter', [entry(ids[0])]);
    expect.soft(hits(ids[0]), 'only assistant text citations or tool-result text fetch markers count').toBe(0);
    expect.soft(meta('citation_sessions_total')).toBe('1');
    expect.soft(meta('citation_sessions_cited')).toBe('0');
  });

  it('accounts a low-tool session without bypassing the capture activity guard', () => {
    inject('short-session');
    stop('short-session', [tool(`[mem-fetched:${ids[0]}]`)], 1);
    expect.soft(hits(ids[0]), 'a single fetch is a valid use even below the capture threshold').toBe(1);
    expect.soft(meta('citation_sessions_total')).toBe('1');
    expect(read<{ n: number }>("SELECT COUNT(*) AS n FROM entities WHERE type = 'session-insight'").n).toBe(0);
    const outcomes = fs.readFileSync(path.join(home, 'hook-outcomes.jsonl'), 'utf8');
    expect(outcomes).toContain(SKIP_REASONS.tooLittleActivity);
  });

  it('uses a new accounting stamp instead of mixing citation-v2 counters', () => {
    const db = new Database(dbPath);
    for (const [key, value] of [['recall_accounting_mode', 'citation-v2 since 2026-09-12'],
      ['citation_sessions_total', '19'], ['citation_sessions_cited', '7']]) {
      db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(key, value);
    }
    db.close();
    inject('new-generation');
    stop('new-generation', [assistant(`[mem:${ids[0]}]`)]);
    expect.soft(meta('recall_accounting_mode')).not.toBe('citation-v2 since 2026-09-12');
    expect.soft(meta('citation_sessions_total')).toBe('1');
    expect.soft(meta('citation_sessions_cited')).toBe('1');
  });

  it('SessionStart binds the persisted injection to the actual payload session id', () => {
    hook('session-start.js', { session_id: 'native-start-session', hook_event_name: 'SessionStart', source: 'startup' });
    const records = fs.readdirSync(sessions).filter(f => f.endsWith('.json')).map(f =>
      JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8')));
    expect(records.length, 'fixture must really inject a seeded memory').toBeGreaterThan(0);
    expect(records.some(record => record.entityIds.includes(ids[0]))).toBe(true);
    expect(records.every(record => record.sessionId === 'native-start-session'), 'PID/timestamp is not the host session identity').toBe(true);
  });

  it('a missing host session id still injects context without inventing an accounting identity', () => {
    const result = hook('session-start.js', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(result.stdout).toContain(`[mem:${ids[0]}]`);
    expect(fs.readdirSync(sessions).filter(f => f.endsWith('.json'))).toEqual([]);
  });

  it('resuming SessionStart merges newly injected ids while retaining previous credit and session counters', () => {
    const db = new Database(dbPath);
    db.prepare('UPDATE tags SET tag = ? WHERE entity_id = ?').run('project:other-project', ids[2]);
    db.close();
    const start = () => hook('session-start.js', { session_id: 'resumed-session', hook_event_name: 'SessionStart', source: 'resume' });
    start();
    const firstRecords = fs.readdirSync(sessions).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8')));
    expect(firstRecords.some(record => record.entityIds.includes(ids[2])), 'new memory must not already be injected').toBe(false);
    stop('resumed-session', [assistant(`[mem:${ids[0]}]`)]);
    expect.soft(hits(ids[0])).toBe(1);
    const updated = new Database(dbPath);
    updated.prepare('UPDATE tags SET tag = ? WHERE entity_id = ?').run(`project:${getProjectName(cwd)}`, ids[2]);
    updated.close();
    start();
    stop('resumed-session', [assistant(`[mem:${ids[0]}] [mem:${ids[2]}]`)]);
    expect.soft(hits(ids[0]), 'resume must preserve already credited ids').toBe(1);
    expect.soft(hits(ids[2]), 'resume must add newly injected ids to the same session').toBe(1);
    expect.soft(meta('citation_sessions_total'), 'resume is not a second session').toBe('1');
    expect.soft(meta('citation_sessions_cited')).toBe('1');
  });

  it('hashes path-shaped session ids without losing their identity or writing outside sessions', () => {
    const sessionId = '../outside-session';
    hook('session-start.js', { session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' });
    const files = fs.readdirSync(sessions).filter(f => f.endsWith('.json'));
    expect(files.length, 'real SessionStart must inject the fixture memory').toBeGreaterThan(0);
    expect.soft(files.every(file => /^[a-f0-9]{64}\.json$/.test(file)), 'session filenames must be hashes').toBe(true);
    stop(sessionId, [assistant(`[mem:${ids[0]}]`)]);
    expect.soft(hits(ids[0]), 'path-shaped host identity must still account normally').toBe(1);
    expect.soft(meta('citation_sessions_total')).toBe('1');
    expect(fs.existsSync(path.join(home, 'outside-session.json')), 'raw SID must not become a path').toBe(false);
  });

  it('R1 cleanup then resume does not replay old transcript credit before the rebuilt injection', () => {
    const filename = inject('expired-resume');
    const oldRow = { ...assistant(`[mem:${ids[0]}]`), timestamp: new Date().toISOString() };
    stop('expired-resume', [oldRow], 0);
    expect.soft(hits(ids[0])).toBe(1);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(filename, stale, stale);
    // Real SessionStart cleanup expires the record, without touching DB state.
    hook('session-start.js', { session_id: 'cleanup-trigger', hook_event_name: 'SessionStart', source: 'startup' });
    expect(fs.existsSync(filename)).toBe(false);
    hook('session-start.js', { session_id: 'expired-resume', hook_event_name: 'SessionStart', source: 'resume' });
    stop('expired-resume', [oldRow], 0);
    expect.soft(hits(ids[0]), 'old transcript citation predates the rebuilt injection').toBe(1);
    expect.soft(meta('citation_sessions_total'), 'stale transcript is not a fresh observed session').toBe('1');
    expect.soft(meta('citation_sessions_cited')).toBe('1');
    const staleOutcomes = fs.readFileSync(path.join(home, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const staleSkip = staleOutcomes.find(row => row.hook === 'session-summary' && row.reason === CORE_SKIP_REASONS.noEligibleRecallRows);
    expect(staleSkip).toMatchObject({ outcome: 'skipped' });
    expect(isTriggeredRecord(staleSkip)).toBe(false);
    expect(staleOutcomes.filter(row => row.hook === 'session-summary' && row.outcome === 'error')).toEqual([]);
    const newRow = { ...tool(`[mem-fetched:${ids[1]}]`), timestamp: new Date().toISOString() };
    stop('expired-resume', [oldRow, newRow], 0);
    expect.soft(hits(ids[0])).toBe(1);
    expect.soft(hits(ids[1]), 'a fetch after the rebuilt injection remains countable').toBe(1);
    // Expiry starts a new accounting window, not permanent state per SID.
    const refetch = { ...tool(`[mem-fetched:${ids[0]}]`), timestamp: new Date().toISOString() };
    stop('expired-resume', [oldRow, newRow, refetch], 0);
    expect.soft(hits(ids[0]), 'a genuinely new fetch can earn credit in the new window').toBe(2);
    expect.soft(meta('citation_sessions_total')).toBe('2');
    expect.soft(meta('citation_sessions_cited')).toBe('2');
  });

  it('R4 persists at most the audit marker prefix rather than complete injected memory text', () => {
    const memory = 'PRIVATE-TEST-MEMORY-' + 'detail '.repeat(8) + '-END';
    const db = new Database(dbPath);
    db.prepare('UPDATE observations SET content = ? WHERE entity_id = ?').run(memory, ids[0]);
    db.close();
    const result = hook('session-start.js', { session_id: 'bounded-record', hook_event_name: 'SessionStart', source: 'startup' });
    expect(result.stdout, 'the fixture must really inject the complete memory').toContain(memory);
    const records = fs.readdirSync(sessions).filter(f => f.endsWith('.json')).map(f => fs.readFileSync(path.join(sessions, f), 'utf8'));
    expect.soft(records.some(record => record.includes(memory)), 'tracking needs ids, not full memory content').toBe(false);
    expect.soft(records.every(record => String(JSON.parse(record).injectedContext || '').length <= 120)).toBe(true);
  });

  it('R5 a global accounting stamp flip never erases this session already credited ids', () => {
    const filename = inject('stamp-flip');
    stop('stamp-flip', [assistant(`[mem:${ids[0]}]`)]);
    expect(hits(ids[0])).toBe(1);
    const db = new Database(dbPath);
    db.prepare('UPDATE memesh_metadata SET value = ? WHERE key = ?').run('citation-v2 since 2026-09-12', 'recall_accounting_mode');
    db.close();
    stop('stamp-flip', [assistant(`[mem:${ids[0]}]`)]);
    expect.soft(hits(ids[0]), 'a global stamp is not authority to forget per-session credit').toBe(1);
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    expect(record.creditedIds).toContain(ids[0]);
    expect(record.sessionCounted).toBe(true);
  });

  it('does not credit rows with absent or invalid timestamps and records the timestamp failure', () => {
    inject('unknown-time');
    stop('unknown-time', [assistant(`[mem:${ids[0]}]`), { ...tool(`[mem-fetched:${ids[1]}]`), timestamp: 'invalid' }], 0, false);
    expect(hits(ids[0])).toBe(0);
    expect(hits(ids[1])).toBe(0);
    expect(meta('citation_sessions_total')).toBeUndefined();
    const records = fs.readFileSync(path.join(home, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const failure = records.find(row => row.hook === 'session-summary' && row.reason === 'recall-accounting: uncaught TranscriptTimestampError');
    expect(failure).toMatchObject({ outcome: 'error' });
    expect(isTriggeredRecord(failure)).toBe(true);
  });

  it('resume retains the earliest injection boundary for still-uncredited prior rows', () => {
    const filename = inject('resume-boundary');
    const before = JSON.parse(fs.readFileSync(filename, 'utf8')).injectedAt;
    const citation = { ...assistant(`[mem:${ids[0]}]`), timestamp: before };
    hook('session-start.js', { session_id: 'resume-boundary', hook_event_name: 'SessionStart', source: 'resume' });
    expect(JSON.parse(fs.readFileSync(filename, 'utf8')).injectedAt).toBe(before);
    stop('resume-boundary', [citation], 0);
    expect(hits(ids[0])).toBe(1);
  });

  it('records missing identities and missing retained records as distinct non-triggered accounting skips', () => {
    hook('session-start.js', { hook_event_name: 'SessionStart', source: 'startup' });
    stop(undefined, [assistant('No accounting identity was supplied.')]);
    stop('missing-record', [assistant('There was no injection for this session.')]);
    const filename = inject('wrong-identity');
    const injection = JSON.parse(fs.readFileSync(filename, 'utf8'));
    fs.writeFileSync(filename, JSON.stringify({ ...injection, sessionId: 'a-different-session' }));
    stop('wrong-identity', [assistant(`[mem:${ids[0]}]`)]);
    expect(hits(ids[0])).toBe(0);
    const records = fs.readFileSync(path.join(home, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    for (const [hookName, reason] of [
      ['session-start', CORE_SKIP_REASONS.noSessionId],
      ['session-summary', CORE_SKIP_REASONS.noSessionId],
      ['session-summary', CORE_SKIP_REASONS.noRecallSessionRecord],
    ]) {
      const skip = records.find(row => row.hook === hookName && row.reason === reason);
      expect(skip, `${hookName}: ${reason}`).toMatchObject({ outcome: 'skipped' });
      expect(isTriggeredRecord(skip)).toBe(false);
    }
    expect(records.filter(row => row.hook === 'session-summary' && row.reason === CORE_SKIP_REASONS.noRecallSessionRecord)).toHaveLength(2);
  });

  it('V1 missing timestamp rows preserve prior 100% counters but repeated failures become visible in doctor', () => {
    inject('timestamp-failure');
    stop('timestamp-failure', [assistant(`[mem:${ids[0]}]`)], 0);
    expect(meta('citation_sessions_total')).toBe('1');
    expect(meta('citation_sessions_cited')).toBe('1');
    for (let n = 0; n < 5; n++) stop('timestamp-failure', [assistant(`[mem:${ids[0]}]`)], 0, false);
    expect(hits(ids[0])).toBe(1);
    expect(meta('citation_sessions_total')).toBe('1');
    expect(meta('citation_sessions_cited')).toBe('1');
    doctorCaptureWarning('session-summary', 'recall-accounting: uncaught TranscriptTimestampError');
  });

  it('V1 a corrupt retained record produces an accounting error visible in doctor', () => {
    const filename = inject('corrupt-record');
    fs.writeFileSync(filename, '{ invalid JSON');
    stop('corrupt-record', [assistant(`[mem:${ids[0]}]`)], 0);
    expect(hits(ids[0])).toBe(0);
    doctorCaptureWarning('session-summary', 'recall-accounting: uncaught SyntaxError');
  });

  it.skipIf(process.platform === 'win32')('V1 a real SessionStart record write failure is visible in doctor', () => {
    const filename = inject('unwritable-record');
    fs.chmodSync(filename, 0o400);
    hook('session-start.js', { session_id: 'unwritable-record', hook_event_name: 'SessionStart', source: 'resume' });
    expect(fs.statSync(filename).mode & 0o777).toBe(0o400);
    doctorCaptureWarning('session-start', 'sessions-write: uncaught Error');
  });
});
