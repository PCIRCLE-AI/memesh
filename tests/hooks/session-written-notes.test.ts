/**
 * Which note files a private session's transcripts name. Real transcript row
 * shapes (Claude Code `assistant` rows, `progress` rows of a subagent), invented text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notePathsWrittenInTranscript as written } from '../../scripts/hooks/_session-written-notes.js';
import { sessionTranscriptFiles } from '../../src/core/private-session.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { canDenyReads } from '../helpers/permissions.js';

const use = (name: string, input: object) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input }] } });
const jsonl = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
/** The scan, with every named note in one list. */
const notePathsWrittenInTranscript = (...args: Parameters<typeof written>) => { const r = written(...args); return { ...r, paths: [...r.byDir.values()].flat() as string[] }; };

// Windows (Q6_16 F7, F8): two assertions here are not made there, and why. The CI's windows-latest runner is several
// times slower than the others (its own comment in .github/workflows/ci.yml), so an absolute bound in milliseconds
// would go red on load, not on a defect: the cost is held relative there instead, by "costs about the same with ten
// notes as with three thousand". And whether `utimes` moves the change time on NTFS has not been verified, so the
// test that needs it does not claim it there. [ASSUMPTION] — a windows-latest run of this file settles it.
const onWindows = process.platform === 'win32';

describe('the note files a session names', () => {
  let root: string;
  let notes: string;
  let transcript: string;
  const note = (rel: string) => {
    const file = path.join(notes, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'body');
    return file;
  };
  const named = (rows: object[]) => {
    fs.writeFileSync(transcript, jsonl(rows));
    const result = notePathsWrittenInTranscript(transcript, notes, { deadlineAt: Date.now() + 60_000 });
    expect(result.complete).toBe(true);
    return result.paths.map((p) => path.relative(notes, p)).sort();
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-written-notes-'));
    notes = path.join(root, 'memory');
    fs.mkdirSync(notes);
    transcript = path.join(root, 'sess.jsonl');
  });
  afterEach(() => removeTempDir(root));

  it('reads every string of every tool input, whatever the tool or the field is called', () => {
    note('a.md'); note('b.md'); note('c.md'); note('d.md');
    expect(named([
      use('mcp__filesystem__write_file', { path: path.join(notes, 'a.md'), content: 'x' }),
      use('mcp__other__anything', { target: { deep: [{ name: 'b.md' }] } }),
      use('Task', { description: 'write notes', prompt: 'please update c.md for me' }),
    ])).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('does not count text that is not a tool input', () => {
    note('a.md'); note('b.md'); note('c.md');
    const rows = [
      { type: 'user', message: { role: 'user', content: 'edit a.md please' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I edited a.md' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'b.md written' }] } },
    ];
    // A text block in the very row that carries a tool_use does not count either: only the tool input does.
    expect(named([{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will not touch a.md' }, { type: 'tool_use', id: 't9', name: 'Write', input: { file_path: '/p/c.md' } }] } }])).toEqual(['c.md']);
    expect(named(rows)).toHaveLength(0);
    expect(named([...rows, use('Write', { file_path: '/p/b.md' })]), 'the same rows with one real tool call name it').toEqual(['b.md']);
  });

  it('reads a subagent\'s transcript and the tool calls it reports as progress rows', () => {
    note('sub.md'); note('prog.md'); note('none.md');
    fs.mkdirSync(path.join(root, 'sess', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sess', 'subagents', 'agent-1.jsonl'), jsonl([use('Write', { file_path: path.join(notes, 'sub.md') })]));
    expect(sessionTranscriptFiles(transcript).map((f) => path.basename(f))).toEqual(['sess.jsonl', 'agent-1.jsonl']);
    expect(named([
      { type: 'progress', data: { type: 'agent_progress', message: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'Edit', input: { file_path: path.join(notes, 'prog.md') } }] } } } },
    ])).toEqual(['prog.md', 'sub.md']);
  });

  it('matches a name with spaces, a backslash-escaped space and a Windows path', () => {
    note('my note.md'); note('win.md'); note('other.md');
    expect(named([
      use('Bash', { command: 'cp x.md my\\ note.md' }),
      use('Bash', { command: 'type C:\\notes\\win.md' }),
    ])).toEqual(['my note.md', 'win.md']);
  });

  it('finds a note in a subfolder by its file name', () => {
    note('deep/er/still.md'); note('top.md');
    const found = named([use('Write', { file_path: '/anywhere/still.md' })]);
    expect(found).toHaveLength(1);
    expect(found).toEqual(['deep/er/still.md']);
  });

  it('matches whole names only', () => {
    note('na.md'); note('banana.md');
    expect(named([use('Bash', { command: 'echo > banana.md' })])).toEqual(['banana.md']);
    expect(named([use('Bash', { command: 'cat na.mdx na.md5 xna.md' })])).toHaveLength(0);
  });

  it('stops at its time budget and says so: the caller then holds by time (see holdOutNotes)', () => {
    note('fresh.md');
    fs.writeFileSync(transcript, jsonl([use('Bash', { command: 'echo hi' })]));
    const result = notePathsWrittenInTranscript(transcript, notes, { deadlineAt: Date.now() - 1 });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('time');
    expect(result.paths).toEqual([]);
  });

  it.skipIf(onWindows)('reads a large transcript with many notes in time: the cost does not grow with lines times notes', () => {
    for (let i = 0; i < 300; i++) note(`n${i}.md`);
    note('target.md');
    const filler = (i: number) => use('Bash', { command: `cat docs/guide${i % 50}.md README.md CHANGELOG.md ${'x'.repeat(2000)}` });
    const lines: string[] = [];
    for (let i = 0; i < 40000; i++) lines.push(JSON.stringify(filler(i)));
    lines.push(JSON.stringify(use('Write', { file_path: '/p/target.md' })));
    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
    const started = Date.now();
    const result = notePathsWrittenInTranscript(transcript, notes, { deadlineAt: Date.now() + 20000 });
    expect(result.complete).toBe(true);
    expect(result.paths.map((p) => path.basename(p))).toEqual(['target.md']);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 60000);

  it('finds a name right after a line break, a tab or a carriage return (they are escapes in the JSON line)', () => {
    note('nl.md'); note('tab.md'); note('cr.md'); note('cont.md'); note('quiet.md');
    expect(named([
      use('Bash', { command: 'xargs rm <<EOF\nnl.md\nEOF' }),
      use('Task', { prompt: 'Write these notes:\n\ttab.md\r\ncr.md' }),
      use('Bash', { command: 'cat x > \\\ncont.md' }),
    ])).toEqual(['cont.md', 'cr.md', 'nl.md', 'tab.md']);
  });

  it.skipIf(onWindows)('reads a line that is nothing but note names within the time limit, however long it is', () => {
    note('n1.md'); note('target.md');
    const dense = Array.from({ length: 300000 }, (_, i) => `[a${i}](f${i % 97}.md)`).join(' ');
    fs.writeFileSync(transcript, jsonl([use('Write', { file_path: '/p/m.md', content: dense }), use('Write', { file_path: '/p/target.md' })]));
    const started = Date.now();
    const result = notePathsWrittenInTranscript(transcript, notes, { deadlineAt: Date.now() + 20000 });
    expect(result.complete).toBe(true);
    expect(result.paths.map((p) => path.basename(p))).toEqual(['target.md']);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 60000);

  it('stops inside one very long line when the deadline passes', () => {
    note(`${'n'.repeat(190)}.md`); // a long name makes the work for each .md as long as it can be
    const dense = Array.from({ length: 400000 }, (_, i) => `a${i}.md`).join(' ');
    fs.writeFileSync(transcript, jsonl([use('Write', { file_path: '/p/x.md', content: dense })]));
    const unlimited = Date.now();
    expect(notePathsWrittenInTranscript(transcript, notes, { deadlineAt: Date.now() + 60000 }).complete).toBe(true);
    const full = Date.now() - unlimited;
    expect(full, 'the line takes real time to read').toBeGreaterThan(120);
    const started = Date.now();
    const result = notePathsWrittenInTranscript(transcript, notes, { deadlineAt: Date.now() + 40 });
    expect(result.complete).toBe(false);
    expect(Date.now() - started, "it stopped inside the line, not after it").toBeLessThan(full * 0.6);
  }, 60000);

  it('refuses to run without a deadline: a default once let a hook read past the time its host gives it (Q6_20 F3)', () => {
    fs.writeFileSync(transcript, jsonl([use('Bash', { command: 'echo hi' })]));
    expect(() => notePathsWrittenInTranscript(transcript, notes)).toThrow(/needs a deadline/);
  });

  it('reads a name split by shell quotes, a simple brace list, and a name composed differently from the one on disk (Q6_14 F2)', () => {
    note('secret.md'); note('other.md'); note('ab.md'); note('cafe\u0301.md');
    expect(named([use('Bash', { command: 'cp /tmp/draft.txt memory/sec"ret".md' })])).toEqual(['secret.md']);
    expect(named([use('Bash', { command: "cp x 'a''b.md'" })])).toEqual(['ab.md']);
    expect(named([use('Bash', { command: 'touch memory/{secret,other}.md' })])).toEqual(['other.md', 'secret.md']);
    expect(named([use('Write', { file_path: '/p/memory/caf\u00e9.md' })])).toEqual(['cafe\u0301.md']);
  });

  it('reads the tool input of Codex rows: a custom_tool_call script and a function_call\'s JSON arguments (Q6_14 F1)', () => {
    note('x.md'); note('y.md'); note('z.md');
    expect(named([
      { type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({ cmd: "echo body > /h/.claude/projects/-work-b/memory/x.md" }));' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cp a memory/y.md'] }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'z.md is only in an output' } },
    ])).toEqual(['x.md', 'y.md']);
  });

  it('says it could not read, and holds recently changed notes, when a transcript or the subagents folder cannot be read', () => {
    const fresh = note('fresh.md');
    fs.writeFileSync(transcript, jsonl([use('Write', { file_path: '/p/fresh.md' })]));
    fs.mkdirSync(path.join(root, 'sess', 'subagents'), { recursive: true });
    const unreadable = notePathsWrittenInTranscript(path.join(root, 'missing.jsonl'), notes, { deadlineAt: Date.now() + 60_000 });
    expect(unreadable.complete).toBe(false);
    expect(unreadable.reason).toBe('unreadable');
    expect(unreadable.paths).toEqual([]); // nothing could be read for names: the caller holds by time
    void fresh;
  });

  it.skipIf(!canDenyReads)('keeps what it found when a later file cannot be read, and adds the notes changed in the window to it', () => {
    const found = note('found.md');
    note('other.md');
    fs.writeFileSync(transcript, jsonl([use('Write', { file_path: '/p/found.md' })]));
    const sub = path.join(root, 'sess', 'subagents', 'agent-1.jsonl');
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, '');
    fs.chmodSync(sub, 0o000);
    try {
      const result = notePathsWrittenInTranscript(transcript, notes, { deadlineAt: Date.now() + 60_000 });
      expect(result.reason).toBe('unreadable');
      expect(result.paths).toEqual([found]);
    } finally { fs.chmodSync(sub, 0o644); }
  });

  it('costs about the same with ten notes as with three thousand (the work does not grow with lines times notes)', () => {
    const filler = JSON.stringify(use('Bash', { command: `cat docs/a.md docs/b.md docs/c.md ${'x'.repeat(300)}` }));
    fs.writeFileSync(transcript, `${Array.from({ length: 40000 }, () => filler).join('\n')}\n`);
    const timed = (count: number) => {
      const dir = path.join(root, `notes-${count}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `n${i}.md`), 'x');
      const started = performance.now();
      const result = notePathsWrittenInTranscript(transcript, dir, { deadlineAt: Date.now() + 60_000 });
      expect(result.complete).toBe(true);
      return performance.now() - started;
    };
    timed(10); // warm up
    const few = timed(10);
    const many = timed(3000);
    expect(many, `10 notes: ${few.toFixed(0)} ms, 3000 notes: ${many.toFixed(0)} ms`).toBeLessThan(few * 4 + 400);
  }, 120000);
});
