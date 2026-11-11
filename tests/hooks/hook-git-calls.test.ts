/**
 * The git processes one hook run spawns, counted through a PATH shim (no clock, so load does
 * not make it flaky). Each git call can take over a second on a slow disk, and the hooks have
 * 5 s (pre-edit) and 10 s (Stop): the counts must not grow past what they were before the
 * project ids covered a checkout's earlier ids (pre-edit 2 with a remote, 4 without one, 3
 * outside a repository; Stop 1 with a remote, 3 without), from the session's directory or a
 * subdirectory of it. Each run must reach git at least once, or a hook that returned early
 * would pass for nothing.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const slug = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-');
type Kind = 'remote' | 'no remote' | 'plain directory';

function world(kind: Kind) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-gitcalls-')));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(home, 'git-calls.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const repo = path.join(home, kind === 'plain directory' ? 'plain' : 'repo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  if (kind !== 'plain directory') execFileSync(realGit, ['-C', repo, 'init', '-q']);
  if (kind === 'remote') execFileSync(realGit, ['-C', repo, 'remote', 'add', 'origin', 'git@gitlab.com:acme/widgets.git']);
  const memesh = path.join(home, '.memesh');
  fs.mkdirSync(memesh);
  fs.writeFileSync(path.join(memesh, 'config.json'), JSON.stringify({ updateCheck: false, autoUpdate: 'off' }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: memesh, MEMESH_AUTO_UPDATE: '0', PATH: `${bin}:${process.env.PATH}` };
  delete env.MEMESH_DB_PATH;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { home, repo, memesh, env, calls, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

describe('pre-edit-recall: git processes per unthrottled edit', () => {
  it.each([['remote', 2], ['no remote', 4], ['plain directory', 3]] as const)('%s: at most %i', (kind, most) => {
    const w = world(kind);
    try {
      const dbPath = path.join(w.home, 'test.db');
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, metadata JSON, status TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id INTEGER NOT NULL, content TEXT NOT NULL);
        CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id INTEGER NOT NULL, tag TEXT NOT NULL);`);
      db.close();
      const r = spawnSync('node', [path.resolve('scripts/hooks/pre-edit-recall.js')], {
        input: JSON.stringify({ cwd: w.repo, session_id: 's', tool_input: { file_path: path.join(w.repo, 'auth.ts') } }),
        env: { ...w.env, MEMESH_DB_PATH: dbPath }, encoding: 'utf8', timeout: 30000,
      });
      expect(r.status, r.stderr).toBe(0);
      const calls = w.calls();
      expect(calls.length, calls.join('\n')).toBeGreaterThanOrEqual(1);
      expect(calls.length, calls.join('\n')).toBeLessThanOrEqual(most);
    } finally { w.done(); }
  });
});

describe('Stop (session-summary): git processes per run', () => {
  it.each([['remote', false, 1], ['remote', true, 1], ['no remote', false, 3], ['no remote', true, 3]] as const)(
    '%s, from a subdirectory: %s, at most %i', (kind, inSub, most) => {
      const w = world(kind);
      try {
        const cwd = inSub ? path.join(w.repo, 'sub') : w.repo;
        const folder = path.join(w.home, '.claude', 'projects', slug(w.repo));
        fs.mkdirSync(path.join(folder, 'memory'), { recursive: true });
        fs.writeFileSync(path.join(folder, 'memory', 'a.md'), '---\nname: feedback-a\ndescription: d\nmetadata:\n  type: feedback\n---\nPrefer small diffs\n');
        const transcript = path.join(folder, 's.jsonl');
        fs.writeFileSync(transcript, [
          { type: 'user', cwd: w.repo, sessionId: 's', message: { role: 'user', content: 'please fix the widget' } },
          { type: 'assistant', cwd, sessionId: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed the widget.' }] } },
        ].map((l) => JSON.stringify(l)).join('\n') + '\n');
        const r = spawnSync('node', [path.resolve('scripts/hooks/session-summary.js')], {
          input: JSON.stringify({ cwd, session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' }),
          env: w.env, encoding: 'utf8', timeout: 60000,
        });
        expect(r.status, r.stderr).toBe(0);
        // The folder was read (the same-project answer was reached, not skipped).
        const outcomes = fs.readFileSync(path.join(w.memesh, 'hook-outcomes.jsonl'), 'utf8');
        expect(outcomes).toMatch(/"hook":"note-ingest"[^\n]*1 created/);
        const calls = w.calls();
        expect(calls.length, calls.join('\n')).toBeGreaterThanOrEqual(1);
        expect(calls.length, calls.join('\n')).toBeLessThanOrEqual(most);
      } finally { w.done(); }
    });
});
