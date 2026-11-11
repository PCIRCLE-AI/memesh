/**
 * Every hook on a Node below the floor: exit 0 (never crash the host), record
 * an `error` outcome with reason `uncaught NODE_TOO_OLD`, and never claim
 * something false. The version is faked with a preload reporting 22.15.1.
 * session-start tells the user to upgrade (with or without a database), instead
 * of "no database yet, memories will be created" or "everything else works".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEmptyDatabase, OLD_NODE_SENTENCE as SENTENCE, writeOldNodePreload } from '../helpers/node-floor.js';

const HOOKS = path.join(__dirname, '..', '..', 'scripts', 'hooks');
let work: string;
let preload: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nodefloor-hooks-'));
  preload = writeOldNodePreload(work);
});
afterAll(() => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function freshHome(name: string, withDb: boolean): string {
  const home = path.join(work, name);
  fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
  if (withDb) createEmptyDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
  return home;
}

function runHook(script: string, payload: object, home: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, MEMESH_SKIP_UPDATE_CHECK: '1',
    MEMESH_HOOK_HOST: 'claude-code', ...extraEnv,
  };
  const r = spawnSync(process.execPath, ['--require', preload, path.join(HOOKS, script)], {
    input: JSON.stringify(payload), encoding: 'utf8', env: env as NodeJS.ProcessEnv, cwd: home,
  });
  const outcomesFile = path.join(home, '.memesh', 'hook-outcomes.jsonl');
  const outcomes = fs.existsSync(outcomesFile)
    ? fs.readFileSync(outcomesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status, outcomes };
}

function expectNodeTooOld(r: ReturnType<typeof runHook>, hook: string) {
  expect(r.exitCode, r.stderr).toBe(0);
  // session-start's closing update tasks leave their own `notified` line when they do not start (for example "no
  // database yet"); it is true and separate from the Node problem this asserts.
  const mine = r.outcomes.filter((o) => o.hook === hook
    && !(o.outcome === 'notified' && /^update (check not started|warning withheld):/.test(o.reason)));
  expect(mine.map((o) => [o.outcome, o.reason]), JSON.stringify(r.outcomes)).toEqual([['error', 'uncaught NODE_TOO_OLD']]);
}

const common = { session_id: 'nf-sess-1' };

describe.each([false, true])('Feature: hooks on a Node below the floor (database present: %s)', (withDb) => {
  it('session-start tells the user to upgrade, and says nothing false', () => {
    const home = freshHome(`ss-${withDb}`, withDb);
    const r = runHook('session-start.js', { ...common, hook_event_name: 'SessionStart', cwd: home, source: 'startup' }, home);
    expectNodeTooOld(r, 'session-start');
    expect(r.stdout).toContain(SENTENCE);
    expect(r.stdout).not.toContain('no database yet');
    expect(r.stdout).not.toContain('everything else works');
    expect(r.stdout).not.toContain('if this repeats');
  });

  it('pre-edit-recall records the reason instead of "no database"', () => {
    const home = freshHome(`pe-${withDb}`, withDb);
    const r = runHook('pre-edit-recall.js', { ...common, hook_event_name: 'PreToolUse', cwd: home, tool_name: 'Edit', tool_input: { file_path: path.join(home, 'a.ts') } }, home);
    expectNodeTooOld(r, 'pre-edit-recall');
    expect(r.stderr).toContain(SENTENCE);
  });

  it('guard-check records the reason instead of "no database"', () => {
    const home = freshHome(`gc-${withDb}`, withDb);
    const r = runHook('guard-check.js', { ...common, hook_event_name: 'PreToolUse', cwd: home, tool_name: 'Bash', tool_input: { command: 'ls' } }, home);
    expectNodeTooOld(r, 'guard-check');
    expect(r.stderr).toContain(SENTENCE);
  });

  it('stop-message-gate records the reason instead of "no database"', () => {
    const home = freshHome(`sg-${withDb}`, withDb);
    const r = runHook('stop-message-gate.js', { ...common, hook_event_name: 'Stop', cwd: home }, home, { MEMESH_RECIPIENT: 'agent-a' });
    expectNodeTooOld(r, 'stop-message-gate');
    expect(r.stderr).toContain(SENTENCE);
  });

  it('codex-busy-message-notice records the reason instead of "no recipient or database"', () => {
    const home = freshHome(`cb-${withDb}`, withDb);
    const r = runHook('codex-busy-message-notice.js', { ...common, hook_event_name: 'UserPromptSubmit', cwd: home }, home, { MEMESH_HOOK_HOST: 'codex', MEMESH_RECIPIENT: 'agent-a' });
    expectNodeTooOld(r, 'codex-busy-message-notice');
    expect(r.stderr).toContain(SENTENCE);
  });
});
