import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  it('wires the native update_plan PostToolUse hook for Codex', () => {
    const manifest = JSON.parse(fs.readFileSync('.codex-plugin/plugin.json', 'utf8'));
    expect(manifest.hooks.hooks.PostToolUse.some((entry: { matcher: string; hooks: Array<{ command: string }> }) => entry.matcher === 'update_plan' && entry.hooks.some(h => h.command.endsWith('/scripts/hooks/codex-plan-activity.js')))).toBe(true);
  });
});
