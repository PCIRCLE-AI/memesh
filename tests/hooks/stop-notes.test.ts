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
  function toolCall(name: string, input: object, result: { error?: boolean; content?: string } = {}) {
    const id = `tu_${++n}`;
    return [
      { type: 'assistant', timestamp: at(60_000), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
      { type: 'user', timestamp: at(59_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: result.error === true, content: result.content ?? 'ok' }] } },
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
    expect(outcomes('remember-nudge').at(-1)?.reason).toMatch(/trivial turn/);
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

  it('a first ingestion of a large memory directory finishes inside the declared Stop budget', () => {
    // The budget is read from hooks/hooks.json, not restated here.
    const hooks = JSON.parse(fs.readFileSync(path.resolve('hooks/hooks.json'), 'utf8'));
    const stop = hooks.hooks.Stop[0].hooks.find((h: { command: string }) => h.command.includes('session-summary.js'));
    const budgetMs = stop.timeout * 1000;
    expect(budgetMs).toBeGreaterThan(0);

    fs.mkdirSync(memoryDir);
    for (let i = 0; i < 150; i++) {
      const body = Array.from({ length: 12 }, (_, p) => `Paragraph ${p} of note ${i}: ${'lorem ipsum '.repeat(20)}`).join('\n\n');
      fs.writeFileSync(path.join(memoryDir, `n${String(i).padStart(3, '0')}.md`),
        `---\nname: budget_note_${i}\ndescription: Budget note ${i}\nmetadata:\n  type: fact\n---\n\n${body}\n`);
    }
    write(reads(1));
    const started = Date.now();
    const r = run();
    const elapsed = Date.now() - started;
    expect(r.status).toBe(0);
    // Half the budget: the rest of the Stop hook (capture, auto-update) and a
    // slower machine must still fit.
    expect(elapsed, `Stop hook took ${elapsed} ms against a ${budgetMs} ms budget`).toBeLessThan(budgetMs / 2);
    const last = outcomes('note-ingest').at(-1)!;
    expect(last.outcome).toBe('wrote');
    // 150 files, 100 read per Stop: the rest are reported and wait.
    expect(last.reason).toMatch(/100 created/);
    expect(last.reason).toMatch(/50 more not processed/);
  }, 60_000);

  it('F8: a rejected plan is not an approved one — with or without is_error', () => {
    const declined = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
    write([...reads(4), ...toolCall('ExitPlanMode', {}, { error: true, content: declined })]);
    expect(run().stdout.trim()).toBe('');
    append([...reads(4), ...toolCall('ExitPlanMode', {}, { content: declined })]);
    expect(run().stdout.trim()).toBe('');
    expect(outcomes('remember-nudge').at(-1)?.reason).toMatch(/no decision-shaped move/);
  }, 60_000);

  it('a commit is `git commit` in command position, not a search for the words', () => {
    write([...reads(4), ...toolCall('Bash', { command: 'grep -rn "git commit" docs' }), ...toolCall('Bash', { command: 'git commit-tree abc' })]);
    expect(run().stdout.trim()).toBe('');
    append([...reads(4), ...toolCall('Bash', { command: 'cd repo && git -C . commit -m "x"' })]);
    expect(JSON.parse(run().stdout).systemMessage).toMatch(/a commit/);
  }, 60_000);

  it('F7: offset files of sessions idle for 30 days are pruned; recent ones kept', () => {
    const dir = path.join(home, '.memesh', 'remember-nudge');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old-session.json');
    const recent = path.join(dir, 'recent-session.json');
    fs.writeFileSync(old, '{"offset":0}');
    fs.writeFileSync(recent, '{"offset":0}');
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    write(reads(1));
    expect(run().status).toBe(0);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(path.join(dir, `${sessionId}.json`))).toBe(true);
  }, 60_000);

  it('P2-b: "rejected"/"declined" in ordinary output does not cancel a real move', () => {
    write([
      ...reads(4),
      ...toolCall('Bash', { command: 'git commit -m "fix: handle rejected payments"' }, { content: '[main abc1234] fix: handle rejected payments' }),
    ]);
    expect(JSON.parse(run().stdout).systemMessage).toMatch(/a commit/);
    append([
      ...reads(3),
      ...toolCall('Bash', { command: 'npx vitest run' }, { error: true, content: 'AssertionError: expected promise to be rejected' }),
      ...toolCall('Bash', { command: 'npx vitest run' }, { content: 'Tests 3 passed; expected promise to be rejected ✓' }),
    ]);
    expect(JSON.parse(run().stdout).systemMessage).toMatch(/a test went red then green/);
    append([...reads(4), ...toolCall('ExitPlanMode', { plan: 'x' }, { content: 'User has approved your plan. Handle declined cards first.' })]);
    expect(JSON.parse(run().stdout).systemMessage).toMatch(/a plan was approved/);
  }, 60_000);

  it('P3-b: commit detection covers quoted -C paths, env prefixes and sudo', () => {
    write([...reads(4), ...toolCall('Bash', { command: 'git -C "/a b/c" commit -m x' })]);
    expect(JSON.parse(run().stdout).systemMessage).toMatch(/a commit/);
    append([...reads(4), ...toolCall('Bash', { command: 'GIT_EDITOR=true git commit --amend' })]);
    expect(JSON.parse(run().stdout).systemMessage).toMatch(/a commit/);
    append([...reads(4), ...toolCall('Bash', { command: 'sudo git commit -m y' })]);
    expect(JSON.parse(run().stdout).systemMessage).toMatch(/a commit/);
  }, 60_000);
});
