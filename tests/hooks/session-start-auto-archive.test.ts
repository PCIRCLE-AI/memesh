import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { AUTO_CAPTURE_TAG } from '../../src/core/types.js';

const HOOK = path.resolve('scripts/hooks/session-start.js');
const CLI = path.resolve('dist/transports/cli/cli.js');
const DAY = 86_400_000;

// The archiver runs where a real install exercises it: the SessionStart hook,
// in a real process, against a real database in a throwaway HOME.
describe('Feature: session start archives unused auto-captured memories and doctor reports it', () => {
  let home: string;
  let dbPath: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-archive-hook-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
    cwd = path.join(home, 'work', 'proj');
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_UPDATE: '0' };
    for (const key of ['MEMESH_DIR', 'MEMESH_BRIEFING', 'MEMESH_SESSION_LIMIT']) delete e[key];
    return e;
  };

  function seed(): void {
    openDatabase(dbPath);
    try {
      const db = getDatabase();
      const kg = new KnowledgeGraph(db);
      kg.createEntity('commit-aaaaaaa', 'commit', { title: 'old commit', observations: ['fix: old'], tags: [AUTO_CAPTURE_TAG], trustOverride: 'untrusted' });
      kg.createEntity('commit-bbbbbbb', 'commit', { title: 'cited commit', observations: ['fix: cited'], tags: [AUTO_CAPTURE_TAG], trustOverride: 'untrusted' });
      kg.createEntity('why-sqlite', 'decision', { title: 'Use node:sqlite', observations: ['Use node:sqlite', 'Why: native builds broke; revisit if removed'] });
      const old = new Date(Date.now() - 40 * DAY).toISOString();
      db.prepare('UPDATE entities SET created_at = ?').run(old);
      db.prepare('UPDATE observations SET created_at = ?').run(old);
      db.prepare("UPDATE entities SET recall_hits = 3 WHERE name = 'commit-bbbbbbb'").run();
      db.prepare("DELETE FROM memesh_metadata WHERE key = 'last_auto_archive_at'").run();
    } finally {
      closeDatabase();
    }
  }

  const status = (name: string): string => {
    openDatabase(dbPath);
    try {
      return (getDatabase().prepare('SELECT status FROM entities WHERE name = ?').get(name) as { status: string }).status;
    } finally {
      closeDatabase();
    }
  };

  function startSession(id: string) {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ cwd, session_id: id, hook_event_name: 'SessionStart' }),
      env: env(), encoding: 'utf8', timeout: 30000,
    });
    expect(r.status, r.stderr).toBe(0);
    return r;
  }

  function doctorCheck(): { summary: string; status: string } | undefined {
    const r = spawnSync('node', [CLI, 'doctor', '--json'], { env: env(), encoding: 'utf8', timeout: 60000 });
    const report = JSON.parse(r.stdout) as { checks: Array<{ id: string; summary: string; status: string }> };
    return report.checks.find((c) => c.id === 'auto_archive');
  }

  it('archives the old unused auto-captured commit, keeps the cited one and the decision, says so, and doctor shows the run', () => {
    seed();
    expect(doctorCheck()?.summary).toContain('Has not run yet');

    const first = startSession('arch-1');
    expect(first.stderr).toContain('archived 1 auto-captured memory');
    expect(status('commit-aaaaaaa')).toBe('archived');
    expect(status('commit-bbbbbbb')).toBe('active');
    expect(status('why-sqlite')).toBe('active');

    const check = doctorCheck();
    expect(check?.summary).toMatch(/Last run .*: 1 auto-captured memory archived \(1 commit\), unused for 14 days; 1 old one\(s\) kept because a session cited them/);
    expect(check?.summary).toContain('never archived this way');

    // The next session inside the day does nothing and says nothing.
    const second = startSession('arch-2');
    expect(second.stderr).not.toContain('archived');
    expect(second.stdout.length).toBeGreaterThan(0);
  });

  it('a damaged run record is reported as unreadable, not as "has not run yet"', () => {
    seed();
    startSession('arch-damaged');
    openDatabase(dbPath);
    try {
      // A record cut off in the middle, as an interrupted write would leave it.
      getDatabase().prepare("UPDATE memesh_metadata SET value = '{\"at\":\"2026-11-0' WHERE key = 'last_auto_archive_run'").run();
    } finally {
      closeDatabase();
    }
    const check = doctorCheck();
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('Cannot tell when it last ran');
    expect(check?.summary).toContain('unreadable');
    expect(check?.summary).not.toContain('Has not run yet');
  });
});
