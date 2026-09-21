// #363 through the real CLI: `memesh import` leaves a memory the user archived
// (forgot) alone when the bundle names it, unless `--restore-archived` is given.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Spawns a bundle of the SOURCE, not `dist` — the same reason as
// tests/cli/import-notes.test.ts: `dist` is a build product, and a test that
// spawns it stays green while src/transports/cli/cli.ts is mutated.
const REPO_ROOT = path.join(__dirname, '..', '..');
let bundleDir: string;
let CLI_PATH: string;

async function bundleCliFromSource(): Promise<void> {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-src-'));
  CLI_PATH = path.join(bundleDir, 'dist', 'transports', 'cli', 'cli.js');
  fs.mkdirSync(path.dirname(CLI_PATH), { recursive: true });
  // cli.ts reads '../../../package.json' relative to its own URL.
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(bundleDir, 'package.json'));
  await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, 'src', 'transports', 'cli', 'cli.ts')],
    outfile: CLI_PATH,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.13',
    packages: 'bundle',
    external: ['node:*'],
    legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
}

function runCli(args: string[], home: string): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

describe('memesh import and archived memories', () => {
  let home: string;
  let bundle: string;

  beforeAll(async () => { await bundleCliFromSource(); }, 120_000);
  afterAll(() => { fs.rmSync(bundleDir, { recursive: true, force: true }); });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-import-archived-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    expect(runCli(['remember', '--name', 'alpha', '--type', 'note', '--obs', 'ORIGINAL'], home).exitCode).toBe(0);
    expect(runCli(['forget', '--name', 'alpha'], home).exitCode).toBe(0);
    bundle = path.join(home, 'b.json');
    fs.writeFileSync(bundle, JSON.stringify({
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
      entities: [{ name: 'alpha', type: 'note', namespace: 'personal', observations: ['REPLACEMENT'], tags: [], relations: [] }],
    }));
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  /** What the graph holds for `alpha`, archived rows included. */
  const alpha = () => {
    const r = runCli(['recall', 'alpha', '--include-archived', '--json'], home);
    expect(r.exitCode).toBe(0);
    const entities = (JSON.parse(r.stdout) as { entities: Array<{ name: string; archived?: boolean; observations: string[] }> }).entities;
    // Exactly one hit: without this, every assertion below would also pass
    // against an empty result.
    expect(entities).toHaveLength(1);
    return entities[0];
  };

  it.each(['append', 'overwrite'])('--merge %s leaves the archived memory archived and says so', (strategy) => {
    expect(alpha().archived, 'fixture: alpha must start archived').toBe(true);

    const r = runCli(['import', bundle, '--merge', strategy], home);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Kept archived: 1');
    expect(r.stdout).toContain('--restore-archived');
    expect(alpha().archived).toBe(true);
    expect(alpha().observations).toEqual(['ORIGINAL']);
  }, 60_000);

  it.each(['append', 'overwrite'])('--merge %s --restore-archived brings it back', (strategy) => {
    const r = runCli(['import', bundle, '--merge', strategy, '--restore-archived'], home);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('Kept archived');
    expect(alpha().archived).toBeUndefined();
    expect(alpha().observations).toContain('REPLACEMENT');
  }, 60_000);

  it('--restore-archived with the default (skip) merge exits 1 with the core message and changes nothing', () => {
    // The default `--merge` is `skip`, and `skip` leaves every existing entity
    // alone: the flag on its own would do nothing and still report success.
    const r = runCli(['import', bundle, '--restore-archived'], home);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Error: restore_archived (--restore-archived) only applies with merge strategy "append" or "overwrite"');
    expect(r.stdout).not.toContain('Imported:');
    expect(alpha().archived).toBe(true);
    expect(alpha().observations).toEqual(['ORIGINAL']);
  }, 60_000);

  it('--merge skip --restore-archived is refused the same way', () => {
    const r = runCli(['import', bundle, '--merge', 'skip', '--restore-archived'], home);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('"append" or "overwrite"');
  }, 60_000);

  it('a bundle that names no archived memory prints no "Kept archived" line', () => {
    const fresh = path.join(home, 'fresh.json');
    fs.writeFileSync(fresh, JSON.stringify({
      version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
      entities: [{ name: 'beta', type: 'note', namespace: 'personal', observations: ['new'], tags: [], relations: [] }],
    }));
    const r = runCli(['import', fresh, '--merge', 'append'], home);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('Kept archived');
  }, 60_000);

  it('--help names the flag', () => {
    expect(runCli(['import', '--help'], home).stdout).toContain('--restore-archived');
  }, 60_000);

  it('--notes refuses --restore-archived instead of ignoring it', () => {
    const notes = path.join(home, 'notes');
    fs.mkdirSync(notes);
    const r = runCli(['import', '--notes', notes, '--restore-archived'], home);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--notes does not take --restore-archived');
  }, 60_000);
});
