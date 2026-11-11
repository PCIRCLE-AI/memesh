/**
 * Every hook on a Node below the floor: exit 0 (never crash the host), record
 * an `error` outcome with reason `uncaught NODE_TOO_OLD`, and never claim
 * something false. The version is faked with a preload reporting 22.15.1.
 * session-start tells the user to upgrade (with or without a database), instead
 * of "no database yet, memories will be created" or "everything else works",
 * and tells the model its MeMesh tools will not work. The two hooks that
 * remind the agent to use `remember` say nothing there, and record why.
 *
 * Nothing here depends on who the test's parent process is: session-start
 * records one outcome and returns before it looks for a `claude` ancestor.
 * No job in CI runs exactly Node 22.16.0; the floor is held by these fakes,
 * the engines test and the real-process tests in tests/storage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDatabase, OLD_NODE_SENTENCE as SENTENCE, writeOldNodePreload } from '../helpers/node-floor.js';

const HOOKS = path.join(__dirname, '..', '..', 'scripts', 'hooks');
let work: string;
let preload: string;
let preloadAtFloor: string;

beforeAll(() => {
  // A folder of our own: the children (an updater that outlives its hook) can only write under it, and all of it goes in afterAll.
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nodefloor-hooks-'));
  preload = writeOldNodePreload(work);
  preloadAtFloor = writeOldNodePreload(work, '22.16.0');
});
afterAll(() => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function freshHome(name: string, withDb: boolean): string {
  const home = path.join(work, name);
  fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
  if (withDb) createDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
  return home;
}

function runHook(script: string, payload: object, home: string, extraEnv: Record<string, string> = {}, fakeNode = preload) {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, MEMESH_SKIP_UPDATE_CHECK: '1',
    MEMESH_HOOK_HOST: 'claude-code', ...extraEnv,
  };
  const r = spawnSync(process.execPath, ['--require', fakeNode, path.join(HOOKS, script)], {
    input: JSON.stringify(payload), encoding: 'utf8', env: env as NodeJS.ProcessEnv, cwd: home, timeout: 30_000,
  });
  const outcomesFile = path.join(home, '.memesh', 'hook-outcomes.jsonl');
  const outcomes = fs.existsSync(outcomesFile)
    ? fs.readFileSync(outcomesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status, outcomes };
}

function expectNodeTooOld(r: ReturnType<typeof runHook>, hook: string, then: Array<[string, string]> = []) {
  expect(r.exitCode, r.stderr).toBe(0);
  const mine = r.outcomes.filter((o) => o.hook === hook);
  expect(mine.map((o) => [o.outcome, o.reason]), JSON.stringify(r.outcomes)).toEqual([['error', 'uncaught NODE_TOO_OLD'], ...then]);
}

const common = { session_id: 'nf-sess-1' };
const UPDATE_NOT_STARTED: Array<[string, string]> = [['notified', 'update check not started: this Node is older than the minimum MeMesh supports']];

describe.each([false, true])('Feature: hooks on a Node below the floor (database present: %s)', (withDb) => {
  it.each(['startup', 'clear'])('session-start (%s) tells the user to upgrade, says nothing false, and records one error', (source) => {
    const home = freshHome(`ss-${source}-${withDb}`, withDb);
    const r = runHook('session-start.js', { ...common, hook_event_name: 'SessionStart', cwd: home, source }, home);
    // The closing update tasks do not start on this Node, and say so in both places: the outcomes file and auto-update.log.
    expectNodeTooOld(r, 'session-start', UPDATE_NOT_STARTED);
    const log = path.join(home, '.memesh', 'auto-update.log');
    expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').toContain('this Node is older than the minimum MeMesh supports, so neither the update check nor the updater starts');
    expect(fs.existsSync(path.join(home, '.memesh', 'auto-update-attempt'))).toBe(false);
    expect(r.stdout).toContain(SENTENCE);
    expect(r.stdout).not.toContain('no database yet');
    expect(r.stdout).not.toContain('everything else works');
    expect(r.stdout).not.toContain('if this repeats');
  });

  it('session-start tells the model its tools will not work, and does not send it to them', () => {
    const home = freshHome(`ssctx-${withDb}`, withDb);
    const r = runHook('session-start.js', { ...common, hook_event_name: 'SessionStart', cwd: home, source: 'startup' }, home, { MEMESH_RECIPIENT: 'agent-a' });
    const context: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain('cannot run on this Node');
    expect(context).toMatch(/do not call/i);
    expect(context).toContain(SENTENCE);
    expect(context).not.toMatch(/Pass project|sender|messaging address|\bproject:/i);
    expect(JSON.parse(r.stdout).systemMessage).not.toMatch(/messaging address|agent-a/);
  });

  it('pre-edit-recall records the reason instead of "no database"', () => {
    const home = freshHome(`pe-${withDb}`, withDb);
    const r = runHook('pre-edit-recall.js', { ...common, hook_event_name: 'PreToolUse', cwd: home, tool_name: 'Edit', tool_input: { file_path: path.join(home, 'a.ts') } }, home);
    expectNodeTooOld(r, 'pre-edit-recall');
    expect(r.stderr).toContain(SENTENCE);
  });

  it('pre-edit-recall says it once and records once for a patch that names two files', () => {
    const home = freshHome(`pa-${withDb}`, withDb);
    const command = '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Add File: b.ts\n+y\n*** End Patch\n';
    const r = runHook('pre-edit-recall.js', { ...common, hook_event_name: 'PreToolUse', cwd: home, tool_name: 'apply_patch', tool_input: { command } }, home, { MEMESH_HOOK_HOST: 'codex' });
    expectNodeTooOld(r, 'pre-edit-recall');
    expect(r.stderr.split(SENTENCE).length - 1, r.stderr).toBe(1);
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

  it('prompt-recall records the reason instead of "no database yet"', () => {
    const home = freshHome(`pr-${withDb}`, withDb);
    const r = runHook('prompt-recall.js', { ...common, hook_event_name: 'UserPromptSubmit', cwd: home, prompt: 'how do we deploy the api server to production' }, home);
    expectNodeTooOld(r, 'prompt-recall');
    expect(r.stdout).toBe('');
  });

  it('decision-nudge does not send the agent to the remember tool, and records why', () => {
    const home = freshHome(`dn-${withDb}`, withDb);
    const r = runHook('decision-nudge.js', { ...common, hook_event_name: 'PostToolUse', cwd: home, tool_name: 'ExitPlanMode', tool_input: {}, tool_response: {} }, home);
    expectNodeTooOld(r, 'decision-nudge');
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(SENTENCE);
  });

  it('user-prompt-intent stays silent and records why', () => {
    const home = freshHome(`ui-${withDb}`, withDb);
    const r = runHook('user-prompt-intent.js', { ...common, hook_event_name: 'UserPromptSubmit', cwd: home, prompt: 'hello there' }, home);
    expectNodeTooOld(r, 'user-prompt-intent');
    expect(r.stdout).toBe('');
  });

  it('on Node 22.16.0 exactly (the floor) no hook is refused', () => {
    const home = freshHome(`floor-${withDb}`, withDb);
    const r = runHook('guard-check.js', { ...common, hook_event_name: 'PreToolUse', cwd: home, tool_name: 'Bash', tool_input: { command: 'ls' } }, home, {}, preloadAtFloor);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr).not.toContain(SENTENCE);
    expect(r.outcomes.map((o) => o.reason)).not.toContain('uncaught NODE_TOO_OLD');
  });
});

describe('Feature: a Node below the floor and a data folder that cannot be written', () => {
  const canTest = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.skipIf(!canTest)('session-start says only the Node problem: no "recall still works", no "capture is unaffected"', () => {
    const home = freshHome('ss-readonly', false);
    const folder = path.join(home, '.memesh');
    fs.chmodSync(folder, 0o500);
    try {
      const r = runHook('session-start.js', { ...common, hook_event_name: 'SessionStart', cwd: home, source: 'startup' }, home);
      expect(r.exitCode, r.stderr).toBe(0);
      const message: string = JSON.parse(r.stdout).systemMessage;
      expect(message).toContain(SENTENCE);
      expect(message).not.toMatch(/recall still works|cannot write|memories will NOT be saved/);
      expect(r.stderr).toContain('could not record the session-start hook outcome');
      expect(r.stderr).not.toContain('Capture itself is unaffected');
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });
});
