/**
 * G1 wired end to end on the HOOK side, against spawned real hooks:
 *
 *   - guard-check.js (PreToolUse Bash): an accepted guard fires on a
 *     matching command — fenced warning with the lesson's `[mem:id]`
 *     handle, fire counted in metadata — and stays silent otherwise.
 *   - pre-edit-recall.js (PreToolUse Edit|Write): the same store serves
 *     Edit guards, and the guard half is NOT throttled — the recall
 *     throttle must never mute a warning about a dangerous edit.
 *
 * Contract order matters: every failure path is a silent pass. A guard
 * system that can break the user's Bash tool is worse than no guards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Feature: lesson guards at the PreToolUse hooks', () => {
  let tmpHome: string;
  let dbPath: string;
  let db: any;
  let kg: any;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-guard-hook-'));
    dbPath = path.join(tmpHome, 'graph.db');
    process.env.MEMESH_DB_PATH = dbPath;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(dbPath);
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    kg = new KnowledgeGraph(db);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedGuardedLesson(guard: Record<string, unknown>, name = 'guarded-lesson'): number {
    return kg.createEntity(name, 'lesson_learned', {
      observations: ['Error: it happened', 'Fix: do not'],
      tags: ['project:memesh'],
      metadata: { guard },
    });
  }

  function runHook(script: string, input: object): { stdout: string; stderr: string } {
    const hookPath = path.resolve(`scripts/hooks/${script}`);
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify({ cwd: tmpHome, ...input }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (result.error) throw result.error;
    expect(result.status, `hook exited ${result.status}\nstderr:\n${result.stderr}`).toBe(0);
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }

  const bashGuard = {
    enabled: true,
    action: 'warn',
    tool: 'Bash',
    pattern: 'git\\s+checkout\\s+--\\s',
    message: 'git checkout -- discards uncommitted work. Commit or stash first.',
    fires: 0,
  };

  it('a matching Bash command gets the fenced warning with the citation handle, and the fire is counted', () => {
    const lessonId = seedGuardedLesson(bashGuard);

    const { stdout, stderr } = runHook('guard-check.js', {
      tool_name: 'Bash',
      tool_input: { command: 'git checkout -- src/core/' },
    });
    expect(stderr).toBe('');
    const out = JSON.parse(stdout);
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('discards uncommitted work');
    expect(ctx).toContain(`[mem:${lessonId}]`);
    // Memory content rides the reference fence like every injection path.
    expect(ctx).toContain('background data');

    const meta = JSON.parse(db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata);
    expect(meta.guard.fires).toBe(1);
    expect(typeof meta.guard.last_fired_at).toBe('string');
  });

  it('a non-matching command, a disabled guard, and a wrong-tool guard are all silence', () => {
    seedGuardedLesson(bashGuard, 'g-armed');
    seedGuardedLesson({ ...bashGuard, enabled: false, pattern: 'rm\\s+-rf\\s' }, 'g-disabled');
    seedGuardedLesson({ ...bashGuard, tool: 'Edit', pattern: 'checkout' }, 'g-edit-only');

    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'git status' } }).stdout).toBe('');
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }).stdout).toBe('');
    // 'checkout' appears in the command, but that guard is Edit-scoped.
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'echo checkout' } }).stdout).toBe('');
  });

  it('no database, no command, garbage input — all silent passes', async () => {
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: {} }).stdout).toBe('');
    // Close our own handle before deleting: Windows locks open files, so
    // rmSync on a database this test still holds open throws EBUSY there
    // (and only there — Linux/macOS happily unlink open files).
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(dbPath, { force: true });
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'git checkout -- x' } }).stdout).toBe('');
  });

  it('an Edit guard still fires when the recall half cannot read observations, and the run is recorded as an error', () => {
    // The guard is evaluated before recall and is the more important half:
    // a fault while looking up memories must not take the warning with it,
    // and must not be recorded as a healthy run either.
    seedGuardedLesson({
      ...bashGuard,
      tool: 'Edit',
      pattern: 'password\\s*=\\s*["\']',
    }, 'no-hardcoded-secrets');
    db.exec('ALTER TABLE observations RENAME TO observations_gone');

    const { stdout, stderr } = runHook('pre-edit-recall.js', {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/config.ts', new_string: 'const password = "hunter2"' },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('A guard you accepted');
    expect(stderr).toContain('observations');

    const lines = fs.readFileSync(path.join(tmpHome, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.hook).toBe('pre-edit-recall');
    expect(last.outcome).toBe('error');
  });

  // Well above what one contended 2 s wait really costs on a slow runner,
  // well below the 30 s a connection waits when the hook budget is not applied.
  const LOCKED_RUN_TIMEOUT_MS = 12000;

  it.each([
    ['a healthy database', false],
    ['observations unreadable', true],
  ])('the Edit guard warning is on stdout before the fire counter is written, so a held write lock cannot cost it (%s)', (_label, breakObservations) => {
    seedGuardedLesson({
      ...bashGuard,
      tool: 'Edit',
      pattern: 'password\\s*=\\s*["\']',
    }, 'no-hardcoded-secrets');
    if (breakObservations) db.exec('ALTER TABLE observations RENAME TO observations_gone');

    // Another writer holds the lock for the whole run. The counter update
    // waits on it — for the hook's own short budget, not the database's
    // default 30 s, so the process ends by itself instead of being killed by
    // its host, and says on stderr that the fire was not counted.
    //
    // The spawn timeout below separates those two waits and nothing finer.
    // What a contended 2 s busy_timeout wait costs in wall-clock time is not
    // portable: the macOS CI runners start this hook in about 0.1 s and then
    // spend close to 4 s in the wait (tests/hooks/hook-time-budgets.test.ts
    // records the same premium), so a limit near the nominal figure fails on
    // the machine, not on the code. With the 30 s default the run is still
    // killed here, and is red.
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = spawnSync('node', [path.resolve('scripts/hooks/pre-edit-recall.js')], {
        input: JSON.stringify({
          cwd: tmpHome,
          tool_name: 'Edit',
          tool_input: { file_path: '/repo/src/config.ts', new_string: 'const password = "hunter2"' },
        }),
        env: { ...process.env, MEMESH_DB_PATH: dbPath },
        encoding: 'utf8',
        timeout: LOCKED_RUN_TIMEOUT_MS,
      });
    } finally {
      db.exec('ROLLBACK');
    }
    expect(result.stdout).toContain('A guard you accepted');
    expect(result.signal, 'the hook was killed at the timeout instead of finishing').toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[memesh guard-fires] not counted');
  }, 20000);

  it('the Bash guard warning survives a held write lock too: the counter gives up within the hook budget', () => {
    seedGuardedLesson(bashGuard);
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = spawnSync('node', [path.resolve('scripts/hooks/guard-check.js')], {
        input: JSON.stringify({ cwd: tmpHome, tool_name: 'Bash', tool_input: { command: 'git checkout -- src/app.ts' } }),
        env: { ...process.env, MEMESH_DB_PATH: dbPath },
        encoding: 'utf8',
        timeout: LOCKED_RUN_TIMEOUT_MS,
      });
    } finally {
      db.exec('ROLLBACK');
    }
    expect(result.stdout).toContain('A guard you accepted');
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[memesh guard-fires] not counted');
    // guard-check counts first and prints after; what saves the warning here
    // is the counter's bounded wait, shared with pre-edit-recall.
    const lines = fs.readFileSync(path.join(tmpHome, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).outcome).toBe('notified');
  }, 20000);

  // POSIX only: there a pipe write is asynchronous, so whatever does not fit
  // the pipe waits for the event loop — which the counter's lock wait blocks.
  // (On Windows Node makes a piped stdout synchronous, so the case cannot
  // arise, and there is no `bash` to build the slow reader with.)
  it.skipIf(process.platform === 'win32')('a warning larger than the pipe buffer arrives whole even when the reader is slow and the write lock is held', () => {
    for (let i = 0; i < 400; i++) {
      seedGuardedLesson({
        ...bashGuard,
        tool: 'Edit',
        pattern: 'hunter2',
        message: `guard ${i}: ${'never hardcode a credential in source. '.repeat(15)}`,
      }, `bulk-guard-${i}`);
    }
    const payload = path.join(tmpHome, 'payload.json');
    fs.writeFileSync(payload, JSON.stringify({
      cwd: tmpHome,
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/config.ts', new_string: 'const password = "hunter2"' },
    }));

    // A real OS pipe whose reader does nothing for 3.5 s — longer than the
    // counter's bounded wait. `pipefail` carries the hook's own exit status.
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = spawnSync('bash', ['-c', 'set -o pipefail; node "$HOOK" < "$PAYLOAD" | (sleep 3.5; cat)'], {
        env: { ...process.env, MEMESH_DB_PATH: dbPath, HOOK: path.resolve('scripts/hooks/pre-edit-recall.js'), PAYLOAD: payload },
        encoding: 'utf8',
        timeout: 12000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } finally {
      db.exec('ROLLBACK');
    }

    expect(result.signal, `killed instead of finishing; stderr: ${result.stderr.slice(0, 300)}`).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(200_000);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('guard 0:');
    expect(context).toContain('guard 399:');
    expect(result.stderr).toContain('[memesh guard-fires] not counted');
  }, 30000);

  it('an Edit guard fires from pre-edit-recall against path plus incoming content — even when the recall throttle would skip the file', () => {
    const lessonId = seedGuardedLesson({
      ...bashGuard,
      tool: 'Edit',
      pattern: 'password\\s*=\\s*["\']',
    }, 'no-hardcoded-secrets');

    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/config.ts', new_string: 'const password = "hunter2"' },
    };

    const first = runHook('pre-edit-recall.js', input);
    expect(first.stdout).not.toBe('');
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain(`[mem:${lessonId}]`);

    // Second edit of the SAME file: the recall half is throttled now, but
    // the dangerous content must still warn — a throttle that mutes guards
    // would train exactly one repetition of every mistake.
    const second = runHook('pre-edit-recall.js', input);
    expect(second.stdout).not.toBe('');
    expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toContain(`[mem:${lessonId}]`);

    const meta = JSON.parse(db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata);
    expect(meta.guard.fires).toBe(2);
  });

  it('a safe edit stays guard-silent (recall may still speak, guards must not)', () => {
    seedGuardedLesson({ ...bashGuard, tool: 'Edit', pattern: 'password\\s*=\\s*["\']' }, 'no-hardcoded-secrets');
    const { stdout } = runHook('pre-edit-recall.js', {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/other.ts', new_string: 'const user = readEnv()' },
    });
    if (stdout !== '') {
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).not.toContain('A guard you accepted');
    }
  });
});
