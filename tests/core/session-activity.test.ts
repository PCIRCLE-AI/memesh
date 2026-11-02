import { describe, expect, it, vi } from 'vitest';
import { createClaudeActivity, createCodexActivity, formatSessionActivity, readCodexTitle } from '../../src/core/session-activity.js';
import { projectTranscriptSlug } from '../../src/core/transcript-source.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canDenyReads } from '../helpers/permissions.js';

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
});
