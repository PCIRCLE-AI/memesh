// Exercise note ingestion through the real Stop hook.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { noteDirId } from '../../src/core/note-dirs.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { canDenyReads } from '../helpers/permissions.js';
import { readFileSnapshot } from '../helpers/fs-snapshot.js';

const HOOK = path.resolve('scripts/hooks/session-summary.js');

describe('Stop note ingestion', () => {
  let home: string;
  let projectDir: string;
  let transcript: string;
  let memoryDir: string;
  const sessionId = 'stop-notes-session-1';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stop-notes-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    // Claude Code's folder for a session started in `home` (the payload's cwd below).
    projectDir = path.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    transcript = path.join(projectDir, `${sessionId}.jsonl`);
    memoryDir = path.join(projectDir, 'memory');
  });

  afterEach(() => removeTempDir(home));

  function run(env: Record<string, string> = {}, payload: Record<string, unknown> = {}, timeout = 20_000) {
    const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    delete childEnv.MEMESH_DB_PATH;
    delete childEnv.MEMESH_DIR;
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: home, hook_event_name: 'Stop', ...payload }),
      env: childEnv,
      encoding: 'utf8',
      timeout,
    });
    let terminal = false;
    try { process.kill(r.pid, 0); } catch (error) { terminal = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, signal: r.signal, pid: r.pid, terminal };
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

  it('B-F14 preserves same-run writes, each refusal count, and deferred files through real Stop', () => {
    fs.mkdirSync(memoryDir);
    const note = (name: string, body = 'body') => `---\nname: ${name}\n---\n\n${body}\n`;
    fs.writeFileSync(path.join(memoryDir, '00-large.md'), note('rejected_large', 'x'.repeat(300 * 1024)));
    fs.writeFileSync(path.join(memoryDir, '01-noheader.md'), 'no header');
    fs.writeFileSync(path.join(memoryDir, '02-observations.md'), note('rejected_many', Array.from({ length: 101 }, (_, i) => `paragraph ${i}`).join('\n\n')));
    fs.writeFileSync(path.join(memoryDir, '03-noname.md'), '---\ndescription: name absent\n---\nbody');
    fs.writeFileSync(path.join(memoryDir, '04-empty.md'), note('rejected_empty', ''));
    const outside = path.join(home, 'outside.md'); fs.writeFileSync(outside, note('rejected_link'));
    fs.symlinkSync(outside, path.join(memoryDir, '05-link.md'));
    // 123 regular files: five refusals + 118 valid; link does not spend a read slot.
    for (let i = 0; i < 118; i++) fs.writeFileSync(path.join(memoryDir, `n${String(i).padStart(3, '0')}.md`), note(`bf14_good_${i}`));
    write(reads(1));
    expect(run().status).toBe(0);
    const ledger = () => JSON.parse('[' + fs.readFileSync(path.join(home, '.memesh/hook-outcomes.jsonl'), 'utf8').trim().split('\n').join(',') + ']') as Array<{hook:string;run:string;outcome:string;reason?:string;count?:number}>;
    const first = ledger().filter((r) => r.hook === 'note-ingest');
    expect(new Set(first.map((r) => r.run)).size).toBe(1);
    expect(first.filter((r) => r.outcome === 'wrote')).toHaveLength(1);
    for (const [reason, count] of [
      ['a note file was larger than the size limit and was not imported', 1],
      ['a note file had no header block and was not imported', 1],
      ['a note file had more observations than the limit and was not imported', 1],
      ['a note file was a symbolic link and was not imported', 1],
      ['a note file was not imported for another recorded reason', 2],
      ['more note files changed than one run reads, so the rest are read at the next Stop', 23],
    ] as const) expect(first.filter((r) => r.reason === reason)).toEqual([expect.objectContaining({ outcome: 'skipped', reason, count })]);
    expect(JSON.stringify(first.filter((r) => r.outcome === 'skipped'))).not.toMatch(/\.md|rejected_/);
    const countSaved = () => {
      const db = new MemeshDatabase(path.join(home, '.memesh/knowledge-graph.db'), { readOnly: true });
      try {
        expect(db.prepare("SELECT count(*) AS n FROM entities WHERE name LIKE 'rejected_%'").get()).toEqual({ n: 0 });
        return db.prepare("SELECT count(*) AS n FROM entities WHERE name LIKE 'bf14_good_%'").get();
      } finally { db.close(); }
    };
    expect(countSaved()).toEqual({ n: 95 });
    append(reads(1)); expect(run().status).toBe(0);
    expect(countSaved()).toEqual({ n: 118 });
    const second = ledger().filter((r) => r.hook === 'note-ingest' && r.run !== first[0].run);
    expect(second.some((r) => r.reason === 'a note file was larger than the size limit and was not imported' && r.count === 1)).toBe(true);
    expect(second.some((r) => r.reason === 'more note files changed than one run reads, so the rest are read at the next Stop')).toBe(false);
  }, 60_000);

  /** The recorded outcomes for one hook name. Pinned non-empty: every Stop
   *  must leave a record, so an empty list is itself a failure, never a
   *  vacuous pass for the `.at(-1)` assertions that follow. */
  function outcomes(hook: string): Array<{ outcome: string; reason?: string; entity?: string }> {
    const file = path.join(home, '.memesh', 'hook-outcomes.jsonl');
    const records = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hook === hook)
      : [];
    expect(records.length, `no ${hook} outcome was recorded`).toBeGreaterThan(0);
    return records;
  }

  it('B-F14 reclassifies unchanged legacy skip caches on the next Stop', () => {
    fs.mkdirSync(memoryDir);
    const large = path.join(memoryDir, 'large.md'); const plain = path.join(memoryDir, 'plain.md');
    fs.writeFileSync(large, 'x'.repeat(300 * 1024)); fs.writeFileSync(plain, 'no header');
    write(reads(1)); expect(run().status).toBe(0);
    const memesh = path.join(home, '.memesh');
    const db = new MemeshDatabase(path.join(memesh, 'knowledge-graph.db'));
    try {
      const key = `note_ingest_skips:${noteDirId(fs.realpathSync(memoryDir))}`;
      const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key) as {value:string};
      const cache = JSON.parse(row.value);
      for (const value of Object.values(cache) as Array<{code?:string}>) delete value.code;
      db.prepare('UPDATE memesh_metadata SET value = ? WHERE key = ?').run(JSON.stringify(cache), key);
    } finally { db.close(); }
    const stateFile = path.join(memesh, 'note-ingest-state-2.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const value of Object.values(state) as Array<{outcomeCodes?:boolean}>) delete value.outcomeCodes;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const before = outcomes('note-ingest').length;
    append(reads(1)); expect(run().status).toBe(0);
    const latest = outcomes('note-ingest').slice(before);
    expect(latest).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'a note file was larger than the size limit and was not imported', count: 1 }),
      expect.objectContaining({ reason: 'a note file had no header block and was not imported', count: 1 }),
    ]));
    expect(latest.some((r) => r.reason === 'a note file was not imported for another recorded reason')).toBe(false);
  }, 60_000);

  it('QA6 new notes progress past 100 unchanged refusals and released owners are retried', () => {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'seed.md'), '---\nname: qa6_seed\n---\nseed');
    write(reads(1)); expect(run().status).toBe(0); // initialize the private schema
    const dbPath = path.join(home, '.memesh/knowledge-graph.db');
    const withDb = <T,>(fn: (db: MemeshDatabase) => T): T => {
      const db = new MemeshDatabase(dbPath); try { return fn(db); } finally { db.close(); }
    };
    withDb((db) => {
      for (let i = 0; i < 100; i++) {
        const name = `qa6_owner_${String(i).padStart(3, '0')}`;
        const id = db.prepare('INSERT INTO entities (name,type) VALUES (?,?)').run(name, 'fact').lastInsertRowid;
        db.prepare('INSERT INTO observations (entity_id,content) VALUES (?,?)').run(id, `original ${i}`);
        db.prepare('INSERT INTO tags (entity_id,tag) VALUES (?,?)').run(id, 'qa6-original');
        fs.writeFileSync(path.join(memoryDir, `a${String(i).padStart(3, '0')}.md`), `---\nname: ${name}\n---\nreplacement ${i}`);
      }
    });
    fs.writeFileSync(path.join(memoryDir, 'zzz.md'), '---\nname: qa6_valid\n---\nvalid');
    const snapshot = () => withDb((db) => ({
      entities: db.prepare("SELECT * FROM entities WHERE name LIKE 'qa6_owner_%' ORDER BY id").all(),
      observations: db.prepare("SELECT o.* FROM observations o JOIN entities e ON e.id=o.entity_id WHERE e.name LIKE 'qa6_owner_%' ORDER BY o.id").all(),
      tags: db.prepare("SELECT t.* FROM tags t JOIN entities e ON e.id=t.entity_id WHERE e.name LIKE 'qa6_owner_%' ORDER BY t.id").all(),
    }));
    const original = snapshot();
    const ledger = () => JSON.parse('[' + fs.readFileSync(path.join(home, '.memesh/hook-outcomes.jsonl'), 'utf8').trim().split('\n').join(',') + ']') as Array<{hook:string;run:string;reason?:string;count?:number;outcome:string}>;
    const prior = ledger().filter((r) => r.hook === 'note-ingest').length;
    const other = 'a note file was not imported for another recorded reason';
    const deferred = 'more note files changed than one run reads, so the rest are read at the next Stop';
    append(reads(1)); expect(run().status).toBe(0);
    const first = ledger().filter((r) => r.hook === 'note-ingest').slice(prior);
    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ reason: other, count: 100 }), expect.objectContaining({ reason: deferred, count: 1 })]));
    expect(snapshot()).toEqual(original);
    expect(withDb((db) => db.prepare("SELECT id FROM entities WHERE name='qa6_valid'").get())).toBeUndefined();
    append(reads(1)); expect(run().status).toBe(0);
    expect(withDb((db) => db.prepare("SELECT id FROM entities WHERE name='qa6_valid'").get())).toBeDefined();
    expect(snapshot()).toEqual(original);
    const second = ledger().filter((r) => r.hook === 'note-ingest').slice(prior + first.length);
    expect(second).toEqual(expect.arrayContaining([expect.objectContaining({ reason: other, count: 99 }), expect.objectContaining({ reason: deferred, count: 1 }), expect.objectContaining({ outcome: 'wrote' })]));
    expect(new Set(second.map((r) => r.run)).size).toBe(1);
    expect(ledger()).toEqual(expect.arrayContaining(first)); // first run's 100 remain in history
    const last = path.join(memoryDir, 'a099.md');
    const before = readFileSnapshot(last);
    withDb((db) => db.prepare("DELETE FROM entities WHERE name='qa6_owner_099'").run());
    append(reads(1)); expect(run().status).toBe(0); // more=1 naturally retries; no touch/throttle override
    const after = readFileSnapshot(last);
    expect(after.bytes).toEqual(before.bytes); expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs);
    const restored = withDb((db) => db.prepare("SELECT o.content FROM observations o JOIN entities e ON e.id=o.entity_id WHERE e.name='qa6_owner_099'").all());
    expect(restored).toEqual([{ content: 'replacement 99' }]);
    const third = ledger().filter((r) => r.hook === 'note-ingest').slice(prior + first.length + second.length);
    expect(third.some((r) => r.outcome === 'wrote')).toBe(true);
    expect(third.some((r) => r.reason === deferred)).toBe(false);
    console.info('QA6 actual Stop receipt', JSON.stringify({ first, second, third, restored,
      originalOwners: original.entities.length, originalOwnerSnapshotSha: createHash('sha256').update(JSON.stringify(original)).digest('hex') }));
  }, 60_000);

  it.skipIf(!canDenyReads)('note I/O retry: unchanged unreadable note is imported after mode recovery on the next real Stop', () => {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'seed.md'), '---\nname: io_seed\n---\nseed');
    write(reads(1)); expect(run().status).toBe(0);
    const stateFile = path.join(home, '.memesh/note-ingest-state-2.json');
    const beforeState = fs.readFileSync(stateFile, 'utf8');
    const good = path.join(memoryDir, 'a-good.md'); const bad = path.join(memoryDir, 'b-unreadable.md');
    fs.writeFileSync(good, '---\nname: io_good\n---\ngood body');
    fs.writeFileSync(bad, '---\nname: io_recovered\n---\nrecovered body');
    const bytes = fs.readFileSync(bad); const mtime = fs.statSync(bad).mtimeMs;
    const withDb = <T,>(fn: (db: MemeshDatabase) => T): T => {
      const db = new MemeshDatabase(path.join(home, '.memesh/knowledge-graph.db'), { readOnly: true });
      try { return fn(db); } finally { db.close(); }
    };
    const goodSnapshot = () => withDb((db) => ({
      entity: db.prepare("SELECT * FROM entities WHERE name='io_good'").get(),
      observations: db.prepare("SELECT o.* FROM observations o JOIN entities e ON e.id=o.entity_id WHERE e.name='io_good' ORDER BY o.id").all(),
      tags: db.prepare("SELECT t.* FROM tags t JOIN entities e ON e.id=t.entity_id WHERE e.name='io_good' ORDER BY t.id").all(),
    }));
    fs.chmodSync(bad, 0);
    let first;
    try {
      let denied: unknown; try { readFileSnapshot(bad); } catch (error) { denied = error; }
      expect(denied).toHaveProperty('code', 'EACCES');
      append(reads(1)); first = run(); expect(first.status).toBe(0); expect(first.terminal).toBe(true);
      expect(withDb((db) => db.prepare("SELECT id FROM entities WHERE name='io_good'").get())).toBeDefined();
      expect(withDb((db) => db.prepare("SELECT id FROM entities WHERE name='io_recovered'").get())).toBeUndefined();
    } finally { fs.chmodSync(bad, 0o600); }
    const failedState = fs.readFileSync(stateFile, 'utf8');
    const storedGood = goodSnapshot();
    const after = readFileSnapshot(bad);
    expect(after.bytes).toEqual(bytes); expect(after.stat.mtimeMs).toBe(mtime);
    append(reads(1)); const second = run(); expect(second.status).toBe(0); expect(second.terminal).toBe(true);
    // Baseline reaches this actual loss assertion: its second Stop is incorrectly throttled.
    expect(withDb((db) => db.prepare("SELECT id FROM entities WHERE name='io_recovered'").get())).toBeDefined();
    expect(failedState).toBe(beforeState);
    expect(goodSnapshot()).toEqual(storedGood);
    expect(withDb((db) => db.prepare("SELECT count(*) AS n FROM entities WHERE name='io_good'").get())).toEqual({ n: 1 });
    const invalid = path.join(memoryDir, 'invalid.md'); fs.writeFileSync(invalid, 'no header');
    append(reads(1)); const validation = run(); expect(validation.status).toBe(0);
    const validState = fs.readFileSync(stateFile, 'utf8');
    append(reads(1)); const quiet = run(); expect(quiet.status).toBe(0);
    expect(outcomes('note-ingest').at(-1)?.reason).toBe('no note file changed since the last ingestion');
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(validState);
    console.info('note I/O retry receipt', JSON.stringify({ first, second, validation, quiet,
      realReadError: 'EACCES', failedStateUnchanged: failedState === beforeState, recovered: true, goodRowsUnchanged: true, noteBytesMtimeUnchanged: true }));
  }, 60_000);

  it.each(['claude-code', 'codex'])('a heavy %s Stop saves the raw reply and notes without a snapshot or reminder', (host) => {
    fs.mkdirSync(memoryDir);
    const note = path.join(memoryDir, 'a.md');
    fs.writeFileSync(note,
      '---\nname: retained_note\nmetadata:\n  type: fact\n---\n\nThe note stays searchable.\n');
    const beforeTurn = new Date(Date.now() - 120_000);
    fs.utimesSync(note, beforeTurn, beforeTurn);
    const reply = 'The final assistant reply.\nIt keeps every paragraph.';
    if (host === 'codex') {
      const commands = Array.from({ length: 22 }, (_, index) => ({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', call_id: 'tool-' + index, arguments: '{"cmd":"git status"}' },
      }));
      write([
        ...commands,
        { type: 'event_msg', payload: { type: 'item_completed', item: {
          type: 'CommandExecution', id: 'committed', command: ['/bin/zsh', '-lc', 'git commit -m fixture'],
          exit_code: 0, status: 'completed',
        } } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } },
      ]);
    } else {
      write([
        ...reads(22),
        ...toolCall('ExitPlanMode', { plan: 'do X' }),
        ...toolCall('Edit', { file_path: '/repo/retired-summary.ts' }),
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
      ]);
    }
    const result = run({ MEMESH_HOOK_HOST: host });
    expect(result.status, result.stderr).toBe(0);
    expect.soft(result.stdout).toBe('');
    expect.soft(fs.readFileSync(path.join(home, '.memesh', 'hook-outcomes.jsonl'), 'utf8')).not.toContain('remember-nudge');
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote' });
    const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'), { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM entities WHERE type IN ('session-summary', 'session-insight')").all()).toEqual([]);
      expect(db.prepare("SELECT e.type, o.content FROM entities e JOIN observations o ON o.entity_id = e.id WHERE e.type = 'conversation'").all()).toEqual([
        { type: 'conversation', content: reply },
      ]);
      expect(db.prepare("SELECT name FROM entities WHERE name = 'retained_note'").get()).toBeDefined();
    } finally { db.close(); }
  });

  it('capture opt-out skips both raw reply and note ingestion', () => {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'note.md'), '---\nname: optout_note\n---\n\nbody\n');
    write(reads(1));
    const result = run({ MEMESH_AUTO_CAPTURE: 'false' }, { last_assistant_message: 'Opted out' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'auto-capture is turned off' });
    expect(fs.existsSync(path.join(home, '.memesh', 'knowledge-graph.db'))).toBe(false);
  });

  it('ingests the memory directory next to the transcript, then skips it while unchanged', () => {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'a.md'), '---\nname: hook_note_a\ndescription: Hook alpha\nmetadata:\n  type: project\n---\n\nalpha body\n');
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- index only\n');
    write(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote' });
    expect(outcomes('note-ingest').at(-1)?.reason).toMatch(/1 created/);
    // X2: a `wrote` record must name something it wrote. Without this the
    // record carried no entity and doctor reported the hook with
    // `lastWriteAt` set and `lastEntity` null — a write with nothing written.
    expect(outcomes('note-ingest').at(-1)?.entity).toBe('hook_note_a');

    const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
    const row = db.prepare(
      "SELECT e.title FROM entities e JOIN tags t ON t.entity_id = e.id AND t.tag = 'source:note-file' WHERE e.name = 'hook_note_a'",
    ).get() as { title: string } | undefined;
    db.close();
    expect(row?.title).toBe('Hook alpha');

    // The person's own memory folder is trusted: sessions may be shown it.
    const trustDb = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
    const meta = trustDb.prepare("SELECT metadata FROM entities WHERE name = 'hook_note_a'").get() as { metadata: string };
    trustDb.close();
    expect(JSON.parse(meta.metadata)).toMatchObject({ trust: 'trusted', provenance: { source: 'note-file' } });

    append(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'no note file changed since the last ingestion' });
  }, 60_000);

  // #506: the note ingest opened the database with its 30 s lock wait, so a
  // Stop that ingested a changed note while another process held the write
  // lock took about 19 s against a 10 s hook limit. It must give up within the
  // hook's own wait, record an error, and ingest the note on the next Stop.
  it('#506 a held write lock does not hold the Stop past its 10 s limit, and the note is ingested next time', () => {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'a.md'), '---\nname: hook_note_a\ndescription: Hook alpha\nmetadata:\n  type: project\n---\n\nalpha body\n');
    write(reads(1));
    expect(run().status).toBe(0);
    fs.writeFileSync(path.join(memoryDir, 'b.md'), '---\nname: hook_note_b\ndescription: Hook beta\nmetadata:\n  type: decision\n---\n\nbeta body\n');
    append(reads(1));

    const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
    db.exec('BEGIN IMMEDIATE');
    let locked;
    try {
      locked = run({}, {}, 10_000);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
    expect(locked.signal, `killed at the hook limit; stderr: ${locked.stderr.slice(0, 300)}`).toBeNull();
    expect(locked.status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'error' });

    append(reads(1));
    expect(run().status).toBe(0);
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote', entity: 'hook_note_b' });
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

  // Permission bits mean nothing to root, and Windows does not model read or
  // traversal permission at all, so the EACCES this test needs cannot be
  // produced in either. Skipped rather than silently vacuous — this guard
  // named only root, and both windows-latest legs failed with
  // `expected 'wrote' to be 'error'`: the hook had read the directory the
  // test believed it had locked.
  it.skipIf(!canDenyReads)('an unreadable memory directory is an error, not "no memory directory"', () => {
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

  it('a run that refused every file does not report that nothing needed storing', () => {
    // `changed` counts only stored things, so a Stop whose only event was a
    // refusal recorded `note files were read and nothing new needed storing`
    // — the user's file was rejected and the hook reported contentment. On a
    // Stop path a silent drop is indistinguishable from nothing happening.
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(home, 'elsewhere.md'),
      '---\nname: outside_note\ndescription: Outside\nmetadata:\n  type: fact\n---\n\nbody\n');
    fs.symlinkSync(path.join(home, 'elsewhere.md'), path.join(memoryDir, 'link.md'));
    write(reads(1));

    expect(run().status).toBe(0);
    const last = outcomes('note-ingest').at(-1)!;
    expect(last.outcome).toBe('skipped');
    expect(last.reason).toBe('a note file was a symbolic link and was not imported');
  }, 60_000);

  // A Stop whose transcript has no memory folder beside it, or whose payload names no
  // transcript, or no cwd either: the hook exits 0 and records a known skip, never an error.
  const NO_FOLDER = 'no Claude Code memory directory for this project';
  it.each([
    ['no memory folder beside the transcript', {}, NO_FOLDER],
    ['no transcript_path', { transcript_path: undefined }, NO_FOLDER],
    ['no transcript_path and no cwd', { transcript_path: undefined, cwd: undefined }, 'cwd absent in payload — cannot resolve project'],
  ])('a Stop with %s records a skip, not an error', (_label, payload, reason) => {
    fs.writeFileSync(transcript, '');
    const r = run({}, payload);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('ERR_INVALID_ARG_TYPE');
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason });
  });

  it('a payload with no cwd does not file notes under no project at all', () => {
    // Ingestion used to run BEFORE the cwd guard, with
    // `project: inputData.cwd ? getProjectName(inputData.cwd) : undefined`.
    // The same file refuses session capture for this exact condition, saying
    // it is better to miss one capture than to file it under the wrong
    // project — and a note filed under NO project is not recoverable later
    // either: note-ingest fast-paths an unchanged file, so the tag backfill
    // is never reached unless the user edits the note again.
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

  // An unreleased 4.13.0 build held some notes back: it left a skip entry marked `held` for each, and
  // a folder stamp in note-ingest-state.json that says nothing changed. Such a note is imported by the
  // next Stop, whatever the stamp says and although the file itself is unchanged.
  it.each([false, true])('imports a note an unreleased build held back, at the next Stop, with the old folder stamp\'s `more` %s', (more) => {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'first.md'), '---\nname: hook_note_first\ndescription: First\nmetadata:\n  type: fact\n---\n\nfirst body\n');
    write(reads(1));
    expect(run().status).toBe(0); // creates the database and the folder's skip cache
    const held = path.join(memoryDir, 'held.md');
    fs.writeFileSync(held, '---\nname: hook_note_held\ndescription: Held back\nmetadata:\n  type: fact\n---\n\nheld body\n');
    const past = new Date(Date.now() - 3_600_000);
    for (const p of [held, path.join(memoryDir, 'first.md'), memoryDir]) fs.utimesSync(p, past, past);
    const st = fs.statSync(held);
    const memesh = path.join(home, '.memesh');
    const db = new MemeshDatabase(path.join(memesh, 'knowledge-graph.db'));
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(
      `note_ingest_skips:${noteDirId(fs.realpathSync(memoryDir))}`,
      JSON.stringify({ 'held.md': { mtime: st.mtimeMs, size: st.size, reason: 'held out by a private session — not imported', held: 'a'.repeat(64) } }),
    );
    db.close();
    // The state as that build left it: only the old file, its stamp newer than every note.
    const key = createHash('sha256').update(memoryDir).digest('hex').slice(0, 16);
    fs.rmSync(path.join(memesh, 'note-ingest-state-2.json'), { force: true });
    fs.writeFileSync(path.join(memesh, 'note-ingest-state.json'), JSON.stringify({ [key]: { at: Date.now(), more, trusted: true } }));

    append(reads(1));
    expect(run().status).toBe(0);
    const check = new MemeshDatabase(path.join(memesh, 'knowledge-graph.db'));
    const row = check.prepare("SELECT name FROM entities WHERE name = 'hook_note_held'").get();
    check.close();
    expect(row, 'the held note was not imported').toBeDefined();
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'wrote', entity: 'hook_note_held' });
  }, 60_000);

  it('a run that read its cap and changed nothing says the rest waits for the next Stop, not that nothing was new', () => {
    fs.mkdirSync(memoryDir);
    const files = Array.from({ length: 101 }, (_, i) => path.join(memoryDir, `bulk-${String(i).padStart(3, '0')}.md`));
    files.forEach((f, i) => fs.writeFileSync(f, `---\nname: cap_note_${i}\ndescription: Cap note ${i}\nmetadata:\n  type: fact\n---\n\nbody ${i}\n`));
    write(reads(1));
    expect(run().status).toBe(0); // 100 of them
    append(reads(1));
    expect(run().status).toBe(0); // the last one
    const now = new Date();
    for (const f of files) fs.utimesSync(f, now, now); // newer than the last run's stamp, the same bytes
    append(reads(1));
    expect(run().status).toBe(0); // 100 read and unchanged, the rest past the cap
    expect(outcomes('note-ingest').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'more note files changed than one run reads, so the rest are read at the next Stop' });
  }, 120_000);

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
