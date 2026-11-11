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
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ outcome: 'skipped', reason: expect.any(String) });
  });
});

describe('memesh hermes capture-session: a conversation in which the agent called private_session', () => {
  const edit = (id: string, file: string) => ({
    role: 'assistant', content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `/repo/src/${file}`, content: 'x' }) } }],
  });
  const work = [edit('c1', 'a.ts'), edit('c2', 'b.ts'), edit('c3', 'c.ts')];
  const privateCall = { role: 'assistant', content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'memesh_private_session', arguments: '{}' } }] };

  it('stores the session when the tool was not called', () => {
    const r = run(['hermes', 'capture-session', '--session', 'hs1'], JSON.stringify({ messages: work }));
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'wrote' });
  });

  it('stores nothing when the call is named without the memesh_ prefix', () => {
    const bare = { role: 'assistant', content: '', tool_calls: [{ id: 'p2', type: 'function', function: { name: 'private_session', arguments: '{}' } }] };
    const r = run(['hermes', 'capture-session', '--session', 'hs4'], JSON.stringify({ messages: [...work, bare] }));
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
  });

  it('stores nothing when the message list holds the call, so a restart or resume is covered', () => {
    const r = run(['hermes', 'capture-session', '--session', 'hs2'], JSON.stringify({ messages: [...work, privateCall] }));
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'skipped', reason: 'private_session', written: [] });
    const quoted = run(['hermes', 'capture-session', '--session', 'hs3'], JSON.stringify({ messages: [...work, { role: 'user', content: 'what does memesh_private_session do?' }, { role: 'assistant', content: 'It is a tool named memesh_private_session.' }] }));
    expect(JSON.parse(quoted.stdout)).toMatchObject({ outcome: 'wrote' });
  });

  it('stores nothing when the session has a private-session marker, even with no call in the message list', () => {
    // The marker decidePrivacy reads: <memesh dir>/private-sessions/<id>.json (not the Hermes plugin's own folder).
    fs.mkdirSync(path.join(home, '.memesh', 'private-sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.memesh', 'private-sessions', 'hs5.json'), '{}');
    const r = run(['hermes', 'capture-session', '--session', 'hs5'], JSON.stringify({ messages: work }));
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'skipped', reason: 'private_session', written: [] });
  });

  it('stores nothing, and names the error, when the private-sessions folder cannot be looked in (unchecked fails closed)', () => {
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.memesh', 'private-sessions'), 'not a folder');
    const r = run(['hermes', 'capture-session', '--session', 'hs6'], JSON.stringify({ messages: work }));
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      outcome: 'skipped',
      reason: 'the session could not be checked for a private-session call, so nothing is saved',
      error: 'the private-sessions folder beside the database cannot be read, so every session is treated as private and nothing is saved until it can be',
      written: [],
    });
  });
});

describe('memesh hermes capture-turn: the same privacy check as capture-session', () => {
  const decision = JSON.stringify({ user: 'which db?', assistant: 'We decided to use SQLite because it is local.' });

  it('stores a decision turn of an ordinary session (the control)', () => {
    const r = run(['hermes', 'capture-turn', '--session', 'ht1'], decision);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'wrote' });
  });

  it('stores nothing when the session has a private-session marker', () => {
    fs.mkdirSync(path.join(home, '.memesh', 'private-sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.memesh', 'private-sessions', 'ht2.json'), '{}');
    const r = run(['hermes', 'capture-turn', '--session', 'ht2'], decision);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ outcome: 'skipped', reason: 'private_session' });
  });

  it('stores nothing, and names the error, when the private-sessions folder cannot be looked in', () => {
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.memesh', 'private-sessions'), 'not a folder');
    const r = run(['hermes', 'capture-turn', '--session', 'ht3'], decision);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      outcome: 'skipped',
      reason: 'the session could not be checked for a private-session call, so nothing is saved',
      error: 'the private-sessions folder beside the database cannot be read, so every session is treated as private and nothing is saved until it can be',
    });
  });
});
