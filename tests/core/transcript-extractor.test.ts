import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVisibleConversation } from '../../src/core/transcript-extractor.js';

function writeTranscript(dir: string, sessionId: string, entries: Array<{ type: string; content: unknown }>, cwd?: string): string {
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = entries.map((e) => JSON.stringify({ type: e.type, cwd, message: { role: e.type, content: e.content } }));
  writeFileSync(path, lines.join('\n') + '\n');
  const now = Date.now();
  utimesSync(path, new Date(now), new Date(now));
  return path;
}

describe('transcript-extractor: parsing', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'memesh-tx-parse-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns only visible UTF-8 user and assistant text in order when explicitly requested', () => {
    const path = writeTranscript(tmp, 'visible', [
      { type: 'user', content: '使用者的第一句：你好' },
      { type: 'assistant', content: [
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'text', text: '助手可見回覆：您好' },
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hidden' } },
        { type: 'text', text: '第二個可見文字區塊' },
      ] },
      { type: 'user', content: [{ type: 'tool_result', content: 'hidden tool result' }] },
      { type: 'user', content: '<command-message>hidden command scaffolding</command-message>' },
      { type: 'user', content: [{ type: 'text', text: '使用者最後一句：再見' }] },
    ]);
    writeFileSync(path, `${readFileSync(path, 'utf8')}not valid json\n`);

    const expected = [
      { role: 'user', text: '使用者的第一句：你好' },
      { role: 'assistant', text: '助手可見回覆：您好' },
      { role: 'assistant', text: '第二個可見文字區塊' },
      { role: 'user', text: '使用者最後一句：再見' },
    ];
    const snapshot = readFileSync(path);
    rmSync(path);
    expect(parseVisibleConversation(snapshot)).toEqual(expected);
  });

  it('filters every meta-user prefix equally in strings and array text blocks', () => {
    const prefixes = ['local-command', 'command-name', 'command-message', 'command-args', 'bash-input', 'bash-stdout', 'bash-stderr', 'user-memory-input', 'system-reminder'];
    const path = writeTranscript(tmp, 'meta-arrays', [
      ...prefixes.flatMap(prefix => [
        { type: 'user', content: `  <${prefix}>hidden string scaffolding` },
        { type: 'user', content: [{ type: 'text', text: `  <${prefix}>hidden array scaffolding` }] },
      ]),
      { type: 'user', content: [{ type: 'text', text: '  Genuine user text  ' }, { type: 'tool_result', content: 'hidden tool output' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Visible assistant answer' }] },
    ]);
    const expected = [{ role: 'user', text: 'Genuine user text' }, { role: 'assistant', text: 'Visible assistant answer' }];
    expect(parseVisibleConversation(readFileSync(path))).toEqual(expected);
  });
});
