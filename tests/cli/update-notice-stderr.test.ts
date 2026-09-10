import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');
const CURRENT_VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version as string;

describe('CLI first-use update notice (#308: any entry point)', () => {
  it('prints one stderr line a day, keeps stdout clean, and skips the update commands themselves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-notice-'));
    fs.writeFileSync(path.join(dir, `update-check.${CURRENT_VERSION}.json`), JSON.stringify({
      currentVersion: CURRENT_VERSION, latestVersion: '99.0.0', checkSucceeded: true,
      lastSuccessfulCheckAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(),
    }));
    const env = { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'memesh.db') };
    const run = (...args: string[]) => spawnSync('node', [CLI, ...args], { env, encoding: 'utf8' });

    const first = run('recall', 'anything', '--json');
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain('[memesh update] 99.0.0 is available');
    expect(() => JSON.parse(first.stdout)).not.toThrow(); // stdout is still machine-readable
    const second = run('recall', 'anything', '--json');
    expect(second.stderr).not.toContain('[memesh update]'); // once a day
    fs.rmSync(path.join(dir, `last-cli-update-notice.${CURRENT_VERSION}.lock`));
    const status = run('status');
    expect(status.stderr).not.toContain('[memesh update]'); // status speaks for itself
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
