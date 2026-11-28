import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { continuationLines } from '../../src/core/continuation.js';
import { getProjectName } from '../../src/core/paths.js';

describe('Codex plan activity hook', () => {
  it('stores native current step for the thread and workspace, then clears completion', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-'));
    const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      const file = path.join(dir, 'codex-plan-activity', `${session}.json`);
      const state = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      const task = () => state()?.task;
      const hook = (plan: unknown, tool_response?: unknown) => spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-plan-activity.js')], {
        input: JSON.stringify({ session_id: session, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'update_plan', tool_input: { plan }, tool_response }),
        env: { ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session }, encoding: 'utf8',
      });
      expect(hook([{ step: 'First', status: 'in_progress' }, { step: 'Second', status: 'pending' }]).status).toBe(0);
      expect(fs.readdirSync(path.join(dir, 'codex-plan-activity'))).toHaveLength(1);
      expect(state()).toEqual({ session, workspace: fs.realpathSync(dir), task: 'First' });
      expect(hook([{ step: 'Bogus', status: 'unknown' }]).status).toBe(0);
      expect(task()).toBeUndefined();
      expect(hook([{ step: 'x'.repeat(5000), status: 'in_progress' }]).status).toBe(0);
      expect(task()).toHaveLength(200);
      expect(hook([{ step: 'y'.repeat(1024 * 1024), status: 'in_progress' }]).status).toBe(0);
      expect(task()).toBeUndefined();
      const outcomes = fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ hook: 'codex-plan-activity', outcome: 'skipped', reason: 'activity state recorded; no notification' }),
        expect.objectContaining({ hook: 'codex-plan-activity', outcome: 'error', reason: 'input exceeds 1 MiB' }),
      ]));
      expect(hook([{ step: 'First', status: 'in_progress' }], { isError: true }).status).toBe(0);
      expect(task()).toBeUndefined();
      expect(hook([{ step: 'First', status: 'completed' }, { step: 'Second', status: 'in_progress' }]).status).toBe(0);
      expect(task()).toBe('Second');
      expect(hook([{ step: 'First', status: 'completed' }, { step: 'Second', status: 'completed' }]).status).toBe(0);
      expect(task()).toBeUndefined();
      expect(hook([{ step: 'Bogus', status: 'unknown' }]).status).toBe(0);
      expect(task()).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('correlates only the exact native operation and keeps a missing return unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-continue-'));
    const workspace = path.join(dir, 'work');
    const sibling = path.join(dir, 'sibling');
    fs.mkdirSync(workspace);
    const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const nextSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const dbPath = path.join(dir, 'data', 'graph.db');
    const runGit = (...args: string[]) => {
      const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    vi.stubEnv('MEMESH_DB_PATH', dbPath);
    const secretCommand = 'a private command body';
    const hook = (event: string, invocation: string, cwd = workspace, response?: unknown, env: Record<string, string> = {}) => {
      const run = spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-plan-activity.js')], {
        input: JSON.stringify({ session_id: session, cwd, turn_id: 'turn-1', hook_event_name: event, tool_name: 'Bash', tool_use_id: invocation, tool_input: { command: secretCommand }, tool_response: response }),
        env: { ...process.env, HOME: dir, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session, ...env }, encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
    };
    try {
      runGit('init');
      runGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'First');
      runGit('worktree', 'add', '--detach', sibling);
      const project = getProjectName(workspace);
      expect(getProjectName(sibling)).toBe(project);
      const lines = (cwd = workspace, id = nextSession) => continuationLines(project, cwd, id).join('\n');
      hook('PreToolUse', 'disabled', workspace, undefined, { MEMESH_AUTO_CAPTURE: 'false' });
      expect(lines()).toBe('');
      hook('PreToolUse', 'first');
      hook('PostToolUse', 'other', workspace, 'some output');
      hook('PostToolUse', 'first', sibling, 'some output');
      expect(lines()).toContain('has no observed return');
      expect(lines()).toContain('liveness are unknown');
      expect(lines(sibling)).toBe('');
      expect(lines(workspace, session)).toBe('');
      const operations = path.join(dir, 'data/codex-plan-activity');
      const bucket = path.join(operations, fs.readdirSync(operations)[0]);
      const record = path.join(bucket, fs.readdirSync(bucket)[0]);
      expect(fs.readFileSync(record, 'utf8')).not.toContain(secretCommand);
      hook('PostToolUse', 'first', workspace, 'success text is not an exit status');
      expect(lines()).toContain('returned to the host');
      expect(lines()).not.toContain('success text');
      runGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Second');
      expect(lines()).toContain('belongs to an older revision');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  it('wires the native update_plan PostToolUse hook for Codex', () => {
    const manifest = JSON.parse(fs.readFileSync('.codex-plugin/plugin.json', 'utf8'));
    expect(manifest.hooks.hooks.PostToolUse.some((entry: { matcher: string; hooks: Array<{ command: string }> }) => entry.matcher === 'update_plan' && entry.hooks.some(h => h.command.endsWith('/scripts/hooks/codex-plan-activity.js')))).toBe(true);
  });
});
