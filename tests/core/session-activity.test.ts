import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeActivity, createCodexActivity, formatSessionActivity, readClaudeRegistry, readCodexTitle, startsMatch } from '../../src/core/session-activity.js';
import { projectTranscriptSlug } from '../../src/core/transcript-source.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canDenyReads } from '../helpers/permissions.js';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';

describe('session activity', () => {
  it('formats available fields and bounds the router summary', () => {
    expect(formatSessionActivity({ repo: 'repo@main', status: 'busy', title: 'Review', task: 'Check tests' })).toBe('repo@main · busy · Review · 進行中：Check tests');
    expect(formatSessionActivity({})).toBeUndefined();
    expect(formatSessionActivity({ title: 'a\u0000b\u001fc\u0085d' })).toBe('a b c\u0085d');
    expect(formatSessionActivity({ task: 'x'.repeat(400) })!.length).toBeLessThanOrEqual(200);
  });
  it('finds the newest matching Codex title and omits missing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-title-'));
    try {
      expect(readCodexTitle(dir, 'thread-a')).toBeUndefined();
      fs.writeFileSync(path.join(dir, 'session_index.jsonl'), [
        JSON.stringify({ id: 'thread-a', thread_name: 'Old' }),
        JSON.stringify({ id: 'thread-b', thread_name: 'Other' }),
        JSON.stringify({ id: 'thread-a', thread_name: 'New' }),
      ].join('\n') + '\n');
      expect(readCodexTitle(dir, 'thread-a')).toBe('New');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('reads only the current parent registry and follows its session after clear', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-registry-'));
    try {
      const workspace = path.join(root, 'work'); const claude = path.join(root, 'claude');
      fs.mkdirSync(workspace); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
      const transcripts = path.join(claude, 'projects', projectTranscriptSlug(workspace)); fs.mkdirSync(transcripts, { recursive: true });
      const registry = path.join(claude, 'sessions', '123.json');
      const writeRegistry = (sessionId: string, status: string) => fs.writeFileSync(registry, JSON.stringify({ pid: 123, cwd: workspace, sessionId, name: 'Example', status }), { mode: 0o644 });
      const writePlan = (session: string, task: string) => fs.writeFileSync(path.join(transcripts, `${session}.jsonl`), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'TodoWrite', input: { todos: [{ content: task, status: 'in_progress', activeForm: 'working' }] } }] } }) + '\n');
      writePlan('aaa', 'first'); writePlan('bbb', 'second'); writeRegistry('aaa', 'busy');
      const activity = createClaudeActivity(123, workspace, claude);
      expect(activity()).toContain('busy · Example · 進行中：first');
      writeRegistry('bbb', 'idle'); expect(activity()).toContain('idle · Example · 進行中：second');
      writeRegistry('bbb', 'unknown'); expect(activity()).not.toContain('unknown');
      if (process.platform !== 'win32') { fs.chmodSync(registry, 0o666); expect(activity()).toBeUndefined(); }
      fs.rmSync(registry); expect(activity()).toBeUndefined();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  describe('a private session', () => {
    const todo = (task: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'TodoWrite', input: { todos: [{ content: task, status: 'in_progress', activeForm: 'working' }] } }] } }) + '\n';
    const privateCall = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'two', name: 'mcp__plugin_memesh_memesh__private_session', input: {} }] } }) + '\n';

    it('shows its repo and status on Claude Code, but not the task it is working on', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-private-activity-'));
      try {
        const workspace = path.join(root, 'work'); const claude = path.join(root, 'claude');
        fs.mkdirSync(workspace); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
        const transcripts = path.join(claude, 'projects', projectTranscriptSlug(workspace)); fs.mkdirSync(transcripts, { recursive: true });
        fs.writeFileSync(path.join(claude, 'sessions', '123.json'), JSON.stringify({ pid: 123, cwd: workspace, sessionId: 'sss', name: 'Example', status: 'busy' }), { mode: 0o644 });
        const transcript = path.join(transcripts, 'sss.jsonl');
        fs.writeFileSync(transcript, todo('SECRET-TASK'));
        const activity = createClaudeActivity(123, workspace, claude);
        expect(activity()).toContain('進行中：SECRET-TASK');
        expect(activity()).toContain('Example');
        fs.appendFileSync(transcript, privateCall);
        const after = activity();
        expect(after).toContain('busy');
        expect(after).not.toContain('Example'); // the name Claude Code makes from the conversation
        expect(after).not.toContain('SECRET-TASK');
        expect(after).not.toContain('進行中');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('hides the name and the task of a session that has only a marker (its transcript shows no call), on Claude Code and on Codex (Q6_23 F3)', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-only-activity-'));
      vi.stubEnv('MEMESH_DB_PATH', path.join(root, 'memesh', 'knowledge-graph.db'));
      try {
        const markers = path.join(root, 'memesh', 'private-sessions'); fs.mkdirSync(markers, { recursive: true });
        const workspace = path.join(root, 'work'); const claude = path.join(root, 'claude');
        fs.mkdirSync(workspace); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
        const transcripts = path.join(claude, 'projects', projectTranscriptSlug(workspace)); fs.mkdirSync(transcripts, { recursive: true });
        fs.writeFileSync(path.join(claude, 'sessions', '123.json'), JSON.stringify({ pid: 123, cwd: workspace, sessionId: 'mmm', name: 'SECRET-TITLE', status: 'busy' }), { mode: 0o644 });
        fs.writeFileSync(path.join(transcripts, 'mmm.jsonl'), todo('SECRET-TODO'));
        const claudeActivity = createClaudeActivity(123, workspace, claude);
        expect(claudeActivity(), 'the control: no marker, so it shows').toContain('SECRET-TODO');
        fs.writeFileSync(path.join(markers, 'mmm.json'), '{}');
        for (const text of [claudeActivity(), claudeActivity()]) {
          expect(text ?? '').toContain('busy');
          expect(text ?? '').not.toContain('SECRET-TITLE');
          expect(text ?? '').not.toContain('SECRET-TODO');
        }
        const thread = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const codexHome = path.join(root, 'codex'); const data = path.join(root, 'data');
        const live = path.join(codexHome, 'sessions', '2026', '11', '08'); fs.mkdirSync(live, { recursive: true });
        fs.writeFileSync(path.join(live, `rollout-2026-11-08T00-00-00-${thread}.jsonl`), todo('nothing'));
        fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: thread, thread_name: 'SECRET-THREAD' }) + '\n');
        fs.writeFileSync(path.join(markers, `${thread}.json`), '{}');
        expect(createCodexActivity(thread, workspace, data, codexHome)() ?? '').not.toContain('SECRET-THREAD');
      } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('keeps hiding a private session when it is asked again about the same, unchanged transcript (Q6_23 F4)', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-twice-activity-'));
      vi.stubEnv('MEMESH_DB_PATH', path.join(root, 'memesh', 'knowledge-graph.db'));
      try {
        const workspace = path.join(root, 'work'); const claude = path.join(root, 'claude');
        fs.mkdirSync(workspace); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
        const transcripts = path.join(claude, 'projects', projectTranscriptSlug(workspace)); fs.mkdirSync(transcripts, { recursive: true });
        fs.writeFileSync(path.join(claude, 'sessions', '123.json'), JSON.stringify({ pid: 123, cwd: workspace, sessionId: 'ttt', name: 'SECRET-TITLE', status: 'busy' }), { mode: 0o644 });
        fs.writeFileSync(path.join(transcripts, 'ttt.jsonl'), todo('SECRET-TODO') + privateCall);
        const activity = createClaudeActivity(123, workspace, claude);
        for (const text of [activity(), activity(), activity()]) {
          expect(text ?? '').toContain('busy');
          expect(text ?? '').not.toContain('SECRET-TITLE');
          expect(text ?? '').not.toContain('SECRET-TODO');
        }
        // A fresh reader (a new process) with the verdict already on disk: still hidden.
        const again = createClaudeActivity(123, workspace, claude);
        expect(again() ?? '').not.toContain('SECRET-TODO');
      } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('hides the name and the task, and says once on stderr, when the transcript is too large to check', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-large-activity-'));
      const lines: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { lines.push(String(chunk)); return true; }) as never);
      try {
        const workspace = path.join(root, 'work'); const claude = path.join(root, 'claude');
        fs.mkdirSync(workspace); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
        const transcripts = path.join(claude, 'projects', projectTranscriptSlug(workspace)); fs.mkdirSync(transcripts, { recursive: true });
        fs.writeFileSync(path.join(claude, 'sessions', '123.json'), JSON.stringify({ pid: 123, cwd: workspace, sessionId: 'big', name: 'Example', status: 'busy' }), { mode: 0o644 });
        const transcript = path.join(transcripts, 'big.jsonl');
        fs.writeFileSync(transcript, todo('A-TASK'));
        fs.truncateSync(transcript, 2 * 1024 * 1024 * 1024 + 1); // sparse: larger than the check will read
        const activity = createClaudeActivity(123, workspace, claude);
        const shown = [activity(), activity()];
        for (const text of shown) {
          expect(text ?? '').toContain('busy');
          expect(text ?? '').not.toContain('Example');
          expect(text ?? '').not.toContain('A-TASK');
        }
        expect(lines.filter((l) => l.includes('could not check whether this session is private'))).toHaveLength(1);
      } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
    });

    it.skipIf(!canDenyReads)('hides the name and the task, for as long as it is so, when the transcript cannot be read', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-unreadable-activity-'));
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
      try {
        const workspace = path.join(root, 'work'); const claude = path.join(root, 'claude');
        fs.mkdirSync(workspace); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
        const transcripts = path.join(claude, 'projects', projectTranscriptSlug(workspace)); fs.mkdirSync(transcripts, { recursive: true });
        fs.writeFileSync(path.join(claude, 'sessions', '123.json'), JSON.stringify({ pid: 123, cwd: workspace, sessionId: 'unreadable', name: 'Example', status: 'busy' }), { mode: 0o644 });
        const transcript = path.join(transcripts, 'unreadable.jsonl');
        fs.writeFileSync(transcript, todo('A-TASK'));
        fs.chmodSync(transcript, 0o000);
        const activity = createClaudeActivity(123, workspace, claude);
        for (const text of [activity(), activity()]) {
          expect(text ?? '').toContain('busy');
          expect(text ?? '').not.toContain('Example');
          expect(text ?? '').not.toContain('A-TASK');
        }
        fs.chmodSync(transcript, 0o600); // readable again: the check can be made, and the session is not private
        expect(activity()).toContain('A-TASK');
      } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('takes only a rollout in sessions/ for the thread that is running: an archived copy, plain or compressed, is not its transcript', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-archived-activity-'));
      try {
        const workspace = path.join(root, 'work'); const codexHome = path.join(root, 'codex'); const data = path.join(root, 'data');
        const thread = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        fs.mkdirSync(workspace); fs.mkdirSync(path.join(data, 'codex-plan-activity'), { recursive: true });
        const archived = path.join(codexHome, 'archived_sessions'); fs.mkdirSync(archived, { recursive: true });
        fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: thread, thread_name: 'A-THREAD-NAME' }) + '\n');
        fs.writeFileSync(path.join(data, 'codex-plan-activity', `${thread}.json`), JSON.stringify({ session: thread, workspace, task: 'A-PLAN-STEP' }), { mode: 0o600 });
        const call = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'memesh', tool: 'private_session', status: 'completed' } } }) + '\n';
        fs.writeFileSync(path.join(archived, `rollout-2026-11-02T00-00-00-${thread}.jsonl`), call);
        fs.writeFileSync(path.join(archived, `rollout-2026-11-02T00-00-00-${thread}.jsonl.zst`), 'compressed');
        expect(createCodexActivity(thread, workspace, data, codexHome)()).toContain('A-THREAD-NAME');
        // A compressed copy in sessions/ is not the running thread's transcript either (S1): only a plain rollout there is.
        const live = path.join(codexHome, 'sessions', '2026', '11', '02'); fs.mkdirSync(live, { recursive: true });
        fs.renameSync(path.join(archived, `rollout-2026-11-02T00-00-00-${thread}.jsonl`), path.join(archived, 'moved-away.jsonl'));
        // Its bytes would say private if they were read as a plain rollout: they must not be read at all.
        fs.writeFileSync(path.join(live, `rollout-2026-11-02T00-00-00-${thread}.jsonl.zst`), call);
        expect(createCodexActivity(thread, workspace, data, codexHome)()).toContain('A-THREAD-NAME');
        fs.rmSync(path.join(live, `rollout-2026-11-02T00-00-00-${thread}.jsonl.zst`));
        fs.writeFileSync(path.join(live, `rollout-2026-11-02T00-00-00-${thread}.jsonl`), call);
        expect(createCodexActivity(thread, workspace, data, codexHome)() ?? '').not.toContain('A-THREAD-NAME');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('shows only the repo on Codex: not the thread name, not the plan step', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-private-activity-'));
      try {
        const workspace = path.join(root, 'work'); const codexHome = path.join(root, 'codex'); const data = path.join(root, 'data');
        const thread = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        fs.mkdirSync(workspace); fs.mkdirSync(path.join(data, 'codex-plan-activity'), { recursive: true });
        const day = path.join(codexHome, 'sessions', '2026', '11', '02'); fs.mkdirSync(day, { recursive: true });
        fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: thread, thread_name: 'SECRET-THREAD-NAME' }) + '\n');
        fs.writeFileSync(path.join(data, 'codex-plan-activity', `${thread}.json`), JSON.stringify({ session: thread, workspace, task: 'SECRET-PLAN-STEP' }), { mode: 0o600 });
        const rollout = path.join(day, `rollout-2026-11-02T00-00-00-${thread}.jsonl`);
        fs.writeFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'memesh', tool: 'recall', status: 'completed' } } }) + '\n');
        const activity = createCodexActivity(thread, workspace, data, codexHome);
        expect(activity()).toContain('SECRET-THREAD-NAME');
        expect(activity()).toContain('SECRET-PLAN-STEP');
        fs.appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'memesh', tool: 'private_session', status: 'failed' } } }) + '\n');
        const after = activity();
        expect(after ?? '').not.toContain('SECRET');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  });
  it('tells sessions in different linked worktrees apart even when the host process runs in the main checkout', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-worktrees-')));
    try {
      const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
      const main = path.join(root, 'repo'); fs.mkdirSync(main);
      git(main, 'init', '-q', '-b', 'main'); git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
      const wtA = path.join(root, 'wt-a'); const wtB = path.join(root, 'wt-b');
      git(main, 'worktree', 'add', '-q', '-b', 'feat-a', wtA); git(main, 'worktree', 'add', '-q', '-b', 'feat-b', wtB);
      const claude = path.join(root, 'claude'); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
      // The fields a real Claude Code registry file carries, except procStart: these pids are not live processes,
      // so there is no start time to record (the procStart check is covered with live processes below). The MCP child keeps the project root as its cwd.
      const writeRegistry = (pid: number, cwd: string, name: string, status: string) => fs.writeFileSync(path.join(claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: `sess-${pid}`, cwd, startedAt: 1, version: '2.1.309', kind: 'interactive', entrypoint: 'cli', name, status, updatedAt: 2, statusUpdatedAt: 2 }), { mode: 0o644 });
      writeRegistry(111, wtA, 'Alpha task', 'busy'); writeRegistry(222, wtB, 'Beta task', 'idle');
      const a = createClaudeActivity(111, main, claude)(); const b = createClaudeActivity(222, main, claude)();
      expect(a).toBe('wt-a@feat-a · busy · Alpha task');
      expect(b).toBe('wt-b@feat-b · idle · Beta task');
      // A registry file that names a different pid is not this session's: nothing from it is shown.
      writeRegistry(999, wtA, 'Alpha task', 'busy'); fs.renameSync(path.join(claude, 'sessions', '999.json'), path.join(claude, 'sessions', '333.json'));
      expect(createClaudeActivity(333, main, claude)()).toBe('repo@main');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform === 'win32')('Claude registry file protections', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const pid = 4242;
  const fields = { cwd: '/somewhere', sessionId: 'sess-1', name: 'n', status: 'idle' };
  function setup(body: Record<string, unknown> | string = { pid, ...fields }, mode = 0o644, id = pid) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-registry-guard-'));
    const dir = path.join(root, 'sessions'); fs.mkdirSync(dir);
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)); fs.chmodSync(file, mode);
    return { root, file, read: () => readClaudeRegistry(id, root), done: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  const psStart = (p: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(p)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim();
  /** A live process of its own, so each test reads a process id no earlier test has cached. */
  const children: ChildProcess[] = [];
  const liveProcess = (): number => { const child = spawn('sleep', ['60'], { stdio: 'ignore' }); children.push(child); return child.pid!; };
  afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });
  const withEnv = <T,>(vars: Record<string, string>, run: () => T): T => {
    const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try { return run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  };

  it('reads a well-formed registry file', () => {
    const t = setup(); try { expect(t.read()).toMatchObject({ pid, sessionId: 'sess-1' }); } finally { t.done(); }
  });
  it.each([0o666, 0o664, 0o646, 0o622].map(mode => [mode.toString(8), mode] as const))('refuses a file that others can write to (mode 0o%s)', (_label, mode) => {
    const t = setup({ pid, ...fields }, mode); try { expect(t.read()).toBeUndefined(); } finally { t.done(); }
  });
  it('refuses a file owned by someone else', () => {
    const t = setup();
    try {
      expect(t.read()).toBeDefined();
      vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
      expect(t.read()).toBeUndefined();
    } finally { t.done(); }
  });
  it('accepts a registry file of exactly 64 KiB and refuses one a byte larger', () => {
    const sized = (bytes: number) => {
      const head = JSON.stringify({ pid, ...fields, pad: '' });
      return head.replace('"pad":""', `"pad":"${'x'.repeat(bytes - Buffer.byteLength(head))}"`);
    };
    const exact = setup(sized(65536)); try { expect(fs.statSync(exact.file).size).toBe(65536); expect(exact.read()).toBeDefined(); } finally { exact.done(); }
    const over = setup(sized(65537)); try { expect(fs.statSync(over.file).size).toBe(65537); expect(over.read()).toBeUndefined(); } finally { over.done(); }
  });
  it('refuses a name that is a directory', () => {
    const t = setup(); try { fs.rmSync(t.file); fs.mkdirSync(t.file); expect(t.read()).toBeUndefined(); } finally { t.done(); }
  });
  it('refuses a symbolic link even to a valid file', () => {
    const t = setup();
    try {
      const target = path.join(t.root, 'target.json'); fs.renameSync(t.file, target); fs.symlinkSync(target, t.file);
      expect(t.read()).toBeUndefined();
    } finally { t.done(); }
  });
  it('does not hang on a named pipe in place of the file', () => {
    const t = setup();
    try {
      fs.rmSync(t.file); execFileSync('mkfifo', [t.file]);
      // In its own process: opening a pipe that nobody writes to blocks for good unless the open is non-blocking.
      const loader = `import { createServer } from 'vite'; const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } }); try { const m = await server.ssrLoadModule('/src/core/session-activity.ts'); console.log(String(m.readClaudeRegistry(Number(process.argv[1]), process.argv[2]))); } finally { await server.close(); }`;
      const run = spawnSync(process.execPath, ['--input-type=module', '--eval', loader, String(pid), t.root], { encoding: 'utf8', timeout: 25000 });
      expect(run.signal).toBeNull();
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe('undefined');
    } finally { t.done(); }
  }, 40000);
  // The next checks overlap with the ones above in the ordinary case. Each simulates the
  // state in which only that one check still stands between the file and the reader.
  it('opens without following a link, even if the name were swapped after the later name check', () => {
    const t = setup();
    try {
      const target = path.join(t.root, 'target.json'); fs.renameSync(t.file, target); fs.symlinkSync(target, t.file);
      vi.spyOn(fs, 'lstatSync').mockReturnValue(fs.lstatSync(target));
      expect(t.read()).toBeUndefined();
    } finally { t.done(); }
  });
  it('refuses an opened file that is not a regular file', () => {
    const t = setup();
    try {
      // This state can only be built with a mock: a real pipe or directory makes the read itself come back empty or fail before this check is reached.
      const real = fs.statSync(t.file);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({ isFile: () => false, dev: real.dev, ino: real.ino, size: real.size, uid: real.uid, mode: real.mode } as fs.Stats);
      expect(t.read()).toBeUndefined();
    } finally { t.done(); }
  });
  it('refuses a name that now points at a different file or device', () => {
    const t = setup();
    try {
      const real = fs.statSync(t.file);
      const lstat = vi.spyOn(fs, 'lstatSync');
      lstat.mockReturnValue({ isFile: () => true, dev: real.dev, ino: real.ino + 1 } as fs.Stats);
      expect(t.read()).toBeUndefined();
      lstat.mockReturnValue({ isFile: () => true, dev: real.dev + 1, ino: real.ino } as fs.Stats);
      expect(t.read()).toBeUndefined();
    } finally { t.done(); }
  });
  it('refuses a file whose pid field names another process', () => {
    const t = setup({ ...fields, pid: pid + 1 }); try { expect(t.read()).toBeUndefined(); } finally { t.done(); }
  });

  describe('process start time', () => {
    const registryFor = (child: number, procStart: unknown, extra: Record<string, unknown> = {}) => setup({ pid: child, ...fields, procStart, ...extra }, 0o644, child);
    it('accepts the registry of a live process and refuses one recorded for another start', () => {
      const child = liveProcess(); const real = psStart(child);
      const t = registryFor(child, real);
      try {
        expect(t.read()).toMatchObject({ sessionId: 'sess-1' });
        fs.writeFileSync(t.file, JSON.stringify({ pid: child, ...fields, procStart: 'Mon Jan  1 00:00:00 2001' }));
        expect(t.read()).toBeUndefined();
      } finally { t.done(); }
    });
    it('refuses the registry of a process that no longer exists', async () => {
      const child = liveProcess(); const real = psStart(child);
      const exited = new Promise<void>(resolve => children[0].once('exit', () => resolve()));
      children[0].kill('SIGKILL'); await exited;
      const t = registryFor(child, real);
      try { expect(t.read()).toBeUndefined(); } finally { t.done(); }
    });
    it('reads the start time in UTC and the C locale whatever the machine uses', () => {
      const child = liveProcess(); const t = registryFor(child, psStart(child));
      try { expect(withEnv({ TZ: 'Pacific/Kiritimati', LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' }, () => t.read())).toMatchObject({ sessionId: 'sess-1' }); } finally { t.done(); }
    });
    it('ignores spacing, which ps changes for days before the 10th', () => {
      expect(startsMatch('Mon Nov  2 18:38:12 2026', 'Mon Nov 2 18:38:12 2026')).toBe(true);
      expect(startsMatch(' Mon Nov 12 18:38:12 2026 ', 'Mon Nov  12 18:38:12 2026')).toBe(true);
      expect(startsMatch('Mon Nov  2 18:38:12 2026', 'Mon Nov  2 18:38:13 2026')).toBe(false);
      const child = liveProcess(); const t = registryFor(child, psStart(child).replace(/ /g, '   '));
      try { expect(t.read()).toBeDefined(); } finally { t.done(); }
    });
    it('does not compare the session id, which changes after /clear while the process stays', () => {
      const child = liveProcess(); const t = registryFor(child, psStart(child), { sessionId: 'sess-after-clear' });
      try { expect(t.read()).toMatchObject({ sessionId: 'sess-after-clear' }); } finally { t.done(); }
    });
    it('asks ps once per process: a later failure of ps does not turn a good registry into a stale one', () => {
      const child = liveProcess(); const real = psStart(child);
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-ps-'));
      const t = registryFor(child, real);
      try {
        expect(t.read()).toBeDefined();
        const write = vi.spyOn(process.stderr, 'write');
        // ps cannot run any more. The start time already read still decides: right one accepted, wrong one refused.
        withEnv({ PATH: empty }, () => {
          expect(t.read()).toBeDefined();
          fs.writeFileSync(t.file, JSON.stringify({ pid: child, ...fields, procStart: 'Mon Jan  1 00:00:00 2001' }));
          expect(t.read()).toBeUndefined();
        });
        expect(write).not.toHaveBeenCalled();
      } finally { t.done(); fs.rmSync(empty, { recursive: true, force: true }); }
    });
    it('does not ask a hung or failing ps again for every read of the same session', () => {
      const child = liveProcess();
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-ps-'));
      const counter = path.join(bin, 'calls');
      fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho x >> '${counter}'\nexit 2\n`, { mode: 0o755 });
      const t = registryFor(child, psStart(child));
      try {
        vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        withEnv({ PATH: bin }, () => { for (let i = 0; i < 4; i++) expect(t.read()).toMatchObject({ sessionId: 'sess-1' }); });
        expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
      } finally { t.done(); fs.rmSync(bin, { recursive: true, force: true }); }
    });
    it('treats a ps that succeeds but prints nothing as "no such process" and refuses the registry file', () => {
      const child = liveProcess();
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-ps-'));
      fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const t = registryFor(child, psStart(child));
      try { withEnv({ PATH: bin }, () => expect(t.read()).toBeUndefined()); }
      finally { t.done(); fs.rmSync(bin, { recursive: true, force: true }); }
    });
    it('says so, once, when ps cannot tell, and uses the registry without that check instead of calling it stale', () => {
      const child = liveProcess(); const real = psStart(child);
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-ps-'));
      const t = registryFor(child, real);
      try {
        const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        withEnv({ PATH: empty }, () => {
          expect(t.read()).toMatchObject({ sessionId: 'sess-1' });
          expect(t.read()).toMatchObject({ sessionId: 'sess-1' });
        });
        const lines = write.mock.calls.map(call => String(call[0])).filter(line => line.includes(`start time of process ${child}`));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/without that check/);
        // After the retry window, with ps working again, the check applies: a wrong start time is refused.
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
        fs.writeFileSync(t.file, JSON.stringify({ pid: child, ...fields, procStart: 'Mon Jan  1 00:00:00 2001' }));
        expect(t.read()).toBeUndefined();
      } finally { t.done(); fs.rmSync(empty, { recursive: true, force: true }); }
    });
  });
});
