import { describe, expect, it } from 'vitest';
import { createClaudeActivity, formatSessionActivity, readCodexTitle } from '../../src/core/session-activity.js';
import { projectTranscriptSlug } from '../../src/core/transcript-source.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
});
