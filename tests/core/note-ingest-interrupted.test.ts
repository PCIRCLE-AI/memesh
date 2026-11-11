/**
 * A Stop that is killed while it makes the folder's notes trusted (the hook's time limit, a
 * user's Ctrl-C) leaves nothing behind that stops the next Stop from doing it: the list of
 * notes already made trusted is written in the same transaction as the change, and into the
 * copy before the copy is put in place. Run in a child process that is SIGKILLed at the
 * moment the copy is renamed into place, or while the record beside it is written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { ingestNoteDirectory } from '../../src/core/note-ingest.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

const dist = (rel: string) => pathToFileURL(fileURLToPath(new URL(`../../dist/${rel}`, import.meta.url))).href;
let root: string;
let folder: string;
let dbPath: string;
let previousDir: string | undefined;

const trust = (name: string) => (getDatabase().prepare("SELECT json_extract(metadata, '$.trust') AS t FROM entities WHERE name = ?").get(name) as { t: string }).t;
const ledgers = (db: { prepare: MemeshDatabase['prepare'] }) =>
  (db.prepare("SELECT value FROM memesh_metadata WHERE key LIKE 'note_trust_lifted:%'").all() as Array<{ value: string }>).map((r) => r.value);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-note-killed-')));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = root;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ updateCheck: false }));
  folder = path.join(root, 'memory');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'a.md'), '---\nname: feedback-a\ndescription: d\nmetadata:\n  type: feedback\n---\nPrefer small diffs\n');
  fs.writeFileSync(path.join(folder, 'b.md'), '---\nname: feedback-b\ndescription: d\nmetadata:\n  type: feedback\n---\nSay why\n');
  dbPath = path.join(root, 'kg.db');
  openDatabase(dbPath);
  // Stored before the folder was trusted, as every note was.
  ingestNoteDirectory({ trusted: false, dir: folder, project: 'proj-b' });
  closeDatabase();
});
afterEach(() => {
  try { closeDatabase(); } catch { /* closed */ }
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Run the trusted read in a child that SIGKILLs itself when `fs.<method>` is called on a path matching `pattern`. */
function killedRun(method: 'renameSync' | 'writeFileSync', pattern: string) {
  const preload = path.join(root, 'kill.cjs');
  fs.writeFileSync(preload, `const fs = require('fs'); const orig = fs.${method};
fs.${method} = function (p, ...rest) { if (String(p).includes(${JSON.stringify(pattern)})) process.kill(process.pid, 'SIGKILL'); return orig.call(this, p, ...rest); };\n`);
  const script = `const { openDatabase } = await import(${JSON.stringify(dist('db.js'))});
const { ingestNoteDirectory } = await import(${JSON.stringify(dist('core/note-ingest.js'))});
openDatabase(${JSON.stringify(dbPath)});
ingestNoteDirectory({ dir: ${JSON.stringify(folder)}, project: 'proj-b', trusted: true });
process.stdout.write('finished');`;
  return spawnSync(process.execPath, ['--require', preload, '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: root, MEMESH_DIR: root, MEMESH_DB_PATH: dbPath }, encoding: 'utf8', timeout: 60000,
  });
}

describe('a Stop killed while it makes the folder\'s notes trusted', () => {
  it.each([
    ['while the copy is put in place', 'renameSync', '.partial-'],
    ['while the record beside the copy is written', 'writeFileSync', '.db.json'],
  ] as const)('%s: nothing changed, nothing marks the notes as done, and the next run makes them trusted', (_when, method, pattern) => {
    const killed = killedRun(method, pattern);
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    expect(killed.stdout).not.toContain('finished');
    openDatabase(dbPath);
    expect([trust('feedback-a'), trust('feedback-b')]).toEqual(['untrusted', 'untrusted']);
    expect(ledgers(getDatabase())).toEqual([]);
    const next = ingestNoteDirectory({ dir: folder, project: 'proj-b', trusted: true });
    expect(next.retrustFailed).toBeNull();
    expect(next.retrusted.sort()).toEqual(['feedback-a', 'feedback-b']);
    expect([trust('feedback-a'), trust('feedback-b')]).toEqual(['trusted', 'trusted']);
    expect(ledgers(getDatabase())).toHaveLength(1);
    // The copy of the run that finished holds the same list the database now holds, so
    // restoring it keeps the notes untrusted.
    const copy = new MemeshDatabase(next.retrustBackup!);
    try {
      expect(ledgers(copy)).toEqual(ledgers(getDatabase()));
      expect((copy.prepare("SELECT json_extract(metadata, '$.trust') AS t FROM entities WHERE name = 'feedback-a'").get() as { t: string }).t).toBe('untrusted');
    } finally { copy.close(); }
  });
});
