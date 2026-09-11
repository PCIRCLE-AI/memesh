/**
 * #324 pieces C (hook path) and D, against the REAL spawned Stop hook
 * (scripts/hooks/session-summary.js → scripts/hooks/_stop-notes.js).
 *
 * D: the nudge fires on a turn with a decision-shaped move and nothing
 *    written; stays silent when a `remember` happened, when a note file
 *    changed, and on a trivial turn; judges each Stop only on what happened
 *    since the previous one; never exits non-zero; prints a valid envelope.
 * C: the Claude Code memory directory next to the transcript is ingested,
 *    and an unchanged directory costs no second ingestion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { expectValidHookOutput } from '../helpers/hook-output-contract.js';

const HOOK = path.resolve('scripts/hooks/session-summary.js');

describe('Stop hook: note ingestion and the remember nudge (#324)', () => {
  let home: string;
  let projectDir: string;
  let transcript: string;
  let memoryDir: string;
  const sessionId = 'nudge-session-1';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stop-notes-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    projectDir = path.join(home, '.claude', 'projects', '-tmp-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    transcript = path.join(projectDir, `${sessionId}.jsonl`);
    memoryDir = path.join(projectDir, 'memory');
  });

  afterEach(() => removeTempDir(home));

  function run(env: Record<string, string> = {}) {
    const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    delete childEnv.MEMESH_DB_PATH;
    delete childEnv.MEMESH_DIR;
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: home, hook_event_name: 'Stop' }),
      env: childEnv,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  }

  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  let n = 0;
  function toolCall(name: string, input: object, result: { error?: boolean } = {}) {
    const id = `tu_${++n}`;
    return [
      { type: 'assistant', timestamp: at(60_000), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
      { type: 'user', timestamp: at(59_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: result.error === true, content: 'ok' }] } },
    ];
  }
  const reads = (count: number) => Array.from({ length: count }, (_, i) => toolCall('Read', { file_path: `/repo/f${i}.ts` })).flat();
  const write = (entries: object[]) => fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const append = (entries: object[]) => fs.appendFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  /** The recorded outcomes for one hook name. Pinned non-empty: every Stop
   *  must leave a record, so an empty list is itself a failure, never a
   *  vacuous pass for the `.at(-1)` assertions that follow. */
  function outcomes(hook: string): Array<{ outcome: string; reason?: string }> {
    const file = path.join(home, '.memesh', 'hook-outcomes.jsonl');
    const records = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hook === hook)
      : [];
    expect(records.length, `no ${hook} outcome was recorded`).toBeGreaterThan(0);
    return records;
  }

  it('nudges once on a turn with a plan approved and nothing written', () => {
    write([...reads(4), ...toolCall('ExitPlanMode', { plan: 'do X' })]);
    const r = run();
    expect(r.status).toBe(0);
    const v = expectValidHookOutput(r.stdout, 'session-summary.js nudge');
    expect(v.kind).toBe('json');
    expect(Object.keys(v.parsed!)).toEqual(['systemMessage']);
    expect(v.parsed!.systemMessage).toMatch(/1 decision-shaped move\(s\) \(a plan was approved\) and stored no memory/);
    expect(outcomes('remember-nudge').at(-1)).toMatchObject({ outcome: 'wrote' });

    // The next Stop sees only what was appended since: a trivial turn → silent.
    append(reads(1));
    const again = run();
    expect(again.status).toBe(0);
    expect(again.stdout.trim()).toBe('');
    expect(outcomes('remember-nudge').at(-1)?.reason).toMatch(/trivial/);
  }, 60_000);

  it('counts a commit and a test that went red then green', () => {
    write([
      ...reads(2),
      ...toolCall('Bash', { command: 'npm test' }, { error: true }),
      ...toolCall('Bash', { command: 'npm test' }),
      ...toolCall('Bash', { command: 'git commit -m "fix"' }),
    ]);
    const r = run();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/2 decision-shaped move\(s\) \(a test went red then green, a commit\)/);
  }, 60_000);

  it('is silent when a remember call happened in the turn', () => {
    write([...reads(4), ...toolCall('ExitPlanMode', {}), ...toolCall('mcp__plugin_memesh_memesh__remember', { note: 'x' })]);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(outcomes('remember-nudge').at(-1)?.reason).toMatch(/memory was written/);
  }, 60_000);

  it('is silent when a note file changed during the turn', () => {
    write([...reads(4), ...toolCall('AskUserQuestion', {})]);
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'x.md'), 'just a scratch note\n');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(outcomes('remember-nudge').at(-1)?.reason).toMatch(/note file changed/);
  }, 60_000);

  it('is silent on a trivial turn, and on a busy turn with no decision-shaped move', () => {
    write([...toolCall('ExitPlanMode', {})]);
    expect(run().stdout.trim()).toBe('');
    append(reads(6));
    expect(run().stdout.trim()).toBe('');
    expect(outcomes('remember-nudge').at(-1)?.reason).toMatch(/no decision-shaped move/);
  }, 60_000);

  it('still nudges with auto-capture off, but does not ingest', () => {
    fs.mkdirSync(memoryDir);
    fs.utimesSync(memoryDir, new Date(0), new Date(0));
    write([...reads(4), ...toolCall('ExitPlanMode', {})]);
    const r = run({ MEMESH_AUTO_CAPTURE: 'false' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/stored no memory/);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'auto-capture is turned off' });
  }, 60_000);

  it('ingests the memory directory next to the transcript, then skips it while unchanged', () => {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'a.md'), '---\nname: hook_note_a\ndescription: Hook alpha\nmetadata:\n  type: decision\n---\n\nalpha body\n');
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- index only\n');
    write(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote' });
    expect(outcomes('note-ingest').at(-1)?.reason).toMatch(/1 created/);

    const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
    const row = db.prepare(
      "SELECT e.title FROM entities e JOIN tags t ON t.entity_id = e.id AND t.tag = 'source:note-file' WHERE e.name = 'hook_note_a'",
    ).get() as { title: string } | undefined;
    db.close();
    expect(row?.title).toBe('Hook alpha');

    append(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'no note file changed since the last ingestion' });
  }, 60_000);
});
