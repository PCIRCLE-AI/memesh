import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import {
  activityFromChatMessages,
  buildSessionInsights,
  captureChatSession,
} from '../../src/core/session-insight.js';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hermes', 'session-messages.json'), 'utf8'),
) as { messages: unknown[] };

describe('activityFromChatMessages (Hermes / OpenAI tool_calls format)', () => {
  it('counts tool calls, edited files, explicit errors and shell commands', () => {
    const a = activityFromChatMessages(fixture.messages);
    expect(a.toolCallCount).toBe(21);
    expect(a.filesEdited.sort()).toEqual(['app.py', 'test_app.py']);
    // One explicit failure (exit_code 1). The read_file result that merely
    // contains the word "Error" is not one.
    expect(a.errorsEncountered).toHaveLength(1);
    expect(a.bashCommands).toHaveLength(2);
    expect(a.unrecognizedTools).toEqual(['mystery_tool']);
  });

  it('redacts a credential in a shell command before storing it', () => {
    const a = activityFromChatMessages(fixture.messages);
    const joined = a.bashCommands.join('\n');
    expect(joined).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('never throws on malformed entries', () => {
    const a = activityFromChatMessages([
      null, 3, { role: 'assistant', tool_calls: [null, { function: { name: 'write_file', arguments: '{not json' } }] },
      { role: 'tool', content: 'plain text, not JSON' },
    ]);
    expect(a.toolCallCount).toBe(1);
    expect(a.filesEdited).toEqual([]);
    expect(a.errorsEncountered).toEqual([]);
    expect(activityFromChatMessages('nope').toolCallCount).toBe(0);
  });
});

describe('buildSessionInsights — the Stop hook rules', () => {
  const ctx = { sessionId: 's1', baseTags: ['platform:hermes'], titleLabel: 'hermes', date: '2026-09-12' };

  it('produces -files, -fixes and -summary for a heavy session that fixed an error', () => {
    const out = buildSessionInsights(activityFromChatMessages(fixture.messages), ctx);
    expect(out.map((e) => e.name)).toEqual(['session-s1-files', 'session-s1-fixes', 'session-s1-summary']);
    const files = out[0];
    expect(files.observations[0]).toBe('Session edited 2 file(s): app.py, test_app.py');
    expect(files.tags).toEqual(expect.arrayContaining(['source:auto-capture', 'session:s1', 'platform:hermes', 'file:app.py', 'file:app']));
    expect(out[1].tags).toContain('type:bugfix');
    expect(out[2].tags).toContain('type:heavy-session');
    expect(files.title).toBe('2026-09-12 hermes: edited 2 file(s)');
  });

  it('stores nothing for a quiet session (fewer than 3 tool calls)', () => {
    const out = buildSessionInsights(
      { filesEdited: ['a.ts'], bashCommands: [], errorsEncountered: [], toolCallCount: 2, unrecognizedTools: [] },
      ctx,
    );
    expect(out).toEqual([]);
  });

  it('writes -fixes only when a file was also edited', () => {
    const out = buildSessionInsights(
      { filesEdited: [], bashCommands: [], errorsEncountered: ['boom'], toolCallCount: 5, unrecognizedTools: [] },
      ctx,
    );
    expect(out).toEqual([]);
  });
});

describe('captureChatSession', () => {
  useTestDatabase('memesh-session-insight-');

  it('writes the entities with source_host from the caller, and re-capture does not duplicate', () => {
    const first = captureChatSession({
      sessionId: 'h-1', messages: fixture.messages, sourceHost: 'hermes', baseTags: ['platform:hermes'], titleLabel: 'hermes',
    });
    expect(first.outcome).toBe('wrote');
    expect(first.written).toEqual(['session-h-1-files', 'session-h-1-fixes', 'session-h-1-summary']);

    const kg = new KnowledgeGraph(getDatabase());
    for (const name of first.written) {
      const e = kg.getEntity(name);
      expect(e, name).not.toBeNull();
      expect(e!.type).toBe('session-insight');
      expect((e!.metadata as { provenance?: { source_host?: string } }).provenance?.source_host).toBe('hermes');
    }
    const before = kg.getEntity('session-h-1-files')!.observations.length;
    captureChatSession({
      sessionId: 'h-1', messages: fixture.messages, sourceHost: 'hermes', baseTags: ['platform:hermes'], titleLabel: 'hermes',
    });
    expect(kg.getEntity('session-h-1-files')!.observations.length).toBe(before);
  });

  it('reports a skip with its reason instead of writing', () => {
    const r = captureChatSession({
      sessionId: 'h-2', messages: [{ role: 'user', content: 'hi' }], sourceHost: 'hermes', baseTags: [], titleLabel: 'hermes',
    });
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toMatch(/too little activity/);
    expect(new KnowledgeGraph(getDatabase()).getEntity('session-h-2-files')).toBeNull();
  });
});
