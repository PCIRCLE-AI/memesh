/**
 * The Stop hook keeps the agent's last message as the project's handoff.
 * Every test spawns the REAL hook (scripts/hooks/session-summary.js →
 * scripts/hooks/_stop-handoff.js) against a throwaway HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
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

  it('is not shown to a new session yet: not in the ranked block, the index or another project\'s view, and it takes no slot', () => {
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
      expect(context, `the positive control is missing at ${level}, so this test proves nothing`).toContain('DECISION-MARKER');
      expect(context).not.toContain('HANDOFF-MARKER');
      expect(context).not.toContain('Where the last session left off');
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
    expect(context).not.toContain('HANDOFF-MARKER');
    expect(String(out.systemMessage ?? '')).toMatch(/5 recent/);
  }, 120_000);
});
