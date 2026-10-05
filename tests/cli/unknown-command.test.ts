import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DX regression: `memesh nonexistent-cmd` used to emit a confusing
//   "error: too many arguments. Expected 0 arguments but got 1."
// because Commander's default rejection runs before the root action's
// `program.args` inspection. The fix uses `.allowExcessArguments(true)`
// so the root action can detect stray positional args and emit a clear
// "unknown command 'foo'" message. Pin the behavior here so a future
// Commander upgrade or refactor cannot silently regress it.

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: process.env.HOME ?? process.env.USERPROFILE ?? '' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('CLI: unknown subcommand', () => {
  it('exits 1 with clean "unknown command" message', () => {
    const result = runCli(['nonexistent-cmd']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command 'nonexistent-cmd'");
    expect(result.stderr).toContain("memesh --help");
    // Anti-regression: the old "too many arguments" message must not return.
    expect(result.stderr).not.toContain('too many arguments');
  });

  it('bare `memesh` prints help and exits 0 — it must NOT start a server', () => {
    // P7's worst first-run moment: `memesh` with no args used to start the
    // dashboard on a RANDOM port and hang the terminal. A first-time user
    // typing the bare command to see what the tool does got a stuck prompt.
    // If this regresses to a server, execFileSync hangs until the timeout
    // and the test fails on it.
    const bare = (() => {
      try {
        const stdout = execFileSync('node', [CLI_PATH], {
          encoding: 'utf8',
          env: { ...process.env, USERPROFILE: process.env.HOME ?? process.env.USERPROFILE ?? '' },
          timeout: 30_000,
        });
        return { stdout, exitCode: 0 };
      } catch (err: any) {
        return { stdout: err.stdout?.toString() ?? '', exitCode: err.status ?? -1 };
      }
    })();
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toContain('Usage:');
    expect(bare.stdout).toContain('serve');
    expect(bare.stdout).not.toContain('MeMesh dashboard: http');
  }, 60_000);

  it('--version still works (allowExcessArguments did not break flag parsing)', () => {
    const result = runCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// `.allowExcessArguments(true)` belongs to the root command only. Commander copies it
// into every subcommand created after it is set, and a subcommand that inherited it
// dropped the extra words and exited 0: `memesh remember Use OAuth with PKCE` stored
// only "Use". The home is a throwaway one, because with the bug these calls write.
describe('CLI: a subcommand refuses words it has no place for', () => {
  function runInThrowawayHome(args: string[]): { stderr: string; exitCode: number } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-excess-args-'));
    try {
      const result = spawnSync('node', [CLI_PATH, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      return { stderr: result.stderr, exitCode: result.status ?? 1 };
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  it.each([
    ['remember Use OAuth with PKCE', ['remember', 'Use', 'OAuth', 'with', 'PKCE']],
    ['recall with two words', ['recall', 'first', 'second']],
    ['a nested subcommand', ['dream', 'list', 'extra']],
  ])('%s exits 1 with "too many arguments"', (_name, args) => {
    const result = runInThrowawayHome(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('too many arguments');
  });
});
