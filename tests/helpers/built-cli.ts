import { spawnSync } from 'child_process';
import path from 'path';

export const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

export interface CliResult { status: number; stdout: string; stderr: string }

/**
 * The environment for the built CLI against a throwaway HOME: its data folder is `<home>/.memesh`, and nothing of
 * the developer's own database, project or API keys leaks in. `extra` is applied last.
 */
export function cliEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh') };
  for (const key of ['MEMESH_DB_PATH', 'MEMESH_PROJECT_ROOT', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  return { ...env, ...extra };
}

export function runCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }): CliResult {
  const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env: options.env, cwd: options.cwd, timeout: options.timeout ?? 30_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
