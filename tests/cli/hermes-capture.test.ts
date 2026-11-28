import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');
let home: string;
let env: NodeJS.ProcessEnv;

function run(args: string[], stdin: string) {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    input: stdin,
    encoding: 'utf8',
    env,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-cli-'));
  env = buildIsolatedSuiteEnv(process.env, { runtimeHome: home });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('memesh hermes: input is refused in its own terms', () => {
  it('requires --session', () => {
    const r = run(['hermes', 'capture-turn'], '{"user":"a","assistant":"b"}');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--session <id> is required/);
  });

  it('refuses a session id that could not be part of an entity name', () => {
    const r = run(['hermes', 'capture-turn', '--session', 'a b/../c'], '{"user":"a","assistant":"b"}');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--session must be/);
  });

  it('refuses non-JSON stdin and the wrong shape, without a stack trace', () => {
    for (const [cmd, body, msg] of [
      ['capture-turn', 'not json', /Error:/],
      ['capture-turn', '{"user": 1}', /stdin must be \{"user"/],
      ['capture-turn', '', /stdin is empty/],
    ] as const) {
      const r = run(['hermes', cmd, '--session', 's1'], body);
      expect(r.code, `${cmd} ${body}`).toBe(1);
      expect(r.stderr).toMatch(msg);
      expect(r.stderr).not.toMatch(/\n\s+at\s/);
    }
  });

  it('prints one JSON result on success', () => {
    const r = run(['hermes', 'capture-turn', '--session', 's1'], '{"user":"hi","assistant":"hello"}');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ outcome: 'wrote', names: [expect.stringMatching(/^hermes-turn-s1-[0-9a-f-]{36}-user$/), expect.stringMatching(/^hermes-turn-s1-[0-9a-f-]{36}-assistant$/)] });
  });

  it('there is no capture-session command any more', () => {
    const r = run(['hermes', 'capture-session', '--session', 's1'], '{"messages": []}');
    expect(r.code).not.toBe(0);
  });
});

it('makes a bound Hermes assistant turn available to the same-project prompt hook only', () => {
  const project = fs.mkdtempSync(path.join(home, 'project-'));
  const other = fs.mkdtempSync(path.join(home, 'other-'));
  const prompt = 'Jasper orange routing prefix';
  const marker = 'recorded-by-hermes-Q9';
  env.MEMESH_PROJECT_ROOT = project;
  const captured = run(['hermes', 'capture-turn', '--session', 'writer'], JSON.stringify({
    user: 'Please analyze this synthetic case',
    assistant: prompt + ': ' + marker,
  }));
  expect(captured.code, captured.stderr).toBe(0);
  expect(JSON.parse(captured.stdout).outcome).toBe('wrote');

  const hook = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'prompt-recall.js');
  const read = (cwd: string, session_id: string) => spawnSync(process.execPath, [hook], {
    env, input: JSON.stringify({ cwd, session_id, prompt, hook_event_name: 'UserPromptSubmit' }),
    encoding: 'utf8', timeout: 15_000,
  });
  const outside = read(other, 'outside');
  expect(outside.status, outside.stderr).toBe(0);
  expect(outside.stdout).not.toContain(marker);
  const inside = read(project, 'inside');
  expect(inside.status, inside.stderr).toBe(0);
  expect(inside.stdout).toContain(marker);
});

it('refuses an invalid declared workspace without writing an unfiled turn', () => {
  env.MEMESH_PROJECT_ROOT = path.join(home, 'missing-project');
  const before = fs.readdirSync(home);
  const captured = run(['hermes', 'capture-turn', '--session', 'writer'], '{"user":"A","assistant":"B"}');
  expect(captured.code).toBe(1);
  expect(captured.stderr).toContain('workspace_unavailable');
  env.MEMESH_AUTO_CAPTURE = 'false';
  const skipped = run(['hermes', 'capture-turn', '--session', 'writer'], '{"user":"A","assistant":"B"}');
  expect(skipped.code, skipped.stderr).toBe(0);
  expect(JSON.parse(skipped.stdout)).toEqual({ outcome: 'skipped', reason: 'auto-capture is turned off' });
  expect(fs.readdirSync(home)).toEqual(before);
});
