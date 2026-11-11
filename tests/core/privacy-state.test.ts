/**
 * The one answer to "is this session private?" (`decidePrivacy`): three states,
 * which reads count, what a vanished file means, the caps and the deadline,
 * both fork chains, and the case table the Hermes plugin runs too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import * as ps from '../../src/core/private-session.js';
import { canDenyReads } from '../helpers/permissions.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const { decidePrivacy, uncheckedKind, sessionFileName, PARENT_NOT_FOUND_PERSISTENT_MS } = ps;
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const CALL = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__memesh__private_session', input: {} }] } };
const QUIET = { type: 'user', message: { content: 'hello' } };
const meta = (id: string, extra: object = {}) => ({ type: 'session_meta', payload: { id, ...extra } });
const codexCall = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', tool: 'private_session', status: 'completed' } } };

let root: string;
let memeshDir: string;
let sessions: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-privacy-'));
  memeshDir = path.join(root, 'memesh');
  sessions = path.join(root, '.codex', 'sessions', '2026', '11', '08');
  fs.mkdirSync(sessions, { recursive: true });
});
afterEach(() => removeTempDir(root));

const decide = (transcriptPath?: string, extra: Partial<Parameters<typeof decidePrivacy>[0]> = {}) =>
  decidePrivacy({ transcriptPath, memeshDir, deadlineAt: Date.now() + 60_000, ...extra });
const file = (name: string, rows: object[]) => { const f = path.join(root, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, jsonl(rows)); return f; };
const rollout = (id: string, rows: object[]) => { const f = path.join(sessions, `rollout-2026-11-08T00-00-00-${id}.jsonl`); fs.writeFileSync(f, jsonl(rows)); return f; };
const P1 = '01a00000-0000-7000-8000-0000000000b1';
const P2 = '01a00000-0000-7000-8000-0000000000b2';
const C = '01a00000-0000-7000-8000-0000000000c1';

describe('three states', () => {
  it('a call is yes, no call is no, and a transcript that is not there is no', () => {
    expect(decide(file('a.jsonl', [QUIET, CALL]))).toEqual({ state: 'yes', evidence: 'transcript' });
    expect(decide(file('b.jsonl', [QUIET]))).toEqual({ state: 'no' });
    expect(decide(path.join(root, 'missing.jsonl'))).toEqual({ state: 'no' });
  });

  it('a marker is yes whatever it holds; a markers folder that is a plain file is unchecked, not no', () => {
    const t = file('a.jsonl', [QUIET]);
    fs.mkdirSync(path.join(memeshDir, 'private-sessions'), { recursive: true });
    fs.writeFileSync(path.join(memeshDir, 'private-sessions', sessionFileName('s1')), 'garbage');
    expect(decide(t, { sessionId: 's1' })).toEqual({ state: 'yes', evidence: 'marker' });
    fs.rmSync(path.join(memeshDir, 'private-sessions'), { recursive: true });
    fs.writeFileSync(path.join(memeshDir, 'private-sessions'), 'a file');
    expect(decide(t, { sessionId: 's1' })).toMatchObject({ state: 'unchecked', reason: 'marker_unreadable', kind: 'transient' });
  });

  it('a call in a chat list (Hermes) is yes', () => {
    expect(decide(undefined, { messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'memesh_private_session' } }] }] })).toEqual({ state: 'yes', evidence: 'messages' });
  });

  it('parent_not_found is transient for seven days, then persistent', () => {
    const now = Date.now();
    expect(uncheckedKind('parent_not_found', now - 1000, now)).toBe('transient');
    expect(uncheckedKind('parent_not_found', now - PARENT_NOT_FOUND_PERSISTENT_MS, now)).toBe('persistent');
    expect(uncheckedKind('too_large', now, now)).toBe('persistent');
  });
});

describe('R-B: only the main transcript\'s own absence means no', () => {
  it('a subagent transcript deleted between listing and reading is unchecked, not no (Q6_01 F1)', () => {
    const main = file('s.jsonl', [QUIET]);
    const subs = path.join(root, 's', 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(path.join(subs, 'agent-a0.jsonl'), jsonl([QUIET]));
    fs.writeFileSync(path.join(subs, 'agent-a1.jsonl'), jsonl([CALL]));
    const real = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('agent-a0.jsonl')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
    }) as typeof fs.statSync);
    try {
      // a1 still holds the call: yes beats the vanished a0.
      expect(decide(main).state).toBe('yes');
      fs.writeFileSync(path.join(subs, 'agent-a1.jsonl'), jsonl([QUIET]));
      expect(decide(main)).toMatchObject({ state: 'unchecked', reason: 'unreadable' });
    } finally { spy.mockRestore(); }
  });

  it.skipIf(!canDenyReads)('an unreadable subagent transcript or subagents folder is unchecked (Q6_01 F2, Q6_05 F4)', () => {
    const main = file('s.jsonl', [QUIET]);
    const subs = path.join(root, 's', 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    const sub = path.join(subs, 'agent-a1.jsonl');
    fs.writeFileSync(sub, jsonl([QUIET]));
    fs.chmodSync(sub, 0o000);
    try { expect(decide(main)).toMatchObject({ state: 'unchecked', reason: 'unreadable' }); } finally { fs.chmodSync(sub, 0o644); }
    fs.chmodSync(subs, 0o000);
    try { expect(decide(main)).toMatchObject({ state: 'unchecked', reason: 'unreadable' }); } finally { fs.chmodSync(subs, 0o755); }
    expect(ps.sessionLastWriteMs).toBeDefined();
    fs.chmodSync(subs, 0o000);
    try { expect(ps.sessionLastWriteMs(main), 'files that cannot be listed: no last write, so the caller treats the session as live').toBeUndefined(); } finally { fs.chmodSync(subs, 0o755); }
  });

  it('I: a session that ran more than 334 subagents (three files each, as Claude Code writes them) is still decided (G05 F1)', () => {
    const main = file('many.jsonl', [QUIET]);
    const subs = path.join(root, 'many', 'subagents');
    fs.mkdirSync(path.join(subs, 'workflows', 'wf_1'), { recursive: true });
    for (let i = 0; i < 400; i++) {
      for (const ext of ['.jsonl', '.meta.json', '.prefix.json']) fs.writeFileSync(path.join(subs, `agent-${i}${ext}`), ext === '.jsonl' ? jsonl([QUIET]) : '{}');
    }
    fs.writeFileSync(path.join(subs, 'workflows', 'wf_1', 'agent-w.jsonl'), jsonl([QUIET]));
    expect(decide(main)).toEqual({ state: 'no' });
    expect(ps.sessionLastWriteMs(main, Date.now() + 60_000)).toBeGreaterThan(0);
    fs.writeFileSync(path.join(subs, 'agent-399.jsonl'), jsonl([CALL]));
    expect(decide(main)).toMatchObject({ state: 'yes', evidence: 'subagent' });
  });

  it('O: bytes given with no transcript path are judged, not answered "no" unread (G04 F4)', () => {
    expect(decidePrivacy({ snapshot: Buffer.from(jsonl([QUIET, CALL])), memeshDir, deadlineAt: Date.now() + 60_000 })).toMatchObject({ state: 'yes' });
    expect(decidePrivacy({ transcriptPath: '', snapshot: Buffer.from(jsonl([QUIET])), memeshDir, deadlineAt: Date.now() + 60_000 })).toEqual({ state: 'no' });
  });

  it('I: listing the subagents past the deadline is a timeout, which passes on its own, never too_large', () => {
    const main = file('late.jsonl', [QUIET]);
    fs.mkdirSync(path.join(root, 'late', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'late', 'subagents', 'agent-1.jsonl'), jsonl([QUIET]));
    expect(decide(main, { deadlineAt: Date.now() - 1 })).toMatchObject({ state: 'unchecked', reason: 'timeout', kind: 'transient' });
    expect(ps.sessionLastWriteMs(main, Date.now() - 1), 'no answer in time: the caller treats the session as live').toBeUndefined();
  });

  it('I: the verdicts remembered on disk answer in a fresh process, forks included, without opening either file (G16 #3)', async () => {
    const cacheDir = path.join(root, 'cache');
    rollout(P1, [meta(P1), CALL]);
    const child = rollout(C, [meta(C, { forked_from_id: P1 }), QUIET]);
    expect(decide(child, { cacheDir }).state).toBe('yes');
    vi.resetModules();
    const fresh = await import('../../src/core/private-session.js');
    const opened: string[] = [];
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => { opened.push(String(p)); return (realOpen as (...a: unknown[]) => number)(p, ...rest); }) as typeof fs.openSync);
    try { expect(fresh.decidePrivacy({ transcriptPath: child, memeshDir, deadlineAt: Date.now() + 60_000, cacheDir }).state).toBe('yes'); } finally { spy.mockRestore(); }
    expect(opened).toEqual([]);
  });

  it('sessionTranscriptFiles keeps its three defences: no symlinks, subfolders searched, .jsonl only; and too deep is too_large (Q6_10 F5)', () => {
    const main = file('s.jsonl', [QUIET]);
    const subs = path.join(root, 's', 'subagents');
    fs.mkdirSync(path.join(subs, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(subs, 'deep', 'agent-x.jsonl'), jsonl([CALL]));
    expect(decide(main).state, 'a subfolder is searched (A22)').toBe('yes');
    fs.rmSync(path.join(subs, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(subs, 'notes.txt'), jsonl([CALL]));
    expect(decide(main).state, 'only .jsonl counts (A23)').toBe('no');
    const target = file('elsewhere.jsonl', [CALL]);
    fs.symlinkSync(target, path.join(subs, 'link.jsonl'));
    expect(decide(main).state, 'a symlink is not followed (A21)').toBe('no');
    fs.mkdirSync(path.join(subs, 'a', 'b', 'c', 'd'), { recursive: true });
    expect(decide(main), 'nested deeper than checked is not skipped in silence').toMatchObject({ state: 'unchecked', reason: 'too_large' });
  });
});

describe('R-D: every read is capped and bounded in time', () => {
  it('a session past the size limit is too_large, decided without reading it', () => {
    const main = file('big.jsonl', [QUIET]);
    fs.truncateSync(main, ps.PRIVATE_CHECK_MAX_BYTES + 1);
    const opened: string[] = [];
    const real = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => { opened.push(String(p)); return (real as (...a: unknown[]) => number)(p, ...rest); }) as typeof fs.openSync);
    try { expect(decide(main)).toMatchObject({ state: 'unchecked', reason: 'too_large', kind: 'persistent' }); } finally { spy.mockRestore(); }
    expect(opened).not.toContain(main);
  });

  it('a past deadline is timeout, never no', () => {
    const main = file('t.jsonl', [QUIET]);
    expect(decidePrivacy({ transcriptPath: main, memeshDir, deadlineAt: Date.now() - 1 })).toMatchObject({ state: 'unchecked', reason: 'timeout' });
  });

  it('reads a long line without a newline in linear time and finds a call after it', () => {
    const main = path.join(root, 'long.jsonl');
    fs.writeFileSync(main, `${'x'.repeat(70 * 1024 * 1024)}\n${JSON.stringify(CALL)}\n`);
    const started = Date.now();
    expect(decide(main).state).toBe('yes');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it('a line that names the tool and is longer than 64 MiB is too_large; text that only mentions the tool on a shorter line is not unchecked (Lead Q6)', () => {
    const short = file('short.jsonl', [QUIET, { type: 'assistant', message: { content: [{ type: 'text', text: 'about private_session and nothing else' }] } }]);
    expect(decide(short)).toEqual({ state: 'no' });
    const main = path.join(root, 'huge-line.jsonl');
    fs.writeFileSync(main, `{"text":"private_session ${'y'.repeat(65 * 1024 * 1024)}"}\n`);
    expect(decide(main)).toMatchObject({ state: 'unchecked', reason: 'too_large' });
  }, 60_000);
});

describe('Q6_01 F4: a header naming two threads follows both, for every kind of parent', () => {
  it.each(['plain', 'cached', 'zst'] as const)('is private when only the second chain\'s parent is private (%s parent)', (kind) => {
    rollout(P1, [meta(P1), QUIET]);
    const privateRows = [meta(P2), codexCall];
    const cacheDir = path.join(root, 'cache');
    if (kind === 'zst') {
      if (typeof zlib.zstdCompressSync !== 'function') return;
      const archived = path.join(root, '.codex', 'archived_sessions');
      fs.mkdirSync(archived, { recursive: true });
      fs.writeFileSync(path.join(archived, `rollout-2026-11-08T00-00-00-${P2}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(jsonl(privateRows))));
    } else {
      rollout(P2, privateRows);
    }
    const child = rollout(C, [meta(C, { forked_from_id: P1, parent_thread_id: P2 }), QUIET]);
    if (kind === 'cached') expect(decide(child, { cacheDir }).state).toBe('yes'); // fills the cache
    expect(decide(child, { cacheDir }).state).toBe('yes');
  });
});

describe('the case table both deciders run (TS here, Python in hermes-provider-contract)', () => {
  const cases = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/private-state-cases.json'), 'utf8')) as Array<{ kind?: string; name: string; sessionId: string; marker: 'none' | 'file' | 'folder-is-file'; messages?: unknown; expect: string; reason?: string; hermesOnly?: boolean; env?: Record<string, string> }>;
  it.each(cases.filter((c) => c.kind === 'record-dir').map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { getMemeshDirFromDbPath, homeDir } = await import('../../src/core/paths.js');
    vi.stubEnv('MEMESH_DB_PATH', undefined as unknown as string);
    for (const [k, v] of Object.entries(c.env ?? {})) vi.stubEnv(k, v);
    try { expect(getMemeshDirFromDbPath()).toBe(path.join(homeDir(), '.memesh')); } finally { vi.unstubAllEnvs(); }
  });
  it.each(cases.filter((c) => !c.hermesOnly && c.kind !== 'record-dir').map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if (c.marker === 'file') { fs.mkdirSync(path.join(memeshDir, 'private-sessions'), { recursive: true }); fs.writeFileSync(path.join(memeshDir, 'private-sessions', sessionFileName(c.sessionId)), c.sessionId); }
    const ageDays = (c as { markerAgeDays?: number }).markerAgeDays; if (ageDays) { const t = Date.now() / 1000 - ageDays * 86400; fs.utimesSync(path.join(memeshDir, 'private-sessions', sessionFileName(c.sessionId)), t, t); }
    if (c.marker === 'folder-is-file') { fs.mkdirSync(memeshDir, { recursive: true }); fs.writeFileSync(path.join(memeshDir, 'private-sessions'), 'x'); }
    const state = decide(undefined, { sessionId: c.sessionId, ...(c.messages === undefined ? {} : { messages: c.messages }) });
    expect(state.state).toBe(c.expect);
    if (c.reason) expect((state as { reason?: string }).reason).toBe(c.reason);
  });
});

describe('one copy of the six-hour window, and private file names (R-L, Q6_02 F2)', () => {
  it('the number appears once, in private-session.ts', () => {
    const files = ['src/core/note-ingest.ts', 'scripts/hooks/_stop-notes.js', 'scripts/hooks/_session-written-notes.js', 'src/core/private-session.ts'];
    const hits = files.filter((f) => fs.readFileSync(path.resolve(f), 'utf8').includes('6 * 60 * 60 * 1000'));
    expect(hits).toEqual(['src/core/private-session.ts']);
  });

  it('a session id with a slash is kept under its hash, inside the folder', () => {
    expect(sessionFileName('../../escape')).toMatch(/^[0-9a-f]{32}\.json$/);
    expect(sessionFileName('plain-id_1')).toBe('plain-id_1.json');
  });
});

describe('S3 follow-up: reads that must not give a wrong or a slow answer', () => {
  it('a subagent transcript that vanishes between being listed and being opened is unchecked and transient, never skipped (Q6_11 F1)', () => {
    const main = file('v.jsonl', [QUIET]);
    const subs = path.join(root, 'v', 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    const gone = path.join(subs, 'agent-gone.jsonl');
    fs.writeFileSync(gone, jsonl([QUIET]));
    const real = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === gone) { fs.rmSync(gone, { force: true }); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }
      return (real as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    try {
      expect(decide(main)).toMatchObject({ state: 'unchecked', reason: 'unreadable', kind: 'transient' });
    } finally { spy.mockRestore(); }
  });

  it.skipIf(!canDenyReads)('a folder of the Codex sessions that cannot be read is parent_unreadable, not parent_not_found (Q6_11 Nit)', () => {
    const child = rollout(C, [meta(C, { forked_from_id: P1 }), QUIET]);
    const locked = path.join(root, '.codex', 'sessions', '2026', '10');
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o000);
    try {
      expect(decide(child)).toMatchObject({ state: 'unchecked', reason: 'parent_unreadable' });
    } finally { fs.chmodSync(locked, 0o700); }
  });

  it('a payload with no transcript path is no without a marker and yes with one (Q6_11 M16)', () => {
    expect(decide(undefined, { sessionId: 's-none' })).toEqual({ state: 'no' });
    fs.mkdirSync(path.join(memeshDir, 'private-sessions'), { recursive: true });
    fs.writeFileSync(ps.privateMarkerPath(memeshDir, 's-none'), '{}');
    expect(decide(undefined, { sessionId: 's-none' })).toEqual({ state: 'yes', evidence: 'marker' });
  });

  it('removes the cache entry of a file that is gone, keeps one whose file is there, and leaves a cache that cannot be listed alone (Q6_11 Nit)', () => {
    const cacheDir = path.join(root, 'cache');
    const kept = file('kept.jsonl', [QUIET]);
    const gone = file('gone.jsonl', [QUIET]);
    decide(kept, { cacheDir });
    decide(gone, { cacheDir });
    expect(fs.readdirSync(cacheDir)).toHaveLength(2);
    fs.rmSync(gone);
    expect(ps.prunePrivateCheckCache(cacheDir)).toBe(1);
    expect(fs.readdirSync(cacheDir)).toHaveLength(1);
    expect(ps.prunePrivateCheckCache(path.join(root, 'no-cache-here'))).toBe(0);
  });

  it('parses only lines that can be a call record: text that names the tool costs no JSON parse (Q6_19 F4)', () => {
    const main = file('mentions.jsonl', Array.from({ length: 3000 }, (_, i) => ({ type: 'user', message: { content: `private_session, again (${i})` } })));
    const spy = vi.spyOn(JSON, 'parse');
    try {
      expect(decide(main)).toEqual({ state: 'no' });
      expect(spy.mock.calls.length, 'lines with no call record type are not parsed').toBeLessThan(10);
    } finally { spy.mockRestore(); }
  });

  it('stops at the deadline inside lines already in memory: a snapshot full of tool calls is timeout, never no (Q6_19 F4)', () => {
    const row = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { note: 'about private_session' } }] } })}\n`;
    const snapshot = Buffer.from(row.repeat(800_000));
    const started = Date.now();
    expect(decide(path.join(root, 'not-on-disk.jsonl'), { snapshot, deadlineAt: Date.now() + 50 })).toMatchObject({ state: 'unchecked', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it('reads a 1 GiB transcript that is one line without a newline in linear time (Q6_22 F3: 4 s at 256 MB and 91 s at 1 GB before)', () => {
    const main = path.join(root, 'one-line.jsonl');
    const fd = fs.openSync(main, 'w');
    fs.ftruncateSync(fd, 1024 ** 3); // sparse: one line of zero bytes
    fs.closeSync(fd);
    const started = Date.now();
    expect(decide(main)).toEqual({ state: 'no' });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 120_000);

  it('judges the snapshot the caller hands in, not the file: one removed or replaced after it was read cannot answer for it; subagents and the marker are still read (Q6_22 F2)', () => {
    const main = file('snap.jsonl', [QUIET, CALL]);
    const withCall = fs.readFileSync(main);
    fs.rmSync(main);
    expect(decide(main, { snapshot: withCall })).toEqual({ state: 'yes', evidence: 'transcript' });
    fs.writeFileSync(main, jsonl([QUIET]));
    expect(decide(main, { snapshot: withCall })).toEqual({ state: 'yes', evidence: 'transcript' });
    const quiet = Buffer.from(jsonl([QUIET]));
    expect(decide(main, { snapshot: quiet })).toEqual({ state: 'no' });
    const subs = path.join(root, 'snap', 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(path.join(subs, 'agent-a.jsonl'), jsonl([CALL]));
    expect(decide(main, { snapshot: quiet })).toEqual({ state: 'yes', evidence: 'subagent' });
    fs.rmSync(subs, { recursive: true });
    fs.mkdirSync(path.join(memeshDir, 'private-sessions'), { recursive: true });
    fs.writeFileSync(ps.privateMarkerPath(memeshDir, 'snap'), '{}');
    expect(decide(main, { snapshot: quiet, sessionId: 'snap' })).toEqual({ state: 'yes', evidence: 'marker' });
  });
});
