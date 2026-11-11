/**
 * On a Node below the floor the CLI says one sentence and exits 1, at all
 * three places it opens the database (the normal open and the two read-only
 * previews). The Node version is faked with a preload that reports 22.15.1;
 * the CLI is bundled from SOURCE so a mutation of cli.ts is seen.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MIN_NODE_SERIES } from '../../src/storage/sqlite.js';
import { createDatabase, OLD_NODE_SENTENCE as SENTENCE, writeOldNodePreload } from '../helpers/node-floor.js';

const REPO_ROOT = path.join(__dirname, '..', '..');
let work: string;
let cliPath: string;
let preload: string;
let homeWithDb: string;
let routerPath: string;

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nodefloor-cli-'));
  cliPath = path.join(work, 'dist', 'transports', 'cli', 'cli.js');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(work, 'package.json'));
  await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, 'src', 'transports', 'cli', 'cli.ts')],
    outfile: cliPath,
    bundle: true, platform: 'node', format: 'esm', target: `node${MIN_NODE_SERIES}`, packages: 'bundle',
    external: ['node:*'], legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
  routerPath = path.join(work, 'dist', 'host-runtime', 'router.js');
  fs.mkdirSync(path.dirname(routerPath), { recursive: true });
  await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, 'src', 'host-runtime', 'router.ts')],
    outfile: routerPath,
    bundle: true, platform: 'node', format: 'esm', target: `node${MIN_NODE_SERIES}`, packages: 'bundle',
    external: ['node:*'], legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
  preload = writeOldNodePreload(work);
  // An existing database file, made on the real Node, for the read-only previews.
  homeWithDb = path.join(work, 'home-with-db');
  fs.mkdirSync(path.join(homeWithDb, '.memesh'), { recursive: true });
  createDatabase(path.join(homeWithDb, '.memesh', 'knowledge-graph.db'));
}, 120_000);

afterAll(() => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

/** A guard kept short on purpose: if the floor ever stops holding, `serve` would run for ever and leave a server behind. */
const CHILD_TIMEOUT_MS = 30_000;

function runOld(args: string[], home: string, nodeFlags: string[] = []) {
  const r = spawnSync(process.execPath, [...nodeFlags, '--require', preload, cliPath, ...args], {
    encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL',
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_SKIP_UPDATE_CHECK: '1' },
  });
  expect(r.error, 'the command did not finish: the Node floor is not holding').toBeUndefined();
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
}

function expectOneSentence(stderr: string) {
  expect(stderr).toContain(SENTENCE);
  expect(stderr.split(SENTENCE).length - 1, `said once: ${stderr}`).toBe(1);
  expect(stderr).not.toContain('cannot open its database');
  expect(stderr).not.toContain('memesh doctor');
}

describe('Feature: the CLI on a Node below the floor', () => {
  it('the normal open (remember) exits 1 with the one sentence', () => {
    const home = path.join(work, 'home-empty');
    fs.mkdirSync(home, { recursive: true });
    const r = runOld(['remember', '--name', 'x', '--type', 'note', '--obs', 'y'], home);
    expect(r.exitCode).toBe(1);
    expectOneSentence(r.stderr);
    // The open refuses before it creates the data folder.
    expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
  });

  // Node 20 has no node:sqlite at all; the flag reproduces that on a newer Node. The bundle must still load: a module
  // that imports node:sqlite on its own, outside src/storage/sqlite.ts, would crash every command with a stack trace.
  describe.each([['recall', ['recall', 'x']], ['briefing', ['briefing']]])('with no node:sqlite at all (%s)', (_name, args) => {
    it('says the one sentence and exits 1, with no stack trace', () => {
      const home = path.join(work, `home-nosqlite-${args[0]}`);
      fs.mkdirSync(home, { recursive: true });
      const r = runOld(args, home, ['--no-experimental-sqlite']);
      expect(r.exitCode, r.stderr).toBe(1);
      expect(r.stdout + r.stderr).toContain(SENTENCE);
      expect(r.stdout + r.stderr).not.toMatch(/ERR_UNKNOWN_BUILTIN_MODULE|\n\s+at /);
    });
  });

  it('doctor still reports, exits 1 and shows no stack trace with no node:sqlite at all', () => {
    const home = path.join(work, 'home-nosqlite-doctor');
    fs.mkdirSync(home, { recursive: true });
    const r = runOld(['doctor'], home, ['--no-experimental-sqlite']);
    expect(r.exitCode, r.stderr).toBe(1);
    expect(r.stdout).toContain('[FAIL] SQLite');
    expect(r.stdout).toContain('[FAIL] Node runtime');
    expect(r.stdout + r.stderr).not.toMatch(/ERR_UNKNOWN_BUILTIN_MODULE|\n\s+at /);
  });

  it('--version still works with no node:sqlite at all', () => {
    const home = path.join(work, 'home-nosqlite-version');
    fs.mkdirSync(home, { recursive: true });
    const r = runOld(['--version'], home, ['--no-experimental-sqlite']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('the read-only preview of kg backfill-relations exits 1 with the one sentence', () => {
    const r = runOld(['kg', 'backfill-relations', '--dry-run'], homeWithDb);
    expect(r.exitCode).toBe(1);
    expectOneSentence(r.stderr);
  });

  it('the read-only list of kg rename-project exits 1 with the one sentence', () => {
    const r = runOld(['kg', 'rename-project'], homeWithDb);
    expect(r.exitCode).toBe(1);
    expectOneSentence(r.stderr);
  });

  it('serve says the sentence once and exits 1', () => {
    const home = path.join(work, 'home-serve');
    fs.mkdirSync(home, { recursive: true });
    const r = runOld(['serve', '--host', '127.0.0.1', '--port', '0'], home);
    expect(r.exitCode).toBe(1);
    expectOneSentence(r.stderr);
    // Not even an empty data folder is left behind.
    expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
  });

  it('serve on a remote bind leaves no token file either', () => {
    const home = path.join(work, 'home-serve-remote');
    fs.mkdirSync(home, { recursive: true });
    const r = runOld(['serve', '--host', '0.0.0.0', '--allow-remote', '--port', '0'], home);
    expect(r.exitCode).toBe(1);
    expectOneSentence(r.stderr);
    expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
  });

  it('install-hooks wires the hooks but warns that nothing works on this Node', () => {
    const home = path.join(work, 'home-install-hooks');
    fs.mkdirSync(home, { recursive: true });
    const r = runOld(['install-hooks', '--dry-run', '--no-journey'], home);
    expect(r.stdout).toContain(`WARNING: This Node (v22.15.1) ${SENTENCE}`);
    expect(r.stdout).toContain('none of MeMesh works until that is fixed');
  });

  it('the router refuses before it writes a token or anything else', () => {
    const home = path.join(work, 'home-router');
    fs.mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, ['--require', preload, routerPath], {
      encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(r.error, 'the router did not finish: the Node floor is not holding').toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(SENTENCE);
    expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
  });
});
