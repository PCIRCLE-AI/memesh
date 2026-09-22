/**
 * `memesh status` on an install that is NEWER than npm's `latest`.
 *
 * A trial build published under the `next` tag (4.10.2 while `latest` was 4.9.4)
 * printed `Update check: up to date (fresh; latest 4.9.4)` and then
 * `Update path: <update command>` — the first is false (the install is ahead of
 * the registry) and the second points at `@latest`, a downgrade. `memesh
 * doctor` had already said the true thing ("Running pre-release version (4.10.2),
 * npm latest is 4.9.4"). This runs the BUILT CLI with `--cached`, so no network
 * is touched: the update check is read from a cache file this test writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');
const INSTALLED_VERSION: string = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

let home: string;

/** `extra` overrides or adds cache-record fields (a deprecation, a partial failure). */
function status(latestVersion: string, extra: Record<string, unknown> = {}): { stdout: string; stderr: string; status: number | null } {
  const now = new Date().toISOString();
  const cache = path.join(home, 'update-check.json');
  fs.writeFileSync(cache, JSON.stringify({
    currentVersion: INSTALLED_VERSION,
    latestVersion,
    checkSucceeded: true,
    lastError: null,
    lastAttemptAt: now,
    lastSuccessfulCheckAt: now,
    ...extra,
  }));
  fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
  // No background update check: it can migrate a bare database mid-run.
  fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({ updateCheck: false }));
  const r = spawnSync('node', [CLI_PATH, 'status', '--cached'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MEMESH_UPDATE_CHECK_PATH: cache,
      MEMESH_AUTO_UPDATE: '0',
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('memesh status: an install newer than npm latest', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-status-ahead-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('says it is running a pre-release version, and does not say "up to date" or point at the updater', () => {
    const r = status('0.0.1');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`MeMesh v${INSTALLED_VERSION}`);
    expect(r.stdout).toContain(`Update check: running pre-release version (${INSTALLED_VERSION}), npm latest is 0.0.1`);
    // The absences below only mean something over the real status output: the
    // version line, the install method and the update-check line, at least.
    expect(r.stdout.split('\n').filter((line) => line.trim() !== '').length).toBeGreaterThanOrEqual(3);
    expect(r.stdout).not.toContain('up to date');
    expect(r.stdout).not.toContain('Update available');
    // The trailer names the updater, which installs `@latest`: a downgrade here.
    expect(r.stdout).not.toContain('Update path:');
    expect(r.stdout).not.toMatch(/memesh update|npm (install|i) .*@latest/);
  });

  // The suppression is for the "running pre-release version" line only. A
  // deprecated or partly checked install that is ahead of `latest` gets a
  // different status line (a deprecation that already says to update, or an
  // uncertain check that names no action of its own), so it keeps the
  // `Update path:` it always had.
  it('a DEPRECATED install that is ahead of latest keeps its update path', () => {
    const r = status('0.0.1', { currentVersionDeprecation: 'security advisory: upgrade now' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('DEPRECATED');
    expect(r.stdout).toContain('Update check: deprecated, upgrade target unknown');
    expect(r.stdout).not.toContain('running pre-release version');
    expect(r.stdout).toContain('Update path:');
  });

  it('a PARTLY checked install that is ahead of latest keeps its update path', () => {
    const r = status('0.0.1', { lastError: 'deprecation lookup failed' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Update check: partial — deprecation status unknown');
    expect(r.stdout).not.toContain('running pre-release version');
    expect(r.stdout).toContain('Update path:');
  });

  it('an install that IS current still says "up to date" and keeps its update path (anti-vacuity)', () => {
    const r = status(INSTALLED_VERSION);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Update check: up to date (cached from`);
    expect(r.stdout).toContain(`latest ${INSTALLED_VERSION})`);
    expect(r.stdout).toContain('Update path:');
  });

  it('an install that is BEHIND still offers the update and its path', () => {
    const r = status('99.0.0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Update available: 99.0.0');
    expect(r.stdout).toContain('Update path:');
  });
});
