import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeTranscriptReader } from '../../src/host-runtime/claude-transcript.js';

const event = (id: string, name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) + '\n';

describe('Claude transcript activity', () => {
  it('offers an independent cursor that reads only complete lines appended after mark', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cursor-'));
    try {
      fs.mkdirSync(path.join(dir, 'one')); const file = path.join(dir, 'one', 'session-a.jsonl');
      fs.writeFileSync(file, event('old', 'TodoWrite', { todos: [{ content: 'first', status: 'in_progress', activeForm: 'working' }] }));
      const activity = new ClaudeTranscriptReader(dir); const receipt = new ClaudeTranscriptReader(dir);
      expect(activity.currentTask('session-a')).toBe('first');
      const mark = receipt.mark('session-a'); expect(mark).toBeDefined();
      const line = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: 'session-a', content: 'notice' }) + '\n';
      fs.appendFileSync(file, line.slice(0, 10)); expect(receipt.readNew('session-a', mark!)).toEqual([]);
      fs.appendFileSync(file, line.slice(10));
      const received = receipt.readNew('session-a', mark!);
      expect(received).toHaveLength(1);
      expect(received).toEqual([expect.objectContaining({ type: 'queue-operation', content: 'notice' })]);
      expect(activity.currentTask('session-a')).toBe('first');
      fs.writeFileSync(path.join(dir, 'one', 'session-b.jsonl'), '');
      expect(receipt.readNew('session-b', mark!)).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('ignores user or tool-result content even if it resembles a tool call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-activity-'));
    try {
      fs.mkdirSync(path.join(dir, 'one'));
      const file = path.join(dir, 'one', 'session-a.jsonl');
      fs.writeFileSync(file, event('same', 'TodoWrite', { todos: [{ content: 'real', status: 'in_progress', activeForm: 'working' }] }));
      const reader = new ClaudeTranscriptReader(dir);
      expect(reader.currentTask('session-a')).toBe('real');
      const fake = { type: 'tool_use', id: 'same', name: 'TodoWrite', input: { todos: [{ content: 'fake', status: 'in_progress', activeForm: 'working' }] } };
      fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [fake] } }) + '\n' + JSON.stringify({ type: 'assistant', message: { role: 'user', content: [{ ...fake, id: 'other' }] } }) + '\n');
      expect(reader.currentTask('session-a')).toBe('real');
      fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ ...fake, id: 'next' }] } }) + '\n' + event('next', 'TodoWrite', { todos: [{ content: 'actual', status: 'in_progress', activeForm: 'working' }] }));
      expect(reader.currentTask('session-a')).toBe('actual');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves a Chinese character split across incremental byte reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-activity-'));
    try {
      fs.mkdirSync(path.join(dir, 'one'));
      const file = path.join(dir, 'one', 'session-a.jsonl');
      const bytes = Buffer.from(event('chinese', 'TodoWrite', { todos: [{ content: '檢查測試', status: 'in_progress', activeForm: '檢查' }] }));
      const split = bytes.indexOf(Buffer.from('檢')) + 1;
      fs.writeFileSync(file, bytes.subarray(0, split));
      const reader = new ClaudeTranscriptReader(dir);
      expect(reader.currentTask('session-a')).toBeUndefined();
      fs.appendFileSync(file, bytes.subarray(split));
      expect(reader.currentTask('session-a')).toBe('檢查測試');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('tracks full desktop plan and advances once per distinct call, replacing and resetting on session change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-activity-'));
    try {
      const project = path.join(dir, 'one'); fs.mkdirSync(project);
      const file = path.join(project, 'session-a.jsonl');
      const reader = new ClaudeTranscriptReader(dir);
      fs.writeFileSync(file, event('full', 'mcp__ccd_turn__update_plan', { items: [{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'pending' }, { content: 'three', status: 'pending' }], scope: 'first_task' }));
      expect(reader.currentTask('session-a')).toBe('one');
      fs.appendFileSync(file, event('a1', 'mcp__ccd_turn__update_plan', { advance: true }) + event('a1', 'mcp__ccd_turn__update_plan', { advance: true }) + event('a2', 'mcp__ccd_turn__update_plan', { advance: true }));
      expect(reader.currentTask('session-a')).toBe('three');
      fs.appendFileSync(file, event('new', 'TodoWrite', { todos: [{ content: 'new task', status: 'in_progress', activeForm: 'working' }] }));
      expect(reader.currentTask('session-a')).toBe('new task');
      const independent = new ClaudeTranscriptReader(dir);
      expect(independent.currentTask('session-a')).toBe('new task');
      fs.appendFileSync(file, event('unknown', 'mcp__ccd_turn__update_plan', { advance: 'unknown' }));
      expect(reader.currentTask('session-a')).toBeUndefined();
      expect(independent.currentTask('session-a')).toBeUndefined();
      fs.writeFileSync(path.join(project, 'session-b.jsonl'), event('b', 'TodoWrite', { todos: [{ content: 'other', status: 'in_progress', activeForm: 'working' }] }));
      expect(reader.currentTask('session-b')).toBe('other');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not infer an advance without a complete plan in the bounded tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-activity-'));
    try {
      fs.mkdirSync(path.join(dir, 'one'));
      fs.writeFileSync(path.join(dir, 'one', 'session-a.jsonl'), event('full', 'mcp__ccd_turn__update_plan', { items: [{ content: 'old', status: 'in_progress' }], scope: 'first_task' }) + ' '.repeat(1024 * 1024 + 10) + '\n' + event('advance', 'mcp__ccd_turn__update_plan', { advance: true }));
      expect(new ClaudeTranscriptReader(dir).currentTask('session-a')).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
