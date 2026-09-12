// #324 piece C through the real CLI: `memesh import --notes <dir>`.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Spawns a bundle of the SOURCE, not `dist` — see the same note in
// tests/cli/remember-quick.test.ts: spawning `dist` left these tests green
// while src/transports/cli/cli.ts was mutated.
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

const note = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: decision\n---\n\n${body}\n`;

describe('memesh import --notes', () => {
  let home: string;
  let notes: string;

  beforeAll(async () => { await bundleCliFromSource(); }, 120_000);
  afterAll(() => { fs.rmSync(bundleDir, { recursive: true, force: true }); });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-import-notes-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    notes = path.join(home, 'notes');
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, 'a.md'), note('cli_note_a', 'Alpha decision', 'alpha body'));
    fs.writeFileSync(path.join(notes, 'b.md'), note('cli_note_b', 'Beta decision', 'beta body'));
    fs.writeFileSync(path.join(notes, 'README.md'), '# no frontmatter\n');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('ingests, reports skips, and is a no-op on the second run', () => {
    const first = runCli(['import', '--notes', notes, '--project', 'p'], home);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain('2 created');
    expect(first.stderr).toContain('skipped README.md');

    const second = runCli(['import', '--notes', notes, '--json'], home);
    expect(second.exitCode, second.stderr).toBe(0);
    const parsed = JSON.parse(second.stdout);
    expect(parsed).toMatchObject({ created: [], replaced: [], unchanged: 2 });
    expect(parsed.discovered).toBeGreaterThanOrEqual(2);

    const recalled = runCli(['recall', 'alpha', '--json', '--cross-project'], home);
    expect(recalled.stdout).toContain('cli_note_a');
  }, 60_000);

  it('a missing directory is a one-line error, not a stack trace', () => {
    const r = runCli(['import', '--notes', path.join(home, 'nope')], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('directory not found');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, 60_000);

  it('refuses --namespace and --merge with --notes instead of ignoring them', () => {
    const ns = runCli(['import', '--notes', notes, '--namespace', 'team'], home);
    expect(ns.exitCode).toBe(1);
    expect(ns.stderr).toContain('--notes does not take --namespace');
    const merge = runCli(['import', '--notes', notes, '--merge', 'append'], home);
    expect(merge.exitCode).toBe(1);
    expect(merge.stderr).toContain('--merge');
  }, 60_000);

  // #324 T6. --notes refuses --namespace and --merge rather than ignoring
  // them, but the JSON path took --project and --json and did nothing with
  // them: a user could believe the bundle had been filed under that project.
  it('refuses --project and --json on the JSON import path instead of ignoring them', () => {
    const bundle = path.join(home, 'export.json');
    fs.writeFileSync(bundle, JSON.stringify({ entities: [], relations: [] }));

    const withProject = runCli(['import', bundle, '--project', 'p'], home);
    expect(withProject.exitCode).toBe(1);
    expect(withProject.stderr).toContain('--project');

    const withJson = runCli(['import', bundle, '--json'], home);
    expect(withJson.exitCode).toBe(1);
    expect(withJson.stderr).toContain('--json');

    // The bundle itself still imports.
    expect(runCli(['import', bundle], home).exitCode).toBe(0);
  }, 60_000);

  it('refuses a file and --notes together, and neither', () => {
    expect(runCli(['import', 'x.json', '--notes', notes], home).stderr).toContain('not both');
    expect(runCli(['import'], home).stderr).toContain('--notes');
  }, 60_000);
});
