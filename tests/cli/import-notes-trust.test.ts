import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

const CLI = path.resolve('dist/transports/cli/cli.js');

// `memesh import --notes <folder>`: notes from a folder are untrusted unless the
// person says the folder is their own, behind the same confirmation `--trust`
// has for a JSON backup.
describe('Feature: import --notes --trust', () => {
  let home: string;
  let dir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-notes-trust-'));
    dir = path.join(home, 'notes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), '---\nname: cli_note\ndescription: "CLI note"\nmetadata: \n  node_type: memory\n  type: feedback\n---\n\nSome text.\n');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const run = (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of ['MEMESH_DIR', 'MEMESH_DB_PATH']) delete env[key];
    return spawnSync('node', [CLI, 'import', '--notes', dir, '--project', 'p', ...args], { env, encoding: 'utf8', input: '', timeout: 60000 });
  };
  function stored(): { trust?: string } | null {
    const file = path.join(home, '.memesh', 'knowledge-graph.db');
    if (!fs.existsSync(file)) return null;
    const db = new MemeshDatabase(file, { readOnly: true });
    try {
      const row = db.prepare("SELECT metadata FROM entities WHERE name = 'cli_note'").get() as { metadata: string } | undefined;
      return row ? JSON.parse(row.metadata) : null;
    } finally {
      db.close();
    }
  }

  it('without --trust the notes are stored untrusted and the output says so', () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('stored as untrusted');
    expect(stored()?.trust).toBe('untrusted');
  });

  it('--trust with --yes stores them trusted', () => {
    const r = run('--trust', '--yes');
    expect(r.status, r.stderr).toBe(0);
    expect(stored()?.trust).toBe('trusted');
  });

  it('--trust with no terminal and no --yes writes nothing and names the command to re-run', () => {
    const r = run('--trust');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not a terminal and --yes not given — nothing was changed');
    expect(r.stderr).toContain('--trust --yes');
    expect(stored()).toBeNull();
  });

  it('--yes without --trust is refused', () => {
    const r = run('--yes');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--yes only applies with --trust');
    expect(stored()).toBeNull();
  });
});
