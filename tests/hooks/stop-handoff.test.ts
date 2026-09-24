/**
 * The Stop hook keeps the agent's last message as the project's handoff.
 * Every test spawns the REAL hook (scripts/hooks/session-summary.js →
 * scripts/hooks/_stop-handoff.js) against a throwaway HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { getProjectName } from '../../src/core/paths.js';
import { sessionHandoffName, SESSION_HANDOFF_TYPE } from '../../src/core/session-handoff.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { expectValidHookOutput } from '../helpers/hook-output-contract.js';

const STOP_HOOK = path.resolve('scripts/hooks/session-summary.js');
const START_HOOK = path.resolve('scripts/hooks/session-start.js');

const LONG_ENOUGH = 'Finished the parser change and the tests are green. Next: rebase the branch and open the pull request.';

describe('Stop hook: the session handoff', () => {
  let home: string;
  let cwd: string;
  let transcript: string;
  let project: string;
  let entityName: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-handoff-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    cwd = path.join(home, 'work', 'acme');
    fs.mkdirSync(cwd, { recursive: true });
    transcript = path.join(home, 'session.jsonl');
    fs.writeFileSync(transcript, '');
    project = getProjectName(cwd);
    entityName = sessionHandoffName(project);
  });

  afterEach(() => removeTempDir(home));

  function childEnv(env: Record<string, string | undefined> = {}) {
    const e: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
    delete e.MEMESH_DB_PATH;
    delete e.MEMESH_DIR;
    return { ...e, ...env };
  }

  function runStop(payload: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
    const r = spawnSync('node', [STOP_HOOK], {
      input: JSON.stringify({ session_id: 'handoff-s1', transcript_path: transcript, cwd, hook_event_name: 'Stop', ...payload }),
      env: childEnv(env),
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  }

  const dbPath = () => path.join(home, '.memesh', 'knowledge-graph.db');

  function handoffRows(name = entityName) {
    if (!fs.existsSync(dbPath())) return { entities: [], observations: [] as string[], tags: [] as string[] };
    const db = new MemeshDatabase(dbPath());
    try {
      const entities = db.prepare('SELECT id, type, status, title FROM entities WHERE name = ?').all(name) as Array<{ id: number; type: string; status: string; title: string | null }>;
      const id = entities[0]?.id;
      const observations = id === undefined ? [] : (db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(id) as Array<{ content: string }>).map((o) => o.content);
      const tags = id === undefined ? [] : (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(id) as Array<{ tag: string }>).map((t) => t.tag);
      return { entities, observations, tags };
    } finally {
      db.close();
    }
  }

  /** Every handoff entity in the graph, whatever project it names. */
  function allHandoffNames(): string[] {
    if (!fs.existsSync(dbPath())) return [];
    const db = new MemeshDatabase(dbPath());
    try {
      return (db.prepare('SELECT name FROM entities WHERE type = ?').all(SESSION_HANDOFF_TYPE) as Array<{ name: string }>).map((r) => r.name);
    } finally {
      db.close();
    }
  }

  function outcomes(): Array<{ outcome: string; reason?: string; entity?: string }> {
    const file = path.join(home, '.memesh', 'hook-outcomes.jsonl');
    const records = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hook === 'handoff-capture')
      : [];
    expect(records.length, 'no handoff-capture outcome was recorded').toBeGreaterThan(0);
    return records;
  }

  const asstLine = (content: unknown, extra: object = {}) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
  const writeTranscript = (lines: string[]) => fs.writeFileSync(transcript, lines.join('\n') + '\n');

  it('stores the payload message as ONE entity per project — even on a turn with no tool calls — and records where it came from', () => {
    const r = runStop({ last_assistant_message: LONG_ENOUGH });
    expect(r.status).toBe(0);
    expectValidHookOutput(r.stdout);

    const rows = handoffRows();
    expect(rows.entities).toHaveLength(1);
    expect(rows.entities[0]).toMatchObject({ type: SESSION_HANDOFF_TYPE, status: 'active' });
    expect(rows.observations).toEqual([LONG_ENOUGH]);
    expect(rows.tags).toEqual(expect.arrayContaining([`project:${project}`, 'session:handoff-s1']));
    expect(outcomes().at(-1)).toMatchObject({ outcome: 'wrote', entity: entityName });
    expect(outcomes().at(-1)?.reason).toMatch(/from the payload/);
  }, 30_000);

  it('replaces the previous handoff on the next Stop instead of adding to it', () => {
    runStop({ last_assistant_message: LONG_ENOUGH });
    const second = 'Second turn: the review found nothing blocking, so the branch is ready to merge once CI is green.';
    runStop({ last_assistant_message: second, session_id: 'handoff-s2' });

    const rows = handoffRows();
    expect(rows.entities).toHaveLength(1);
    expect(rows.observations).toEqual([second]);
    expect(rows.tags).toContain('session:handoff-s2');
    expect(rows.tags).not.toContain('session:handoff-s1');
  }, 60_000);

  it('keeps a good handoff when the next message is only an acknowledgement', () => {
    runStop({ last_assistant_message: LONG_ENOUGH });
    const r = runStop({ last_assistant_message: 'Done.' });
    expect(r.status).toBe(0);

    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);
    expect(outcomes().at(-1)).toMatchObject({ outcome: 'skipped' });
    expect(outcomes().at(-1)?.reason).toMatch(/too short to be a handoff/);
  }, 60_000);

  it('falls back to the transcript tail, and skips sub-agent and error lines', () => {
    writeTranscript([
      asstLine([{ type: 'text', text: LONG_ENOUGH }]),
      asstLine([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      asstLine([{ type: 'text', text: 'A sub-agent report that must not become the handoff, long enough to pass the floor.' }], { isSidechain: true }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded, retry later please; this line is deliberately long enough to pass the length floor on its own.' }] } }),
    ]);
    const r = runStop({});
    expect(r.status).toBe(0);

    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);
    expect(outcomes().at(-1)?.reason).toMatch(/from the transcript/);
  }, 30_000);

  it('reads a bounded tail: text further back than the window is not fetched', () => {
    const toolOnly = asstLine([{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/repo/a.ts' } }]);
    const lines: string[] = [asstLine([{ type: 'text', text: 'THE ANCIENT ONE, at the very start of a transcript far larger than the tail window.' }])];
    while (lines.join('\n').length < 400 * 1024) lines.push(toolOnly);
    writeTranscript(lines);
    runStop({});
    expect(handoffRows().entities).toHaveLength(0);
    expect(outcomes().at(-1)?.reason).toMatch(/held no assistant message/);

    // The same transcript with the message inside the window is found.
    lines.push(asstLine([{ type: 'text', text: LONG_ENOUGH }]));
    writeTranscript(lines);
    runStop({});
    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);
  }, 60_000);

  it('prefers the payload message over the transcript, and falls back when the payload one is blank', () => {
    writeTranscript([asstLine([{ type: 'text', text: 'TRANSCRIPT-TEXT: the previous turn said this, which is long enough to pass the floor.' }])]);
    runStop({ last_assistant_message: LONG_ENOUGH });
    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);

    runStop({ last_assistant_message: '   \n ', session_id: 'handoff-s2' });
    expect(handoffRows().observations[0]).toContain('TRANSCRIPT-TEXT');
    expect(outcomes().at(-1)?.reason).toMatch(/from the transcript/);
  }, 60_000);

  it('measures the length AFTER cleaning: a long message that is mostly code keeps the previous handoff', () => {
    runStop({ last_assistant_message: LONG_ENOUGH });
    const codeHeavy = `Here is the patch:\n\`\`\`diff\n${'+ an added line of code\n'.repeat(50)}\`\`\``;
    expect(codeHeavy.length).toBeGreaterThan(1000);
    runStop({ last_assistant_message: codeHeavy });

    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);
    expect(outcomes().at(-1)?.reason).toMatch(/too short to be a handoff/);
  }, 60_000);

  it('adds no session tag for an id that is not a plain token', () => {
    runStop({ last_assistant_message: LONG_ENOUGH, session_id: 'has spaces/and:colons' });
    const { tags } = handoffRows();
    expect(tags).toContain(`project:${project}`);
    expect(tags.some((t) => t.startsWith('session:'))).toBe(false);
  }, 30_000);

  it('redacts a secret BEFORE it cuts the text: a token straddling the cut leaves no fragment', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    // 770 characters follow the token, so an 800-character cut lands 11
    // characters INSIDE it. Cut first and the tail of the token no longer
    // looks like a token and is stored; redact first and it is gone.
    const message = `${'lead-in words '.repeat(10)}${secret} ${'tail words '.repeat(70).trimEnd()}`;
    runStop({ last_assistant_message: message });

    const [stored] = handoffRows().observations;
    expect(stored.startsWith('…'), 'the message was not cut, so the order of redaction and cutting did not matter').toBe(true);
    expect(stored).not.toContain(secret.slice(11));
    expect(stored).not.toContain(secret.slice(-12));
  }, 30_000);

  it('drops fenced code and redacts secrets BEFORE anything is stored', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const message = [
      `The deploy token is ${secret} and it must be rotated before the next release goes out today.`,
      '```sh',
      'export SHOULD_NOT_BE_STORED=1',
      '```',
      'Next: rotate the token, then re-run the release check.',
    ].join('\n');
    runStop({ last_assistant_message: message });

    const [stored] = handoffRows().observations;
    expect(stored).toBeDefined();
    expect(stored).not.toContain(secret);
    expect(stored).toContain('***REDACTED***');
    expect(stored).not.toContain('SHOULD_NOT_BE_STORED');
    expect(stored).toContain('Next: rotate the token');
  }, 30_000);

  it('records a skip and stores nothing when auto-capture is off', () => {
    const r = runStop({ last_assistant_message: LONG_ENOUGH }, { MEMESH_AUTO_CAPTURE: 'false' });
    expect(r.status).toBe(0);
    expect(allHandoffNames()).toEqual([]);
    expect(outcomes().at(-1)).toMatchObject({ outcome: 'skipped' });
    expect(outcomes().at(-1)?.reason).toMatch(/auto-capture is turned off/);
  }, 30_000);

  it('records a skip and stores nothing when the payload has no cwd', () => {
    const r = runStop({ last_assistant_message: LONG_ENOUGH, cwd: undefined });
    expect(r.status).toBe(0);
    expect(allHandoffNames()).toEqual([]);
    expect(outcomes().at(-1)?.reason).toMatch(/cwd absent/);
  }, 30_000);

  it('says so when there is no message and no transcript, and when the transcript holds no assistant text', () => {
    runStop({ transcript_path: path.join(home, 'gone.jsonl') });
    expect(outcomes().at(-1)?.reason).toMatch(/no transcript to read/);

    writeTranscript([JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })]);
    runStop({});
    expect(outcomes().at(-1)?.reason).toMatch(/held no assistant message/);
    expect(handoffRows().entities).toHaveLength(0);
  }, 60_000);

  it('keeps two projects apart', () => {
    const other = path.join(home, 'work', 'beta');
    fs.mkdirSync(other, { recursive: true });
    const second = 'Beta project: the migration ran cleanly on the staging copy; the production run is the next step.';
    runStop({ last_assistant_message: LONG_ENOUGH });
    runStop({ last_assistant_message: second, cwd: other });

    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);
    expect(handoffRows(sessionHandoffName(getProjectName(other))).observations).toEqual([second]);
  }, 60_000);

  it('leaves a forget-archived handoff alone and says so', () => {
    runStop({ last_assistant_message: LONG_ENOUGH });
    const db = new MemeshDatabase(dbPath());
    db.prepare("UPDATE entities SET status = 'archived' WHERE name = ?").run(entityName);
    db.close();

    const r = runStop({ last_assistant_message: 'A newer message that is long enough to count as a handoff, if only the entity were still active.' });
    expect(r.status).toBe(0);
    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);
    expect(handoffRows().entities[0].status).toBe('archived');
    expect(outcomes().at(-1)?.reason).toMatch(/archived by forget/);
  }, 60_000);

  it('records an error and still exits 0 when the database cannot be opened', () => {
    // A directory where the database file should be: opening it throws.
    const blocked = path.join(home, '.memesh', 'blocked.db');
    fs.mkdirSync(blocked);
    const r = runStop({ last_assistant_message: LONG_ENOUGH }, { MEMESH_DB_PATH: blocked });
    expect(r.status).toBe(0);
    expect(outcomes().at(-1)).toMatchObject({ outcome: 'error' });
  }, 30_000);

  it('a database that fails to CLOSE after the write still records the write', async () => {
    // In-process, so the close can be made to fail after a real commit.
    const { DatabaseSync } = await import('node:sqlite');
    const { runStopHandoff } = await import('../../scripts/hooks/_stop-handoff.js');
    // The outcome record's location is read from process.env, not the env
    // argument, so both point at this test's HOME.
    vi.stubEnv('MEMESH_DB_PATH', dbPath());
    vi.stubEnv('MEMESH_DIR', path.join(home, '.memesh'));
    const env = process.env;
    const realClose = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function failingClose(this: InstanceType<typeof DatabaseSync>) {
      realClose.call(this);
      throw new Error('simulated close failure');
    };
    try {
      runStopHandoff(
        { session_id: 'handoff-s1', transcript_path: transcript, cwd, hook_event_name: 'Stop', last_assistant_message: LONG_ENOUGH },
        { captureEnabled: true, project, env },
      );
    } finally {
      DatabaseSync.prototype.close = realClose;
      vi.unstubAllEnvs();
    }
    expect(handoffRows().observations).toEqual([LONG_ENOUGH]);
    expect(outcomes().at(-1)).toMatchObject({ outcome: 'wrote' });
  }, 30_000);

  it('a Stop\'s handoff leads the next session at every level — this project\'s only, and it takes no ranked slot', () => {
    // Order matters. Another project's handoff makes the database first; the
    // decision is created next; THIS project's handoff is written last, so it
    // has the highest id and wins every score tie. With a single slot, a
    // handoff that is not kept out of the pool would take it and the decision
    // would vanish — which is what the positive control below would catch.
    const other = path.join(home, 'work', 'beta');
    fs.mkdirSync(other, { recursive: true });
    runStop({ last_assistant_message: 'BETA-HANDOFF-MARKER: the beta project stopped before its release step, which is still to do.', cwd: other });

    const db = new MemeshDatabase(dbPath());
    const id = db.prepare("INSERT INTO entities (name, type) VALUES ('use-sqlite-decision', 'decision')").run().lastInsertRowid as number;
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'DECISION-MARKER: we keep everything in one SQLite file.');
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, `project:${project}`);
    db.close();

    runStop({ last_assistant_message: 'HANDOFF-MARKER: the last session stopped right before the release step, which is still to do.' });
    expect(handoffRows().observations).toHaveLength(1);

    for (const level of ['minimal', 'standard', 'full']) {
      const r = spawnSync('node', [START_HOOK], {
        input: JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'startup' }),
        env: childEnv({ MEMESH_BRIEFING: level, MEMESH_SESSION_LIMIT: '1' }),
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(r.status, `session-start at ${level}`).toBe(0);
      const context = String(JSON.parse(r.stdout.trim()).hookSpecificOutput?.additionalContext ?? '');
      // The single ranked slot still goes to the decision: the handoff is not
      // a ranked memory, it leads the block on its own.
      expect(context, `the decision lost its slot at ${level}`).toContain('DECISION-MARKER');
      expect(context.split('Where the last session left off')).toHaveLength(2);
      expect(context).toContain('HANDOFF-MARKER: the last session stopped right before the release step');
      expect(context.indexOf('HANDOFF-MARKER'), 'the handoff does not lead').toBeLessThan(context.indexOf('DECISION-MARKER'));
      expect(context, 'another project\'s handoff leaked in').not.toContain('BETA-HANDOFF-MARKER');
    }
  }, 120_000);

  it('takes no slot in the other-projects list either: at full, all five other decisions still show', () => {
    // Other project first (it makes the database), then five of ITS decisions,
    // then THIS project's handoff — the newest row, which wins every tie for the
    // five places of the recent pool.
    const other = path.join(home, 'work', 'beta');
    fs.mkdirSync(other, { recursive: true });
    runStop({ last_assistant_message: 'BETA-HANDOFF-MARKER: the beta project stopped before its release step, which is still to do.', cwd: other });

    const db = new MemeshDatabase(dbPath());
    for (let i = 1; i <= 5; i++) {
      const id = db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(`other-decision-${i}`, 'decision').lastInsertRowid as number;
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, `OTHER-DECISION-${i}: beta settled question ${i}.`);
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, `project:${getProjectName(other)}`);
    }
    db.close();
    runStop({ last_assistant_message: 'HANDOFF-MARKER: this project stopped right before the release step, which is still to do.' });

    const r = spawnSync('node', [START_HOOK], {
      input: JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'startup' }),
      env: childEnv({ MEMESH_BRIEFING: 'full' }),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    const context = String(out.hookSpecificOutput?.additionalContext ?? '');
    for (let i = 1; i <= 5; i++) expect(context, `other decision ${i} was pushed out of the recent pool`).toContain(`OTHER-DECISION-${i}`);
    expect(context).toContain('HANDOFF-MARKER: this project stopped');
    expect(context, 'the other project\'s handoff leaked into the recent pool').not.toContain('BETA-HANDOFF-MARKER');
    expect(String(out.systemMessage ?? '')).toMatch(/5 recent/);
  }, 120_000);

  describe('a handoff that came in through an import (#434 step 2, trust)', () => {
    const IMPORT_MARKS = { trust: 'untrusted', provenance: { source: 'import', imported_at: '2026-09-20T00:00:00Z' } };
    function start(level = 'standard') {
      const r = spawnSync('node', [START_HOOK], {
        input: JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'startup' }),
        env: childEnv({ MEMESH_BRIEFING: level }), encoding: 'utf8', timeout: 20_000,
      });
      expect(r.status).toBe(0);
      return String(JSON.parse(r.stdout.trim()).hookSpecificOutput?.additionalContext ?? '');
    }
    function metadata(): Record<string, unknown> {
      const db = new MemeshDatabase(dbPath());
      try {
        return JSON.parse((db.prepare('SELECT metadata FROM entities WHERE name = ?').get(entityName) as { metadata: string }).metadata);
      } finally { db.close(); }
    }
    /** A handoff as `memesh import` leaves it: imported text, import marks, plus a key that must survive. */
    function seedImported(extra: Record<string, unknown> = {}) {
      runStop({ last_assistant_message: 'IMPORTED-OLD-TEXT: this came from another machine and must not be shown as this session\'s handoff.' });
      const db = new MemeshDatabase(dbPath());
      db.prepare('UPDATE entities SET metadata = ? WHERE name = ?').run(JSON.stringify({ ...IMPORT_MARKS, ...extra }), entityName);
      db.close();
    }
    function sessionStartRecords() {
      return fs.readFileSync(path.join(home, '.memesh', 'hook-outcomes.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).filter((r) => r.hook === 'session-start');
    }

    it('stays hidden, says why, and shows again once a real local Stop replaces it', () => {
      seedImported({ forgotten_observation_hashes: ['keep-me'] });
      const before = start();
      expect(before).not.toContain('IMPORTED-OLD-TEXT');
      expect(sessionStartRecords().at(-1)?.reason).toMatch(/session handoff not shown \(untrusted\)/);

      const fresh = 'LOCAL-NEW-TEXT: the local session finished the importer and the next step is the staging dry run.';
      runStop({ last_assistant_message: fresh });
      const meta = metadata();
      expect(meta.trust).toBeUndefined();
      expect(meta.provenance).toEqual({ source_host: 'claude-code' });
      expect(meta.forgotten_observation_hashes, 'other keys must survive the refresh').toEqual(['keep-me']);
      const after = start();
      expect(after).toContain('LOCAL-NEW-TEXT');
      expect(after).not.toContain('IMPORTED-OLD-TEXT');
    }, 90_000);

    it('is not healed by a Stop that stores nothing (too short, capture off, archived)', () => {
      seedImported();
      runStop({ last_assistant_message: 'Done.' });
      runStop({ last_assistant_message: 'A long enough message that auto-capture being off must still refuse to store anywhere.' }, { MEMESH_AUTO_CAPTURE: 'false' });
      expect(metadata()).toMatchObject(IMPORT_MARKS);
      expect(start()).not.toContain('Where the last session left off');

      const db = new MemeshDatabase(dbPath());
      db.prepare("UPDATE entities SET status = 'archived' WHERE name = ?").run(entityName);
      db.close();
      runStop({ last_assistant_message: 'Another long message; the archived handoff must be left exactly as forget left it.' });
      expect(metadata()).toMatchObject(IMPORT_MARKS);
    }, 90_000);

    it('rolls the replacement back, marks included, when every new line was forgotten', () => {
      const fresh = 'FORGOTTEN-TEXT: the user removed exactly this line before, so it must never come back.';
      seedImported({ forgotten_observation_hashes: [createHash('sha256').update(fresh).digest('hex')] });
      const snapshot = () => {
        const db = new MemeshDatabase(dbPath());
        try {
          const row = db.prepare('SELECT id, metadata FROM entities WHERE name = ?').get(entityName) as { id: number; metadata: string };
          const fts = (term: string) => (db.prepare('SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?').all(term) as Array<{ rowid: number }>).map((r) => r.rowid);
          return { ...handoffRows(), metadata: row.metadata, ftsOld: fts('IMPORTED'), ftsNew: fts('FORGOTTEN') };
        } finally { db.close(); }
      };
      const before = snapshot();
      expect(before.ftsOld, 'the old text is not searchable before the Stop, so this proves nothing').not.toHaveLength(0);
      runStop({ last_assistant_message: fresh });
      expect(outcomes().at(-1)).toMatchObject({ outcome: 'error' });
      expect(outcomes().at(-1)?.outcome).not.toBe('wrote');
      const after = snapshot();
      expect(after.observations).toEqual(before.observations);
      expect([...after.tags].sort()).toEqual([...before.tags].sort());
      expect(after.metadata).toBe(before.metadata);
      expect(after.ftsOld).toEqual(before.ftsOld);
      expect(after.ftsNew).toEqual([]);
    }, 60_000);

    it('heals unreadable metadata on a real local replacement, and says so on stderr', () => {
      runStop({ last_assistant_message: 'CORRUPT-OLD: a first handoff whose metadata is about to become unreadable garbage.' });
      const db = new MemeshDatabase(dbPath());
      db.prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('garbage{', entityName);
      db.close();
      expect(start()).not.toContain('CORRUPT-OLD');

      const r = runStop({ last_assistant_message: 'CORRUPT-NEW: the next local Stop replaces the text, so the handoff can be trusted again.' });
      expect(r.stderr).toMatch(/healed corrupted metadata for entity \d+/);
      expect(metadata()).toEqual({});
      expect(start()).toContain('CORRUPT-NEW');
    }, 90_000);

    it('leaves a memory of another type that happens to use the handoff\'s name alone', () => {
      // Make the database with another project's Stop, then store a NOTE
      // under this project's handoff name, imported and untrusted.
      const other = path.join(home, 'work', 'gamma');
      fs.mkdirSync(other, { recursive: true });
      runStop({ last_assistant_message: 'A first Stop in another project, only here to create the database and its schema.', cwd: other });
      const db = new MemeshDatabase(dbPath());
      const id = db.prepare('INSERT INTO entities (name, type, metadata) VALUES (?, ?, ?)')
        .run(entityName, 'note', JSON.stringify(IMPORT_MARKS)).lastInsertRowid as number;
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'USER-NOTE: the user stored this themselves.');
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'user-tag');
      db.close();
      const before = { ...handoffRows(), metadata: metadata() };

      runStop({ last_assistant_message: 'A normal handoff message, long enough to be stored, that must not replace the user note.' });
      expect(outcomes().at(-1)).toMatchObject({ outcome: 'error' });
      const after = { ...handoffRows(), metadata: metadata() };
      expect(after.entities).toEqual(before.entities);
      expect(after.entities[0]).toMatchObject({ type: 'note', status: 'active' });
      expect(after.observations).toEqual(['USER-NOTE: the user stored this themselves.']);
      expect([...after.tags].sort()).toEqual([...before.tags].sort());
      expect(after.metadata).toEqual(before.metadata);

      // Archived keeps precedence: an archived note under that name is a skip, not an error.
      const db2 = new MemeshDatabase(dbPath());
      db2.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(id);
      db2.close();
      runStop({ last_assistant_message: 'Another normal handoff message; the archived note must be skipped exactly as forget left it.' });
      expect(outcomes().at(-1)?.reason).toMatch(/archived by forget/);
      expect(handoffRows().observations).toEqual(['USER-NOTE: the user stored this themselves.']);
    }, 90_000);

    it('survives a real export and import into a fresh home, then a local Stop shows it', () => {
      runStop({ last_assistant_message: 'EXPORTED-TEXT: written on the first machine before the move, with a next step at the end.' });
      const bundle = path.join(home, 'bundle.json');
      const cli = path.resolve('dist/transports/cli/cli.js');
      const exp = spawnSync('node', [cli, 'export', '--out', bundle], { env: childEnv(), encoding: 'utf8', timeout: 30_000 });
      expect(exp.status, exp.stderr).toBe(0);

      fs.rmSync(path.join(home, '.memesh'), { recursive: true, force: true });
      fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
      const imp = spawnSync('node', [cli, 'import', bundle], { env: childEnv(), encoding: 'utf8', timeout: 30_000 });
      expect(imp.status, imp.stderr).toBe(0);
      expect(metadata()).toMatchObject({ trust: 'untrusted' });
      expect(start(), 'imported text must not be injected').not.toContain('EXPORTED-TEXT');

      runStop({ last_assistant_message: 'AFTER-MOVE-TEXT: the first session on the new machine, with its own next step at the end.' });
      const shown = start();
      expect(shown).toContain('AFTER-MOVE-TEXT');
      expect(shown).not.toContain('EXPORTED-TEXT');
    }, 120_000);
  });
});
