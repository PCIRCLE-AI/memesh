/**
 * What follows from the privacy answer at the note importer: holds, waits,
 * re-decisions, the lock, error codes and counts. One test per root cause of
 * the S3 redesign (see the test names); each was red on 2fbe559d8.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { getDatabase } from '../../src/db.js';
import * as ni from '../../src/core/note-ingest.js';
import { PRIVATE_CHECK_MAX_BYTES, PRIVATE_WINDOW_MS } from '../../src/core/private-session.js';
import { SKIP_REASONS } from '../../src/core/capture-liveness.js';
import { getMemeshDirFromDbPath } from '../../src/core/paths.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { canDenyReads } from '../helpers/permissions.js';

const { ingestNoteDirectory, holdOutNoteFiles, markPrivateSession, summarizeNoteIngest } = ni;
const fixture = useTestDatabase('memesh-private-holds-');
beforeEach(() => {
  vi.stubEnv('MEMESH_DB_PATH', fixture.dbPath);
  for (const d of ['private-sessions', 'note-ingest-holds']) fs.rmSync(path.join(getMemeshDirFromDbPath(), d), { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllEnvs(); });

const note = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name}\ntype: fact\n---\n\n${body}\n`;
let n = 0;
/** A notes folder as Claude Code lays them out: `<root>/<project>/memory`, all under one projects root. */
const dirWith = (files: Record<string, string>) => {
  const dir = path.join(fixture.tmpDir, 'projects', `-proj-${++n}`, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), c);
  return dir;
};
const names = () => (getDatabase().prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map((r) => r.name);
const holdsDir = () => path.join(getMemeshDirFromDbPath(), 'note-ingest-holds');
const markersDir = () => path.join(getMemeshDirFromDbPath(), 'private-sessions');
/** A sparse file: no disk is used, but every byte would be read by a scan. */
const sparse = (file: string, bytes: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, bytes);
  for (let off = 1 << 20; off < bytes; off += 64 << 20) fs.writeSync(fd, '\n', off);
  fs.closeSync(fd);
  return file;
};
const tentative = (reason: string, transcript: string) => ({ transcript, tentative: { reason } });

describe('R-C: a note held while its session could not be checked is looked at again', () => {
  it('a run that holds a note only tentatively tells its caller to run again (Q6_08 N1)', () => {
    const dir = dirWith({ 'secret.md': note('note_secret', 'Body.') });
    const folder = path.join(fixture.tmpDir, 'a-folder.jsonl');
    fs.mkdirSync(folder, { recursive: true });
    holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [path.join(dir, 'secret.md')], ...tentative('unreadable', folder) });
    const run = ingestNoteDirectory({ dir });
    expect(run.created).toEqual([]);
    expect((run.held?.unchecked ?? 0) + run.more + run.pendingPrivate, 'the caller is told to look again').toBeGreaterThan(0);
  });
});

describe('R-D: re-deciding a held session costs a stat, not a scan', () => {
  const readsOf = (file: string, fn: () => void): number => {
    let bytes = 0;
    const real = fs.readSync;
    const fds = new Set<number>();
    const realOpen = fs.openSync;
    const o = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => { const fd = (realOpen as (...a: unknown[]) => number)(p, ...rest); if (String(p) === file) fds.add(fd); return fd; }) as typeof fs.openSync);
    const r = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...rest: unknown[]) => { const got = (real as (...a: unknown[]) => number)(fd, ...rest); if (fds.has(fd)) bytes += got; return got; }) as typeof fs.readSync);
    try { fn(); } finally { o.mockRestore(); r.mockRestore(); }
    return bytes;
  };

  it('P1: a held session whose transcripts are past the size limit is not read again by an import (Q6_09)', () => {
    const dir = dirWith({ 'secret.md': note('note_secret', 'held while unknown') });
    const main = sparse(path.join(fixture.tmpDir, 't', 'main.jsonl'), Math.floor(1.9 * 1024 ** 3));
    sparse(path.join(fixture.tmpDir, 't', 'main', 'subagents', 'agent-a.jsonl'), Math.floor(1.1 * 1024 ** 3));
    holdOutNoteFiles({ dir, sessionId: 'sess-big', paths: [path.join(dir, 'secret.md')], ...tentative('too_large', main) });
    expect(readsOf(main, () => { ingestNoteDirectory({ dir }); ingestNoteDirectory({ dir }); })).toBe(0);
  }, 120_000);

  it('P1b: the same for a transcript alone over PRIVATE_CHECK_MAX_BYTES (Q6_09)', () => {
    const dir = dirWith({ 'secret.md': note('note_secret2', 'held while unknown') });
    const big = sparse(path.join(fixture.tmpDir, 't2', 'big.jsonl'), PRIVATE_CHECK_MAX_BYTES + 64 * 1024 ** 2);
    holdOutNoteFiles({ dir, sessionId: 'sess-big2', paths: [path.join(dir, 'secret.md')], ...tentative('too_large', big) });
    expect(readsOf(big, () => ingestNoteDirectory({ dir }))).toBe(0);
  }, 120_000);

  it('P1c: ten such sessions held for one folder cost nothing to an import of an unrelated folder (Q6_09, Q6_06 F3)', () => {
    const dir = dirWith({ 'secret.md': note('note_s3', 'x') });
    const main = sparse(path.join(fixture.tmpDir, 't3', 'main.jsonl'), Math.floor(1.9 * 1024 ** 3));
    sparse(path.join(fixture.tmpDir, 't3', 'main', 'subagents', 'agent-a.jsonl'), Math.floor(1.1 * 1024 ** 3));
    for (let i = 0; i < 10; i++) holdOutNoteFiles({ dir, sessionId: `sess-big-${i}`, paths: [path.join(dir, 'secret.md')], ...tentative('too_large', main) });
    fs.rmSync(path.join(fixture.tmpDir, 'other-root'), { recursive: true, force: true });
    const unrelated = path.join(fixture.tmpDir, 'other-root', 'proj', 'memory');
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, 'mine.md'), note('note_mine', 'ordinary'));
    let r: ReturnType<typeof ingestNoteDirectory> | undefined;
    const t0 = Date.now();
    expect(readsOf(main, () => { r = ingestNoteDirectory({ dir: unrelated }); })).toBe(0);
    expect(Date.now() - t0, 'ten times faster than the 10.2 s measured on 2fbe559d8').toBeLessThan(1020);
    expect(r?.created).toEqual(['note_mine']);
  }, 300_000);
});

describe('R-E: the outcome says how many notes are held', () => {
  it('counts every held note and names it in the summary (Q6_09, Q6_08 Nit)', () => {
    const dir = dirWith({ 'secret.md': note('note_counted', 'Body.') });
    holdOutNoteFiles({ dir, sessionId: 'sess-c', paths: [path.join(dir, 'secret.md')] });
    const run = ingestNoteDirectory({ dir });
    expect(run.held?.private).toBe(1);
    expect(summarizeNoteIngest(run)).toContain('1 held out by a private session');
  });
});

describe('R-F: a private session waits imports in every notes folder of its projects root', () => {
  it('a note written into another project\'s folder before the private session\'s next Stop waits (it is not imported)', () => {
    const own = dirWith({});
    const other = dirWith({});
    markPrivateSession({ sessionId: 'sess-p', dirs: [own], dir: own, now: Date.now() - 1000 } as Parameters<typeof markPrivateSession>[0]);
    fs.writeFileSync(path.join(other, 'leak.md'), note('note_leak', 'PRIVATEBODY written by the private session'));
    const run = ingestNoteDirectory({ dir: other });
    expect(names()).not.toContain('note_leak');
    expect(run.pendingPrivate).toBe(1);
  });
});

describe('R-G: every write of a hold record holds the one lock and applies only its own change', () => {
  it('a release decided on a record that changed since it was read is not applied, and the newer hold stays', () => {
    const dir = dirWith({ 'a.md': note('note_a', 'A.'), 'b.md': note('note_b', 'B.') });
    const t = path.join(fixture.tmpDir, 'quiet.jsonl');
    fs.writeFileSync(t, '{"type":"user","message":{"content":"hi"}}\n');
    holdOutNoteFiles({ dir, sessionId: 'sess-r', paths: [path.join(dir, 'a.md')], ...tentative('timeout', t) });
    const before = JSON.parse(fs.readFileSync(path.join(holdsDir(), 'sess-r.json'), 'utf8'));
    // Another hook of the session records a firm hold meanwhile.
    holdOutNoteFiles({ dir, sessionId: 'sess-r', paths: [path.join(dir, 'b.md')] });
    expect(ni.settleTentativeHolds('sess-r', 'no', { expectRev: before.rev })).toBe(false);
    ingestNoteDirectory({ dir, deadlineAt: Date.now() - 1 }); // no time to decide again: nothing released
    expect(names()).not.toContain('note_b');
  });

  it('four processes writing holds for one session at the same time lose none of them (the built importer; G01 F4)', async () => {
    const dir = dirWith(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`n${i}.md`, note(`note_${i}`, `body ${i}`)])));
    const script = (from: number) => `import(${JSON.stringify(pathToFileURL(path.resolve('dist/core/note-ingest.js')).href)}).then((ni) => { for (let i = ${from}; i < ${from + 50}; i++) ni.holdOutNoteFiles({ dir: ${JSON.stringify(dir)}, sessionId: 'sess-two', paths: [${JSON.stringify(dir)} + '/n' + i + '.md'] }); });`;
    const env = { ...process.env, MEMESH_DB_PATH: fixture.dbPath };
    const exits = await Promise.all([0, 50, 100, 150].map((from) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['-e', script(from)], { env, stdio: 'ignore' });
      child.on('exit', resolve);
    })));
    expect(exits).toEqual([0, 0, 0, 0]);
    const rec = JSON.parse(fs.readFileSync(path.join(holdsDir(), 'sess-two.json'), 'utf8'));
    expect(Object.keys(Object.values(rec.firm)[0] as object)).toHaveLength(200);
  }, 60_000);

  it('a lock left by a process that is gone is broken; a live one past the deadline is BUSY', async () => {
    const { withPrivateStateLock, PRIVATE_STATE_BUSY } = await import('../../src/core/private-state-lock.js');
    const memesh = getMemeshDirFromDbPath();
    fs.mkdirSync(memesh, { recursive: true });
    const lock = path.join(memesh, 'private-state.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import('os')).hostname(), at: Date.now() }));
    expect(withPrivateStateLock(memesh, Date.now() + 2000, () => 'ran')).toBe('ran');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: (await import('os')).hostname(), at: Date.now() }));
    let code: string | undefined;
    try { withPrivateStateLock(memesh, Date.now() + 50, () => 'ran'); } catch (err) { code = (err as { code?: string }).code; }
    fs.rmSync(lock, { force: true });
    expect(code).toBe(PRIVATE_STATE_BUSY);
  });
});

describe('O: the lock stays one holder at a time (G09 F7)', () => {
  const setup = async () => {
    const { withPrivateStateLock, PRIVATE_STATE_BUSY } = await import('../../src/core/private-state-lock.js');
    const memesh = getMemeshDirFromDbPath();
    fs.mkdirSync(memesh, { recursive: true });
    return { withPrivateStateLock, PRIVATE_STATE_BUSY, memesh, lock: path.join(memesh, 'private-state.lock'), host: (await import('os')).hostname() };
  };

  it('breaking a dead lock never removes a live one another process took meanwhile', async () => {
    const { withPrivateStateLock, PRIVATE_STATE_BUSY, memesh, lock, host } = await setup();
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host, at: Date.now() }));
    const fresh = JSON.stringify({ pid: process.pid, host, at: Date.now(), token: 'theirs' });
    const realRename = fs.renameSync;
    let raced = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (!raced && String(from) === lock) { raced = true; fs.rmSync(lock); fs.writeFileSync(lock, fresh); } // another process broke it first and took it
      return realRename(from, to);
    }) as typeof fs.renameSync);
    let code: string | undefined;
    try { withPrivateStateLock(memesh, Date.now() + 200, () => 'ran'); } catch (err) { code = (err as { code?: string }).code; } finally { spy.mockRestore(); }
    expect(fs.readFileSync(lock, 'utf8'), 'the live lock is back in place').toBe(fresh);
    fs.rmSync(lock, { force: true });
    expect(code).toBe(PRIVATE_STATE_BUSY);
  });

  it('a holder releases only its own lock', async () => {
    const { withPrivateStateLock, memesh, lock, host } = await setup();
    const theirs = JSON.stringify({ pid: process.pid, host, at: Date.now(), token: 'theirs' });
    withPrivateStateLock(memesh, Date.now() + 2000, () => { fs.writeFileSync(lock, theirs); }); // broken and taken by another while this one ran
    expect(fs.existsSync(lock) && fs.readFileSync(lock, 'utf8')).toBe(theirs);
    fs.rmSync(lock, { force: true });
  });
});

describe('R-J: a write that fails is never reported as a damaged marker, and never answered with "delete it"', () => {
  it.skipIf(!canDenyReads)('finalizing an idle session over an unwritable holds folder is HOLDS_UNWRITABLE, and the note is not imported once it is writable', () => {
    const dir = dirWith({});
    markPrivateSession({ sessionId: 'sess-fz', dirs: [dir], dir, now: Date.now() - 1000 } as Parameters<typeof markPrivateSession>[0]);
    fs.writeFileSync(path.join(dir, 'secret.md'), note('note_fz_secret', 'FZSECRET'));
    ni.renewPrivateSession('sess-fz', Date.now() + 1000);
    fs.mkdirSync(holdsDir(), { recursive: true });
    fs.chmodSync(holdsDir(), 0o500);
    let code: string | undefined;
    try { ingestNoteDirectory({ dir, now: Date.now() + PRIVATE_WINDOW_MS + 60_000 }); } catch (err) { code = (err as { code?: string }).code; } finally { fs.chmodSync(holdsDir(), 0o700); }
    expect(code).toBe(ni.NOTE_HOLDS_UNWRITABLE);
    ingestNoteDirectory({ dir, now: Date.now() + PRIVATE_WINDOW_MS + 60_000 });
    expect(names()).not.toContain('note_fz_secret');
    expect(SKIP_REASONS.noteMarkersUnreadable).not.toContain('ends the wait');
    expect(SKIP_REASONS.noteHoldsUnwritable).not.toMatch(/delet/);
  });
});

describe('R-K: a damaged marker of a private session is not taken for none', () => {
  it('is never overwritten as if absent; rebuilding it starts no later than asked (Q6_05 damaged-own, M23 both ways)', () => {
    const dir = dirWith({});
    markPrivateSession({ sessionId: 'sess-d', dirs: [dir], dir, now: Date.now() - 5000 } as Parameters<typeof markPrivateSession>[0]);
    fs.writeFileSync(path.join(markersDir(), 'sess-d.json'), '{ damaged');
    let code: string | undefined;
    try { markPrivateSession({ sessionId: 'sess-d', dirs: [dir], dir } as Parameters<typeof markPrivateSession>[0]); } catch (err) { code = (err as { code?: string }).code; }
    expect(code).toBe(ni.NOTE_MARKERS_UNREADABLE);
    expect(fs.readFileSync(path.join(markersDir(), 'sess-d.json'), 'utf8')).toBe('{ damaged');
    const from = Date.now() - PRIVATE_WINDOW_MS;
    expect(markPrivateSession({ sessionId: 'sess-d', dirs: [dir], rebuildFrom: from })).toBeLessThanOrEqual(from);
  });
});

describe('R-M: a held note that could not be read keeps its folder waiting', () => {
  it.skipIf(!canDenyReads)('stays out after it is made readable and renamed (Q6_08 N4)', () => {
    const dir = dirWith({ 'secret.md': note('note_unread_secret', 'UNREADSECRET body.') });
    const file = path.join(dir, 'secret.md');
    fs.chmodSync(file, 0o000);
    try { expect(holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [file] })).toBe(1); } finally { fs.chmodSync(file, 0o644); }
    fs.renameSync(file, path.join(dir, 'renamed.md'));
    expect(ingestNoteDirectory({ dir }).created).toEqual([]);
    expect(names()).not.toContain('note_unread_secret');
  });

  it.skipIf(!canDenyReads)('while it cannot be read, every note changed in its folder since waits; once read, the wait ends', () => {
    const dir = dirWith({ 'secret.md': note('note_unread2', 'S.') });
    const file = path.join(dir, 'secret.md');
    fs.chmodSync(file, 0o000);
    try {
      holdOutNoteFiles({ dir, sessionId: 'sess-2', paths: [file] });
      fs.writeFileSync(path.join(dir, 'later.md'), note('note_later2', 'L.'));
      expect(ingestNoteDirectory({ dir }).pendingPrivate).toBeGreaterThan(0);
      expect(names()).not.toContain('note_later2');
    } finally { fs.chmodSync(file, 0o644); }
    ingestNoteDirectory({ dir });
    expect(names()).toContain('note_later2');
    expect(names()).not.toContain('note_unread2');
  });
});

describe('Q6_08 gaps', () => {
  it('N3: sinceMs holds a note moved in with an old modification time (mv, cp -p)', () => {
    const dir = dirWith({});
    const since = Date.now() - 1000;
    const file = path.join(dir, 'moved.md');
    fs.writeFileSync(file, note('note_moved', 'Moved body.'));
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(file, old, old);
    expect(holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [], sinceMs: since })).toBe(1);
    expect(ingestNoteDirectory({ dir }).created).toEqual([]);
  });

  it('N5: a note named with another letter case than on disk is held by its content', () => {
    const dir = dirWith({ 'a.md': note('note_case_secret', 'CASESECRET body.') });
    const named = path.join(dir, 'A.md');
    if (!fs.existsSync(named)) return; // a case-sensitive disk has no such file to name
    expect(holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [named] })).toBe(1);
    expect(ingestNoteDirectory({ dir }).created).toEqual([]);
  });

  it('N6: a tentative part with no start time is a damaged record', () => {
    const dir = dirWith({ 'a.md': note('note_n6', 'A body.') });
    fs.mkdirSync(holdsDir(), { recursive: true });
    fs.writeFileSync(path.join(holdsDir(), 'sess-bad.json'), JSON.stringify({ v: 2, rev: 1, session: 's', firm: {}, tentative: { reason: 'r', updatedAt: 1, holdsAt: 1, projectsRoot: '', dirs: {} } }));
    let code: string | undefined;
    try { ingestNoteDirectory({ dir }); } catch (err) { code = (err as { code?: string }).code; }
    expect(code).toBe(ni.NOTE_HOLDS_UNREADABLE);
  });

  it('M16b: a note over the size limit is not read into memory to be held', () => {
    const dir = dirWith({});
    const big = path.join(dir, 'big.md');
    fs.writeFileSync(big, note('note_big', 'x'.repeat(300 * 1024)));
    const spy = vi.spyOn(fs, 'readFileSync');
    try { expect(holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [big] })).toBe(0); }
    finally { expect(spy.mock.calls.some(([p]) => String(p) === big || String(p) === fs.realpathSync(big))).toBe(false); spy.mockRestore(); }
  });
});

describe('surviving mutants of Q6_05 and Q6_09', () => {
  const at = (file: string, ms: number) => fs.utimesSync(file, new Date(ms), new Date(ms));
  it('two live markers in one folder: a note changed between the earlier and the later wait start waits (Math.min)', () => {
    const dir = dirWith({});
    const now = Date.now();
    markPrivateSession({ sessionId: 'early', dirs: [dir], now: now - 60_000 });
    markPrivateSession({ sessionId: 'late', dirs: [dir], now: now + 60_000 });
    fs.writeFileSync(path.join(dir, 'between.md'), note('note_between', 'B.'));
    expect(ingestNoteDirectory({ dir }).pendingPrivate).toBe(1);
    expect(names()).not.toContain('note_between');
  });

  it('a private-sessions path that is a plain file stops import with MARKERS_DIR_UNREADABLE', () => {
    const dir = dirWith({ 'a.md': note('note_md', 'A.') });
    fs.mkdirSync(path.dirname(markersDir()), { recursive: true });
    fs.writeFileSync(markersDir(), 'a file');
    let code: string | undefined;
    try { ingestNoteDirectory({ dir }); } catch (err) { code = (err as { code?: string }).code; } finally { fs.rmSync(markersDir(), { force: true }); }
    expect(code).toBe(ni.NOTE_MARKERS_DIR_UNREADABLE);
    expect(names()).not.toContain('note_md');
  });

  it.each([
    ['a marker without a session field', { v: 2, dirs: [], projectsRoot: '', startedAt: 1, updatedAt: 1, holdsAt: 1 }],
    ['a marker that is an empty object', {}],
  ])('%s stops import as MARKERS_UNREADABLE', (_label, body) => {
    const dir = dirWith({ 'a.md': note('note_bad_marker', 'A.') });
    fs.mkdirSync(markersDir(), { recursive: true });
    fs.writeFileSync(path.join(markersDir(), 'bad.json'), JSON.stringify(body));
    let code: string | undefined;
    try { ingestNoteDirectory({ dir }); } catch (err) { code = (err as { code?: string }).code; }
    expect(code).toBe(ni.NOTE_MARKERS_UNREADABLE);
  });

  it('finalizing over a damaged own hold record reports HOLDS_UNREADABLE, never a marker error', () => {
    const dir = dirWith({ 'a.md': note('note_fh', 'A.') });
    markPrivateSession({ sessionId: 'sess-h', dirs: [dir], now: Date.now() - 1000 });
    fs.mkdirSync(holdsDir(), { recursive: true });
    fs.writeFileSync(path.join(holdsDir(), 'sess-h.json'), '{ damaged');
    let code: string | undefined;
    try { ingestNoteDirectory({ dir, now: Date.now() + PRIVATE_WINDOW_MS + 60_000 }); } catch (err) { code = (err as { code?: string }).code; }
    expect(code).toBe(ni.NOTE_HOLDS_UNREADABLE);
  });

  it('a renewed marker (startedAt < updatedAt) finalizes from startedAt and waits from holdsAt', () => {
    const dir = dirWith({});
    const start = Date.now() - 10_000;
    markPrivateSession({ sessionId: 'sess-ren', dirs: [dir], now: start });
    const between = path.join(dir, 'between.md');
    fs.writeFileSync(between, note('note_ren', 'R.'));
    ni.renewPrivateSession('sess-ren', Date.now() + 5_000);
    expect(ingestNoteDirectory({ dir }).pendingPrivate, 'waits: changed after holdsAt (= startedAt)').toBe(1);
    expect(ingestNoteDirectory({ dir, now: Date.now() + PRIVATE_WINDOW_MS + 60_000 }).created).toEqual([]);
    expect(names()).not.toContain('note_ren');
    void at;
  });

  it('a note touched exactly at holdsAt waits (>=)', () => {
    const dir = dirWith({});
    const file = path.join(dir, 'edge.md');
    fs.writeFileSync(file, note('note_edge', 'E.'));
    const st = fs.statSync(file);
    markPrivateSession({ sessionId: 'sess-edge', dirs: [dir], now: Math.max(st.mtimeMs, st.ctimeMs) });
    expect(ingestNoteDirectory({ dir }).pendingPrivate).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('marker and hold files are 0600 and their folders 0700', () => {
    const dir = dirWith({ 'a.md': note('note_mode', 'A.') });
    const umask = process.umask(0o022); // the usual umask, so only the mode the writer asks for can make the file private
    try {
      markPrivateSession({ sessionId: 'sess-m', dirs: [dir] });
      holdOutNoteFiles({ dir, sessionId: 'sess-m', paths: [path.join(dir, 'a.md')] });
    } finally { process.umask(umask); }
    expect(fs.statSync(path.join(markersDir(), 'sess-m.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(holdsDir(), 'sess-m.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(markersDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(holdsDir()).mode & 0o777).toBe(0o700);
  });

  it('a hold whose tentative transcript is not a string is HOLDS_UNREADABLE (Q6_06 M4c)', () => {
    const dir = dirWith({ 'a.md': note('note_m4c', 'A.') });
    fs.mkdirSync(holdsDir(), { recursive: true });
    fs.writeFileSync(path.join(holdsDir(), 's.json'), JSON.stringify({ v: 2, rev: 1, session: 's', transcript: 7, firm: {} }));
    let code: string | undefined;
    try { ingestNoteDirectory({ dir }); } catch (err) { code = (err as { code?: string }).code; }
    expect(code).toBe(ni.NOTE_HOLDS_UNREADABLE);
  });

  it('a renew during finalization keeps the newer updatedAt (the finalizer writes only the marker it read)', () => {
    const dir = dirWith({});
    markPrivateSession({ sessionId: 'sess-rf', dirs: [dir], now: Date.now() - 1000 });
    const file = path.join(markersDir(), 'sess-rf.json');
    const later = Date.now() + PRIVATE_WINDOW_MS + 60_000;
    const realRead = fs.readFileSync;
    let renewed = false;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const out = (realRead as (...a: unknown[]) => unknown)(p, ...rest);
      // Right after the finalizer first reads the marker, the session's user comes back.
      if (!renewed && String(p) === file && new Error().stack?.includes('readAllMarkers')) { renewed = true; spy.mockRestore(); ni.renewPrivateSession('sess-rf', later - 1000); }
      return out;
    }) as typeof fs.readFileSync);
    try { ingestNoteDirectory({ dir, now: later }); } finally { spy.mockRestore(); }
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(marker.finalizedAt).toBeUndefined();
    expect(marker.updatedAt).toBe(later - 1000);
  });

  it('removes a temporary file a crashed writer left in either folder, and keeps a fresh one', () => {
    for (const dir of [markersDir(), holdsDir()]) fs.mkdirSync(dir, { recursive: true });
    const old = Date.now() - 10 * 60_000;
    const files = [markersDir(), holdsDir()].flatMap((dir) => ['a.json.111.tmp', 'b.json.222.tmp'].map((n) => path.join(dir, n)));
    for (const f of files) fs.writeFileSync(f, '{}');
    for (const f of files.filter((f) => f.includes('a.json'))) fs.utimesSync(f, new Date(old), new Date(old));
    ni.removeStalePrivateStateTemps();
    expect(files.filter((f) => fs.existsSync(f)).map((f) => path.basename(f))).toEqual(['b.json.222.tmp', 'b.json.222.tmp']);
  });
});

describe('S3 follow-up: held notes, the per-run cap, and a private session that comes back', () => {
  it('R-N: held notes sorting first do not use the per-run cap: an ordinary note behind them imports at the first run (Q6_07 F3 PROBE cap)', () => {
    const dir = dirWith({ 'a1.md': note('n_a1', 'S1'), 'a2.md': note('n_a2', 'S2'), 'a3.md': note('n_a3', 'S3') });
    holdOutNoteFiles({ dir, sessionId: 'S', paths: ['a1.md', 'a2.md', 'a3.md'].map((f) => path.join(dir, f)) });
    fs.writeFileSync(path.join(dir, 'z.md'), note('n_z', 'ordinary'));
    const run = ingestNoteDirectory({ dir, maxFiles: 2 });
    expect(run.created).toEqual(['n_z']);
    expect(run.held.private).toBe(3);
    expect(run.more).toBe(0);
  });

  it('R-N: a held note is not read again while it is unchanged and still held, and is read and imported once released', () => {
    const dir = dirWith({ 'held.md': note('n_held', 'HELD') });
    const held = path.join(dir, 'held.md');
    const notAFile = path.join(fixture.tmpDir, 'r-n-folder.jsonl'); // a transcript path that is a folder: the session stays unchecked
    fs.mkdirSync(notAFile, { recursive: true });
    holdOutNoteFiles({ dir, sessionId: 'S2', paths: [held], ...tentative('unreadable', notAFile), tentative: { reason: 'unreadable', holdsAt: Date.now() + 60_000 } });
    const reads = (fn: () => void): number => {
      const real = fs.readFileSync;
      let count = 0;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => { if (String(p).endsWith(`${path.sep}held.md`)) count++; return (real as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof fs.readFileSync);
      try { fn(); } finally { spy.mockRestore(); }
      return count;
    };
    expect(reads(() => expect(ingestNoteDirectory({ dir }).held.unchecked).toBe(1)), 'read once, to know it is held').toBe(1);
    expect(reads(() => expect(ingestNoteDirectory({ dir }).held.unchecked).toBe(1)), 'the fingerprint: not read again').toBe(0);
    expect(ni.settleTentativeHolds('S2', 'no')).toBe(true);
    expect(reads(() => ingestNoteDirectory({ dir })), 'released: read like any other file').toBe(1);
    expect(names()).toContain('n_held');
  });

  it('a private session resumed after its SessionEnd keeps the others waiting: a note it writes before its next Stop is not imported (Q6_15 F1)', () => {
    const dir = dirWith({ 'early.md': note('n_early', 'PRIVATE early') });
    markPrivateSession({ sessionId: 'P', dirs: [dir], now: Date.now() - 60_000 });
    holdOutNoteFiles({ dir, sessionId: 'P', paths: [path.join(dir, 'early.md')] });
    ni.endPrivateSession('P');
    expect(ni.renewPrivateSession('P'), 'the marker is still there to renew').toBe(true);
    fs.writeFileSync(path.join(dir, 'after.md'), note('after_resume', 'PRIVATE after resume'));
    const run = ingestNoteDirectory({ dir }); // another session's import, before the private session's next Stop
    expect(run.pendingPrivate, 'the notes changed since its holds wait').toBeGreaterThan(0);
    expect(names()).not.toContain('after_resume');
    expect(names()).not.toContain('n_early');
  });

  it('a finalized marker renewed by a prompt and idle again holds what was written after the renewal (Q6_15 F4)', () => {
    const dir = dirWith({});
    const t0 = Date.now() - 60_000;
    markPrivateSession({ sessionId: 'F', dirs: [dir], now: t0 });
    const later = Date.now() + PRIVATE_WINDOW_MS + 60_000;
    ingestNoteDirectory({ dir, now: later }); // idle for the window: finalized
    expect(JSON.parse(fs.readFileSync(path.join(markersDir(), 'F.json'), 'utf8')).finalizedAt, 'held up to its last activity').toBe(t0);
    expect(ni.renewPrivateSession('F', later)).toBe(true); // its user writes a prompt again
    expect(JSON.parse(fs.readFileSync(path.join(markersDir(), 'F.json'), 'utf8')).finalizedAt, 'renewing makes it live again').toBeUndefined();
    fs.writeFileSync(path.join(dir, 'late.md'), note('n_late', 'PRIVATE written after the renewal'));
    ingestNoteDirectory({ dir, now: later + PRIVATE_WINDOW_MS + 60_000 }); // idle again: finalized again, from its start to its last sign of life
    expect(names()).not.toContain('n_late');
  });

  it('the six-hour window: a marker silent for five hours still waits; one silent for seven is finalized (Q6_16 F2, M14)', () => {
    const dir = dirWith({});
    markPrivateSession({ sessionId: 'W', dirs: [dir], now: Date.now() - 1000 });
    fs.writeFileSync(path.join(dir, 'w.md'), note('n_w', 'PRIVATE'));
    const t0 = Date.now() + 1000; // its last sign of life, after the note
    markPrivateSession({ sessionId: 'W', dirs: [dir], now: t0 });
    const marker = () => JSON.parse(fs.readFileSync(path.join(markersDir(), 'W.json'), 'utf8'));
    expect(ingestNoteDirectory({ dir, now: t0 + 5 * 3600_000 }).pendingPrivate, 'five hours: still live').toBe(1);
    expect(marker().finalizedAt).toBeUndefined();
    ingestNoteDirectory({ dir, now: t0 + 7 * 3600_000 });
    expect(marker().finalizedAt, 'seven hours: gone, held up to its last activity').toBe(t0);
    expect(names()).not.toContain('n_w');
  });

  it.skipIf(!canDenyReads)('a holds or markers folder that cannot be listed is said in doctor\'s summary, not dropped (doctor `catch { return null; }`, Q6_24 N7)', () => {
    for (const dir of [markersDir(), holdsDir()]) { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o000); }
    try {
      expect(ni.summarizeNoteHolds().unreadableFolders.sort()).toEqual(['holds', 'markers']);
    } finally { for (const dir of [markersDir(), holdsDir()]) fs.chmodSync(dir, 0o700); }
    expect(ni.summarizeNoteHolds().unreadableFolders).toEqual([]);
  });
});

describe('S3 review 3b: what a private session wrote stays out', () => {
  const idle = () => Date.now() - PRIVATE_WINDOW_MS - 3_600_000;
  const aged = (file: string, ms: number) => { fs.utimesSync(file, new Date(ms), new Date(ms)); return file; };
  const markerAt = (id: string) => JSON.parse(fs.readFileSync(path.join(markersDir(), `${id}.json`), 'utf8'));

  it('B: a finalized session that writes its transcript again, with no prompt in between, keeps other imports waiting (G01 F7, G02 F3, G06 F5)', () => {
    const dir = dirWith({});
    const transcript = path.join(fixture.tmpDir, 'b-sess.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const old = idle();
    aged(transcript, old);
    markPrivateSession({ sessionId: 'sess-b', dirs: [dir], transcript, now: old });
    ingestNoteDirectory({ dir }); // idle past the window: finalized
    expect(markerAt('sess-b').finalizedAt).toBeDefined();
    fs.appendFileSync(transcript, '{}\n'); // the session runs again: no UserPromptSubmit
    fs.writeFileSync(path.join(dir, 'after.md'), note('n_after_finalize', 'PRIVATE written after the finalize'));
    expect(ingestNoteDirectory({ dir }).pendingPrivate).toBe(1);
    expect(names()).not.toContain('n_after_finalize');
  });

  it('B: a marker renewed while it is being finalized keeps the import waiting (G03 #7)', () => {
    const dir = dirWith({});
    markPrivateSession({ sessionId: 'sess-b7', dirs: [dir], now: Date.now() - 1000 });
    fs.writeFileSync(path.join(dir, 'b7.md'), note('n_b7', 'PRIVATE written as it came back'));
    const file = path.join(markersDir(), 'sess-b7.json');
    const later = Date.now() + PRIVATE_WINDOW_MS + 60_000;
    const realRead = fs.readFileSync;
    let renewed = false;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const out = (realRead as (...a: unknown[]) => unknown)(p, ...rest);
      if (!renewed && String(p) === file && new Error().stack?.includes('readAllMarkers')) { renewed = true; spy.mockRestore(); ni.renewPrivateSession('sess-b7', later - 1000); }
      return out;
    }) as typeof fs.readFileSync);
    let run: ReturnType<typeof ingestNoteDirectory> | undefined;
    try { run = ingestNoteDirectory({ dir, now: later }); } finally { spy.mockRestore(); }
    expect(run?.pendingPrivate).toBe(1);
    expect(names()).not.toContain('n_b7');
  });

  it.skipIf(!canDenyReads)('C: a subfolder of a notes folder that cannot be listed stops the holds, it is not "no notes" (G02 F2, G03 #1)', () => {
    const dir = dirWith({});
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'secret.md'), note('n_sub_secret', 'PRIVATE in a subfolder'));
    fs.chmodSync(sub, 0o000);
    let code: string | undefined;
    try { holdOutNoteFiles({ dir, sessionId: 'sess-c', paths: [], sinceMs: Date.now() - 60_000 }); } catch (err) { code = (err as { code?: string }).code; } finally { fs.chmodSync(sub, 0o755); }
    expect(code).toBe('MEMESH_NOTE_FOLDER_UNREADABLE');
  });

  it.skipIf(!canDenyReads)('C: a named note under a folder that cannot be searched stops the holds (G02 F2 :605)', () => {
    const dir = dirWith({});
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'named.md'), note('n_named_secret', 'PRIVATE'));
    fs.chmodSync(sub, 0o000);
    let code: string | undefined;
    try { holdOutNoteFiles({ dir, sessionId: 'sess-c2', paths: [path.join(sub, 'named.md')] }); } catch (err) { code = (err as { code?: string }).code; } finally { fs.chmodSync(sub, 0o755); }
    expect(code).toBe('MEMESH_NOTE_FOLDER_UNREADABLE');
  });

  it('E: every notes folder of the projects root is held when an idle session is finalized, past two hundred of them (G01 F1)', () => {
    const own = dirWith({});
    const folders = [own, ...Array.from({ length: 205 }, () => dirWith({}))];
    markPrivateSession({ sessionId: 'sess-e', dirs: [own], now: Date.now() - 1000 });
    folders.forEach((dir, i) => fs.writeFileSync(path.join(dir, 'e.md'), note(`n_e_${i}`, `PRIVATE ${i}`)));
    ni.renewPrivateSession('sess-e', Date.now() + 1000);
    const later = Date.now() + PRIVATE_WINDOW_MS + 60_000;
    ingestNoteDirectory({ dir: own, now: later }); // finalized: every folder of its root is held up to its last activity
    expect(markerAt('sess-e').finalizedAt).toBeDefined();
    for (const dir of folders) ingestNoteDirectory({ dir, now: later });
    expect(names().filter((name) => name.startsWith('n_e_'))).toEqual([]);
  }, 120_000);

  it('F: a held note copied into another notes folder, even under another projects root, stays out (G01 F2)', () => {
    const dir = dirWith({ 'secret.md': note('n_copied_secret', 'PRIVATE copied') });
    holdOutNoteFiles({ dir, sessionId: 'sess-f1', paths: [path.join(dir, 'secret.md')] });
    const elsewhere = path.join(fixture.tmpDir, 'other-root', 'p', 'memory');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.copyFileSync(path.join(dir, 'secret.md'), path.join(elsewhere, 'copy.md'));
    const sibling = dirWith({});
    fs.copyFileSync(path.join(dir, 'secret.md'), path.join(sibling, 'copy.md'));
    ingestNoteDirectory({ dir: elsewhere });
    ingestNoteDirectory({ dir: sibling });
    expect(names()).not.toContain('n_copied_secret');
  });

  it('F: a note held, rewritten and held again keeps both contents out (G01 F3)', () => {
    const dir = dirWith({ 'a.md': note('n_first_version', 'PRIVATE first') });
    const first = fs.readFileSync(path.join(dir, 'a.md'));
    holdOutNoteFiles({ dir, sessionId: 'sess-f2', paths: [path.join(dir, 'a.md')] });
    fs.writeFileSync(path.join(dir, 'a.md'), note('n_second_version', 'PRIVATE second'));
    holdOutNoteFiles({ dir, sessionId: 'sess-f2', paths: [path.join(dir, 'a.md')] });
    fs.writeFileSync(path.join(dir, 'restored.md'), first); // a backup, a checkout, a sync conflict brings the first back
    ingestNoteDirectory({ dir });
    expect(names()).not.toContain('n_first_version');
    expect(names()).not.toContain('n_second_version');
  });

  it.skipIf(!canDenyReads)('F: a held note that could not be read is not resolved by what is at its path later (G03 #4)', () => {
    const dir = dirWith({ 'secret.md': note('n_unread_original', 'PRIVATE original') });
    const file = path.join(dir, 'secret.md');
    fs.chmodSync(file, 0o000);
    try { holdOutNoteFiles({ dir, sessionId: 'sess-f3', paths: [file] }); } finally { fs.chmodSync(file, 0o644); }
    fs.copyFileSync(file, path.join(dir, 'copy.md'));
    fs.writeFileSync(file, note('n_unread_edited', 'edited in place'));
    ingestNoteDirectory({ dir });
    expect(names()).not.toContain('n_unread_original');
  });

  it('G: a session that could not be checked and went idle has its notes held in every folder, whichever is imported first (G03 #2)', () => {
    const [a, b] = [dirWith({}), dirWith({})];
    const root = path.dirname(path.dirname(fs.realpathSync(a))); // as the hooks record it
    const transcript = path.join(fixture.tmpDir, 'g-unchecked.jsonl'); // a folder: the session stays unchecked
    fs.mkdirSync(transcript, { recursive: true });
    const old = idle();
    for (const dir of [a, b]) {
      fs.writeFileSync(path.join(dir, 'g.md'), note(`n_g_${path.basename(path.dirname(dir))}`, 'written while unchecked'));
      aged(path.join(dir, 'g.md'), old - 30_000);
    }
    holdOutNoteFiles({ dir: a, sessionId: 'sess-g', paths: [], transcript, tentative: { reason: 'unreadable', projectsRoot: root, holdsAt: old - 60_000 }, now: old - 60_000 });
    aged(transcript, old);
    ingestNoteDirectory({ dir: a });
    ingestNoteDirectory({ dir: b });
    expect(names().filter((name) => name.startsWith('n_g_'))).toEqual([]);
  });

  it('O: a Codex private session waits imports under Claude Code\'s projects root even when it named another root (CLAUDE_CONFIG_DIR set on one side only; G06 F4)', () => {
    const dir = dirWith({});
    const rollout = path.join(fixture.tmpDir, 'codex', 'sessions', 'rollout-2026-11-11T00-00-00-0000.jsonl');
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, '{}\n');
    markPrivateSession({ sessionId: 'sess-codex', projectsRoot: path.join(fixture.tmpDir, 'not-the-claude-root'), transcript: rollout, now: Date.now() - 1000 });
    fs.writeFileSync(path.join(dir, 'codex.md'), note('n_codex_written', 'PRIVATE from Codex'));
    expect(ingestNoteDirectory({ dir }).pendingPrivate).toBe(1);
    expect(names()).not.toContain('n_codex_written');
  });

  it('G: a note the idle session wrote and someone renamed later is still held when it is finalized (G03 #3)', () => {
    const dir = dirWith({});
    const transcript = path.join(fixture.tmpDir, 'g2.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const old = idle();
    markPrivateSession({ sessionId: 'sess-g2', dirs: [dir], transcript, now: old - 60_000 });
    aged(transcript, old);
    const written = path.join(dir, 'written.md');
    fs.writeFileSync(written, note('n_renamed_later', 'PRIVATE renamed'));
    aged(written, old - 30_000);
    fs.renameSync(written, path.join(dir, 'renamed.md')); // the change time moves past the session's last activity
    ingestNoteDirectory({ dir });
    expect(names()).not.toContain('n_renamed_later');
  });
});
