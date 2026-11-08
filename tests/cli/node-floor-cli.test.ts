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
import { createEmptyDatabase, OLD_NODE_SENTENCE as SENTENCE, writeOldNodePreload } from '../helpers/node-floor.js';

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
    bundle: true, platform: 'node', format: 'esm', target: 'node22.16', packages: 'bundle',
    external: ['node:*'], legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
  routerPath = path.join(work, 'dist', 'host-runtime', 'router.js');
  fs.mkdirSync(path.dirname(routerPath), { recursive: true });
  await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, 'src', 'host-runtime', 'router.ts')],
    outfile: routerPath,
    bundle: true, platform: 'node', format: 'esm', target: 'node22.16', packages: 'bundle',
    external: ['node:*'], legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
  preload = writeOldNodePreload(work);
  // An existing database file, made on the real Node, for the read-only previews.
  homeWithDb = path.join(work, 'home-with-db');
  fs.mkdirSync(path.join(homeWithDb, '.memesh'), { recursive: true });
  createEmptyDatabase(path.join(homeWithDb, '.memesh', 'knowledge-graph.db'));
}, 120_000);

afterAll(() => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function runOld(args: string[], home: string) {
  const r = spawnSync(process.execPath, ['--require', preload, cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_SKIP_UPDATE_CHECK: '1' },
  });
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
  });

  it('the router refuses before it writes a token or anything else', () => {
    const home = path.join(work, 'home-router');
    fs.mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, ['--require', preload, routerPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(SENTENCE);
    expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
  });
});
