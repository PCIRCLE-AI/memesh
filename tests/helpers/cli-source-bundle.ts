// Spawn-able bundle of the CLI built from SOURCE, not `dist`: a test that
// spawns `dist` stays green while src/ is mutated (see tests/cli/import-notes.test.ts).
import { spawnSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..');

export async function bundleCliFromSource(): Promise<{ cliPath: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-src-'));
  const cliPath = path.join(dir, 'dist', 'transports', 'cli', 'cli.js');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  // cli.ts reads '../../../package.json' relative to its own URL.
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(dir, 'package.json'));
  await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, 'src', 'transports', 'cli', 'cli.ts')],
    outfile: cliPath, bundle: true, platform: 'node', format: 'esm', target: 'node22.13',
    packages: 'bundle', external: ['node:*'], legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
  return { cliPath, dir };
}

export function runBundledCli(cliPath: string, args: string[], home: string, cwd?: string, input?: string): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh') };
  for (const key of ['MEMESH_DB_PATH', 'MEMESH_PROJECT_ROOT']) delete env[key];
  const r = spawnSync('node', [cliPath, ...args], { encoding: 'utf8', env, cwd, input, timeout: 60000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
