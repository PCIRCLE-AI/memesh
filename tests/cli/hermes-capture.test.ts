import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');
let home: string;

function run(args: string[], stdin: string) {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-cli-')); });
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
      ['capture-session', '{"messages": "x"}', /stdin must be \{"messages"/],
      ['capture-session', '', /stdin is empty/],
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
    expect(JSON.parse(r.stdout)).toEqual({ outcome: 'skipped', reason: expect.any(String) });
  });
});
