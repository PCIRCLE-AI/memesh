import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { expect } from 'vitest';

/**
 * Turn the SQLite file at `file` into a rollback-journal database that a crash left with a half-done transaction
 * (a "hot" journal): a child process starts a transaction that touches many pages, is killed before it commits,
 * and leaves `<file>-journal` behind with the bytes needed to undo it. Reading such a file without rolling the
 * journal back shows changes that were never committed.
 */
export function leaveHotJournal(file: string): void {
  const setup = new DatabaseSync(file);
  setup.exec('PRAGMA journal_mode = DELETE');
  setup.exec('CREATE TABLE junk (v TEXT)');
  setup.exec('BEGIN');
  const insert = setup.prepare('INSERT INTO junk VALUES (?)');
  for (let i = 0; i < 4000; i += 1) insert.run('x'.repeat(200));
  setup.exec('COMMIT');
  setup.close();
  spawnSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(process.argv[1]);
    d.exec('PRAGMA cache_size = 10');
    d.exec('BEGIN');
    d.exec("UPDATE junk SET v = 'CHANGED' || substr(v, 8)");
    process.kill(process.pid, 'SIGKILL');
  `, file]);
  expect(fs.statSync(`${file}-journal`).size, 'the crash left no journal: this is not the state under test').toBeGreaterThan(0);
}
