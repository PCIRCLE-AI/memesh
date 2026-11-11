import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('Codex plan activity hook', () => {
  it('stores native current step for the thread and workspace, then clears completion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-'));
    const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      const { readCodexPlanActivity } = await import('../../src/core/session-activity.js');
      const hook = (plan: unknown, tool_response?: unknown) => spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-plan-activity.js')], {
        input: JSON.stringify({ session_id: session, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'update_plan', tool_input: { plan }, tool_response }),
        env: { ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session }, encoding: 'utf8',
      });
      expect(hook([{ step: 'First', status: 'in_progress' }, { step: 'Second', status: 'pending' }]).status).toBe(0);
      expect(fs.readdirSync(path.join(dir, 'codex-plan-activity'))).toHaveLength(1);
      expect(readCodexPlanActivity(dir, session, dir)).toBe('First');
      expect(hook([{ step: 'Bogus', status: 'unknown' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBeUndefined();
      expect(hook([{ step: 'x'.repeat(5000), status: 'in_progress' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toHaveLength(200);
      expect(hook([{ step: 'y'.repeat(1024 * 1024), status: 'in_progress' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBeUndefined();
      const outcomes = fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ hook: 'codex-plan-activity', outcome: 'skipped', reason: 'activity state recorded; no notification' }),
        expect.objectContaining({ hook: 'codex-plan-activity', outcome: 'error', reason: 'input exceeds 1 MiB' }),
      ]));
      expect(hook([{ step: 'First', status: 'in_progress' }], { isError: true }).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBeUndefined();
      expect(readCodexPlanActivity(dir, session, path.dirname(dir))).toBeUndefined();
      expect(readCodexPlanActivity(dir, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', dir)).toBeUndefined();
      expect(hook([{ step: 'First', status: 'completed' }, { step: 'Second', status: 'in_progress' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBe('Second');
      expect(hook([{ step: 'First', status: 'completed' }, { step: 'Second', status: 'completed' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBeUndefined();
      expect(hook([{ step: 'Bogus', status: 'unknown' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('writes no plan step in a session where the agent called private_session, and removes the one it had', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-private-'));
    const session = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const transcript = path.join(dir, 'rollout.jsonl');
    try {
      const { readCodexPlanActivity } = await import('../../src/core/session-activity.js');
      const hook = (plan: unknown) => spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-plan-activity.js')], {
        input: JSON.stringify({ session_id: session, cwd: dir, transcript_path: transcript, hook_event_name: 'PostToolUse', tool_name: 'update_plan', tool_input: { plan } }),
        env: { ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session }, encoding: 'utf8',
      });
      fs.writeFileSync(transcript, '');
      expect(hook([{ step: 'Before asking', status: 'in_progress' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBe('Before asking');
      const call = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'memesh', tool: 'private_session', status: 'completed' } } };
      fs.writeFileSync(transcript, `${JSON.stringify(call)}\n`);
      expect(hook([{ step: 'Secret plan step', status: 'in_progress' }]).status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBeUndefined();
      expect(fs.readdirSync(path.join(dir, 'codex-plan-activity'))).toEqual([]);
      const outcomes = fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(outcomes.at(-1)).toMatchObject({ hook: 'codex-plan-activity', outcome: 'skipped', reason: 'private_session' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('writes no plan step, and says why as an error, when the transcript cannot be checked (the session is treated as private)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-unreadable-'));
    const session = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    try {
      const { readCodexPlanActivity } = await import('../../src/core/session-activity.js');
      const transcript = path.join(dir, 'a-directory'); fs.mkdirSync(transcript);
      const r = spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-plan-activity.js')], {
        input: JSON.stringify({ session_id: session, cwd: dir, transcript_path: transcript, hook_event_name: 'PostToolUse', tool_name: 'update_plan', tool_input: { plan: [{ step: 'Visible step', status: 'in_progress' }] } }),
        env: { ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session }, encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir)).toBeUndefined();
      const outcomes = fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ hook: 'codex-plan-activity', outcome: 'error', reason: 'the private-session check could not read the transcript, so the session is treated as private' }),
        // Unchecked is never labelled private: the skip says the session could not be checked.
        expect.objectContaining({ hook: 'codex-plan-activity', outcome: 'skipped', reason: 'the session could not be checked for a private-session call, so nothing is saved' }),
      ]));
      expect(outcomes.some((o: { reason?: string }) => o.reason === 'private_session'), 'never labelled private (Q6_18 F5)').toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('writes no plan step in a thread forked from a private one (named by forked_from_id), and none when its parent cannot be found', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-fork-'));
    const session = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const parentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    try {
      const { readCodexPlanActivity } = await import('../../src/core/session-activity.js');
      const day = path.join(dir, '.codex', 'sessions', '2026', '11', '08');
      fs.mkdirSync(day, { recursive: true });
      const child = path.join(day, `rollout-2026-11-08T00-00-00-${session}.jsonl`);
      fs.writeFileSync(child, `${JSON.stringify({ type: 'session_meta', payload: { id: session, forked_from_id: parentId } })}\n`);
      const hook = () => spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-plan-activity.js')], {
        input: JSON.stringify({ session_id: session, cwd: dir, transcript_path: child, hook_event_name: 'PostToolUse', tool_name: 'update_plan', tool_input: { plan: [{ step: 'Secret plan step', status: 'in_progress' }] } }),
        env: { ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session }, encoding: 'utf8',
      });
      expect(hook().status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir), 'parent not found').toBeUndefined();
      const recorded = fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(recorded.some((r: { hook: string; outcome: string; reason?: string }) => r.hook === 'codex-plan-activity' && r.outcome === 'error' && String(r.reason).includes('fork parent')), 'the missing parent is recorded as an error').toBe(true);
      const call = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'memesh', tool: 'private_session', status: 'completed' } } };
      fs.writeFileSync(path.join(day, `rollout-2026-11-08T00-00-00-${parentId}.jsonl`), `${JSON.stringify(call)}\n`);
      expect(hook().status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir), 'parent private').toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'codex-plan-activity')) ? fs.readdirSync(path.join(dir, 'codex-plan-activity')) : []).toEqual([]);
      fs.writeFileSync(path.join(day, `rollout-2026-11-08T00-00-00-${parentId}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: parentId } })}\n`);
      expect(hook().status).toBe(0);
      expect(readCodexPlanActivity(dir, session, dir), 'parent plain').toBe('Secret plan step');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('wires the native update_plan PostToolUse hook for Codex', () => {
    const manifest = JSON.parse(fs.readFileSync('.codex-plugin/plugin.json', 'utf8'));
    expect(manifest.hooks.hooks.PostToolUse.some((entry: { matcher: string; hooks: Array<{ command: string }> }) => entry.matcher === 'update_plan' && entry.hooks.some(h => h.command.endsWith('/scripts/hooks/codex-plan-activity.js')))).toBe(true);
  });
});
