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

  function run(env: Record<string, string> = {}, payload: Record<string, unknown> = {}) {
    const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    delete childEnv.MEMESH_DB_PATH;
    delete childEnv.MEMESH_DIR;
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: home, hook_event_name: 'Stop', ...payload }),
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

  it('a first ingestion of a large memory directory stays bounded to INGEST_MAX_FILES per Stop', () => {
    // What keeps a first ingestion inside the Stop budget is the per-run file
    // cap, and THAT is what this asserts. It used to assert on elapsed wall
    // time instead (`elapsed < budgetMs / 2`), which measured the machine, not
    // the code: with the cap mutated from 100 to 150 — the bound removed
    // outright — the run still finished in 149 ms of a 10,000 ms budget and
    // only the `100 created` assertion below went red. So the timing check
    // protected nothing the counts do not, while carrying the one risk this
    // project has already paid for once: a fixture bound to the clock, red on
    // a loaded runner for no defect, with 244 test files running serially.
    // The budget is read from hooks/hooks.json, not restated here, and
    // reported on failure as context — never as the verdict.
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
    const timing = `Stop hook took ${elapsed} ms against a ${budgetMs} ms budget`;
    const last = outcomes('note-ingest').at(-1)!;
    expect(last.outcome, timing).toBe('wrote');
    // 150 files, 100 read per Stop: the rest are reported and wait. This pair
    // is the budget guard — remove the cap and `150 created` comes back here.
    expect(last.reason, timing).toMatch(/100 created/);
    expect(last.reason, timing).toMatch(/50 more not processed/);
  }, 60_000);

  // Permission bits mean nothing to root, so the EACCES this test needs
  // cannot be produced there. Skipped rather than silently vacuous.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(asRoot)('an unreadable memory directory is an error, not "no memory directory"', () => {
    // claudeMemoryDir's `catch { return null; }` gave EACCES and EIO the same
    // answer as ENOENT, so a user whose memory directory became unreadable
    // was told every Stop, forever, that they simply have no notes — a
    // sentence that is both false and reassuring. It is worse than a plain
    // silent skip: note-ingest is not in SILENT_ELIGIBLE_HOOKS, so doctor
    // never escalates the hook that keeps answering "nothing to do here".
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'a.md'),
      '---\nname: locked_note\ndescription: Locked\nmetadata:\n  type: fact\n---\n\nbody\n');
    write(reads(1));
    // No search permission on the parent: lstat of any child fails EACCES.
    fs.chmodSync(projectDir, 0o600);
    try {
      const r = run();
      expect(r.status).toBe(0);
      const last = outcomes('note-ingest').at(-1)!;
      expect(last.outcome, 'a permissions failure recorded as a skip').toBe('error');
      expect(last.reason).not.toBe('no Claude Code memory directory for this project');
    } finally {
      fs.chmodSync(projectDir, 0o700);
    }
  }, 60_000);

  it('a payload with no cwd does not file notes under no project at all', () => {
    // Ingestion used to run BEFORE the cwd guard, with
    // `project: inputData.cwd ? getProjectName(inputData.cwd) : undefined`.
    // The same file refuses session capture for this exact condition, saying
    // it is better to miss one capture than to file it under the wrong
    // project — and a note filed under NO project is not recoverable later
    // either: note-ingest fast-paths an unchanged file, so the tag backfill
    // is never reached unless the user edits the note again.
    //
    // The nudge half must still run: it writes nothing and needs no project.
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'a.md'),
      '---\nname: nocwd_note\ndescription: No cwd\nmetadata:\n  type: decision\n---\n\nbody\n');
    write([...reads(4), ...toolCall('ExitPlanMode', { plan: 'do X' })]);

    const r = run({}, { cwd: undefined });
    expect(r.status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({
      outcome: 'skipped',
      reason: 'cwd absent in payload — cannot resolve project',
    });

    // Nothing was stored. On a first Stop the skip is total — ingestion never
    // opens a database, so there is no `entities` table to query; both that
    // and an empty answer mean the same thing here.
    const dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
    let stored: unknown;
    if (fs.existsSync(dbPath)) {
      const db = new MemeshDatabase(dbPath);
      try {
        stored = db.prepare("SELECT id FROM entities WHERE name = 'nocwd_note'").get();
      } catch (err) {
        expect(String(err), 'the only tolerated failure is that no graph exists yet').toMatch(/no such table: entities/);
      }
      db.close();
    }
    expect(stored, 'a note was stored with no project tag it can never gain').toBeUndefined();

    // The nudge half still ran and reached its own verdict — it is silenced
    // here by the note file this test just wrote, which is its normal rule,
    // not by the missing cwd. What matters is that skipping ingestion did not
    // take the nudge down with it.
    expect(outcomes('remember-nudge').at(-1)).toMatchObject({
      outcome: 'skipped',
      reason: 'a note file changed since the last Stop',
    });

    // And with cwd present the same directory ingests normally.
    fs.utimesSync(path.join(memoryDir, 'a.md'), new Date(), new Date());
    append(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote' });
    const db2 = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
    const tags = db2.prepare(
      "SELECT t.tag FROM entities e JOIN tags t ON t.entity_id = e.id WHERE e.name = 'nocwd_note' AND t.tag LIKE 'project:%'",
    ).all() as Array<{ tag: string }>;
    db2.close();
    expect(tags.length).toBeGreaterThan(0);
  }, 60_000);

  it('the Stop after an over-cap run resumes it, without any file being touched', () => {
    // The resume flag had no guard: mutating `more: result.more > 0` to
    // `more: false` in _stop-notes.js left all fourteen tests green. The gap
    // was never "no test runs a second Stop" — several do — it is that no
    // test ran a second Stop AFTER AN OVER-CAP RUN. Without the flag the
    // mtime throttle (`newest <= last`) short-circuits the second Stop, and
    // the 50 notes the cap deferred are never ingested at all: they wait for
    // an edit that will never come, silently.
    fs.mkdirSync(memoryDir);
    for (let i = 0; i < 150; i++) {
      fs.writeFileSync(path.join(memoryDir, `n${String(i).padStart(3, '0')}.md`),
        `---\nname: resume_note_${i}\ndescription: Resume note ${i}\nmetadata:\n  type: fact\n---\n\nbody of note ${i}\n`);
    }
    write(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)?.reason).toMatch(/100 created/);

    const stored = () => {
      const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM entities e JOIN tags t ON t.entity_id = e.id AND t.tag = 'source:note-file' WHERE e.name LIKE 'resume_note_%'",
      ).get() as { n: number };
      db.close();
      return row.n;
    };
    expect(stored()).toBe(100);

    // Second Stop. Nothing on disk changed — no write, no touch, no new
    // transcript work beyond one trivial read. Only the resume flag can carry
    // this run past the mtime throttle.
    append(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote' });
    expect(outcomes('note-ingest').at(-1)?.reason).toMatch(/50 created/);
    expect(stored()).toBe(150);
  }, 120_000);

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

  it('a move and a returning file are writes, not "nothing new" (#324)', () => {
    fs.mkdirSync(memoryDir);
    const body = '---\nname: moved_note\ndescription: Moved\nmetadata:\n  type: decision\n---\n\nmoved body\n';
    fs.writeFileSync(path.join(memoryDir, 'a.md'), body);
    write(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote' });

    // A pure rename: the bytes are the same, the path is not.
    fs.renameSync(path.join(memoryDir, 'a.md'), path.join(memoryDir, 'b.md'));
    append(reads(1));
    expect(run().status).toBe(0);
    const moved = outcomes('note-ingest').at(-1)!;
    expect(moved.outcome, 'a move changed the database and was recorded as nothing').toBe('wrote');
    expect(moved.reason).toMatch(/1 moved/);

    // Gone, then back at the same path: the missing tag is cleared, which is
    // also a write.
    fs.renameSync(path.join(memoryDir, 'b.md'), path.join(home, 'away.md'));
    append(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote' });
    fs.renameSync(path.join(home, 'away.md'), path.join(memoryDir, 'b.md'));
    append(reads(1));
    expect(run().status).toBe(0);
    const restored = outcomes('note-ingest').at(-1)!;
    expect(restored.outcome, 'a memory coming back out of "missing" was recorded as nothing').toBe('wrote');
    expect(restored.reason).toMatch(/1 restored/);
  }, 60_000);
});
