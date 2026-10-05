// #529 through the real CLI: `memesh kg backfill-relations` previews by
// default and writes only with --apply, after a backup.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// Spawns a bundle of the SOURCE, not `dist` — see tests/cli/import-notes.test.ts.
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

let home: string;
function runCli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_AUTO_CAPTURE: 'false' },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

function snapshot(dbFile: string) {
  const reader = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return {
      relations: reader.prepare('SELECT from_entity_id, to_entity_id, relation_type FROM relations ORDER BY 1, 2, 3').all(),
      metadata: reader.prepare('SELECT key, value FROM memesh_metadata ORDER BY key').all(),
      entities: reader.prepare('SELECT name, confidence, last_accessed_at FROM entities ORDER BY id').all(),
    };
  } finally {
    reader.close();
  }
}

describe('memesh kg backfill-relations', () => {
  let dbFile: string;

  beforeAll(async () => { await bundleCliFromSource(); }, 120_000);
  afterAll(() => { fs.rmSync(bundleDir, { recursive: true, force: true }); });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-backfill-cli-'));
    for (const name of ['auth-a', 'auth-b']) {
      const seeded = runCli('remember', '--name', name, '--type', 'note', '--obs', `${name} body`,
        '--tags', 'topic:auth', 'tech:oauth', 'project:p529');
      expect(seeded.exitCode, seeded.stderr).toBe(0);
    }
    dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
    // A stale memory and no decay marker: a normal open would decay it.
    const writer = new DatabaseSync(dbFile);
    writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'auth-a'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
    writer.close();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('previews by default and writes nothing, not even the attempted-orphan cache or auto-decay', () => {
    const before = snapshot(dbFile);
    for (const extra of [[], ['--dry-run'], ['--reset-idempotency']]) {
      const preview = runCli('kg', 'backfill-relations', '--project', 'p529', ...extra);
      expect(preview.exitCode, preview.stderr).toBe(0);
      expect(preview.stdout).toContain('auth-a  --[related-to]-->  auth-b');
      expect(preview.stdout).toContain('Nothing written. Re-run with --apply');
    }
    const json = runCli('kg', 'backfill-relations', '--json');
    expect(json.exitCode, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).candidates.length).toBeGreaterThan(0);
    expect(snapshot(dbFile)).toEqual(before);
    expect(fs.existsSync(path.join(home, '.memesh', 'backups'))).toBe(false);
  }, 60_000);

  it('--apply backs up the database beside it first, then writes', () => {
    const applied = runCli('kg', 'backfill-relations', '--project', 'p529', '--apply', '--json');
    expect(applied.exitCode, applied.stderr).toBe(0);
    const result = JSON.parse(applied.stdout) as { edgesWritten: number; backupPath: string };
    expect(result.edgesWritten).toBeGreaterThan(0);
    expect(fs.realpathSync(path.dirname(path.dirname(result.backupPath)))).toBe(fs.realpathSync(path.join(home, '.memesh')));
    expect(path.basename(result.backupPath)).toMatch(/^kg-before-backfill-relations-.+\.db$/);
    // The backup holds the graph as it was before the write.
    expect(snapshot(result.backupPath).relations).toHaveLength(0);
    expect(snapshot(dbFile).relations.length).toBe(result.edgesWritten);

    const text = runCli('kg', 'backfill-relations', '--apply', '--reset-idempotency');
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain('Backup: ');
    expect(text.stdout).toContain('.restore');
  }, 60_000);

  it('refuses --apply together with --dry-run in one line, before opening anything', () => {
    const before = snapshot(dbFile);
    const r = runCli('kg', 'backfill-relations', '--apply', '--dry-run');
    expect(r.exitCode).toBe(1);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('pass one of them');
    expect(snapshot(dbFile)).toEqual(before);
    expect(fs.existsSync(path.join(home, '.memesh', 'backups'))).toBe(false);
  }, 60_000);
});
