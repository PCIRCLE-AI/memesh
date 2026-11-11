/**
 * A Node can fail to run MeMesh in three ways and each has its own words and repair: too old (upgrade), node:sqlite
 * switched off on a new Node (remove the flag), built without FTS5 (install the official build). The first block
 * checks the wording in-process; the second runs a bundle of the SOURCE of src/storage/sqlite.ts in a child process,
 * because node:sqlite missing at import, the probe's failures and its cache (a module-level value) cannot be seen
 * from inside the test runner.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MIN_NODE_SERIES, UnsupportedNodeError, nodeProblem } from '../../src/storage/sqlite.js';
import { writeOldNodePreload } from '../helpers/node-floor.js';

const yes = () => true;

describe('Feature: the three ways a Node cannot run MeMesh', () => {
  it('are told apart by cause: too old first, then node:sqlite switched off, then no FTS5', () => {
    expect(nodeProblem('20.19.0', yes, false)?.kind).toBe('too-old');
    expect(nodeProblem('24.0.0', yes, false)?.kind).toBe('sqlite-switched-off');
    expect(nodeProblem('24.0.0', () => false)?.kind).toBe('no-fts5');
    expect(nodeProblem('24.0.0', yes, true)).toBeNull();
  });

  it('only a Node that is too old is told to upgrade; the other two are told what actually helps', () => {
    const tooOld = nodeProblem('22.15.1', yes)!;
    const off = nodeProblem('24.0.0', yes, false)!;
    const noFts5 = nodeProblem('24.0.0', () => false)!;
    expect(tooOld.fix).toMatch(/^Upgrade Node to 22\.16/);
    for (const other of [off, noFts5]) {
      expect(other.message).not.toMatch(/upgrade/i);
      expect(other.fix).not.toMatch(/upgrade/i);
    }
    expect(off.message).toContain('--no-experimental-sqlite');
    expect(off.fix).toContain('--no-experimental-sqlite');
    expect(noFts5.fix).toContain('nodejs.org');
    expect(new Set([tooOld.fix, off.fix, noFts5.fix]).size).toBe(3);
  });

  it('an UnsupportedNodeError carries the fix of its own cause', () => {
    const problem = nodeProblem('24.0.0', yes, false)!;
    const err = new UnsupportedNodeError(problem);
    expect(err.fix).toBe(problem.fix);
    expect(err.message).toBe(problem.message);
    expect(err.code).toBe('NODE_TOO_OLD');
  });

  it('nothing outside src/storage/sqlite.ts imports node:sqlite for real: a Node without it must be able to load every module', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '_generated') walk(full); continue; }
        if (!/\.(ts|js|mjs)$/.test(entry.name) || full.endsWith(path.join('storage', 'sqlite.ts'))) continue;
        // a static `import … from 'node:sqlite'` (not `import type`) or a `require('node:sqlite')` at module level
        const text = fs.readFileSync(full, 'utf8');
        if (/^import\s+(?!type\b)[^;]*from\s+['"]node:sqlite['"]/m.test(text)) offenders.push(path.relative(root, full));
      }
    };
    const root = path.join(__dirname, '..', '..');
    walk(path.join(root, 'src'));
    walk(path.join(root, 'scripts', 'hooks'));
    expect(offenders).toEqual([]);
  });

  it('the bundles are built for the floor, not for an older Node, so a bundle never carries syntax the floor lacks', () => {
    // CI runs 22.x, 24 and 26: no job runs exactly 22.16.0, so the floor is held by this text and by the engines test.
    for (const file of ['scripts/build-cli-bundle.mjs', 'scripts/build-mcp-bundle.mjs']) {
      expect(fs.readFileSync(file, 'utf8'), file).toContain(`target: 'node${MIN_NODE_SERIES}'`);
    }
  });
});

describe('Feature: the Node check in a real process', () => {
  let work: string;
  let bundle: string;
  let oldPreload: string;
  let faultPreload: string;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nodefloor-storage-'));
    bundle = path.join(work, 'sqlite.mjs');
    await build({
      entryPoints: [path.join(__dirname, '..', '..', 'src', 'storage', 'sqlite.ts')],
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: `node${MIN_NODE_SERIES}`, legalComments: 'none',
    });
    oldPreload = writeOldNodePreload(work);
    // MODE=nofts: the FTS5 statement fails like a Node built without it. execboom: it fails once for another reason.
    // closeboom: the probe's close fails once.
    faultPreload = path.join(work, 'probe-faults.cjs');
    fs.writeFileSync(faultPreload, `
      const { DatabaseSync } = require('node:sqlite');
      const mode = process.env.MODE || '';
      const exec = DatabaseSync.prototype.exec;
      const close = DatabaseSync.prototype.close;
      let execFailed = false; let closeFailed = false;
      DatabaseSync.prototype.exec = function (sql) {
        if (/fts5/i.test(sql)) {
          if (mode === 'nofts') throw new Error('no such module: fts5');
          if (mode.includes('execboom') && !execFailed) { execFailed = true; throw new Error('out of memory'); }
        }
        return exec.call(this, sql);
      };
      DatabaseSync.prototype.close = function () {
        if (mode.includes('closeboom') && !closeFailed) { closeFailed = true; throw new Error('close boom'); }
        return close.call(this);
      };
    `);
  }, 60_000);
  afterAll(() => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  /** Runs `body` (it sees `m`, the module, `attempt(fn)` and `out`) in a child and returns what it put in `out`. */
  function child(body: string, { flags = [] as string[], preloads = [] as string[], mode = '' } = {}) {
    const script = `
      const m = await import(process.env.BUNDLE);
      const attempt = (fn) => { try { return { ok: fn() ?? null }; } catch (e) { return { threw: { name: e.name, code: e.code, message: e.message, fix: e.fix, advice: e.advice } }; } };
      const out = {};
      ${body}
      console.log(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, [...flags, ...preloads.flatMap((p) => ['--require', p]), '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, BUNDLE: bundle, MODE: mode },
    });
    expect(r.status, r.stderr).toBe(0);
    return { out: JSON.parse(r.stdout.trim().split('\n').pop() as string), stderr: r.stderr };
  }

  const TOO_OLD = 'This Node (v22.15.1) lacks the full-text search MeMesh needs; upgrade to Node 22.16 or newer and run memesh again.';

  it('a Node with no node:sqlite and an old version (Node 20) imports without crashing and says only: upgrade', () => {
    const { out, stderr } = child(`
      out.problem = m.nodeSupportProblem();
      out.open = attempt(() => new m.MemeshDatabase(':memory:'));`,
    { flags: ['--no-experimental-sqlite'], preloads: [oldPreload] });
    expect(out.problem).toBe(TOO_OLD);
    expect(out.open.threw.code).toBe('NODE_TOO_OLD');
    expect(out.open.threw.message).toBe(TOO_OLD);
    expect(out.open.threw.fix).toMatch(/^Upgrade Node to 22\.16/);
    expect(stderr).not.toContain('node:sqlite');
  });

  it('a new-enough Node with node:sqlite switched off is told to remove the flag, not to upgrade', () => {
    const { out } = child(`
      out.problem = m.nodeProblem();
      out.open = attempt(() => new m.MemeshDatabase(':memory:'));`,
    { flags: ['--no-experimental-sqlite'] });
    expect(out.problem.kind).toBe('sqlite-switched-off');
    expect(out.problem.message).toContain('--no-experimental-sqlite');
    expect(out.problem.message).not.toMatch(/upgrade/i);
    expect(out.open.threw.code).toBe('NODE_TOO_OLD');
    expect(out.open.threw.fix).toBe(out.problem.fix);
    expect(out.open.threw.fix).not.toMatch(/upgrade/i);
  });

  it('a new-enough Node built without FTS5 is told to install the official build', () => {
    const { out } = child(`
      out.problem = m.nodeProblem();
      out.open = attempt(() => new m.MemeshDatabase(':memory:'));`,
    { preloads: [faultPreload], mode: 'nofts' });
    expect(out.problem.kind).toBe('no-fts5');
    expect(out.problem.message).toContain('nodejs.org');
    expect(out.open.threw.fix).toBe(out.problem.fix);
    expect(out.open.threw.fix).not.toMatch(/upgrade/i);
  });

  it('a Node that works answers null; on a Node below the floor the version is checked before anything is probed', () => {
    const fine = child('out.problem = m.nodeSupportProblem();', { preloads: [faultPreload] });
    expect(fine.out.problem).toBeNull();
    // The probe would fail here (execboom); it must not run, so the answer stays the old-Node sentence.
    const old = child('out.problem = m.nodeSupportProblem();', { preloads: [oldPreload, faultPreload], mode: 'execboom' });
    expect(old.out.problem).toBe(TOO_OLD);
  });

  it('a probe that fails for another reason says so, is not remembered as "no FTS5", and the next open works', () => {
    const { out } = child(`
      out.first = attempt(() => new m.MemeshDatabase(':memory:'));
      out.second = attempt(() => { new m.MemeshDatabase(':memory:').close(); return 'opened'; });`,
    { preloads: [faultPreload], mode: 'execboom' });
    expect(out.first.threw.code).toBe('SQLITE_SELF_CHECK_FAILED');
    expect(out.first.threw.message).toContain('out of memory');
    expect(out.first.threw.advice).not.toMatch(/upgrade|move|backup/i);
    expect(out.second).toEqual({ ok: 'opened' });
  });

  it('closing the probe can fail without failing the open and without hiding the probe\'s own error', () => {
    const closeOnly = child(`
      out.problem = m.nodeSupportProblem();
      out.open = attempt(() => { new m.MemeshDatabase(':memory:').close(); return 'opened'; });`,
    { preloads: [faultPreload], mode: 'closeboom' });
    expect(closeOnly.out.problem).toBeNull();
    expect(closeOnly.out.open).toEqual({ ok: 'opened' });
    const both = child('out.first = attempt(() => m.nodeSupportProblem());', { preloads: [faultPreload], mode: 'execboom,closeboom' });
    expect(both.out.first.threw.message).toContain('out of memory');
    expect(both.out.first.threw.message).not.toContain('close boom');
  });
});
