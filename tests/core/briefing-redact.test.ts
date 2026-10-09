// #464: every injected memory line is redacted, not only the index's.
//
// The durable-memory index redacted secrets and user paths in titles and
// snippets; the ranked sections above it ("Decisions and direction", lessons,
// …) printed the stored text as it was. One memory therefore appeared twice
// in one injected block — redacted under the index heading, unredacted a few
// lines above. Both the MCP/CLI `briefing` and the SessionStart hook render
// through the same line builder, and both are checked here against one graph.
//
// The rows are seeded with raw SQL on purpose: `remember` now redacts on
// write (#523), so a fixture written through it would have nothing to leak
// and this test would pass with the display-side redaction removed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { getProjectName, homeDir } from '../../src/core/paths.js';
import { SNIPPET_FETCH_CHARS } from '../../src/core/work-topology.js';
import { taskStateLines, taskStateName } from '../../src/core/task-state.js';
import { buildBriefingIndex } from '../../src/core/briefing-index.js';
import { toTopologyEntity } from '../../src/core/briefing-pools.js';
import { sessionHandoffName, SESSION_HANDOFF_TYPE } from '../../src/core/session-handoff.js';
import { removeTempDir } from '../helpers/temp-dir.js';

// Assembled at runtime so no line in the repository looks like a credential.
const DB_PASSWORD = 'hunter2hunter2';
const DB_URL = ['postgres://appuser', `${DB_PASSWORD}@db:5432/app`].join(':');
const TOKEN_VALUE = 'abc123abc123abc123';
const SNIPPET_PASSWORD = 'cachepass9cachepass9';
const CUT_PASSWORD = 'zq7cutpasszq7cutpass';

let tmpDir: string;
let dbPath: string;
let cwd: string;
let project: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-briefing-redact-'));
  dbPath = path.join(tmpDir, 'test.db');
  cwd = path.join(tmpDir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  project = getProjectName(cwd);
  openDatabase(dbPath);
  seedUnredactedRows();
});

afterEach(() => {
  closeDatabase();
  removeTempDir(tmpDir);
});

/** Rows exactly as a pre-#523 graph holds them: the secret is in the database. */
function seedUnredactedRows(): void {
  const db = getDatabase();
  const insert = db.prepare('INSERT INTO entities (name, type, title, status) VALUES (?, ?, ?, \'active\')');
  const addObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
  const addTag = db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)');

  // A decision: ranks under "Decisions and direction" AND is listed in the index.
  const decision = Number(insert.run('staging-db-decision', 'decision', `Set ${['token', TOKEN_VALUE].join('=')} for staging`).lastInsertRowid);
  addObs.run(decision, `Staging database is ${DB_URL}`);
  addTag.run(decision, `project:${project}`);

  // A lesson: ranks under the lessons section; its title names a file under HOME.
  const lesson = Number(insert.run('lesson-notes-path', 'lesson_learned', `Keep the runbook at ${path.join(homeDir(), 'runbook.md')}`).lastInsertRowid);
  addObs.run(lesson, `Error: the old copy at ${path.join(homeDir(), 'old-runbook.md')} was stale`);
  addTag.run(lesson, `project:${project}`);

  // A decision with NO title (pre-UX-1 data): the line is built from the
  // first observation, so this is the fixture that makes the SNIPPET
  // redaction load-bearing — with titles everywhere, `title || snippet`
  // never printed a snippet and removing its redaction stayed green.
  const untitled = Number(insert.run('untitled-cache-decision', 'decision', null).lastInsertRowid);
  addObs.run(untitled, `Cache lives at ${['redis://cache', `${SNIPPET_PASSWORD}@cache.internal:6379`].join(':')} for now`);
  addTag.run(untitled, `project:${project}`);

  // A snippet that was cut before it was redacted (the old SQL `substr(content, 1, SNIPPET_FETCH_CHARS)`, then redaction)
  // redacted, so a credential straddling that cut is seen by the redactor
  // as a fragment. This row places the password exactly across the cut.
  const cutAt = SNIPPET_FETCH_CHARS;
  const cutUrl = ['mysql://svc', `${CUT_PASSWORD}@db.internal:3306/app`].join(':');
  const filler = 'y'.repeat(cutAt - 'mysql://svc:'.length - 4); // cut lands 4 chars into the password
  const straddling = Number(insert.run('untitled-cut-decision', 'decision', null).lastInsertRowid);
  addObs.run(straddling, `${filler}${cutUrl} tail`);
  addTag.run(straddling, `project:${project}`);

  // Reproducer: NO title, and a credential whose
  // password is longer than every fetch window (640 ranked, 4000 index), at
  // the START of the observation. `substr()` in SQL cut the `@` off, the
  // pattern no longer matched, and the visible prefix `postgres://reviewer:`
  // was printed on both surfaces, ranked AND index. Redaction must see the
  // whole observation before any clipping.
  const longUrl = ['postgres://reviewer', `${'p'.repeat(5000)}@db.example/memory`].join(':');
  const longRow = Number(insert.run('untitled-long-credential', 'decision', null).lastInsertRowid);
  addObs.run(longRow, `${longUrl} is the old primary`);
  addTag.run(longRow, `project:${project}`);

  // A session handoff written BEFORE #523 (raw SQL): the Stop hook stores a
  // new one redacted, but this one leads the block for up to 14 days on
  // both surfaces, and `handoffView` must redact it on display.
  const handoff = Number(insert.run(sessionHandoffName(project), SESSION_HANDOFF_TYPE, null).lastInsertRowid);
  addObs.run(handoff, `…was wiring the staging database ${DB_URL} and left the ${['token', TOKEN_VALUE].join('=')} in the env file; next: rotate it and finish the migration script`);

  // A task state written BEFORE #523 (raw SQL, so `setTaskState`'s own
  // redaction cannot mask it): `metadata.task_state.goal` holds the secret,
  // and both injected surfaces render it through `taskStateLines`, which
  // must redact on display. Seeding through the fixed `setTaskState` here
  // hid exactly this gap (fix-verifier I6).
  db.prepare("INSERT INTO entities (name, type, status, metadata) VALUES (?, 'task-state', 'active', ?)").run(
    taskStateName(project),
    JSON.stringify({ task_state: { goal: `migrate ${DB_URL}`, next: `set ${['token', TOKEN_VALUE].join('=')} on staging`, updated_at: new Date().toISOString() } }),
  );
}

/** The ranked block: everything before the index heading. */
function rankedPart(text: string): string {
  return text.split('Index of durable memories for')[0];
}
function indexPart(text: string): string {
  return text.split('Index of durable memories for')[1] ?? '';
}

function expectRedactedEverywhere(text: string): void {
  expect(text).not.toContain(DB_PASSWORD);
  expect(text).not.toContain(TOKEN_VALUE);
  expect(text).not.toContain(SNIPPET_PASSWORD);
  // The straddling fixture: neither the password nor a fragment of it.
  expect(text).not.toContain(CUT_PASSWORD.slice(0, 4));
  expect(text).not.toContain('mysql://svc:');
  // The task-state line is injected too, and must be clean on both surfaces.
  expect(text).toContain('Goal:');
  // The legacy handoff leads the block, redacted, on both surfaces.
  expect(text).toContain('Where the last session left off');
  expect(text).toContain('finish the migration script');
  // The 5000-character credential: neither the prefix nor the password, in
  // the ranked sections NOR the index, and the memory is still listed.
  expect(text).not.toContain('postgres://reviewer:');
  expect(text).not.toContain('ppppp');
  expect(rankedPart(text)).toContain('is the old primary');
  expect(indexPart(text)).toContain('is the old primary');
  expect(text).not.toContain(homeDir());
  expect(text).toContain('***REDACTED***');
  expect(text).toContain(path.join('~', 'runbook.md')); // `~\runbook.md` on Windows

  // The decision is in both places, redacted in both — never one of each.
  const ranked = rankedPart(text);
  const index = indexPart(text);
  expect(ranked).toContain('for staging');
  expect(index).toContain('for staging');
  const stagingLines = text.split('\n').filter((l) => l.includes('for staging'));
  expect(stagingLines.length).toBeGreaterThanOrEqual(2);
  for (const line of stagingLines) expect(line).toContain('***REDACTED***');
}

describe('briefing redaction (#464)', () => {
  it('#406 a real CLI goal update keeps old done out of CLI briefing and SessionStart', () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    // This legacy raw-SQL fixture must have the project tag a real task write
    // creates; otherwise the CLI correctly refuses the ownership collision.
    getDatabase().prepare('INSERT INTO tags (entity_id, tag) SELECT id, ? FROM entities WHERE name = ?')
      .run(`project:${project}`, taskStateName(project));
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run(
      JSON.stringify({ task_state: { goal: 'Previous goal', done: 'Ancient done fixture', updated_at: old } }), taskStateName(project));
    closeDatabase();
    const env = { HOME: tmpDir, USERPROFILE: tmpDir, PATH: path.dirname(process.execPath),
      MEMESH_DIR: tmpDir, MEMESH_DB_PATH: dbPath, MEMESH_BRIEFING: 'standard', MEMESH_AUTO_UPDATE: '0', MEMESH_UPDATE_CHECK: '0' };
    const cli = path.resolve('dist/transports/cli/cli.js');
    const runCli = (args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    const written = JSON.parse(runCli(['task', '--project', project, '--goal', 'Fresh goal fixture', '--json']));
    expect(written.state.done).toBe('Ancient done fixture');
    expect(written.state.stated_at.done).toBeUndefined();
    expect(written.state.legacy_updated_at).toBe(old);
    expect(written.state.stated_at.goal).toBe(written.state.updated_at);
    const full = runCli(['task', '--project', project]);
    expect(full).toContain('Ancient done fixture');
    expect(full).toContain('Had just finished: (unknown date) Ancient done fixture');
    const brief = JSON.parse(runCli(['briefing', '--project', project, '--json'])).text;
    const hookOut = execFileSync(process.execPath, [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd }), cwd, env, encoding: 'utf8', timeout: 15000,
    });
    const hook = JSON.parse(hookOut.trim().split('\n').filter(Boolean).at(-1)!).hookSpecificOutput.additionalContext;
    for (const text of [brief, hook]) {
      expect(text).toContain('Fresh goal fixture');
      expect(text).not.toContain('Ancient done fixture');
      expect(text).toContain('not shown as current');
    }
    openDatabase(dbPath);
  });
  it('assembleBriefing redacts the ranked sections the same way as the index', () => {
    const previous = process.env.MEMESH_BRIEFING;
    process.env.MEMESH_BRIEFING = 'standard';
    try {
      const result = assembleBriefing(project);
      expect(result.text).toContain('Decisions and direction');
      expectRedactedEverywhere(result.text);
    } finally {
      if (previous === undefined) delete process.env.MEMESH_BRIEFING;
      else process.env.MEMESH_BRIEFING = previous;
    }
  });

  it('the SessionStart hook injects no unredacted line either', () => {
    closeDatabase(); // the hook opens its own handle
    const hookOut = execFileSync('node', [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_BRIEFING: 'standard' },
      encoding: 'utf8',
      timeout: 15000,
    });
    openDatabase(dbPath); // afterEach closes it
    const injected: string =
      JSON.parse(hookOut.trim().split('\n').filter(Boolean).at(-1)!).hookSpecificOutput.additionalContext;
    expect(injected).toContain('Decisions and direction');
    expectRedactedEverywhere(injected);
  });

  it('the SessionStart hook redacts a 300,000-character legacy observation within its time budget', () => {
    // 300,000 characters of `eyJ`: no write path accepts this any more, but
    // an older version stored such rows. The hook reads it whole and redacts
    // it; redaction is linear on runs of `eyJ` (#567), so it stays in budget.
    const db = getDatabase();
    const huge = Number(db.prepare("INSERT INTO entities (name, type, title, status) VALUES ('huge-legacy-decision', 'decision', 'huge legacy decision', 'active')").run().lastInsertRowid);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(huge, 'eyJ'.repeat(100_000));
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(huge, `project:${project}`);
    closeDatabase(); // the hook opens its own handle
    const hookOut = execFileSync('node', [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_BRIEFING: 'standard' },
      encoding: 'utf8',
      timeout: 15000,
    });
    openDatabase(dbPath); // afterEach closes it
    const injected: string =
      JSON.parse(hookOut.trim().split('\n').filter(Boolean).at(-1)!).hookSpecificOutput.additionalContext;
    expect(injected).toContain('huge legacy decision');
    expectRedactedEverywhere(injected);
  });

  it('a long credential does not pull a later credential into the snippet, and a huge legacy handoff is redacted within budget', () => {
    const db = getDatabase();
    // A long first credential redacts to a short marker, pulling what follows
    // it into the printed snippet; the later URL is redacted with the rest,
    // so its password never prints.
    const pw = 'straddlepw';
    const crossing = `password=${'A'.repeat(16350)} ${['postgres://u1', `${pw}@host/db`].join(':')} tail`;
    const row = Number(db.prepare("INSERT INTO entities (name, type, title, status) VALUES ('crossing-window-decision', 'decision', 'crossing window decision', 'active')").run().lastInsertRowid);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(row, crossing);
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(row, `project:${project}`);
    // A handoff written through `remember` before the Stop hook bounded it.
    db.prepare('UPDATE observations SET content = ? WHERE entity_id = (SELECT id FROM entities WHERE name = ?)')
      .run(`${'eyJ'.repeat(100_000)} finish the migration script`, sessionHandoffName(project));
    closeDatabase(); // the hook opens its own handle
    const hookOut = execFileSync('node', [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_BRIEFING: 'standard' },
      encoding: 'utf8',
      timeout: 15000,
    });
    openDatabase(dbPath); // afterEach closes it
    const injected: string =
      JSON.parse(hookOut.trim().split('\n').filter(Boolean).at(-1)!).hookSpecificOutput.additionalContext;
    expect(injected).toContain('crossing window decision');
    expect(injected).not.toContain(pw);
    expect(injected).not.toContain('postgres://u1');
    expect(injected).toContain('Where the last session left off');
    expect(injected).toContain('finish the migration script');
  });
});

// A private key stored before write-time redaction, with its header in one
// shown text and its body in another, is masked as a whole on every display
// path that puts those texts on one line or one block.
describe('a key split across shown texts is masked as a whole (#565, display)', () => {
  const dashes = '-'.repeat(5);
  const kind = ['RSA', 'PRIVATE', 'KEY'].join(' ');
  const header = `${dashes}BEGIN ${kind}${dashes}`;
  const footer = `${dashes}END ${kind}${dashes}`;
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';

  it('task state: header in one field, body in another', () => {
    const lines = taskStateLines({ goal: header, next: body, blocked: footer }, 'split-key');
    expect(lines.join('\n')).not.toContain(body);
    expect(lines.join('\n')).toContain('***REDACTED***');
  });

  it('durable-memory index: header in the title, body in the snippet', () => {
    const index = buildBriefingIndex(
      [{ id: 1, type: 'decision', title: header, snippet: body, lastActivity: '2026-10-01 00:00:00', metadata: null }],
      'split-key',
      Date.parse('2026-10-05T00:00:00Z'),
    );
    expect(JSON.stringify(index)).not.toContain(body);
    expect(JSON.stringify(index)).toContain('***REDACTED***');
  });

  it('ranked line: header in the title, body in the first observation', () => {
    const entity = toTopologyEntity(
      { id: 7, name: 'split', type: 'decision', title: header, metadata: null },
      new Map([[7, { first: body, fix: null }]]),
    );
    expect(JSON.stringify(entity)).not.toContain(body);
    expect(entity.title).toBe('***REDACTED***');
  });
});
