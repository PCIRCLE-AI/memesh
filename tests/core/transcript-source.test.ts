import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { executeWorkPackage } from '../../src/core/dreamer.js';
import { getProjectName } from '../../src/core/paths.js';
import {
  projectTranscriptSlug,
  scanTranscripts,
  claudeProjectsDir,
  recordedCwd,
  transcriptMiningDue,
  lastTranscriptMineAt,
  recordTranscriptMine,
} from '../../src/core/transcript-source.js';

// Discovery half of the transcript source (Task #18, B1). Every test points
// CLAUDE_PROJECTS_DIR at a temp dir — this suite never reads the developer's
// real ~/.claude/projects, and never writes anything anywhere but the temp
// dir it owns.

let root: string;
let prev: string | undefined;
type WorkPackageInput = Parameters<typeof executeWorkPackage>[1];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-transcripts-'));
  prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = root;
});

afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
  else process.env.CLAUDE_PROJECTS_DIR = prev;
  fs.rmSync(root, { recursive: true, force: true });
});

function seedSession(cwd: string, sessionId: string, lines: number, ageDays: number): string {
  const dir = path.join(root, projectTranscriptSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => JSON.stringify({ i, cwd })).join('\n') + '\n');
  const t = Date.now() - ageDays * 86400_000;
  fs.utimesSync(file, new Date(t), new Date(t));
  return file;
}

describe('work-package source boundary', () => {
  let db: ReturnType<typeof openDatabase>;
  let cwd: string;
  let project: string;
  const secret = 'sk-' + 'z'.repeat(40); // Synthetic shape only; never a real credential.
  const result = { name: 'fixture-decision', type: 'decision' as const, observations: ['Use the smaller parser.'], tags: ['parser'] };
  const prepare = () => executeWorkPackage(db, { action: 'prepare', kind: 'transcript', project });
  const writeSession = (recordedProject: string, text: string) => {
    const file = seedSession(cwd, 'snapshot-session', 1, 0);
    fs.writeFileSync(file, JSON.stringify({ cwd: recordedProject, type: 'user', message: { content: text } }));
    return file;
  };
  beforeEach(() => {
    cwd = fs.realpathSync(root);
    project = getProjectName(cwd);
    vi.stubEnv('MEMESH_DIR', root);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    db = openDatabase(path.join(root, 'fixture.db'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeDatabase();
  });

  it('accepts equivalent project paths and redacts transcript text without changing raw-byte identity', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(cwd, alias, 'dir');
    const file = writeSession(alias, `Visible fixture ${secret}`);
    const response = prepare();
    expect(response.status).toBe('available');
    expect(response.package).toMatchObject({
      ref: { source_hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
      sources: [{ role: 'user', text: 'Visible fixture ***REDACTED***' }],
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toEqual({ n: 0 });
  });

  it('rejects cwd-less foreign work-package content under a colliding project slug', () => {
    cwd = path.join(root, 'my-project');
    const foreign = path.join(root, 'my_project');
    fs.mkdirSync(cwd);
    fs.mkdirSync(foreign);
    vi.mocked(process.cwd).mockReturnValue(cwd);
    project = getProjectName(cwd);
    expect(projectTranscriptSlug(cwd)).toBe(projectTranscriptSlug(foreign));
    const file = seedSession(foreign, 'cwd-less-foreign', 1, 0);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'FOREIGN_PRIVATE_TEXT' } }));
    const response = prepare();
    expect(response).toEqual({ status: 'none_available', selection_mode: 'newest_session', available_action: [] });
    expect(JSON.stringify(response)).not.toContain('FOREIGN_PRIVATE_TEXT');
    expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toEqual({ n: 0 });
  });

  it.each(['prepare', 'submit', 'defer'] as const)('rejects a same-mtime foreign-project snapshot swap during %s', (action) => {
    const file = writeSession(cwd, 'Visible local evidence');
    const pkg = prepare().package as { id: string; ref: Extract<WorkPackageInput, { action: 'submit' }>['ref'] };
    const stamp = fs.statSync(file).mtime;
    const replacement = path.join(root, 'replacement.jsonl');
    fs.writeFileSync(replacement, JSON.stringify({ cwd: `${cwd}-foreign`, type: 'user', message: { content: 'FOREIGN_PRIVATE_TEXT' } }));
    fs.utimesSync(replacement, stamp, stamp);
    const realOpen = fs.openSync;
    let opens = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (args[0] === file && ++opens === 2) fs.renameSync(replacement, file);
      return realOpen(...args);
    });
    const response = action === 'prepare' ? prepare() : executeWorkPackage(db, action === 'submit'
      ? { action, package_id: pkg.id, ref: pkg.ref, result }
      : { action, package_id: pkg.id, ref: pkg.ref, reason: 'not_now' });
    expect(opens).toBe(2);
    expect(response).toMatchObject(action === 'prepare' ? { status: 'none_available' } : { status: 'error', error: 'stale_package' });
    expect(JSON.stringify(response)).not.toContain('FOREIGN_PRIVATE_TEXT');
    expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toEqual({ n: 0 });
  });

  it('redacts digest names and observations while hashing original source content', () => {
    const kg = new KnowledgeGraph(db);
    for (let i = 0; i < 5; i++) kg.createEntity(`commit-${i}-${secret}`, 'commit', {
      observations: [`Visible change ${i}: ${secret}`], tags: [`project:${project}`],
    });
    const input = { action: 'prepare' as const, kind: 'digest' as const, project };
    const response = executeWorkPackage(db, input);
    expect(response.status).toBe('available');
    const pkg = response.package as { sources: Array<{ name: string; observations: string[] }>; ref: { source_hash: string } };
    expect(pkg.sources).toHaveLength(5);
    expect(pkg.sources[0]).toMatchObject({ name: 'commit-0-***REDACTED***', observations: ['Visible change 0: ***REDACTED***'] });
    expect(JSON.stringify(response)).not.toContain(secret);
    db.prepare('UPDATE observations SET content = replace(content, ?, ?)').run(secret, 'sk-' + 'x'.repeat(40));
    const changed = executeWorkPackage(db, input).package as typeof pkg;
    expect(changed.sources).toEqual(pkg.sources);
    expect(changed.ref.source_hash).not.toBe(pkg.ref.source_hash);
  });

  it.each(['pending', 'applied', 'rejected'])('replays exact %s packages before reading changed or missing transcripts', (status) => {
    const file = writeSession(cwd, 'Use the smaller parser.');
    const pkg = prepare().package as { id: string; ref: Extract<WorkPackageInput, { action: 'submit' }>['ref'] };
    const submit = { action: 'submit' as const, package_id: pkg.id, ref: pkg.ref, result };
    const staged = executeWorkPackage(db, submit);
    expect(staged.status).toBe('staged');
    db.prepare('UPDATE dream_proposals SET status = ? WHERE id = ?').run(status, Number(staged.proposal_id));
    if (status === 'pending') writeSession(`${cwd}-foreign`, 'Changed after submission');
    else if (status === 'applied') fs.utimesSync(file, new Date(0), new Date(0));
    else fs.unlinkSync(file);
    const before = db.prepare('SELECT total_changes() AS n').get();
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('replay must not read transcripts'); });
    const existing = { status: 'existing', proposal_id: staged.proposal_id, proposal_status: status, available_action: [] };
    expect(executeWorkPackage(db, submit)).toEqual(existing);
    expect(executeWorkPackage(db, { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' })).toEqual(existing);
    expect(executeWorkPackage(db, { ...submit, result: { ...result, name: 'conflicting-result' } })).toMatchObject({ error: 'submission_conflict' });
    expect(executeWorkPackage(db, { ...submit, ref: { ...pkg.ref, source_hash: '0'.repeat(64) } })).toMatchObject({ error: 'stale_package' });
    expect(open).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toEqual({ n: 1 });
  });
});

describe('transcript-source discovery', () => {
  it('slug mirrors Claude Code: every non-alphanumeric char becomes a dash', () => {
    expect(projectTranscriptSlug('/Users/kt/Dev/memesh-llm-memory'))
      .toBe('-Users-kt-Dev-memesh-llm-memory');
  });

  it('honours CLAUDE_PROJECTS_DIR so it never reads the real ~/.claude', () => {
    expect(claudeProjectsDir()).toBe(root);
  });

  it('lists only in-window .jsonl sessions for the given project, newest first', () => {
    const cwd = '/proj/alpha';
    seedSession(cwd, 'sess-fresh', 10, 0);
    seedSession(cwd, 'sess-old', 10, 30); // outside a 3-day window
    seedSession(cwd, 'sess-yesterday', 5, 1);
    // Noise that must be ignored:
    const dir = path.join(root, projectTranscriptSlug(cwd));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript');

    const found = scanTranscripts({ cwd, windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['sess-fresh', 'sess-yesterday']);
    expect(found[0].lineCount).toBe(10);
    expect(found[1].lineCount).toBe(5);
  });

  it('does not cross project boundaries — only the requested cwd is scanned', () => {
    seedSession('/proj/alpha', 'a1', 3, 0);
    seedSession('/proj/beta', 'b1', 3, 0);
    const found = scanTranscripts({ cwd: '/proj/alpha', windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('returns [] (never throws) when the project has no transcript dir', () => {
    expect(scanTranscripts({ cwd: '/proj/never-seen', windowDays: 3 })).toEqual([]);
  });

  it('skips an unreadable file rather than fabricating a line count', () => {
    const cwd = '/proj/gamma';
    seedSession(cwd, 'ok', 4, 0);
    const dir = path.join(root, projectTranscriptSlug(cwd));
    const bad = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(bad, 'x\ny\n');
    fs.utimesSync(bad, new Date(), new Date());
    // Make it unreadable on POSIX; on platforms where chmod is a no-op the
    // file simply reads normally and both sessions appear — either way no
    // fabricated count and no throw.
    try { fs.chmodSync(bad, 0o000); } catch { /* ignore */ }
    const found = scanTranscripts({ cwd, windowDays: 3 });
    expect(found.some((s) => s.sessionId === 'ok')).toBe(true);
    for (const s of found) expect(s.lineCount).toBeGreaterThan(0);
    try { fs.chmodSync(bad, 0o644); } catch { /* ignore */ }
  });

  it('binds stat and read to one fd — a path swap after readdir cannot mislead the count', () => {
    // Regression for the js/file-system-race (TOCTOU) CodeQL flagged: the
    // old code did statSync(path) then readFileSync(path), so the count and
    // the window decision could describe two different inodes. The scanner
    // now opens once and reads through that fd. We can't portably swap an
    // inode mid-call, but we can prove the count comes from the file's
    // actual bytes (not a re-stat) and that the loop is defensive: a file
    // that disappears between readdir and open is skipped, not fabricated.
    const cwd = '/proj/race';
    seedSession(cwd, 'real', 7, 0);
    const dir = path.join(root, projectTranscriptSlug(cwd));
    // A dangling entry: present at readdir, gone at open.
    const ghost = path.join(dir, 'ghost.jsonl');
    fs.writeFileSync(ghost, 'a\nb\n');
    fs.utimesSync(ghost, new Date(), new Date());
    fs.rmSync(ghost);
    const found = scanTranscripts({ cwd, windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['real']);
    expect(found[0].lineCount).toBe(7);
  });
});

describe('transcript-source slug-collision guard', () => {
  // projectTranscriptSlug is lossy: '/p/my-project' and '/p/my_project' both
  // map to '-p-my-project'. Without a per-session cwd check, scanning one would
  // pull in the other's sessions and stamp them with the wrong project tag.

  // Write a transcript whose entries record `recordCwd`. The first two lines are
  // metadata WITHOUT a cwd (mirrors real Claude Code files), so a guard that
  // only peeked line 1 would find nothing and never fire.
  function seedWithCwd(slugCwd: string, sessionId: string, recordCwd: string | null): void {
    const dir = path.join(root, projectTranscriptSlug(slugCwd));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'summary', leafUuid: 'x' }),
      JSON.stringify({ type: 'x', mode: 'default' }),
      JSON.stringify(recordCwd === null ? { type: 'user', text: 'hi' } : { type: 'user', cwd: recordCwd, text: 'hi' }),
    ];
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.utimesSync(file, new Date(), new Date());
  }

  it('recordedCwd finds the cwd past the metadata preamble, not just line 1', () => {
    const text = [
      JSON.stringify({ type: 'summary', leafUuid: 'x' }),
      JSON.stringify({ type: 'x', permissionMode: 'default' }),
      JSON.stringify({ type: 'user', cwd: '/p/my-project', text: 'hi' }),
    ].join('\n');
    expect(recordedCwd(text)).toBe('/p/my-project');
    // No cwd anywhere → null: discovery cannot verify project ownership.
    expect(recordedCwd(JSON.stringify({ type: 'user', text: 'hi' }))).toBe(null);
  });

  it('two slug-colliding projects each see only their OWN sessions', () => {
    // '/p/my-project' and '/p/my_project' collapse to the same slug dir.
    expect(projectTranscriptSlug('/p/my-project')).toBe(projectTranscriptSlug('/p/my_project'));
    seedWithCwd('/p/my-project', 'hyphen-sess', '/p/my-project');
    seedWithCwd('/p/my_project', 'underscore-sess', '/p/my_project');

    const hyphen = scanTranscripts({ cwd: '/p/my-project', windowDays: 3 });
    expect(hyphen.map((s) => s.sessionId)).toEqual(['hyphen-sess']);

    const underscore = scanTranscripts({ cwd: '/p/my_project', windowDays: 3 });
    expect(underscore.map((s) => s.sessionId)).toEqual(['underscore-sess']);
  });

  it('rejects cwd-less sessions for both projects under a colliding slug', () => {
    expect(projectTranscriptSlug('/p/my-project')).toBe(projectTranscriptSlug('/p/my_project'));
    seedWithCwd('/p/my_project', 'no-cwd-sess', null);
    expect(scanTranscripts({ cwd: '/p/my-project', windowDays: 3 })).toEqual([]);
    expect(scanTranscripts({ cwd: '/p/my_project', windowDays: 3 })).toEqual([]);
  });

  it('normalises both sides of the cwd compare so a cosmetic difference is not a false skip', () => {
    // Recorded cwd has a redundant `.` segment and a doubled slash; the scanned
    // cwd is the plain form. path.normalize collapses those, so the session is
    // NOT skipped. Without normalisation this exact-string compare would drop
    // the project's own session. (Trailing-slash and symlink /tmp-vs-/private
    // differences are NOT collapsed by normalize — the fail-closed edge noted
    // in scanTranscripts.)
    seedWithCwd('/p/norm', 'norm-sess', '/p//./norm');
    const found = scanTranscripts({ cwd: '/p/norm', windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['norm-sess']);
  });
});

describe('transcript-source scheduled-mining throttle (B4)', () => {
  // Every test writes the throttle state to a temp file it owns (override path),
  // so the real ~/.memesh/transcript-mining.json is never read or written.
  let stateFile: string;

  beforeEach(() => {
    stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mine-state-')), 'transcript-mining.json');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
  });

  const H = 3600_000;

  it('transcriptMiningDue: never-mined (null) is due', () => {
    expect(transcriptMiningDue(1_000_000, null, 24)).toBe(true);
  });

  it('transcriptMiningDue: within the interval is NOT due; at/after it IS', () => {
    const now = 100 * H;
    // Break-test: flip the `>=` in transcriptMiningDue and the boundary case fails.
    expect(transcriptMiningDue(now, now - 23 * H, 24)).toBe(false); // 23h < 24h
    expect(transcriptMiningDue(now, now - 24 * H, 24)).toBe(true);  // exactly due
    expect(transcriptMiningDue(now, now - 25 * H, 24)).toBe(true);  // overdue
  });

  it('transcriptMiningDue: a FUTURE last-run (clock skew) is due, not a lockout', () => {
    const now = 100 * H;
    // Break-test: remove the `lastMs > nowMs` guard and this returns false
    // (now - future is negative < interval) → the schedule wedges shut.
    expect(transcriptMiningDue(now, now + 5 * H, 24)).toBe(true);
  });

  it('transcriptMiningDue: a non-positive interval means always due, never a lockout', () => {
    const now = 50 * H;
    expect(transcriptMiningDue(now, now, 0)).toBe(true);
    expect(transcriptMiningDue(now, now, -5)).toBe(true);
    expect(transcriptMiningDue(now, now, NaN)).toBe(true); // Math.max(0, NaN) === NaN → 0-floor path
  });

  it('record → read round-trips the per-project timestamp', () => {
    expect(lastTranscriptMineAt('proj-a', stateFile)).toBeNull(); // nothing written yet
    recordTranscriptMine('proj-a', 42_000, stateFile);
    expect(lastTranscriptMineAt('proj-a', stateFile)).toBe(42_000);
  });

  it('keys BY PROJECT — recording one project does not reset another', () => {
    recordTranscriptMine('proj-a', 1_000, stateFile);
    recordTranscriptMine('proj-b', 2_000, stateFile);
    recordTranscriptMine('proj-a', 3_000, stateFile); // update A, B must survive
    expect(lastTranscriptMineAt('proj-a', stateFile)).toBe(3_000);
    expect(lastTranscriptMineAt('proj-b', stateFile)).toBe(2_000);
  });

  it('a corrupt/unreadable state file reads as null (due), never throws — a broken throttle must not wedge the schedule shut', () => {
    fs.writeFileSync(stateFile, 'not json at all');
    expect(lastTranscriptMineAt('proj-a', stateFile)).toBeNull();
    // and a subsequent record still succeeds (overwrites the garbage)
    recordTranscriptMine('proj-a', 7_000, stateFile);
    expect(lastTranscriptMineAt('proj-a', stateFile)).toBe(7_000);
  });
});
