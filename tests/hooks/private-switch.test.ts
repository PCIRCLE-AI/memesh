/**
 * "Don't remember this session": the agent calls the `private_session` tool,
 * and every hook that writes from a transcript then writes nothing. These run
 * the real Stop and PreCompact hooks against Claude Code and Codex transcripts
 * in the shapes the hosts write (field layout real, text invented).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { pathToFileURL } from 'url';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { deadlineFor, HOOK_BUDGET_MS } from '../../scripts/hooks/_hook-budgets.js';
import { decidePrivacy, findCodexRollout, isPrivateToolName } from '../../src/core/private-session.js';

/** The one decider, over a transcript file alone (no marker folder): a test helper with the old shape. */
const NO_MARKERS = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-no-markers-'));
const decideFile = (file: string, options: { cacheDir?: string } = {}) =>
  decidePrivacy({ transcriptPath: file, memeshDir: NO_MARKERS, deadlineAt: Date.now() + 60_000, ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }) });
/** The one decider over transcript text already in memory (the snapshot input), with no marker and no file behind it. */
const transcriptCallsPrivateTool = (text: string): boolean =>
  decidePrivacy({ transcriptPath: path.join(NO_MARKERS, 'in-memory.jsonl'), snapshot: Buffer.from(text), memeshDir: NO_MARKERS, deadlineAt: Date.now() + 60_000 }).state === 'yes';
/** true for yes, false for no; throws with `failure` set to the reason for unchecked. */
const transcriptFileCallsPrivateTool = (file: string, options: { cacheDir?: string } = {}): boolean => {
  const state = decideFile(file, options);
  if (state.state === 'unchecked') throw Object.assign(new Error(state.detail), { failure: state.reason });
  return state.state === 'yes';
};
import { SESSION_HANDOFF_TYPE } from '../../src/core/session-handoff.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { canDenyReads } from '../helpers/permissions.js';

const STOP = path.resolve('scripts/hooks/session-summary.js');
const PRE_COMPACT = path.resolve('scripts/hooks/pre-compact.js');
const SESSION_END = path.resolve('scripts/hooks/session-end-notes.js');
const PRIVATE_MARK = path.resolve('scripts/hooks/private-session-mark.js');
const USER_PROMPT = path.resolve('scripts/hooks/user-prompt-intent.js');
const CLAUDE_TOOL = 'mcp__plugin_memesh_memesh__private_session';
const SENTENCE = '我相信人類不可能在提示裡輸入這個<private> tag';

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
let n = 0;

// Claude Code rows.
const claudeUser = (text: string) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const claudeText = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const claudeCall = (name: string, input: object = {}) => {
  const id = `tu_${++n}`;
  return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }, id] as const;
};
const claudeResult = (id: string, content: string, isError = false) =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
const claudeEdits = () => ['a', 'b', 'c', 'd'].flatMap((f) => {
  const [call, id] = claudeCall('Edit', { file_path: `/repo/src/${f}.ts` });
  return [call, claudeResult(id, 'ok')];
});
const claudePrivateCall = (isError = false) => {
  const [call, id] = claudeCall(CLAUDE_TOOL);
  return [call, claudeResult(id, isError ? 'tool failed' : 'Automatic saving stops for this session.', isError)];
};

// Codex rollout rows.
const done = (item: object) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 't1', turn_id: 'u1', item } });
const codexEdits = () => [
  ...[1, 2, 3].flatMap((i) => {
    const call_id = `call_${++n}`;
    return [
      { type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id, name: 'exec', input: `text(await tools.exec_command({ cmd: "echo step-${i}" }));` } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }] } },
    ];
  }),
  done({ type: 'FileChange', id: `fc${++n}`, changes: { '/repo/src/a.ts': { type: 'update' } }, status: 'completed', stdout: '', stderr: '' }),
];
const codexMcpCall = (tool: string, status = 'completed', args: object = {}) => done({
  type: 'McpToolCall', id: `mc${++n}`, server: 'memesh', tool, arguments: args, status, duration: { secs: 0, nanos: 1 },
  // A failed call carries `error` and no `result`, as Codex writes it.
  ...(status === 'failed' ? { error: { message: 'tool failed' } } : { result: { content: [{ type: 'text', text: 'ok' }] } }),
});
const codexScript = (input: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: `call_${++n}`, name: 'exec', input } });
const CONFIRMATION = 'Automatic saving stops for this session.';
const codexScriptCall = (callId: string, input: string) =>
  ({ type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'exec', input } });
const codexScriptOutput = (callId: string, text: string) =>
  ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text }] } });
const CALL_SCRIPT = 'const r = await tools.mcp__memesh__private_session({});\ntext(JSON.stringify(r));';
/** The first line of a forked rollout: Codex names the thread it was forked from in `forked_from_id`. */
const codexForkMeta = (id: string, parent: string) => ({
  type: 'session_meta',
  payload: { id, forked_from_id: parent },
});
const codexMeta = (id: string) => ({ type: 'session_meta', payload: { id, thread_source: 'user' } });
const codexFunctionCall = (namespace: string, name: string) =>
  ({ type: 'response_item', payload: { type: 'function_call', call_id: `call_${++n}`, namespace, name, arguments: '{}' } });
const codexCompacted = (toolName: string) =>
  ({ type: 'compacted', payload: { message: '', replacement_history_metadata: [{ mcp_attribution: { status: 'ok', sources: [{ first_turn_id: 'u1', server_name: 'memesh', tool_name: toolName }] } }] } });
const codexMessage = (role: string, type: string, text: string) =>
  ({ type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } });

describe('the detector reads call records only', () => {
  const call = (rows: object[]) => transcriptCallsPrivateTool(jsonl(rows));

  it('finds a Claude Code tool_use of the tool, with any server prefix', () => {
    expect(call([claudeUser('hi'), ...claudePrivateCall()])).toBe(true);
    expect(call([claudeCall('mcp__memesh__private_session')[0]])).toBe(true);
  });

  it('counts a call whose result is an error', () => {
    expect(call([...claudePrivateCall(true)])).toBe(true);
  });

  it('finds a Codex McpToolCall of the tool, completed or failed', () => {
    expect(call([codexMcpCall('private_session')])).toBe(true);
    expect(call([codexMcpCall('private_session', 'failed')])).toBe(true);
  });

  it('finds the other structural forms Codex writes: a function call in the memesh namespace, a compacted history that names it', () => {
    expect(call([codexFunctionCall('mcp__memesh', 'private_session')])).toBe(true);
    expect(call([codexCompacted('private_session')])).toBe(true);
  });

  describe('a Codex thread forked from another (it inherits the parent\'s response items, not its events)', () => {
    let root: string;
    let sessions: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-fork-'));
      sessions = path.join(root, '.codex', 'sessions', '2026', '11', '02');
      fs.mkdirSync(sessions, { recursive: true });
    });
    afterEach(() => removeTempDir(root));
    const rollout = (id: string, rows: object[]) => {
      const file = path.join(sessions, `rollout-2026-11-02T00-00-00-${id}.jsonl`);
      fs.writeFileSync(file, jsonl(rows));
      return file;
    };
    const PARENT = '01a00000-0000-7000-8000-000000000001';
    const CHILD = '01a00000-0000-7000-8000-000000000002';
    const GRANDCHILD = '01a00000-0000-7000-8000-000000000003';

    it('is private when its parent is, whatever the child itself holds (only the parent\'s own rollout decides)', () => {
      rollout(PARENT, [codexMeta(PARENT), codexMcpCall('private_session', 'failed')]);
      const quiet = rollout(CHILD, [codexForkMeta(CHILD, PARENT), codexMessage('user', 'input_text', 'hello')]);
      expect(transcriptFileCallsPrivateTool(quiet)).toBe(true);
      const withScript = rollout(GRANDCHILD, [codexForkMeta(GRANDCHILD, PARENT), codexScriptCall('c1', CALL_SCRIPT)]);
      expect(transcriptFileCallsPrivateTool(withScript)).toBe(true);
    });

    it('follows a fork of a fork', () => {
      rollout(PARENT, [codexMeta(PARENT), codexMcpCall('private_session')]);
      rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      const grandchild = rollout(GRANDCHILD, [codexForkMeta(GRANDCHILD, CHILD)]);
      expect(transcriptFileCallsPrivateTool(grandchild)).toBe(true);
    });

    it('is not private when its parent is not, even if an inherited script mentions the call and prints the confirmation sentence', () => {
      rollout(PARENT, [codexMeta(PARENT), codexScriptCall('m1', '// tools.mcp__memesh__private_session( is the call\nawait tools.exec_command({ cmd: "rg -n Automatic src/core" });')]);
      const child = rollout(CHILD, [
        codexForkMeta(CHILD, PARENT),
        codexScriptCall('m1', '// tools.mcp__memesh__private_session( is the call\nawait tools.exec_command({ cmd: "rg -n Automatic src/core" });'),
        codexScriptOutput('m1', `src/core/private-session.ts:22:  '${CONFIRMATION}'`),
      ]);
      expect(transcriptFileCallsPrivateTool(child)).toBe(false);
    });

    const checkFailure = (file: string, options?: { cacheDir?: string }) => {
      const state = decideFile(file, options);
      return state.state === 'unchecked' ? state.reason : 'no error';
    };

    it.each(['forked_from_id', 'parent_thread_id'])('reads the parent named by %s alone, with no history ordinal', (field) => {
      rollout(PARENT, [codexMeta(PARENT), codexMcpCall('private_session')]);
      const child = rollout(CHILD, [{ type: 'session_meta', payload: { id: CHILD, [field]: PARENT } }]);
      expect(transcriptFileCallsPrivateTool(child)).toBe(true);
      const other = rollout(GRANDCHILD, [{ type: 'session_meta', payload: { id: GRANDCHILD, [field]: '01a00000-0000-7000-8000-0000000000ff' } }]);
      expect(checkFailure(other)).toBe('parent_not_found');
    });

    it('cannot tell when the parent rollout is not there, whatever the child inherited: it is unknown, not private by its text and not plain', () => {
      const inherited = rollout(CHILD, [codexForkMeta(CHILD, PARENT), codexScriptCall('c1', CALL_SCRIPT)]);
      expect(checkFailure(inherited)).toBe('parent_not_found');
      const quiet = rollout(GRANDCHILD, [codexForkMeta(GRANDCHILD, PARENT)]);
      expect(checkFailure(quiet)).toBe('parent_not_found');
      const plain = rollout('01a00000-0000-7000-8000-000000000004', [codexMeta('x'), codexScriptCall('c1', CALL_SCRIPT)]);
      expect(transcriptFileCallsPrivateTool(plain), 'a thread that is not a fork holds no call').toBe(false);
    });

    it('follows five parents and gives up on a sixth or seventh: a chain too long is unknown', () => {
      const ids = Array.from({ length: 8 }, (_, i) => `01a00000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`);
      rollout(ids[7], [codexMeta(ids[7]), codexMcpCall('private_session')]);
      for (let i = 6; i >= 0; i--) rollout(ids[i], [codexForkMeta(ids[i], ids[i + 1])]);
      // ids[k] has 7-k ancestors.
      expect(transcriptFileCallsPrivateTool(path.join(sessions, `rollout-2026-11-02T00-00-00-${ids[2]}.jsonl`)), 'five parents').toBe(true);
      expect(checkFailure(path.join(sessions, `rollout-2026-11-02T00-00-00-${ids[1]}.jsonl`)), 'six parents').toBe('fork_too_deep');
      expect(checkFailure(path.join(sessions, `rollout-2026-11-02T00-00-00-${ids[0]}.jsonl`)), 'seven parents').toBe('fork_too_deep');
    });

    it.skipIf(!canDenyReads)('cannot tell when the parent rollout cannot be read', () => {
      const parent = rollout(PARENT, [codexMeta(PARENT), codexMcpCall('private_session')]);
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      fs.chmodSync(parent, 0o000);
      try { expect(checkFailure(child)).toBe('parent_unreadable'); } finally { fs.chmodSync(parent, 0o644); }
    });

    it.skipIf(typeof zlib.zstdCompressSync !== 'function')('finds a parent that was archived, plain or compressed', () => {
      const archived = path.join(root, '.codex', 'archived_sessions');
      fs.mkdirSync(archived, { recursive: true });
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      const plain = path.join(archived, `rollout-2026-11-02T00-00-00-${PARENT}.jsonl`);
      fs.writeFileSync(plain, jsonl([codexMeta(PARENT), codexMcpCall('private_session')]));
      expect(transcriptFileCallsPrivateTool(child), 'archived, plain').toBe(true);
      fs.rmSync(plain);
      const zst = `${plain}.zst`;
      fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(jsonl([codexMeta(PARENT), codexMcpCall('private_session')]))));
      expect(transcriptFileCallsPrivateTool(child), 'archived, zstd, private').toBe(true);
      const quiet = rollout(GRANDCHILD, [codexForkMeta(GRANDCHILD, '01a00000-0000-7000-8000-000000000009')]);
      fs.writeFileSync(path.join(archived, 'rollout-2026-11-02T00-00-00-01a00000-0000-7000-8000-000000000009.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(jsonl([codexMeta('p'), codexEdits()[0]]))));
      expect(transcriptFileCallsPrivateTool(quiet), 'archived, zstd, not private').toBe(false);
      fs.writeFileSync(zst, 'not zstd');
      expect(checkFailure(child), 'a damaged archive').toBe('parent_unreadable');
    });

    it.skipIf(typeof zlib.zstdCompressSync !== 'function')('reads a private archived parent as private, and cannot tell, and says so, when this Node has no zstd', () => {
      const archived = path.join(root, '.codex', 'archived_sessions');
      fs.mkdirSync(archived, { recursive: true });
      fs.writeFileSync(path.join(archived, `rollout-2026-11-02T00-00-00-${PARENT}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(jsonl([codexMeta(PARENT), codexMcpCall('private_session')]))));
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      expect(transcriptFileCallsPrivateTool(child), 'with zstd: the archived parent is read and is private').toBe(true);
      // A new archive (another size, so not the remembered verdict), read by a Node without zstd.
      fs.writeFileSync(path.join(archived, `rollout-2026-11-02T00-00-00-${PARENT}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(jsonl([codexMeta(PARENT), codexEdits()[0], codexMcpCall('private_session')]))));
      const real = (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync;
      (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync = undefined;
      try {
        expect(checkFailure(child)).toBe('no_zstd');
      } finally { (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync = real; }
    });

    it('finds a rollout from what a directory entry says it is: only a symbolic link costs a stat', () => {
      const codexHome = path.join(root, '.codex');
      for (let i = 0; i < 20; i++) rollout(`01a00000-0000-7000-8000-0000000003${String(i).padStart(2, '0')}`, [codexMeta('x')]);
      const real = fs.statSync;
      let stats = 0;
      const spy = vi.spyOn(fs, 'statSync').mockImplementation(((...args: unknown[]) => { stats++; return (real as (...a: unknown[]) => fs.Stats)(...args); }) as typeof fs.statSync);
      try {
        expect(findCodexRollout(codexHome, '01a00000-0000-7000-8000-000000000305')?.file).toContain('000000000305');
        expect(stats, 'a plain tree is walked without a stat of any entry').toBe(0);
        fs.symlinkSync(path.join(codexHome, 'sessions', '2026'), path.join(codexHome, 'sessions', 'linked-year'));
        expect(findCodexRollout(codexHome, '01a00000-0000-7000-8000-000000000399')).toBeUndefined();
        expect(stats, 'the link is followed with one stat').toBeGreaterThan(0);
      } finally { spy.mockRestore(); }
    });

    it('follows a symbolic link to the parent rollout and to a day folder', () => {
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      const real = path.join(elsewhere, `rollout-2026-11-02T00-00-00-${PARENT}.jsonl`);
      fs.writeFileSync(real, jsonl([codexMeta(PARENT), codexMcpCall('private_session')]));
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      fs.symlinkSync(real, path.join(sessions, path.basename(real)));
      expect(transcriptFileCallsPrivateTool(child), 'a linked file').toBe(true);
      fs.rmSync(path.join(sessions, path.basename(real)));
      fs.symlinkSync(elsewhere, path.join(root, '.codex', 'sessions', '2026', '11', '03'));
      expect(transcriptFileCallsPrivateTool(child), 'a linked folder').toBe(true);
    });

    it('does not scan a parent over the size limit, and does not read a damaged header as "not a fork"', () => {
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      const parent = rollout(PARENT, [codexMeta(PARENT)]);
      fs.truncateSync(parent, 1024 * 1024 * 1024 + 1); // a sparse file: nothing is written
      const opened: string[] = [];
      const realOpen = fs.openSync;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => { opened.push(String(p)); return (realOpen as (...a: unknown[]) => number)(p, ...rest); }) as typeof fs.openSync);
      try { expect(checkFailure(child)).toBe('parent_too_large'); } finally { spy.mockRestore(); }
      expect(opened, 'decided by its size: the parent is never opened').not.toContain(parent);
      const bom = rollout(GRANDCHILD, []);
      fs.writeFileSync(bom, `\uFEFF${JSON.stringify(codexForkMeta(GRANDCHILD, PARENT))}\n`);
      expect(checkFailure(bom)).toBe('header_unreadable');
    });

    it('reads a fork header that has no newline after it, and an id that is not a plain token finds nothing', () => {
      const child = path.join(sessions, `rollout-2026-11-02T00-00-00-${CHILD}.jsonl`);
      fs.writeFileSync(child, JSON.stringify(codexForkMeta(CHILD, PARENT))); // one line, no trailing newline
      expect(checkFailure(child), 'a one-line fork file is still a fork').toBe('parent_not_found');
      for (const id of ['../outside', 'a/b', '']) {
        const odd = rollout(GRANDCHILD, [{ type: 'session_meta', payload: { id: GRANDCHILD, forked_from_id: id === '' ? 'x' : id } }]);
        fs.writeFileSync(path.join(sessions, 'rollout-2026-11-02T00-00-00-outside.jsonl'), jsonl([codexMeta('outside'), codexMcpCall('private_session')]));
        expect(checkFailure(odd), `id ${JSON.stringify(id)}`).toBe('parent_not_found');
      }
    });

    it('takes only a file named rollout-…-<id>.jsonl for the parent', () => {
      fs.writeFileSync(path.join(sessions, `notes-for-${PARENT}.jsonl`), jsonl([codexMeta(PARENT), codexMcpCall('private_session')]));
      fs.writeFileSync(path.join(sessions, `rollout-2026-11-02T00-00-00-${PARENT}.json`), jsonl([codexMeta(PARENT), codexMcpCall('private_session')]));
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      expect(checkFailure(child)).toBe('parent_not_found');
    });

    it('finds a call made inside a subagent\'s transcript of the session, and fails closed when that transcript is too large or cannot be read', () => {
      const main = rollout('01a00000-0000-7000-8000-0000000000e1', [claudeUser('go')]);
      fs.mkdirSync(path.join(sessions, 'rollout-2026-11-02T00-00-00-01a00000-0000-7000-8000-0000000000e1', 'subagents'), { recursive: true });
      const sub = path.join(sessions, 'rollout-2026-11-02T00-00-00-01a00000-0000-7000-8000-0000000000e1', 'subagents', 'agent-a1.jsonl');
      fs.writeFileSync(sub, jsonl([claudeUser('inner')]));
      expect(transcriptFileCallsPrivateTool(main), 'a subagent that made no call').toBe(false);
      fs.writeFileSync(sub, jsonl([...claudePrivateCall()]));
      expect(transcriptFileCallsPrivateTool(main), 'a subagent that called the tool').toBe(true);
      fs.writeFileSync(sub, jsonl([claudeUser('inner')]));
      // The session's files together past the limit: not scanned at all (sparse, so nothing is written).
      fs.truncateSync(sub, 2 * 1024 * 1024 * 1024 + 1);
      expect(checkFailure(main)).toBe('too_large');
      fs.writeFileSync(sub, jsonl([claudeUser('inner')]));
      if (canDenyReads) {
        fs.chmodSync(sub, 0o000);
        try { expect(checkFailure(main), 'a subagent transcript that cannot be read (Q6_01 F2)').toBe('unreadable'); } finally { fs.chmodSync(sub, 0o644); }
      }
    });

    it.each([
      ['an empty string', { forked_from_id: '' }],
      ['an empty parent_thread_id', { parent_thread_id: '' }],
      ['a number', { forked_from_id: 7 }],
      ['an object', { parent_thread_id: { id: 'x' } }],
      ['an empty string next to a valid parent', { forked_from_id: '', parent_thread_id: PARENT }],
    ])('cannot tell when a fork field is %s: a damaged header, never "not a fork"', (_label, fields) => {
      rollout(PARENT, [codexMeta(PARENT)]);
      const child = rollout(CHILD, [{ type: 'session_meta', payload: { id: CHILD, ...fields } }]);
      expect(checkFailure(child)).toBe('header_unreadable');
    });

    it('reads a rollout with neither fork field as a thread that is not a fork', () => {
      const plain = rollout(CHILD, [{ type: 'session_meta', payload: { id: CHILD, thread_source: 'user', forked_from_id: null } }]);
      expect(transcriptFileCallsPrivateTool(plain)).toBe(false);
    });

    const cacheKey = (file: string) => {
      const st = fs.statSync(file);
      return `${file}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`;
    };
    /** One cache entry per file, named by its path (a new key replaces the entry rather than adding one). */
    const entryFile = (cacheDir: string, key: string) => path.join(cacheDir, `${createHash('sha256').update(key.split('\0')[0]).digest('hex').slice(0, 40)}.json`);
    const askFresh = (child: string, cacheDir: string) => spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { decidePrivacy as d } from ${JSON.stringify(path.resolve('scripts/hooks/_generated/private-session.js'))};` +
      `console.log(d({ transcriptPath: ${JSON.stringify(child)}, memeshDir: ${JSON.stringify(NO_MARKERS)}, deadlineAt: Date.now() + 60000, cacheDir: ${JSON.stringify(cacheDir)} }).state === 'yes');`], { encoding: 'utf8' });

    it('remembers a parent in memory: asking again does not open the parent again', () => {
      const parent = rollout(PARENT, [codexMeta(PARENT), ...codexEdits()]);
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      const opened: string[] = [];
      const real = fs.openSync;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => { opened.push(String(p)); return (real as (...a: unknown[]) => number)(p, ...rest); }) as typeof fs.openSync);
      try {
        expect(transcriptFileCallsPrivateTool(child)).toBe(false);
        expect(transcriptFileCallsPrivateTool(child)).toBe(false);
      } finally { spy.mockRestore(); }
      expect(opened.filter((p) => p === parent)).toHaveLength(1);
      expect(opened.filter((p) => p === child), 'the child\'s own verdict is remembered too').toHaveLength(1);
    });

    it('remembers a parent on disk: a fresh process answers from the entry without reading the parent', () => {
      const cacheDir = path.join(root, 'cache');
      const parent = rollout(PARENT, [codexMeta(PARENT), ...codexEdits()]);
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      expect(transcriptFileCallsPrivateTool(child, { cacheDir })).toBe(false);
      const key = cacheKey(parent);
      expect(JSON.parse(fs.readFileSync(entryFile(cacheDir, key), 'utf8'))).toMatchObject({ key, found: false });
      // The entry says "private" though the parent is not: only an answer taken from the entry can be true.
      fs.writeFileSync(entryFile(cacheDir, key), JSON.stringify({ key, found: true, forks: [], headerBroken: false }));
      expect(askFresh(child, cacheDir).stdout.trim()).toBe('true');
    });

    it('re-reads the parent when its entry is damaged or belongs to another key', () => {
      const cacheDir = path.join(root, 'cache');
      const parent = rollout(PARENT, [codexMeta(PARENT), ...codexEdits()]);
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      const key = cacheKey(parent);
      fs.mkdirSync(cacheDir);
      fs.writeFileSync(entryFile(cacheDir, key), '{damaged');
      expect(askFresh(child, cacheDir).stdout.trim()).toBe('false');
      fs.writeFileSync(entryFile(cacheDir, key), JSON.stringify({ key: `${key}x`, found: true, forks: [], headerBroken: false }));
      expect(askFresh(child, cacheDir).stdout.trim(), 'an entry for another key is not trusted').toBe('false');
    });

    it('reads a parent again when it was replaced by one of the same size and the same modification time', () => {
      const cacheDir = path.join(root, 'cache');
      const privateText = jsonl([codexMeta(PARENT), codexMcpCall('private_session')]);
      const plainText = privateText.replace('"private_session"', '"private_sessio_"'); // as long, and not a call
      expect(plainText.length).toBe(privateText.length);
      const parent = path.join(sessions, `rollout-2026-11-02T00-00-00-${PARENT}.jsonl`);
      fs.writeFileSync(parent, plainText);
      fs.utimesSync(parent, 1_700_000_000, 1_700_000_000);
      const child = rollout(CHILD, [codexForkMeta(CHILD, PARENT)]);
      expect(transcriptFileCallsPrivateTool(child, { cacheDir })).toBe(false);
      const replacement = `${parent}.new`;
      fs.writeFileSync(replacement, privateText);
      fs.utimesSync(replacement, 1_700_000_000, 1_700_000_000);
      fs.renameSync(replacement, parent);
      expect(fs.statSync(parent).size).toBe(plainText.length);
      expect(fs.statSync(parent).mtimeMs).toBe(1_700_000_000_000);
      expect(transcriptFileCallsPrivateTool(child, { cacheDir }), 'in the same process').toBe(true);
      expect(askFresh(child, cacheDir).stdout.trim(), 'in a fresh process').toBe('true');
    });

    it('does not look for a parent whose id is not a plain token, even where a file name would fit it', () => {
      // `rollout-<date>-rollout-x-a.b.jsonl` ends in `-a.b.jsonl`: only the id check keeps it from being taken for the parent of "a.b".
      rollout('rollout-x-a.b', [codexMeta('a.b'), codexMcpCall('private_session')]);
      const child = rollout(CHILD, [{ type: 'session_meta', payload: { id: CHILD, forked_from_id: 'a.b' } }]);
      expect(checkFailure(child)).toBe('parent_not_found');
    });
  });

  it('does not count look-alikes of those forms', () => {
    expect(call([
      codexFunctionCall('mcp__memesh', 'recall'),
      codexFunctionCall('other', 'private_session'),
      codexCompacted('recall'),
      claudeCall('mcp__memesh__private_session_extra')[0],
      claudeCall('xmcp__memesh__private_session')[0],
      claudeCall('mcp____private_session')[0],
      claudeCall('private_session_extra')[0],
      { type: 'compacted', payload: { replacement_history_metadata: [{ note: 'private_session' }], message: 'private_session' } },
    ])).toBe(false);
  });

  it.each(['mcp__memesh__private_session', 'mcp__memesh-dev__private_session', 'mcp__mymem__private_session', 'mcp__plugin_other_server__private_session'])(
    'finds a call under any server name the user registered: %s', (name) => {
      expect(call([claudeCall(name)[0]])).toBe(true);
    });

  it('finds a Codex function call under any server namespace', () => {
    expect(call([codexFunctionCall('mcp__mymem', 'private_session')])).toBe(true);
  });

  it('finds a call nested in a subagent\'s progress row, and not one that only sits in a tool result or a tool input', () => {
    const nested = (inner: object) => ({ type: 'progress', data: { type: 'agent_progress', message: { type: 'assistant', message: { content: [inner] } } } });
    expect(call([nested({ type: 'tool_use', id: 'x', name: CLAUDE_TOOL, input: {} })])).toBe(true);
    expect(call([nested({ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'tool_use', name: CLAUDE_TOOL }] })])).toBe(false);
    expect(call([nested({ type: 'tool_use', id: 'y', name: 'Write', input: { content: { type: 'tool_use', name: CLAUDE_TOOL } } })])).toBe(false);
  });

  it.each([
    ['a comment', '// later: tools.mcp__memesh__private_session({})\nawait tools.exec_command({ cmd: "echo hi" });'],
    ['a string', 'const doc = "call tools.mcp__memesh__private_session({}) to stop saving";\ntext(doc);'],
    ['rg', 'await tools.exec_command({ cmd: "rg -nF \'tools.mcp__memesh__private_session(\' src/core" });'],
    ['apply_patch', 'await tools.apply_patch(`*** Begin Patch\n*** Update File: t.ts\n@@\n-x\n+await tools.mcp__memesh__private_session({});\n*** End Patch`);'],
    ['a template literal', 'const line = `await tools.mcp__memesh__private_session({})`;\ntext(line);'],
  ])('does not count the text of a Codex script: %s', (_label, script) => {
    expect(call([codexScript(script)])).toBe(false);
  });

  it('does not count text, results, other tools or other record types that name the tool', () => {
    const [recall, recallId] = claudeCall('mcp__plugin_memesh_memesh__recall', { query: 'private_session' });
    expect(call([
      claudeUser(`please call ${CLAUDE_TOOL}`),
      claudeUser(SENTENCE),
      claudeText(`I would call ${CLAUDE_TOOL} for that.`),
      recall, claudeResult(recallId, `the ${CLAUDE_TOOL} tool exists`),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo private_session' } }] } },
      codexMessage('user', 'input_text', 'private_session'),
      codexMessage('assistant', 'output_text', 'private_session'),
      codexMcpCall('recall', 'completed', { query: 'private_session' }),
      done({ type: 'AgentMessage', tool: 'private_session', text: 'private_session' }),
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x', output: 'private_session' } },
    ])).toBe(false);
  });

  it('skips a line it cannot read and keeps going', () => {
    expect(transcriptCallsPrivateTool(`{"type":"assistant", private_session\n${jsonl([...claudePrivateCall()])}`)).toBe(true);
  });

  describe('over a large file', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-private-switch-')); });
    afterEach(() => removeTempDir(dir));
    const CHUNK = 8 * 1024 * 1024;

    it.each([CHUNK - 40, CHUNK, CHUNK + 40, 2 * CHUNK - 10])('finds the call when its line starts %i bytes in', (offset) => {
      const file = path.join(dir, 't.jsonl');
      const head = `${'x'.repeat(offset - 1)}\n`;
      fs.writeFileSync(file, head + jsonl([...claudePrivateCall()]));
      expect(transcriptFileCallsPrivateTool(file)).toBe(true);
      fs.writeFileSync(file, head + jsonl([claudeText(`mentions ${CLAUDE_TOOL}`)]));
      expect(transcriptFileCallsPrivateTool(file)).toBe(false);
    });

    it('finds a call on the last line with no trailing newline', () => {
      const file = path.join(dir, 't.jsonl');
      fs.writeFileSync(file, jsonl([claudeUser('hi')]) + JSON.stringify(claudePrivateCall()[0]));
      expect(transcriptFileCallsPrivateTool(file)).toBe(true);
    });

    it('cannot check a path it cannot read (unchecked), and finds nothing in a transcript that is not there (no)', () => {
      fs.mkdirSync(path.join(dir, 'a-folder.jsonl'));
      expect(() => transcriptFileCallsPrivateTool(path.join(dir, 'a-folder.jsonl'))).toThrow();
      expect(transcriptFileCallsPrivateTool(path.join(dir, 'missing.jsonl'))).toBe(false);
    });
  });
});

describe('the hooks, end to end', () => {
  let home: string;
  let projectDir: string;
  let transcript: string;
  let memoryDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-private-switch-hook-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    projectDir = path.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    transcript = path.join(projectDir, 'sess-1.jsonl');
    memoryDir = path.join(projectDir, 'memory');
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'a.md'), '---\nname: switch_note_a\ndescription: Switch alpha\nmetadata:\n  type: decision\n---\n\nalpha body\n');
  });
  afterEach(() => removeTempDir(home));

  const run = (hook: string, extra: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
    delete env.MEMESH_DB_PATH;
    delete env.MEMESH_DIR;
    delete env.CLAUDE_CONFIG_DIR; // a Codex session's notes are looked for under Claude Code's projects folder: the test's own
    const r = spawnSync('node', [hook], {
      input: JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: home, hook_event_name: 'Stop', last_assistant_message: 'I changed the parser and the lexer, updated their tests, and all of the tests pass now. The next step is the release notes.', ...extra }),
      env, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    return r;
  };
  const names = (): string[] => {
    const file = path.join(home, '.memesh', 'knowledge-graph.db');
    if (!fs.existsSync(file)) return [];
    const db = new MemeshDatabase(file, { readOnly: true });
    try { return (db.prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map((r) => r.name); } finally { db.close(); }
  };
  const outcomes = (hook: string) => {
    const file = path.join(home, '.memesh', 'hook-outcomes.jsonl');
    return (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
      .filter((r) => r.hook === hook);
  };
  const stop = (rows: object[]) => { fs.writeFileSync(transcript, jsonl(rows)); run(STOP); };

  const hosts = {
    'Claude Code': { work: claudeEdits, asked: () => claudePrivateCall(), summary: /^session-/ },
    Codex: { work: codexEdits, asked: () => [codexMcpCall('private_session')], summary: /^session-/ },
  };

  describe.each(Object.entries(hosts))('%s transcript', (_host, h) => {
    it('writes the session, the handoff and the notes when the tool was not called', () => {
      stop([claudeUser('fix the parser'), ...h.work()]);
      const stored = names();
      expect(stored.some((name) => h.summary.test(name)), stored.join(',')).toBe(true);
      expect(stored.some((name) => name.startsWith(SESSION_HANDOFF_TYPE))).toBe(true);
      expect(stored).toContain('switch_note_a');
    });

    it('writes nothing when the tool was called, and leaves one outcome record per hook, with no content', () => {
      stop([claudeUser('fix the parser'), ...h.work(), ...h.asked()]);
      expect(outcomes('session-summary').length, 'the hook ran').toBeGreaterThan(0);
      expect(names()).toEqual([]);
      for (const hook of ['session-summary', 'handoff-capture', 'note-ingest', 'remember-nudge']) {
        const last = outcomes(hook).at(-1);
        expect(last, hook).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
        expect(Object.keys(last).sort(), hook).toEqual(['at', 'hook', 'host', 'outcome', 'reason', 'run']);
      }
    });
  });

  it.each([
    ['a user message with the sentence about the tag', () => [claudeUser(SENTENCE)]],
    ['an assistant message naming the tool', () => [claudeText(`You can ask me to call ${CLAUDE_TOOL}.`)]],
    ['the tool name inside a tool result', () => {
      const [call, id] = claudeCall('Read', { file_path: '/repo/README.md' });
      return [call, claudeResult(id, `the ${CLAUDE_TOOL} tool, <private>not a tag</private>`)];
    }],
  ])('keeps writing normally with %s', (_label, extra) => {
    stop([claudeUser('fix the parser'), ...extra(), ...claudeEdits()]);
    const stored = names();
    expect(stored.some((name) => name.startsWith('session-'))).toBe(true);
    expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'wrote' });
  });

  it.each([
    ['a comment', '// later: tools.mcp__memesh__private_session({})\ntext("x");'],
    ['a string', 'const doc = "call tools.mcp__memesh__private_session({}) to stop saving";\ntext(doc);'],
    ['rg', 'await tools.exec_command({ cmd: "rg -nF \'tools.mcp__memesh__private_session(\' src/core" });'],
    ['apply_patch', 'await tools.apply_patch(`*** Begin Patch\n*** Update File: t.ts\n@@\n-x\n+await tools.mcp__memesh__private_session({});\n*** End Patch`);'],
    ['a template literal', 'const line = `await tools.mcp__memesh__private_session({})`;\ntext(line);'],
  ])('keeps writing normally when a Codex script only contains the call as text: %s', (_label, script) => {
    stop([codexScript(script), ...codexEdits()]);
    expect(names().some((name) => name.startsWith('session-'))).toBe(true);
    expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'wrote' });
  });

  describe('a Codex thread forked from another, through the real hooks', () => {
    const PARENT = '01a00000-0000-7000-8000-0000000000a1';
    const CHILD = '01a00000-0000-7000-8000-0000000000a2';
    const forkFile = (id: string, rows: object[]) => {
      const dir = path.join(home, '.codex', 'sessions', '2026', '11', '02');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-2026-11-02T00-00-00-${id}.jsonl`);
      fs.writeFileSync(file, jsonl(rows));
      return file;
    };

    it('R-A (Codex): a fork whose parent could not be found once is stored normally once the parent is there and not private', () => {
      const child = forkFile(CHILD, [codexForkMeta(CHILD, PARENT), ...codexEdits()]);
      run(STOP, { session_id: CHILD, transcript_path: child });
      expect(names()).toEqual([]);
      expect(fs.existsSync(path.join(home, '.memesh', 'private-sessions', `${CHILD}.json`)), 'unchecked never writes a marker').toBe(false);
      forkFile(PARENT, [codexMeta(PARENT), ...codexEdits()]);
      const before = outcomes('session-summary').length;
      run(STOP, { session_id: CHILD, transcript_path: child });
      expect(outcomes('session-summary').slice(before).map((r) => r.outcome)).toContain('wrote');
      expect(outcomes('session-summary').slice(before).map((r) => r.reason)).not.toContain('private_session');
    });

    it('writes nothing when the parent is private, and records why', () => {
      forkFile(PARENT, [codexMeta(PARENT), codexMcpCall('private_session')]);
      const child = forkFile(CHILD, [codexForkMeta(CHILD, PARENT), ...codexEdits()]);
      run(STOP, { session_id: CHILD, transcript_path: child });
      expect(outcomes('session-summary').length, 'the hook ran').toBeGreaterThan(0);
      expect(names()).toEqual([]);
      expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
    });

    it.each(['forked_from_id', 'parent_thread_id'])('writes nothing when the parent named by %s alone is private', (field) => {
      forkFile(PARENT, [codexMeta(PARENT), codexMcpCall('private_session')]);
      const child = forkFile(CHILD, [{ type: 'session_meta', payload: { id: CHILD, [field]: PARENT } }, ...codexEdits()]);
      run(STOP, { session_id: CHILD, transcript_path: child });
      expect(names()).toEqual([]);
      expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
    });

    it('writes nothing and records an error when the parent rollout cannot be found', () => {
      const child = forkFile(CHILD, [codexForkMeta(CHILD, PARENT), ...codexEdits()]);
      const r = run(STOP, { session_id: CHILD, transcript_path: child });
      expect(names()).toEqual([]);
      expect(outcomes('session-summary')).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: 'error', reason: expect.stringContaining('fork parent') }),
      ]));
      expect(r.stderr).toContain('parent rollout of this forked thread was not found');
    });

    describe('whatever cannot be settled about the ancestry is treated as private, through the real hooks', () => {
      const ids = Array.from({ length: 8 }, (_, i) => `01a00000-0000-7000-8000-0000000002${String(i).padStart(2, '0')}`);
      const setups: Array<[string, () => string, boolean]> = [
        ['the parent cannot be read', () => {
          const parent = forkFile(PARENT, [codexMeta(PARENT), codexMcpCall('private_session')]);
          const child = forkFile(CHILD, [codexForkMeta(CHILD, PARENT), ...codexEdits()]);
          fs.chmodSync(parent, 0o000);
          return child;
        }, canDenyReads],
        ['the parent is over the size limit', () => {
          const parent = forkFile(PARENT, [codexMeta(PARENT)]);
          fs.truncateSync(parent, 1024 * 1024 * 1024 + 1);
          return forkFile(CHILD, [codexForkMeta(CHILD, PARENT), ...codexEdits()]);
        }, true],
        ['the header is damaged', () => {
          const child = forkFile(CHILD, []);
          fs.writeFileSync(child, `\uFEFF${JSON.stringify(codexForkMeta(CHILD, PARENT))}\n${jsonl(codexEdits())}`);
          return child;
        }, true],
        ['the fork chain is more than five deep', () => {
          forkFile(ids[7], [codexMeta(ids[7]), codexMcpCall('private_session')]);
          for (let i = 6; i >= 1; i--) forkFile(ids[i], [codexForkMeta(ids[i], ids[i + 1])]);
          return forkFile(ids[0], [codexForkMeta(ids[0], ids[1]), ...codexEdits()]);
        }, true],
      ];

      // A setup this machine cannot make (no denied reads as root or on Windows) is skipped, not run as an empty pass.
      it.each(setups.filter(([, , runnable]) => runnable))('writes nothing and records an error when %s', (_label, setup) => {
        const child = setup();
        const r = run(STOP, { session_id: 'c', transcript_path: child });
        try {
          expect(names()).toEqual([]);
          const all = outcomes('session-summary');
          expect(all.some((rec: { outcome: string; reason?: string }) => rec.outcome === 'error' && String(rec.reason).includes('fork parent'))).toBe(true);
          expect(all.some((rec: { reason?: string }) => rec.reason === 'private_session'), 'a session nobody called the tool in is not labelled private').toBe(false);
          expect(outcomes('handoff-capture').at(-1)).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('could not be checked') });
          expect(outcomes('remember-nudge').at(-1)).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('could not be checked') });
          expect(r.stderr).toContain('nothing saved');
        } finally {
          try { fs.chmodSync(path.join(home, '.codex', 'sessions', '2026', '11', '02', `rollout-2026-11-02T00-00-00-${PARENT}.jsonl`), 0o644); } catch { /* not that case */ }
        }
      });

      it('saves nothing at PreCompact either', () => {
        const child = forkFile(CHILD, []);
        fs.writeFileSync(child, `${JSON.stringify({ type: 'session_meta', payload: { id: CHILD, forked_from_id: '' } })}\n${jsonl(codexEdits())}`);
        const r = run(PRE_COMPACT, { session_id: 'c', transcript_path: child, trigger: 'auto', hook_event_name: 'PreCompact' });
        expect(names()).toEqual([]);
        expect(r.stderr).toContain('nothing saved');
      });
    });

    it.each([
      ['an archived parent', (parent: string, rows: object[]) => {
        const dir = path.join(home, '.codex', 'archived_sessions');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, path.basename(parent)), jsonl(rows));
      }],
      ['a compressed archived parent', (parent: string, rows: object[]) => {
        const dir = path.join(home, '.codex', 'archived_sessions');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${path.basename(parent)}.zst`), zlib.zstdCompressSync(Buffer.from(jsonl(rows))));
      }],
      ['a parent behind a symbolic link', (parent: string, rows: object[]) => {
        const elsewhere = path.join(home, 'elsewhere');
        fs.mkdirSync(elsewhere, { recursive: true });
        fs.writeFileSync(path.join(elsewhere, path.basename(parent)), jsonl(rows));
        fs.symlinkSync(path.join(elsewhere, path.basename(parent)), parent);
      }],
    ])('writes nothing, and says the session is private, when the private parent is %s', (_label, place) => {
      if (_label.includes('compressed') && typeof zlib.zstdCompressSync !== 'function') return;
      const parentFile = path.join(home, '.codex', 'sessions', '2026', '11', '02', `rollout-2026-11-02T00-00-00-${PARENT}.jsonl`);
      fs.mkdirSync(path.dirname(parentFile), { recursive: true });
      place(parentFile, [codexMeta(PARENT), codexMcpCall('private_session')]);
      const child = forkFile(CHILD, [codexForkMeta(CHILD, PARENT), ...codexEdits()]);
      run(STOP, { session_id: CHILD, transcript_path: child });
      expect(names()).toEqual([]);
      expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
    });

    it('writes as a plain session would when the parent is not private, though an inherited script mentions the call and prints its confirmation sentence', () => {
      const mention = '// tools.mcp__memesh__private_session( is the call\nawait tools.exec_command({ cmd: "rg -n Automatic src/core" });';
      forkFile(PARENT, [codexMeta(PARENT), ...codexEdits()]);
      const child = forkFile(CHILD, [codexForkMeta(CHILD, PARENT), codexScriptCall('m1', mention), codexScriptOutput('m1', `src/core/private-session.ts:22:  '${CONFIRMATION}'`), ...codexEdits()]);
      run(STOP, { session_id: CHILD, transcript_path: child });
      expect(names().some((name) => name.startsWith('session-'))).toBe(true);
      expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'wrote' });
    });
  });

  it('keeps writing normally with a Codex user message about the tag and a Codex result naming the tool', () => {
    stop([codexMessage('user', 'input_text', SENTENCE), ...codexEdits(), { type: 'response_item', payload: { type: 'function_call_output', call_id: 'z', output: 'private_session' } }]);
    expect(names().some((name) => name.startsWith('session-'))).toBe(true);
  });

  describe('note files a private session names', () => {
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000); // relative to the moment of the call: a long run must not age the times
    const note = (file: string, name: string, body: string, when?: Date) => {
      fs.mkdirSync(path.dirname(path.join(memoryDir, file)), { recursive: true });
      fs.writeFileSync(path.join(memoryDir, file), `---\nname: ${name}\ndescription: ${name}\nmetadata:\n  type: decision\n---\n\n${body}\n`);
      if (when) fs.utimesSync(path.join(memoryDir, file), when, when);
    };
    const observations = (name: string): string => {
      const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'), { readOnly: true });
      try {
        return (db.prepare("SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ?").all(name) as Array<{ content: string }>).map((r) => r.content).join('|');
      } finally { db.close(); }
    };
    /** A tool input in a Claude Code transcript. */
    const tool = (name: string, input: object) => {
      const [call, id] = claudeCall(name, input);
      return [{ ...call, cwd: projectDir }, claudeResult(id, 'ok')];
    };
    const wrote = (file: string, name = 'Write') => tool(name, { file_path: path.join(memoryDir, file) });
    const bash = (command: string) => tool('Bash', { command });
    const transcriptOf = (id: string) => path.join(projectDir, `${id}.jsonl`);
    const session = (id: string, rows: object[], env: Record<string, string> = {}) => {
      fs.writeFileSync(transcriptOf(id), jsonl([claudeUser('go'), ...rows]));
      run(STOP, { session_id: id, transcript_path: transcriptOf(id) }, env);
    };
    const normal = (id: string, rows: object[] = []) => session(id, [...claudeEdits(), ...rows]);
    const end = (id: string) => run(SESSION_END, { session_id: id, transcript_path: transcriptOf(id), hook_event_name: 'SessionEnd', reason: 'other' });
    /** A private session that runs and ENDS: the later session in each test below starts after it is over. */
    const priv = (id: string, rows: object[] = []) => { session(id, [...claudeEdits(), ...rows, ...claudePrivateCall()]); end(id); };

    beforeEach(() => {
      normal('s-first'); // imports switch_note_a
      // In the past, never the future (§8.1): a future time made this note look changed after every marker, which is what let :983 pass by coincidence.
      note('existing.md', 'switch_note_existing', 'old body', at(-600));
      normal('s-second'); // imports the existing note
      expect(observations('switch_note_existing')).toContain('old body');
    });

    // Every shape reaches the transcript as text that names the file: no shell syntax is parsed.
    const shapes: Array<[string, (dir: string, file: string) => object[]]> = [
      ['Write', (_d, f) => wrote(f)],
      ['Edit', (_d, f) => wrote(f, 'Edit')],
      ['MultiEdit', (_d, f) => wrote(f, 'MultiEdit')],
      ['NotebookEdit', (d, f) => tool('NotebookEdit', { notebook_path: path.join(d, f) })],
      ['>', (d, f) => bash(`echo body > ${path.join(d, f)}`)],
      ['>>', (d, f) => bash(`printf body >> ${path.join(d, f)}`)],
      ['heredoc', (d, f) => bash(`cat <<'EOF' > ${path.join(d, f)}\nbody\nEOF`)],
      ['relative after cd', (d, f) => bash(`cd ${d} && echo body > ${f}`)],
      ['cp', (d, f) => bash(`cp ../src.md ${path.join(d, f)}`)],
      ['mv', (_d, f) => bash(`mv draft.txt ${f}`)],
      ['tee -a', (d, f) => bash(`echo body | tee -a ${path.join(d, f)}`)],
      ['install', (d, f) => bash(`install -m 600 src.md ${path.join(d, f)}`)],
      ['dd of=', (d, f) => bash(`dd if=src.md of=${path.join(d, f)}`)],
      ['python3 -c', (_d, f) => bash(`python3 -c "open('${f}', 'w').write('body')"`)],
      ['~ and $HOME', (_d, f) => bash(`echo body > ~/x/$HOME/${f}`)],
      ['x/../memory', (d, f) => bash(`echo body > ${d}/x/../${f}`)],
      ['//', (d, f) => bash(`echo body > ${d.replace('/memory', '//memory')}/${f}`)],
      ['upper case', (_d, f) => bash(`echo body > ${f.toUpperCase()}`)],
      ['only reading it', (_d, f) => bash(`cat ${f}`)],
      ['after a line break', (_d, f) => bash(`xargs rm <<'EOF'\n${f}\nEOF`)],
      ['after a tab', (_d, f) => tool('Task', { prompt: `Write these notes:\n\t${f}` })],
      ['an MCP file tool', (d, f) => tool('mcp__filesystem__write_file', { path: path.join(d, f), content: 'x' })],
    ];

    it.each(shapes)('is held out when the session names it with %s, and is not imported by a later normal session', (label, make) => {
      const file = `shape-${label.replace(/[^A-Za-z0-9]+/g, '-')}.md`;
      const name = `switch_note_${label.replace(/[^A-Za-z0-9]+/g, '_')}`;
      note(file, name, `SHAPE-${label}`);
      note(`other-${file}`, `${name}_other`, `OTHER-${label}`); // never named, older than the call: the later import must run and take it
      priv('s-private', make(memoryDir, file));
      normal('s-after-1');
      expect(names(), label).not.toContain(name);
      expect(names(), 'the later session did import').toContain(`${name}_other`);
      expect(names()).toContain('switch_note_existing'); // an unrelated, already imported note is untouched
    });

    it('does not hold a note whose name is only part of another name the session mentions', () => {
      note('na.md', 'switch_note_na', 'NA-BODY');
      note('banana.md', 'switch_note_banana', 'BANANA-BODY');
      priv('s-private', bash('echo body > banana.md'));
      normal('s-after-1');
      expect(names()).toContain('switch_note_na'); // "na.md" is inside "banana.md", but it is not that name
      expect(names()).not.toContain('switch_note_banana');
    });

    it('imports the same note when no session named it (the control the shapes above are measured against)', () => {
      note('control.md', 'switch_note_control', 'CONTROL');
      priv('s-private');
      normal('s-after-1');
      expect(names()).toContain('switch_note_control');
    });

    it('is held out through a symlinked alias of the folder', () => {
      const alias = path.join(home, 'alias-to-memory');
      fs.symlinkSync(memoryDir, alias);
      note('aliased.md', 'switch_note_aliased', 'ALIASED');
      priv('s-private', bash(`echo body > ${alias}/aliased.md`));
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_aliased');
    });

    it('leaves a note written by an ordinary session meanwhile (d.md) importable', () => {
      note('private.md', 'switch_note_private', 'PRIVATE-BODY');
      note('d.md', 'switch_note_d', 'ordinary body'); // an ordinary session wrote it; the private one never names it
      priv('s-private', wrote('private.md'));
      normal('s-after-1', wrote('d.md'));
      expect(names()).toContain('switch_note_d');
      expect(names()).not.toContain('switch_note_private');
    });

    it('does not release a held note on a touch, and imports it once its content differs', () => {
      note('private.md', 'switch_note_private', 'PRIVATE-BODY');
      priv('s-private', wrote('private.md'));
      fs.utimesSync(path.join(memoryDir, 'private.md'), at(90), at(90));
      note('a.md', 'switch_note_a', 'a changed body', at(91)); // another note changes too
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_private');
      note('private.md', 'switch_note_private', 'rewritten later', at(120));
      normal('s-after-2');
      expect(observations('switch_note_private')).toContain('rewritten later');
      expect(observations('switch_note_private')).not.toContain('PRIVATE-BODY');
    });

    it('keeps the old memory of an imported note the session edited, and imports a later edit', () => {
      note('existing.md', 'switch_note_existing', 'private edit', at(41));
      priv('s-private', wrote('existing.md', 'Edit'));
      normal('s-after-1');
      expect(observations('switch_note_existing')).toContain('old body');
      expect(observations('switch_note_existing')).not.toContain('private edit');
      note('existing.md', 'switch_note_existing', 'edited by someone else afterwards', at(130));
      normal('s-after-2');
      expect(observations('switch_note_existing')).toContain('edited by someone else afterwards');
    });

    it('holds a note even when auto-capture is off for the private Stop', () => {
      note('private.md', 'switch_note_private', 'PRIVATE-BODY');
      session('s-private', [...claudeEdits(), ...wrote('private.md'), ...claudePrivateCall()], { MEMESH_AUTO_CAPTURE: 'false' });
      end('s-private'); // the marker is gone: only the hold record keeps the note out
      expect(fs.readdirSync(path.join(home, '.memesh', 'note-ingest-holds'))).toEqual(['s-private.json']);
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_private');
    });

    it('holds a note written after the last Stop, through SessionEnd; and records that a normal session had nothing to hold', () => {
      priv('s-private');
      note('late.md', 'switch_note_late', 'LATE-BODY', at(60));
      fs.appendFileSync(transcriptOf('s-private'), jsonl(wrote('late.md')));
      run(SESSION_END, { session_id: 's-private', transcript_path: transcriptOf('s-private'), hook_event_name: 'SessionEnd', reason: 'other' });
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_late');
      normal('s-ordinary');
      note('late2.md', 'switch_note_late2', 'LATE2-BODY', at(70));
      fs.appendFileSync(transcriptOf('s-ordinary'), jsonl(wrote('late2.md')));
      run(SESSION_END, { session_id: 's-ordinary', transcript_path: transcriptOf('s-ordinary'), hook_event_name: 'SessionEnd', reason: 'other' });
      expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'not a private session' });
      normal('s-after-2');
      expect(names()).toContain('switch_note_late2');
    });

    it('holds a note when the database is locked during the private Stop', () => {
      note('private.md', 'switch_note_private', 'PRIVATE-BODY');
      const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
      db.exec('BEGIN EXCLUSIVE');
      try {
        priv('s-private', wrote('private.md'));
      } finally {
        db.exec('ROLLBACK');
        db.close();
      }
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_private');
    });

    it('keeps both records when two private sessions stop at the same moment', async () => {
      note('one.md', 'switch_note_one', 'ONE-BODY');
      note('two.md', 'switch_note_two', 'TWO-BODY');
      const start = (id: string, file: string) => {
        fs.writeFileSync(transcriptOf(id), jsonl([claudeUser('go'), ...claudeEdits(), ...wrote(file), ...claudePrivateCall()]));
        const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
        delete env.MEMESH_DB_PATH; delete env.MEMESH_DIR;
        return new Promise<number | null>((resolve) => {
          const child = spawn('node', [STOP], { env });
          child.stdin.end(JSON.stringify({ session_id: id, transcript_path: transcriptOf(id), cwd: home, hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(100) }));
          child.on('close', resolve);
        });
      };
      expect(await Promise.all([start('s-one', 'one.md'), start('s-two', 'two.md')])).toEqual([0, 0]);
      end('s-one');
      end('s-two'); // both markers are gone: only the two hold records keep the notes out
      expect(fs.readdirSync(path.join(home, '.memesh', 'note-ingest-holds')).sort()).toEqual(['s-one.json', 's-two.json']);
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_one');
      expect(names()).not.toContain('switch_note_two');
    });

    it('stops importing, and says what to delete, when a hold record is damaged', () => {
      note('private.md', 'switch_note_private', 'PRIVATE-BODY');
      priv('s-private', wrote('private.md'));
      const record = path.join(home, '.memesh', 'note-ingest-holds', 's-private.json');
      expect(fs.existsSync(record)).toBe(true);
      fs.writeFileSync(record, 'not json');
      note('ordinary.md', 'switch_note_ordinary', 'ORDINARY-BODY', at(100));
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_private');
      expect(names()).not.toContain('switch_note_ordinary');
      const last = outcomes('note-ingest').at(-1);
      expect(last).toMatchObject({ outcome: 'error' });
      expect(last.reason).toMatch(/hold record cannot be read.*note-ingest-holds folder/);
      fs.rmSync(record);
      normal('s-after-2');
      expect(names()).toContain('switch_note_ordinary');
    });

    it('holds a note that a subagent of the private session named, and one named in a progress row', () => {
      note('by-subagent.md', 'switch_note_by_subagent', 'SUBAGENT-SECRET');
      note('by-progress.md', 'switch_note_by_progress', 'PROGRESS-SECRET');
      fs.mkdirSync(path.join(projectDir, 's-private', 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 's-private', 'subagents', 'agent-a1.jsonl'), jsonl(wrote('by-subagent.md')));
      const progress = { type: 'progress', data: { type: 'agent_progress', message: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'Write', input: { file_path: path.join(memoryDir, 'by-progress.md') } }] } } } };
      priv('s-private', [progress]);
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_by_subagent');
      expect(names()).not.toContain('switch_note_by_progress');
    });

    it('holds a note an MCP file tool wrote, and one in a subfolder', () => {
      note('by-mcp.md', 'switch_note_by_mcp', 'MCP-SECRET');
      note('deeper/in-folder.md', 'switch_note_in_folder', 'FOLDER-SECRET');
      priv('s-private', [...tool('mcp__filesystem__write_file', { path: path.join(memoryDir, 'by-mcp.md'), content: 'x' }), ...bash('echo x > in-folder.md')]);
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_by_mcp');
      expect(names()).not.toContain('switch_note_in_folder');
    });

    it('does not overwrite a session\'s own damaged hold record at its next Stop: nothing is written, the marker stays and an error says why', () => {
      note('private.md', 'switch_note_private', 'PRIVATE-BODY');
      session('s-private', [...claudeEdits(), ...wrote('private.md'), ...claudePrivateCall()]);
      const record = path.join(home, '.memesh', 'note-ingest-holds', 's-private.json');
      fs.writeFileSync(record, 'not json');
      session('s-private', [...claudeEdits(), ...wrote('private.md'), ...claudePrivateCall()]);
      expect(fs.readFileSync(record, 'utf8')).toBe('not json');
      expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'error' });
      expect(fs.existsSync(path.join(home, '.memesh', 'private-sessions', 's-private.json'))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('writes the marker before it reads the transcripts: a hook that is killed while reading leaves it', () => {
      // A named pipe nobody writes to: opening it blocks for ever, like a read that outlasts the host's time limit.
      const pipe = transcriptOf('s-p');
      expect(spawnSync('mkfifo', [pipe]).status).toBe(0);
      // The session is private by its marker (the call was recorded at PostToolUse), so the check never opens the pipe.
      const markers = path.join(home, '.memesh', 'private-sessions');
      fs.mkdirSync(markers, { recursive: true });
      fs.writeFileSync(path.join(markers, 's-p.json'), JSON.stringify({ v: 2, session: 's-p', dirs: [], projectsRoot: '', startedAt: 1, updatedAt: 1, holdsAt: 1 }));
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.MEMESH_DB_PATH;
      delete env.MEMESH_DIR;
      const r = spawnSync('node', [SESSION_END], {
        input: JSON.stringify({ session_id: 's-p', transcript_path: pipe, cwd: home, hook_event_name: 'SessionEnd', reason: 'other' }),
        env, encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL',
      });
      expect(r.signal, 'the hook was still blocked reading when it was killed').toBe('SIGKILL');
      const marker = JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'private-sessions', 's-p.json'), 'utf8'));
      expect(marker.updatedAt, 'written again before the read began').toBeGreaterThan(1);
    }, 20_000);

    it.skipIf(!canDenyReads)('holds the notes changed in the last six hours, and says so, when a subagent transcript cannot be read', () => {
      note('recent.md', 'switch_note_recent', 'RECENT-BODY');
      fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...claudeEdits(), ...claudePrivateCall()]));
      const sub = path.join(projectDir, 's-p', 'subagents', 'agent-a1.jsonl');
      fs.mkdirSync(path.dirname(sub), { recursive: true });
      fs.writeFileSync(sub, '');
      fs.chmodSync(sub, 0o000);
      try {
        run(SESSION_END, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'SessionEnd', reason: 'other' });
      } finally { fs.chmodSync(sub, 0o644); }
      expect(outcomes('note-ingest')).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'notified', reason: expect.stringContaining('too large, too slow or unreadable') })]));
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_recent');
    });

    it.skipIf(!canDenyReads)('holds the notes while the session cannot be checked (an unreadable subagents folder), and lets them through once it can be and is not private', () => {
      note('recent.md', 'switch_note_recent', 'RECENT-BODY');
      fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...claudeEdits()])); // no call anywhere in it
      const folder = path.join(projectDir, 's-p', 'subagents');
      fs.mkdirSync(folder, { recursive: true });
      fs.chmodSync(folder, 0o000);
      try {
        run(STOP, { session_id: 's-p', transcript_path: transcriptOf('s-p') });
        expect(outcomes('session-summary').some((r: { outcome: string }) => r.outcome === 'error')).toBe(true);
        normal('s-after-1');
        expect(names(), 'still unknown, so still held').not.toContain('switch_note_recent');
      } finally { fs.chmodSync(folder, 0o755); }
      normal('s-after-2');
      expect(names(), 'checked again, not private: released').toContain('switch_note_recent');
    });

    it('does not let another session import a note the private session wrote before its own Stop (two sessions at once)', () => {
      // The private session calls the tool: its PostToolUse hook runs at once.
      fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...claudeEdits(), ...claudePrivateCall()]));
      run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
      expect(fs.readdirSync(path.join(home, '.memesh', 'private-sessions'))).toEqual(['s-p.json']);
      // It then writes two notes, and has not stopped yet: one it names, one a script writes.
      note('named.md', 'switch_note_named', 'NAMED-BODY', at(60));
      note('scripted.md', 'switch_note_scripted', 'SCRIPTED-BODY', at(61));
      fs.appendFileSync(transcriptOf('s-p'), jsonl(wrote('named.md')));
      // Another session's Stop runs BEFORE the private session's Stop or SessionEnd.
      normal('s-other');
      expect(names()).not.toContain('switch_note_named');
      expect(names()).not.toContain('switch_note_scripted'); // not told apart yet, so it waits
      expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: "note files changed while a private session runs are waiting for its next Stop to record what it holds", count: 2 });
      // The private session ends: what it may have written is held for good, and its marker is kept (marked ended) as the record of the call.
      run(SESSION_END, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'SessionEnd', reason: 'other' });
      expect(typeof JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'private-sessions', 's-p.json'), 'utf8')).endedAt).toBe('number');
      normal('s-other-2');
      expect(names()).not.toContain('switch_note_named');
      expect(names()).not.toContain('switch_note_scripted'); // never named, but written while the session was private: held by content too
    });

    it('holds out the notes the session had already named at the moment it called the tool, before any Stop or SessionEnd', () => {
      note('before-call.md', 'switch_note_before_call', 'BEFORE-CALL-BODY'); // older than the marker: only the hold by name can keep it out
      fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...wrote('before-call.md'), ...claudePrivateCall()]));
      run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
      expect(fs.readdirSync(path.join(home, '.memesh', 'note-ingest-holds'))).toEqual(['s-p.json']);
      normal('s-other'); // another session's Stop, before the private session's own Stop or end
      expect(names()).not.toContain('switch_note_before_call');
    });

    it('keeps the marker, so notes keep waiting, when the holds could not be recorded at the end', () => {
      fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...claudeEdits(), ...claudePrivateCall()]));
      run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
      fs.rmSync(path.join(home, '.memesh', 'note-ingest-holds'), { recursive: true, force: true });
      fs.writeFileSync(path.join(home, '.memesh', 'note-ingest-holds'), 'a file where the holds folder should be');
      run(SESSION_END, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'SessionEnd', reason: 'other' });
      expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'error' });
      expect(fs.existsSync(path.join(home, '.memesh', 'private-sessions', 's-p.json'))).toBe(true);
    });

    it('writes the marker when the notes folder does not exist yet, and holds the first note the session writes', () => {
      fs.rmSync(memoryDir, { recursive: true });
      run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
      const marker = JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'private-sessions', 's-p.json'), 'utf8'));
      expect(marker.dirs).toEqual([path.join(fs.realpathSync(projectDir), 'memory')]);
      expect(marker.transcript, 'the marker remembers the transcript, so its liveness can be told later').toBe(transcriptOf('s-p'));
      note('first.md', 'switch_note_first', 'FIRST-NOTE-SECRET'); // Claude Code makes the folder with its first note
      normal('s-other');
      expect(names(), 'another session\'s Stop leaves it alone while the private session runs').not.toContain('switch_note_first');
      fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...claudeEdits(), ...claudePrivateCall()]));
      run(STOP, { session_id: 's-p', transcript_path: transcriptOf('s-p') });
      end('s-p');
      normal('s-other-2');
      expect(names(), 'held for good once the session is over').not.toContain('switch_note_first');
    });

    it('renews a private session\'s marker when its user writes a prompt, and creates none for a session that has not called the tool', () => {
      run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
      const markerFile = path.join(home, '.memesh', 'private-sessions', 's-p.json');
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      const idle = Date.now() - 7 * 3600 * 1000;
      fs.writeFileSync(markerFile, JSON.stringify({ ...marker, startedAt: idle, updatedAt: idle }));
      run(USER_PROMPT, { session_id: 's-p', prompt: 'carry on', hook_event_name: 'UserPromptSubmit' });
      const renewed = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      expect(renewed.startedAt).toBe(idle);
      expect(renewed.updatedAt).toBeGreaterThan(Date.now() - 60_000);
      run(USER_PROMPT, { session_id: 's-never', prompt: 'hello', hook_event_name: 'UserPromptSubmit' });
      expect(fs.readdirSync(path.join(home, '.memesh', 'private-sessions'))).toEqual(['s-p.json']);
    });

    it('stops importing and names the private-sessions folder when a marker is damaged (not the holds folder)', () => {
      run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
      fs.writeFileSync(path.join(home, '.memesh', 'private-sessions', 's-p.json'), '{ damaged');
      note('ordinary.md', 'switch_note_ordinary', 'ORDINARY-BODY');
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_ordinary');
      const last = outcomes('note-ingest').at(-1);
      expect(last).toMatchObject({ outcome: 'error' });
      expect(last.reason).toContain('private-sessions folder');
      expect(last.reason).not.toContain('note-ingest-holds');
    });

    it.skipIf(!canDenyReads)('holds the notes the session may have written when its own transcript cannot be read', () => {
      note('recent.md', 'switch_note_recent', 'RECENT-BODY');
      fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...wrote('recent.md'), ...claudePrivateCall()]));
      fs.chmodSync(transcriptOf('s-p'), 0o000);
      try {
        run(SESSION_END, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'SessionEnd', reason: 'other' });
      } finally { fs.chmodSync(transcriptOf('s-p'), 0o644); }
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_recent');
    });

    it('holds every recently changed note when the transcript is too large to read for names', () => {
      note('recent.md', 'switch_note_recent', 'RECENT-BODY');
      fs.writeFileSync(transcriptOf('s-big'), jsonl([claudeUser('go'), ...claudeEdits(), ...claudePrivateCall()]));
      fs.truncateSync(transcriptOf('s-big'), 2 * 1024 * 1024 * 1024 + 1); // sparse: too large to scan
      run(STOP, { session_id: 's-big', transcript_path: transcriptOf('s-big') });
      end('s-big');
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_recent');
    });

    it('holds a note the session wrote without naming it (a whole-folder copy), and a note moved in with an old time', () => {
      run(PRIVATE_MARK, { session_id: 's-private', transcript_path: transcriptOf('s-private'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
      note('copied.md', 'switch_note_copied', 'COPIED-BODY');
      note('moved.md', 'switch_note_moved', 'MOVED-BODY', new Date(Date.now() - 3 * 24 * 3600 * 1000)); // an old modification time, as `mv` and `cp -p` keep it
      priv('s-private', bash(`cp -r /tmp/generated/. ${memoryDir}/`)); // names the folder, never a file
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_copied');
      expect(names()).not.toContain('switch_note_moved');
    });

    it('holds a held note under any other name, in any folder of the notes directory', () => {
      note('private.md', 'switch_note_private', 'PRIVATE-BODY');
      priv('s-private', wrote('private.md'));
      fs.mkdirSync(path.join(memoryDir, 'sub'));
      fs.renameSync(path.join(memoryDir, 'private.md'), path.join(memoryDir, 'sub', 'renamed.md'));
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_private');
    });

    describe('the S3 redesign, through the real hooks', () => {
      const markerOf = (id: string) => path.join(home, '.memesh', 'private-sessions', `${id}.json`);
      const subagents = (id: string) => path.join(projectDir, id, 'subagents');

      it.skipIf(!canDenyReads)('R-A: a session that could not be checked once is stored normally at its next Stop, and is never labelled private', () => {
        fs.writeFileSync(transcriptOf('s-u'), jsonl([claudeUser('go'), ...claudeEdits()]));
        fs.mkdirSync(subagents('s-u'), { recursive: true });
        fs.chmodSync(subagents('s-u'), 0o000);
        try { run(STOP, { session_id: 's-u', transcript_path: transcriptOf('s-u') }); } finally { fs.chmodSync(subagents('s-u'), 0o755); }
        expect(fs.existsSync(markerOf('s-u')), 'unchecked never writes a marker').toBe(false);
        expect(names()).not.toContain('session-s-u-files');
        const before = { s: outcomes('session-summary').length, n: outcomes('note-ingest').length };
        run(STOP, { session_id: 's-u', transcript_path: transcriptOf('s-u') });
        expect(names()).toContain('session-s-u-files');
        expect(outcomes('session-summary').slice(before.s).map((r) => r.reason)).not.toContain('private_session');
        expect(outcomes('note-ingest').slice(before.n).map((r) => r.reason)).not.toContain('private_session');
      });

      it.skipIf(!canDenyReads)('R-C: a note held while the session could not be checked is let in at its next Stop, though no note changed (Q6_08 N2)', () => {
        fs.writeFileSync(transcriptOf('s-u'), jsonl([claudeUser('go'), ...claudeEdits(), ...wrote('held.md')]));
        note('held.md', 'switch_note_held_once', 'HELD-ONCE', at(-300));
        fs.mkdirSync(subagents('s-u'), { recursive: true });
        fs.chmodSync(subagents('s-u'), 0o000);
        try { run(STOP, { session_id: 's-u', transcript_path: transcriptOf('s-u') }); } finally { fs.chmodSync(subagents('s-u'), 0o755); }
        expect(names()).not.toContain('switch_note_held_once');
        run(STOP, { session_id: 's-u', transcript_path: transcriptOf('s-u') });
        expect(names()).toContain('switch_note_held_once');
      });

      it.skipIf(!canDenyReads)('Q6_10 F1: after a Stop that could not check the session, another session importing before its next Stop does not take a note it wrote meanwhile', () => {
        fs.writeFileSync(transcriptOf('s-u'), jsonl([claudeUser('go'), ...claudeEdits()]));
        fs.mkdirSync(subagents('s-u'), { recursive: true });
        fs.chmodSync(subagents('s-u'), 0o000);
        try {
          run(STOP, { session_id: 's-u', transcript_path: transcriptOf('s-u') });
          note('meanwhile.md', 'switch_note_meanwhile', 'MEANWHILE-BODY');
          normal('s-other');
          expect(names(), 'the tentative record is the wait').not.toContain('switch_note_meanwhile');
        } finally { fs.chmodSync(subagents('s-u'), 0o755); }
      });

      describe('R-F: a note a private session writes into another project\'s notes folder (22543bf03 onwards)', () => {
        // Project B's own folder is named after the directory its sessions run in (the Stop hook checks that).
        const dirB = () => path.join(home, 'proj-b');
        const projectB = () => path.join(home, '.claude', 'projects', dirB().replace(/[^a-zA-Z0-9]/g, '-'));
        const memoryB = () => path.join(projectB(), 'memory');
        const writeB = () => {
          fs.mkdirSync(memoryB(), { recursive: true });
          fs.writeFileSync(path.join(memoryB(), 'x.md'), '---\nname: probe_private_written_into_b\ndescription: b\nmetadata:\n  type: decision\n---\n\nSECRET-B-CONTENT\n');
        };
        const stopB = (id: string) => {
          const t = path.join(projectB(), `${id}.jsonl`);
          fs.writeFileSync(t, jsonl([claudeUser('go'), ...claudeEdits()]));
          run(STOP, { session_id: id, transcript_path: t, cwd: dirB() });
        };
        const privateWritesB = () => {
          fs.writeFileSync(transcriptOf('s-p'), jsonl([claudeUser('go'), ...claudeEdits(), ...claudePrivateCall()]));
          run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
          writeB();
          fs.appendFileSync(transcriptOf('s-p'), jsonl(tool('Write', { file_path: path.join(memoryB(), 'x.md') })));
        };

        it('③ b imports before the private session\'s next Stop: the note waits, then is held', () => {
          privateWritesB();
          stopB('s-b1');
          expect(names()).not.toContain('probe_private_written_into_b');
          run(STOP, { session_id: 's-p', transcript_path: transcriptOf('s-p') });
          stopB('s-b2');
          expect(names()).not.toContain('probe_private_written_into_b');
        });

        it('② b imports after the private session\'s Stop, before its SessionEnd: held, and the marker names b', () => {
          privateWritesB();
          run(STOP, { session_id: 's-p', transcript_path: transcriptOf('s-p') });
          expect(JSON.parse(fs.readFileSync(markerOf('s-p'), 'utf8')).dirs).toContain(fs.realpathSync(memoryB()));
          stopB('s-b1');
          expect(names()).not.toContain('probe_private_written_into_b');
        });

        it('① b imports after the private session has ended: held', () => {
          privateWritesB();
          run(STOP, { session_id: 's-p', transcript_path: transcriptOf('s-p') });
          end('s-p');
          stopB('s-b1');
          expect(names()).not.toContain('probe_private_written_into_b');
        });
      });

      it('R-E: the import\'s outcome counts the notes it held', () => {
        note('counted.md', 'switch_note_counted', 'COUNTED');
        priv('s-private', wrote('counted.md'));
        normal('s-after');
        const last = outcomes('note-ingest').at(-1);
        expect(last?.count).toBeGreaterThan(0);
      });

      it('each hook takes its time budget from HOOK_BUDGET_MS (Q6_04 N1 / H1)', () => {
        for (const [file, key] of [
          ['session-summary.js', 'HOOK_BUDGET_MS.stop.decide'], ['session-summary.js', 'HOOK_BUDGET_MS.stop.notes'],
          ['session-end-notes.js', 'HOOK_BUDGET_MS.sessionEnd.decide'], ['session-end-notes.js', 'HOOK_BUDGET_MS.sessionEnd.notes'],
          ['private-session-mark.js', 'HOOK_BUDGET_MS.privateMark.notes'], ['pre-compact.js', 'HOOK_BUDGET_MS.preCompact.decide'],
          ['decision-nudge.js', 'HOOK_BUDGET_MS.postToolUse.decide'], ['codex-plan-activity.js', 'HOOK_BUDGET_MS.postToolUse.decide'],
          ['pre-compact.js', 'HOOK_BUDGET_MS.preCompact.read'], ['user-prompt-intent.js', 'HOOK_BUDGET_MS.userPrompt.renew'],
        ]) expect(fs.readFileSync(path.resolve('scripts/hooks', file), 'utf8'), `${file} passes ${key}`).toContain(key);
        // A budget left out is an error, not a deadline that never passes (NaN), which is what let a read run until the host killed it (Q6_20 F3).
        expect(() => deadlineFor(undefined as unknown as number)).toThrow(/budget must be a number/);
        expect(deadlineFor(1000, 5_000, 200)).toBe(5_800);
      });
    });

    describe('S3 follow-up (phase 2b), through the real hooks', () => {
      const markerOf = (id: string) => path.join(home, '.memesh', 'private-sessions', `${id}.json`);
      const subagents = (id: string) => path.join(projectDir, id, 'subagents');
      const MARKER_FOLDER = 'the private-sessions folder beside the database cannot be read, so every session is treated as private and nothing is saved until it can be';
      const UNREAD = 'the private-session check could not read the transcript, so the session is treated as private';
      const HELD_BY_TIME = 'the transcripts could not be read for note names (too large, too slow or unreadable), so every note changed in the last six hours is held out';
      const LARGE = 'the transcript is too large to check for a private-session call, so the session is treated as private';
      const sparse = (file: string, bytes: number) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(file, 'w');
        fs.ftruncateSync(fd, bytes);
        fs.closeSync(fd);
      };
      // Project B's own folder is named after the directory its sessions run in (the Stop hook checks that).
        const dirB = () => path.join(home, 'proj-b');
        const projectB = () => path.join(home, '.claude', 'projects', dirB().replace(/[^a-zA-Z0-9]/g, '-'));
      const memoryB = () => path.join(projectB(), 'memory');
      const noteB = (file: string, name: string, body: string) => {
        fs.mkdirSync(memoryB(), { recursive: true });
        fs.writeFileSync(path.join(memoryB(), file), `---\nname: ${name}\ndescription: ${name}\nmetadata:\n  type: decision\n---\n\n${body}\n`);
      };
      const stopB = (id: string) => {
        const t = path.join(projectB(), `${id}.jsonl`);
        fs.writeFileSync(t, jsonl([claudeUser('go'), ...claudeEdits()]));
        run(STOP, { session_id: id, transcript_path: t, cwd: dirB() });
      };

      it.skipIf(!canDenyReads)('R-A P1b: an ordinary note written while a session was only unchecked is imported once the session is checked and is not private, never held for good (Q6_17 P1b)', () => {
        fs.writeFileSync(transcriptOf('s-u'), jsonl([claudeUser('go'), ...claudeEdits()]));
        fs.mkdirSync(subagents('s-u'), { recursive: true });
        fs.chmodSync(subagents('s-u'), 0o000);
        try { run(STOP, { session_id: 's-u', transcript_path: transcriptOf('s-u') }); } finally { fs.chmodSync(subagents('s-u'), 0o755); }
        note('ordinary.md', 'switch_note_ordinary_meanwhile', 'ORDINARY-MEANWHILE'); // another, ordinary session writes it
        run(STOP, { session_id: 's-u', transcript_path: transcriptOf('s-u') }); // now checkable, and not private
        end('s-u');
        normal('s-after-1');
        normal('s-after-2');
        expect(names()).toContain('switch_note_ordinary_meanwhile');
        const holds = path.join(home, '.memesh', 'note-ingest-holds');
        const held = fs.existsSync(holds) ? fs.readdirSync(holds).map((f) => fs.readFileSync(path.join(holds, f), 'utf8')).join(' ') : '';
        expect(held).not.toContain('ordinary.md');
      });

      it('a private Stop that runs before the notes folder exists keeps the marker on the folder it will have (Q6_17 F8, Q617P5)', () => {
        fs.rmSync(memoryDir, { recursive: true });
        session('s-p', [...claudeEdits(), ...claudePrivateCall()]); // no mark hook: the Stop writes the marker first
        expect(JSON.parse(fs.readFileSync(markerOf('s-p'), 'utf8')).dirs).toEqual([path.join(fs.realpathSync(projectDir), 'memory')]);
        note('first.md', 'switch_note_first_after_stop', 'FIRST-AFTER-STOP-SECRET');
        normal('s-other');
        expect(names()).not.toContain('switch_note_first_after_stop');
      });

      it('a Stop whose payload has no transcript path keeps the folders and the root the marker already names (Q6_17 Nit)', () => {
        run(PRIVATE_MARK, { session_id: 's-p', transcript_path: transcriptOf('s-p'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
        const before = JSON.parse(fs.readFileSync(markerOf('s-p'), 'utf8'));
        expect(before.dirs.length).toBe(1);
        run(STOP, { session_id: 's-p', transcript_path: undefined });
        const after = JSON.parse(fs.readFileSync(markerOf('s-p'), 'utf8'));
        expect(after.dirs).toEqual(before.dirs);
        expect(after.projectsRoot).toBe(before.projectsRoot);
        expect(after.transcript).toBe(before.transcript);
      });

      it.skipIf(!canDenyReads)('a private-sessions folder that cannot be read is reported as that folder, not as the transcript (Q6_18 F1, Q6_20 F2)', () => {
        const folder = path.join(home, '.memesh', 'private-sessions');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(transcriptOf('s-m'), jsonl([claudeUser('go'), ...claudeEdits()]));
        fs.chmodSync(folder, 0o000);
        try {
          run(STOP, { session_id: 's-m', transcript_path: transcriptOf('s-m') });
          run(PRE_COMPACT, { session_id: 's-m', transcript_path: transcriptOf('s-m'), hook_event_name: 'PreCompact', trigger: 'auto' });
        } finally { fs.chmodSync(folder, 0o700); }
        for (const hook of ['session-summary', 'pre-compact']) {
          const errors = outcomes(hook).filter((r) => r.outcome === 'error').map((r) => r.reason);
          expect(errors, hook).toContain(MARKER_FOLDER);
          expect(errors, hook).not.toContain(UNREAD);
        }
        expect(names()).not.toContain('session-s-m-files');
      });

      it('SessionEnd of a session whose own files are past the total size limit ends within its three seconds and says why (Q6_11 F3: six 950 MB subagents)', () => {
        fs.writeFileSync(transcriptOf('s-big'), jsonl([claudeUser('go'), ...claudeEdits()]));
        for (let i = 0; i < 6; i++) sparse(path.join(subagents('s-big'), `agent-${i}.jsonl`), 950 * 1000 * 1000);
        const started = Date.now();
        end('s-big');
        expect(Date.now() - started, 'the host gives SessionEnd three seconds').toBeLessThan(3000);
        expect(outcomes('note-ingest').some((r) => r.outcome === 'error' && r.reason === LARGE)).toBe(true);
      }, 60_000);

      it('SessionEnd of a session that cannot be checked keeps its holds tentative and ends their wait, with no error of its own (Q6_22 F4)', () => {
        const folder = transcriptOf('s-t');
        fs.mkdirSync(folder, { recursive: true }); // a transcript path that is a folder: unchecked
        note('t.md', 'switch_note_t', 'T-BODY');
        run(SESSION_END, { session_id: 's-t', transcript_path: folder, hook_event_name: 'SessionEnd', reason: 'other' });
        const rec = JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'note-ingest-holds', 's-t.json'), 'utf8'));
        expect(Object.values(rec.firm).flatMap((d) => Object.keys(d as object)), 'never firm: it was not found private').toEqual([]);
        expect(rec.tentative.endedAt, 'SessionEnd ends the wait').toBeGreaterThan(0);
        expect(outcomes('note-ingest').filter((r) => r.outcome === 'error').map((r) => r.reason)).toEqual([UNREAD]);
      });

      it('the private_session mark hook reads within its own budget: a 2 GiB transcript ends in time, holds by time and is recorded (Q6_20 F3, M-B2)', () => {
        sparse(transcriptOf('s-huge'), 2 * 1024 ** 3 + 1);
        const started = Date.now();
        run(PRIVATE_MARK, { session_id: 's-huge', transcript_path: transcriptOf('s-huge'), hook_event_name: 'PostToolUse', tool_name: CLAUDE_TOOL, tool_input: {} });
        expect(Date.now() - started).toBeLessThan(5000);
        const records = outcomes('note-ingest');
        expect(records.some((r) => r.outcome === 'notified' && r.reason === HELD_BY_TIME)).toBe(true);
        expect(records.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
        expect(records.some((r) => r.outcome === 'error'), 'a hook that passes no deadline records an error here').toBe(false);
      }, 60_000);

      it('a run that read its cap and changed nothing says the rest waits for the next Stop, not that nothing was new (Q6_07 F3)', () => {
        for (let i = 0; i < 101; i++) note(`bulk-${String(i).padStart(3, '0')}.md`, `switch_note_bulk_${i}`, `bulk ${i}`, at(-900));
        normal('s-bulk-1'); // 100 of them
        normal('s-bulk-2'); // the last one
        for (let i = 0; i < 101; i++) { const f = path.join(memoryDir, `bulk-${String(i).padStart(3, '0')}.md`); const now = new Date(); fs.utimesSync(f, now, now); } // newer than the last run's stamp, never in the future
        normal('s-bulk-3'); // the same bytes with new times: 100 read and unchanged, the rest past the cap
        expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'more note files changed than one run reads, so the rest are read at the next Stop' });
      }, 120_000);

      it('every Stop removes the private-check cache entry of a transcript that is gone (Q6_11 Nit)', () => {
        const cache = path.join(home, '.memesh', 'private-check-cache');
        fs.mkdirSync(cache, { recursive: true });
        const gone = path.join(cache, 'gone-entry.json');
        fs.writeFileSync(gone, JSON.stringify({ key: `${path.join(home, 'no-such.jsonl')}\u00001\u00001\u00001\u00001`, found: false, forks: [], headerBroken: false }));
        normal('s-cache');
        expect(fs.existsSync(gone)).toBe(false);
        expect(fs.readdirSync(cache).length, 'the entry of the transcript just checked stays').toBeGreaterThan(0);
      });

      it('a renewal that cannot read the session\'s marker is recorded, not dropped (Q6_15 F3)', () => {
        fs.mkdirSync(path.dirname(markerOf('s-r')), { recursive: true });
        fs.writeFileSync(markerOf('s-r'), '{}');
        run(USER_PROMPT, { session_id: 's-r', hook_event_name: 'UserPromptSubmit', prompt: 'carry on' });
        expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'error', reason: expect.stringContaining('private-session marker cannot be read') });
      });

      it.each([
        ['split by shell quotes', 'secret.md', 'cp /tmp/draft.txt memory/sec"ret".md'],
        ['in a brace list', 'secret.md', 'touch memory/{secret,other}.md'],
      ])('R2/R3: a note written before the call and named %s is held (Q6_14 F2)', (_label, file, command) => {
        note(file, 'switch_note_shaped', 'SHAPED-SECRET', at(-600));
        priv('s-shape', bash(command));
        normal('s-after');
        expect(names()).not.toContain('switch_note_shaped');
      });

      it('a Codex private session that writes into a Claude Code notes folder: b waits before its Stop, and holds after it (Q6_14 F1, codex-cross)', () => {
        const id = '01a00000-0000-7000-8000-00000000c0de';
        const rolloutDir = path.join(home, '.codex', 'sessions', '2026', '11', '08');
        fs.mkdirSync(rolloutDir, { recursive: true });
        const rollout = path.join(rolloutDir, `rollout-2026-11-08T00-00-00-${id}.jsonl`);
        noteB('y.md', 'probe_ordinary_b', 'ordinary');
        stopB('s-b0'); // b's own notes import
        expect(names()).toContain('probe_ordinary_b');
        const script = `text(await tools.exec_command({ cmd: "echo body > ${path.join(memoryB(), 'x.md')}" }));`;
        fs.writeFileSync(rollout, jsonl([codexMeta(id), codexMcpCall('private_session')]));
        run(PRIVATE_MARK, { session_id: id, transcript_path: rollout, hook_event_name: 'PostToolUse', tool_name: 'mcp__memesh__private_session', tool_input: {} });
        noteB('x.md', 'probe_codex_secret', 'SECRET private content codex');
        stopB('s-b1'); // before the Codex Stop: the note waits
        expect(names()).not.toContain('probe_codex_secret');
        fs.appendFileSync(rollout, jsonl([codexScript(script)]));
        run(STOP, { session_id: id, transcript_path: rollout });
        run(SESSION_END, { session_id: id, transcript_path: rollout, hook_event_name: 'SessionEnd', reason: 'exit' });
        stopB('s-b2');
        expect(names()).not.toContain('probe_codex_secret');
        expect(fs.readdirSync(path.join(home, '.memesh', 'note-ingest-holds')).map((f) => fs.readFileSync(path.join(home, '.memesh', 'note-ingest-holds', f), 'utf8')).join(' ')).toContain('x.md');
      });
    });

    it('treats a resumed session as one that named everything its transcript names', () => {
      note('earlier.md', 'switch_note_earlier_in_session', 'earlier body');
      priv('s-private', wrote('earlier.md'));
      normal('s-after-1');
      expect(names()).not.toContain('switch_note_earlier_in_session');
    });
  });

  it('holds a note named through a folder path with a backslash (the JSON of the transcript escapes it) by its name: it was written before the call, so no time window covers it', () => {
    const odd = path.join(home, '.claude', 'projects', '-p7\\win');
    fs.mkdirSync(path.join(odd, 'memory'), { recursive: true });
    const oddNote = path.join(odd, 'memory', 'w.md');
    fs.writeFileSync(oddNote, '---\nname: switch_note_backslash\ndescription: backslash\nmetadata:\n  type: decision\n---\n\nBACKSLASH-BODY\n');
    const earlier = new Date(Date.now() - 600_000);
    fs.utimesSync(oddNote, earlier, earlier);
    const [call, id] = claudeCall('Write', { file_path: oddNote });
    const file = path.join(odd, 's-bs.jsonl');
    fs.writeFileSync(file, jsonl([claudeUser('go'), ...claudeEdits(), { ...call, cwd: odd }, claudeResult(id, 'ok'), ...claudePrivateCall()]));
    run(STOP, { session_id: 's-bs', transcript_path: file });
    run(SESSION_END, { session_id: 's-bs', transcript_path: file, hook_event_name: 'SessionEnd', reason: 'other' }); // the marker is ended: the hold alone must keep it out
    const other = path.join(odd, 's-bs2.jsonl');
    fs.writeFileSync(other, jsonl([claudeUser('go'), ...claudeEdits()]));
    run(STOP, { session_id: 's-bs2', transcript_path: other });
    expect(names()).not.toContain('switch_note_backslash');
  });

  it('keeps every hook\'s read budget a second or more under the time its manifest gives the hook', () => {
    const manifests = ['hooks/hooks.json', '.codex-plugin/plugin.json'].map((file) => {
      const json = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      return json.hooks.hooks ?? json.hooks;
    });
    const timeoutOf = (manifest: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>, event: string, script: string) =>
      manifest[event].flatMap((entry) => entry.hooks).find((hook) => hook.command.endsWith(`/${script}`))?.timeout;
    for (const manifest of manifests) {
      for (const [event, script, budget] of [
        ['Stop', 'session-summary.js', HOOK_BUDGET_MS.stop],
        ['SessionEnd', 'session-end-notes.js', HOOK_BUDGET_MS.sessionEnd],
        ['PostToolUse', 'private-session-mark.js', HOOK_BUDGET_MS.privateMark],
        ['PreCompact', 'pre-compact.js', HOOK_BUDGET_MS.preCompact],
        ['PostToolUse', 'decision-nudge.js', HOOK_BUDGET_MS.postToolUse],
        ['UserPromptSubmit', 'user-prompt-intent.js', HOOK_BUDGET_MS.userPrompt],
      ] as const) {
        const timeout = timeoutOf(manifest as never, event, script);
        if (timeout === undefined && manifest !== manifests[0]) continue; // a hook the Codex manifest does not register
        expect(timeout, `${script} declares a timeout`).toBeGreaterThan(0);
        for (const ms of Object.values(budget)) expect(ms, `${script} budget`).toBeLessThanOrEqual((timeout as number) * 1000 - 1000);
      }
    }
  });

  it('has a PostToolUse matcher in both manifests that matches every name the detector accepts', () => {
    const matchers = ['hooks/hooks.json', '.codex-plugin/plugin.json'].map((file) => {
      const json = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const hooks = json.hooks.hooks ?? json.hooks;
      return hooks.PostToolUse.find((entry: { hooks: Array<{ command: string }> }) => entry.hooks.some((h) => h.command.endsWith('/private-session-mark.js'))).matcher as string;
    });
    expect(new Set(matchers).size).toBe(1);
    for (const name of ['private_session', 'mcp__memesh__private_session', 'mcp__mymem__private_session', 'mcp__memesh-dev__private_session', CLAUDE_TOOL, 'mcp__a_b__c__private_session']) {
      expect(isPrivateToolName(name), name).toBe(true);
      expect(new RegExp(matchers[0]).test(name), `matcher for ${name}`).toBe(true);
    }
    expect(isPrivateToolName('mcp__memesh__recall')).toBe(false);
  });

  it('treats a session as private when the mark hook recorded the call, though no transcript row shows it (first answer)', () => {
    fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudeEdits()])); // a clean transcript: no call anywhere in it
    run(PRIVATE_MARK, { session_id: 'sess-1', transcript_path: transcript, hook_event_name: 'PostToolUse', tool_name: 'mcp__mymem__private_session', tool_input: {} });
    expect(fs.readdirSync(path.join(home, '.memesh', 'private-sessions'))).toEqual(['sess-1.json']);
    run(STOP, {});
    expect(names()).toEqual([]);
    expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
  });

  it('records the call for a host with no notes folder too (the transcript is not under a Claude project folder)', () => {
    const elsewhere = path.join(home, 'elsewhere.jsonl');
    fs.writeFileSync(elsewhere, jsonl([claudeUser('go'), ...claudeEdits()]));
    run(PRIVATE_MARK, { session_id: 'sess-codex', transcript_path: elsewhere, hook_event_name: 'PostToolUse', tool_name: 'mcp__memesh__private_session', tool_input: {} });
    expect(fs.readdirSync(path.join(home, '.memesh', 'private-sessions'))).toEqual(['sess-codex.json']);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
  });

  it('writes nothing when the call was made inside a subagent or in a progress row', () => {
    fs.mkdirSync(path.join(projectDir, 'sess-1', 'subagents'), { recursive: true });
    fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudeEdits()]));
    fs.writeFileSync(path.join(projectDir, 'sess-1', 'subagents', 'agent-a1.jsonl'), jsonl([...claudePrivateCall()]));
    run(STOP, {});
    expect(names()).toEqual([]);
    expect(outcomes('session-summary').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
    fs.rmSync(path.join(projectDir, 'sess-1'), { recursive: true });
    const [, id] = claudeCall(CLAUDE_TOOL);
    fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudeEdits(), { type: 'progress', data: { message: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: CLAUDE_TOOL, input: {} }] } } } }]));
    run(STOP, { session_id: 'sess-2' });
    expect(names()).toEqual([]);
  });

  it('the PostToolUse mark hook does nothing for a tool that is not private_session, and says so', () => {
    run(PRIVATE_MARK, { session_id: 's-x', transcript_path: transcript, hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_memesh_memesh__recall', tool_input: {} });
    expect(fs.existsSync(path.join(home, '.memesh', 'private-sessions'))).toBe(false);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'not a call of the private_session tool' });
  });

  it('a private Stop with auto-capture off creates no database and records the hold in a small file of its own', () => {
    fs.rmSync(path.join(home, '.memesh'), { recursive: true });
    fs.mkdirSync(path.join(home, '.memesh'));
    const [call, id] = claudeCall('Write', { file_path: path.join(memoryDir, 'a.md') });
    fs.writeFileSync(transcript, jsonl([claudeUser('go'), { ...call, cwd: projectDir }, claudeResult(id, 'ok'), ...claudePrivateCall()]));
    run(STOP, {}, { MEMESH_AUTO_CAPTURE: 'false' });
    expect(fs.existsSync(path.join(home, '.memesh', 'knowledge-graph.db'))).toBe(false);
    expect(fs.readdirSync(path.join(home, '.memesh', 'note-ingest-holds'))).toEqual(['sess-1.json']);
  });

  it('PreCompact writes the snapshot when the tool was not called, and nothing when it was', () => {
    fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudeEdits()]));
    run(PRE_COMPACT, { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(names()).toContain('pre-compact-sess-1');
    fs.rmSync(path.join(home, '.memesh'), { recursive: true });
    fs.mkdirSync(path.join(home, '.memesh'));
    fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudeEdits(), ...claudePrivateCall()]));
    run(PRE_COMPACT, { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(outcomes('pre-compact').length, 'the hook ran').toBeGreaterThan(0);
    expect(names()).toEqual([]);
    expect(outcomes('pre-compact').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'private_session' });
  });

  it('records the importer as not built, not as a hold, when the plugin has no dist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-no-dist-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
      fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudePrivateCall()]));
      const script = `
        const { runStopNotes } = await import(${JSON.stringify(pathToFileURL(path.resolve('scripts/hooks/_stop-notes.js')).href)});
        await runStopNotes({ session_id: 'sess-1', transcript_path: ${JSON.stringify(transcript)} },
          { captureEnabled: true, project: 'p', privacy: { state: 'yes' }, deadlineAt: Date.now() + 5000, metaUrl: ${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'hooks', 'x.js')).href)} });`;
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.MEMESH_DB_PATH; delete env.MEMESH_DIR;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('is not built') });
    } finally { removeTempDir(root); }
  });

  describe('a transcript that exists but cannot be checked is treated as private (the check fails closed)', () => {
    const UNREAD = 'the private-session check could not read the transcript, so the session is treated as private';
    const LARGE = 'the transcript is too large to check for a private-session call, so the session is treated as private';

    it('a transcript path that is a directory: PreCompact saves nothing, and says why', () => {
      run(PRE_COMPACT, { hook_event_name: 'PreCompact', trigger: 'auto', transcript_path: projectDir });
      expect(outcomes('pre-compact').some((r) => r.outcome === 'error' && r.reason === UNREAD)).toBe(true);
      // Unchecked is never labelled private (Q6_18 F5, Q6_19 F2).
      expect(outcomes('pre-compact').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'the session could not be checked for a private-session call, so nothing is saved' });
      expect(outcomes('pre-compact').some((r) => r.reason === 'private_session')).toBe(false);
      expect(names()).toEqual([]);
    });

    it.skipIf(!canDenyReads)('an unreadable transcript: no handoff, no summary, an error that says the session is treated as private', () => {
      fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudeEdits()]));
      fs.chmodSync(transcript, 0o000);
      try {
        run(STOP);
      } finally {
        fs.chmodSync(transcript, 0o600);
      }
      expect(names()).toEqual([]);
      expect(outcomes('session-summary').some((r) => r.outcome === 'error' && r.reason === UNREAD)).toBe(true);
      expect(outcomes('handoff-capture').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'the session could not be checked for a private-session call, so nothing is saved' });
      expect(outcomes('session-summary').some((r) => r.reason === 'private_session'), 'nobody called the tool: it is not labelled private').toBe(false);
    });

    it('a transcript too large to scan: nothing is saved, and the error says so', () => {
      fs.writeFileSync(transcript, jsonl([claudeUser('go'), ...claudeEdits()]));
      fs.truncateSync(transcript, 2 * 1024 * 1024 * 1024 + 1); // sparse: more than the check will read
      run(STOP);
      expect(names()).toEqual([]);
      expect(outcomes('session-summary').some((r) => r.outcome === 'error' && r.reason === LARGE)).toBe(true);
    });

    it('a transcript that is simply not there is not private: the handoff from the payload is still written', () => {
      fs.rmSync(transcript, { force: true });
      run(STOP);
      expect(names().some((name) => name.startsWith(SESSION_HANDOFF_TYPE))).toBe(true);
      expect(outcomes('session-summary').every((r) => r.outcome !== 'error' || r.reason !== UNREAD)).toBe(true);
    });
  });
});
