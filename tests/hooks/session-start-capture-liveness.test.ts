import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  serializeHookOutcome,
  HOOK_OUTCOMES_FILENAME,
  HOOK_OUTCOMES_PER_HOOK,
  SILENT_HOOK_MIN_RUNS,
  SKIP_REASONS,
  type HookOutcomeRecord,
} from '../../src/core/capture-liveness.js';

/**
 * The one SessionStart sentence when capture has gone quiet (#327).
 *
 * It exists because a user should not need to run a sqlite query to notice
 * that nothing has been saved for two days. It must therefore appear — and,
 * just as importantly, must NOT appear when it would be noise: not more than
 * once a day, not in the first sessions after an install or an upgrade (when
 * a run of skips is expected), and not at all once a write lands.
 */
describe('SessionStart capture-liveness line', () => {
  let testDir: string;
  let memeshDir: string;
  let dbPath: string;
  const GRACE_FILE = 'capture-liveness-grace.json';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ss-liveness-'));
    memeshDir = path.join(testDir, 'memesh');
    fs.mkdirSync(memeshDir);
    dbPath = path.join(memeshDir, 'knowledge-graph.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function writeRecords(records: HookOutcomeRecord[]): void {
    fs.writeFileSync(
      path.join(memeshDir, HOOK_OUTCOMES_FILENAME),
      records.map(serializeHookOutcome).join(''),
    );
  }

  function silentPostCommit(n: number): HookOutcomeRecord[] {
    return Array.from({ length: n }, (_, i) => ({
      hook: 'post-commit', at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`,
      host: 'claude-code' as const, outcome: 'skipped' as const,
      reason: SKIP_REASONS.commitLineMissing,
    }));
  }

  /**
   * Past the grace: the counter says this install has been seen for four
   * sessions, starting well over 24h ago. Written directly because driving
   * four real sessions would test the counter's arithmetic, not the line.
   */
  function graceExpired(version = 'test-version'): void {
    fs.writeFileSync(path.join(memeshDir, GRACE_FILE), JSON.stringify({
      version,
      firstSeenAt: new Date(Date.now() - 72 * 3600_000).toISOString(),
      sessions: 4,
    }));
  }

  function runHook(envOverrides: Record<string, string> = {}): { out: Record<string, unknown>; ms: number } {
    const started = Date.now();
    const result = execFileSync('node', [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ session_id: 'ss-1', cwd: testDir }),
      env: { ...process.env, MEMESH_DIR: memeshDir, MEMESH_DB_PATH: dbPath, HOME: testDir, ...envOverrides },
      encoding: 'utf8',
      timeout: 20000,
    });
    return { out: JSON.parse(result.trim()), ms: Date.now() - started };
  }

  function systemMessage(): string {
    return String(runHook().out.systemMessage ?? '');
  }

  /** The version the grace counter keys on, as the hook resolves it. */
  function installedVersion(): string {
    return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  }

  it('says one line when a hook ran and wrote nothing', () => {
    writeRecords(silentPostCommit(SILENT_HOOK_MIN_RUNS + 3));
    graceExpired(installedVersion());
    const message = systemMessage();
    expect(message).toContain('memesh: post-commit ran');
    expect(message).toContain('wrote nothing');
    expect(message).toContain('memesh doctor');
    // ONE line. A banner that grows is a banner that gets ignored.
    expect(message.split('\n').filter((l) => l.includes('wrote nothing'))).toHaveLength(1);
    // "since" is the FIRST run in the window, not the latest one: the
    // records span 09-01..09-08, and "8 times since 09-08" would be false.
    expect(message).toContain(`ran ${SILENT_HOOK_MIN_RUNS + 3} times since 2026-09-01`);
  });

  it('stays quiet on a default install where hooks skip by design', () => {
    // guard-check skips every Bash call no guard matches and post-commit
    // ignores every non-commit — the ordinary state, which must not produce
    // a daily banner.
    const at = (i: number) => `2026-09-0${(i % 9) + 1}T00:00:00.000Z`;
    const many = (hook: string, reason: string): HookOutcomeRecord[] =>
      Array.from({ length: 20 }, (_, i) => ({ hook, at: at(i), host: 'claude-code' as const, outcome: 'skipped' as const, reason }));
    writeRecords([
      ...many('guard-check', 'no active guard matched this command'),
      ...many('post-commit', SKIP_REASONS.notGitCommit),
      { hook: 'session-summary', at: at(3), host: 'claude-code', outcome: 'wrote', entity: 'session-s1-summary' },
    ]);
    graceExpired(installedVersion());
    expect(systemMessage()).not.toContain('wrote nothing');
  });

  it('is throttled to once a day', () => {
    writeRecords(silentPostCommit(SILENT_HOOK_MIN_RUNS + 3));
    graceExpired(installedVersion());
    expect(systemMessage()).toContain('wrote nothing');
    expect(systemMessage(), 'the second session the same day must stay quiet').not.toContain('wrote nothing');

    // Age the throttle marker past 24h and it speaks again.
    const marker = path.join(memeshDir, 'last-capture-liveness-notice.lock');
    const old = Date.now() - 25 * 3600_000;
    fs.utimesSync(marker, new Date(old), new Date(old));
    expect(systemMessage()).toContain('wrote nothing');
  });

  it('disappears after the next successful write, with no marker to clear', () => {
    writeRecords([
      ...silentPostCommit(SILENT_HOOK_MIN_RUNS + 3),
      { hook: 'post-commit', at: '2026-09-10T00:00:00.000Z', host: 'claude-code', outcome: 'wrote', entity: 'commit-abc1234' },
    ]);
    graceExpired(installedVersion());
    expect(systemMessage()).not.toContain('wrote nothing');
  });

  it('stays quiet through the post-install grace, and counts the sessions itself', () => {
    writeRecords(silentPostCommit(SILENT_HOOK_MIN_RUNS + 3));
    // No grace file: this is a first session on this version.
    expect(systemMessage(), 'a fresh install has no history to be alarmed about').not.toContain('wrote nothing');
    const state = JSON.parse(fs.readFileSync(path.join(memeshDir, GRACE_FILE), 'utf8'));
    expect(state.sessions).toBe(1);
    expect(state.version).toBe(installedVersion());
    // Still inside 24h, so more sessions do not end the grace either.
    expect(systemMessage()).not.toContain('wrote nothing');
    expect(systemMessage()).not.toContain('wrote nothing');
    expect(systemMessage()).not.toContain('wrote nothing');
  });

  it('a version change restarts the grace — an upgrade replaces the hooks', () => {
    writeRecords(silentPostCommit(SILENT_HOOK_MIN_RUNS + 3));
    graceExpired('some-older-version');
    expect(systemMessage(), 'the first session after an upgrade must not accuse it').not.toContain('wrote nothing');
    const state = JSON.parse(fs.readFileSync(path.join(memeshDir, GRACE_FILE), 'utf8'));
    expect(state.version).toBe(installedVersion());
    expect(state.sessions).toBe(1);
  });

  it('stays well inside its 10s budget with a full history present', () => {
    // A full file is the worst case the hook can meet, and this line is not
    // worth a slow session start. The SessionStart hook's declared timeout
    // is 10s; a full history must not come close to it.
    writeRecords(silentPostCommit(HOOK_OUTCOMES_PER_HOOK * 10));
    graceExpired(installedVersion());
    const { out, ms } = runHook();
    expect(String(out.systemMessage ?? '')).toContain('wrote nothing');
    expect(ms, `session-start took ${ms}ms with a full outcome history`).toBeLessThan(5000);
  });

  it('reads the JSONL and never the database', () => {
    // A banner line is not worth a query against a graph that may be
    // mid-write, so the hook must reach its verdict with no database at all.
    writeRecords(silentPostCommit(SILENT_HOOK_MIN_RUNS + 3));
    graceExpired(installedVersion());
    expect(fs.existsSync(dbPath), 'this case is only meaningful with no database').toBe(false);
    expect(systemMessage()).toContain('wrote nothing');
  });

  it('reads the outcome file beside the database, not MEMESH_DIR, when the two differ', () => {
    // recordHookOutcome writes beside the database (dirname(MEMESH_DB_PATH));
    // the banner must read from the SAME place or it silently reads nothing
    // when MEMESH_DB_PATH points away from MEMESH_DIR — the split that the
    // "banner and report can never disagree" promise exists to close.
    const dbDir = path.join(testDir, 'elsewhere');
    fs.mkdirSync(dbDir, { recursive: true });
    const remoteDb = path.join(dbDir, 'knowledge-graph.db');
    // The writer's behaviour: outcomes + grace land beside the DB path.
    fs.writeFileSync(
      path.join(dbDir, HOOK_OUTCOMES_FILENAME),
      silentPostCommit(SILENT_HOOK_MIN_RUNS + 3).map(serializeHookOutcome).join(''),
    );
    fs.writeFileSync(path.join(dbDir, GRACE_FILE), JSON.stringify({
      version: installedVersion(),
      firstSeenAt: new Date(Date.now() - 72 * 3600_000).toISOString(),
      sessions: 4,
    }));
    const message = String(runHook({ MEMESH_DB_PATH: remoteDb }).out.systemMessage ?? '');
    expect(message).toContain('wrote nothing');
  });

  it('shows the warning on the populated-database path too', () => {
    writeRecords(silentPostCommit(SILENT_HOOK_MIN_RUNS + 3));
    graceExpired(installedVersion());
    execFileSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'remember', 'an existing memory'], {
      cwd: testDir,
      env: { ...process.env, MEMESH_DIR: memeshDir, MEMESH_DB_PATH: dbPath, HOME: testDir },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(fs.existsSync(dbPath), 'the populated-path case must have an entities database').toBe(true);
    expect(systemMessage()).toContain('wrote nothing');
  });
});
