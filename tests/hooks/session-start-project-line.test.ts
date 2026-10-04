/**
 * SessionStart states this session's exact project id, so an agent can pass
 * it as `project` to remember/learn/recall without guessing — on every exit
 * path, with or without a database, memories or a messaging recipient. It
 * comes only from the cwd the host reported for this session: no cwd, a
 * relative one or a missing directory gives no line, never the hook
 * process's own directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { SKIP_REASONS } from '../../src/core/capture-liveness.js';

const require = createRequire(import.meta.url);
const { getProjectName: mirrorProjectName, sessionProjectLine } = require('../../scripts/hooks/_shared.js');
const hookPath = path.resolve('scripts/hooks/session-start.js');

let root: string;
let dbPath: string;
let dirA: string;
let dirB: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-project-line-')));
  dbPath = path.join(root, 'memesh', 'knowledge-graph.db');
  dirA = path.join(root, 'proj-a');
  dirB = path.join(root, 'proj-b');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
});
afterEach(() => {
  try { closeDatabase(); } catch { /* not open */ }
  removeTempDir(root);
});

function runHook(input: object, env: Record<string, string> = {}) {
  const out = execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    // A minimal environment: no recipient, no host session, no update check.
    env: { PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_UPDATE: '0', ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  const parsed = JSON.parse(out.trim()) as { systemMessage: string; hookSpecificOutput?: { additionalContext?: string } };
  return { ...parsed, context: parsed.hookSpecificOutput?.additionalContext ?? '' };
}
const lineFor = (dir: string): string => sessionProjectLine(mirrorProjectName(dir));
const outcomes = () => {
  const file = path.join(path.dirname(dbPath), 'hook-outcomes.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

describe('the project line', () => {
  it('appears with no database yet, and with no messaging recipient', () => {
    const out = runHook({ cwd: dirA });
    expect(out.context.startsWith(lineFor(dirA))).toBe(true);
    expect(out.context).toContain('project: false for a memory that belongs to no project');
    expect(out.context).not.toContain('messaging address');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('appears for an empty project at minimal, and the "nothing to inject" reason is still recorded', () => {
    openDatabase(dbPath);
    closeDatabase();
    const out = runHook({ cwd: dirA }, { MEMESH_BRIEFING: 'minimal' });
    expect(out.context).toBe(lineFor(dirA));
    const reason = outcomes().find((r) => typeof r.reason === 'string' && r.reason.includes('nothing to inject'));
    expect(reason?.reason).toContain('"minimal"');
  });

  it('comes ahead of the memory block, outside its fence, when the project has memories', () => {
    openDatabase(dbPath);
    remember({ name: 'a-decision', type: 'decision', observations: ['okapi decision of A'], project: mirrorProjectName(dirA) });
    closeDatabase();
    const out = runHook({ cwd: dirA });
    expect(out.context.startsWith(lineFor(dirA))).toBe(true);
    expect(out.context).toContain('okapi decision of A');
    const fence = out.context.indexOf('okapi decision of A');
    expect(out.context.indexOf(lineFor(dirA))).toBeLessThan(fence);
    expect(out.context.split(lineFor(dirA)).length).toBe(2);
  });

  it('follows each session start\'s own cwd: A, then B', () => {
    const a = runHook({ cwd: dirA });
    const b = runHook({ cwd: dirB });
    expect(mirrorProjectName(dirA)).not.toBe(mirrorProjectName(dirB));
    expect(a.context.startsWith(lineFor(dirA))).toBe(true);
    expect(b.context.startsWith(lineFor(dirB))).toBe(true);
    expect(b.context).not.toContain(mirrorProjectName(dirA));
  });

  it('is absent without a usable cwd, and never names the hook process\'s own directory', () => {
    const file = path.join(dirA, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x');
    // '.' is a relative path that does exist (the hook's own working directory),
    // so only the absolute-path check keeps it out.
    for (const input of [{}, { cwd: '' }, { cwd: 'proj-a' }, { cwd: '.' }, { cwd: path.join(root, 'missing') }, { cwd: file }]) {
      const out = runHook(input);
      expect(out.context, JSON.stringify(input)).not.toContain('MeMesh project for this session');
      expect(out.context).not.toContain(mirrorProjectName(process.cwd()));
    }
    // Each of the six starts recorded why the line was missing, with no path in it.
    const skipped = outcomes().filter((r) => r.hook === 'session-start' && r.outcome === 'skipped' && r.reason === SKIP_REASONS.projectLineNoCwd);
    expect(skipped).toHaveLength(6);
    expect(JSON.stringify(skipped)).not.toContain(root);
  });

  it('comes first, once, when the database cannot be read and memories are not loaded', () => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a SQLite database');
    const out = runHook({ cwd: dirA });
    expect(out.systemMessage).toContain('memories not loaded this session');
    expect(out.context.startsWith(lineFor(dirA))).toBe(true);
    expect(out.context.split(lineFor(dirA)).length).toBe(2);
  });

  it('comes first, once, when the database has no memory tables yet', () => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE unrelated (id INTEGER)');
    db.close();
    const out = runHook({ cwd: dirA });
    expect(out.systemMessage).toContain('database initialised but no memories stored yet');
    expect(out.context.startsWith(lineFor(dirA))).toBe(true);
    expect(out.context.split(lineFor(dirA)).length).toBe(2);
  });

  it('records no project-line skip when the cwd is usable', () => {
    runHook({ cwd: dirA });
    expect(outcomes().filter((r) => r.reason === SKIP_REASONS.projectLineNoCwd)).toEqual([]);
  });
});
