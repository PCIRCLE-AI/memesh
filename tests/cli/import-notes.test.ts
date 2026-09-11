// #324 piece C through the real CLI: `memesh import --notes <dir>`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

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

    const recalled = runCli(['recall', 'alpha', '--json', '--cross-project'], home);
    expect(recalled.stdout).toContain('cli_note_a');
  }, 60_000);

  it('a missing directory is a one-line error, not a stack trace', () => {
    const r = runCli(['import', '--notes', path.join(home, 'nope')], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('directory not found');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, 60_000);

  it('refuses a file and --notes together, and neither', () => {
    expect(runCli(['import', 'x.json', '--notes', notes], home).stderr).toContain('not both');
    expect(runCli(['import'], home).stderr).toContain('--notes');
  }, 60_000);
});
