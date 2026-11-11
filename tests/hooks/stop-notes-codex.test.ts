/**
 * The remember nudge on Codex. The nudge counts tool calls and looks for
 * decision-shaped moves in what happened since the last Stop; it used to read
 * only Claude Code's `tool_use` blocks, so a Codex rollout counted zero calls and
 * every Stop was a "trivial turn", with a skip record that looked like normal
 * behaviour. Fixtures follow the rows Codex writes (field layout real, text
 * invented): `function_call` and `custom_tool_call` response items for the
 * requests, and `item_completed` events for what a command or an MCP tool did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanTranscriptWindow, NUDGE_MIN_TOOL_CALLS } from '../../scripts/hooks/_stop-notes.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const HOOK = path.resolve('scripts/hooks/session-summary.js');
let n = 0;
const jsonl = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const functionCall = (name = 'shell') => ({ type: 'response_item', payload: { type: 'function_call', call_id: `fc_${++n}`, name, arguments: '{}' } });
const scriptCall = () => ({ type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: `cc_${++n}`, name: 'exec', input: 'text(await tools.exec_command({ cmd: "ls" }));' } });
const command = (cmd: string, exit_code = 0, status: string = exit_code === 0 ? 'completed' : 'failed') => ({
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: 't1', turn_id: 'u1', item: {
    type: 'CommandExecution', id: `ce${++n}`, command: ['/bin/zsh', '-lc', cmd], cwd: '/repo', source: 'unified_exec_startup',
    status, aggregated_output: '', exit_code,
  } },
});
const mcpCall = (tool: string, status = 'completed') => ({
  type: 'event_msg',
  payload: { type: 'item_completed', item: { type: 'McpToolCall', id: `mc${++n}`, server: 'memesh', tool, arguments: {}, status } },
});
const calls = (count: number) => Array.from({ length: count }, (_, i) => (i % 2 === 0 ? functionCall() : scriptCall()));

describe('scanTranscriptWindow on a Codex rollout', () => {
  it('counts every function_call and custom_tool_call request, and nothing else', () => {
    const scan = scanTranscriptWindow(jsonl([...calls(7), command('ls'), mcpCall('recall'), { type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } }]));
    expect(scan.toolCalls).toBe(7);
    expect(scan.toolCalls).toBeGreaterThanOrEqual(NUDGE_MIN_TOOL_CALLS);
  });

  it('sees a commit that succeeded, not one that failed', () => {
    expect(scanTranscriptWindow(jsonl([command('git commit -m "x"')])).moves).toEqual(['a commit']);
    expect(scanTranscriptWindow(jsonl([command('git commit -m "x"', 1)])).moves).toEqual([]);
  });

  it('sees a test go red then green, in order', () => {
    expect(scanTranscriptWindow(jsonl([command('npm test', 1), command('npm test', 0)])).moves).toEqual(['a test went red then green']);
    expect(scanTranscriptWindow(jsonl([command('npm test', 0)])).moves).toEqual([]);
  });

  it('sees a memory written through the MCP tool or the CLI, and not one that failed', () => {
    expect(scanTranscriptWindow(jsonl([mcpCall('remember')])).wroteMemory).toBe(true);
    expect(scanTranscriptWindow(jsonl([mcpCall('learn')])).wroteMemory).toBe(true);
    expect(scanTranscriptWindow(jsonl([command('memesh remember "x"')])).wroteMemory).toBe(true);
    expect(scanTranscriptWindow(jsonl([mcpCall('remember', 'failed')])).wroteMemory).toBe(false);
    expect(scanTranscriptWindow(jsonl([mcpCall('recall')])).wroteMemory).toBe(false);
  });

  it('does not take a memesh remember that failed for a memory written, whichever field says it failed', () => {
    expect(scanTranscriptWindow(jsonl([command('memesh remember "x"', 1)])).wroteMemory, 'exit code 1, status failed').toBe(false);
    expect(scanTranscriptWindow(jsonl([command('memesh remember "x"', 1, 'completed')])).wroteMemory, 'the exit code alone').toBe(false);
    expect(scanTranscriptWindow(jsonl([command('memesh remember "x"', 0, 'failed')])).wroteMemory, 'the status alone').toBe(false);
    expect(scanTranscriptWindow(jsonl([command('memesh remember "x"', 0, 'completed')])).wroteMemory).toBe(true);
  });

  it('sees a commit that failed by exit code alone or by status alone as a commit that did not happen', () => {
    expect(scanTranscriptWindow(jsonl([command('git commit -m "x"', 1, 'completed')])).moves).toEqual([]);
    expect(scanTranscriptWindow(jsonl([command('git commit -m "x"', 0, 'failed')])).moves).toEqual([]);
    expect(scanTranscriptWindow(jsonl([command('git commit -m "x"', 0, 'declined')])).moves, 'neither completed nor failed').toEqual([]);
  });
});

describe('the Stop hook on a Codex rollout', () => {
  let home: string;
  let rollout: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nudge-codex-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    const dir = path.join(home, '.codex', 'sessions', '2026', '11', '08');
    fs.mkdirSync(dir, { recursive: true });
    rollout = path.join(dir, 'rollout-2026-11-08T00-00-00-01a00000-0000-7000-8000-0000000000c1.jsonl');
  });
  afterEach(() => removeTempDir(home));

  const stop = (rows: object[]) => {
    fs.writeFileSync(rollout, jsonl(rows));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_HOOK_HOST: 'codex' };
    delete env.MEMESH_DB_PATH; delete env.MEMESH_DIR;
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: '01a00000-0000-7000-8000-0000000000c1', transcript_path: rollout, cwd: home, hook_event_name: 'Stop' }),
      env, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  const outcome = () => {
    const file = path.join(home, '.memesh', 'hook-outcomes.jsonl');
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.hook === 'remember-nudge');
    expect(records.length, 'the nudge records an outcome on every Stop').toBeGreaterThan(0);
    return records.at(-1);
  };

  it('nudges when the turn had enough tool calls, made a commit and stored no memory', () => {
    const stdout = stop([...calls(NUDGE_MIN_TOOL_CALLS + 3), command('git commit -m "ship it"')]);
    expect(stdout).toMatch(/1 decision-shaped move\(s\) \(a commit\) and stored no memory/);
    expect(outcome()).toMatchObject({ outcome: 'notified', reason: 'a commit' });
  });

  it('stays silent when a memory was stored, and says why', () => {
    const stdout = stop([...calls(NUDGE_MIN_TOOL_CALLS + 3), command('git commit -m "ship it"'), mcpCall('remember')]);
    expect(stdout).not.toMatch(/decision-shaped/);
    expect(outcome()).toMatchObject({ outcome: 'skipped', reason: 'a memory was written since the last Stop' });
  });

  it('is a trivial turn only when it really had too few tool calls', () => {
    stop([...calls(NUDGE_MIN_TOOL_CALLS - 1), command('git commit -m "ship it"')]);
    expect(outcome()).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/too few tool calls/) });
  });
});
