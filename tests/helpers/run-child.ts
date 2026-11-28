import { spawn } from 'node:child_process';

/**
 * Run `node ...args` to completion and report its exit code and stderr.
 * `input`, when given, is written to the child's stdin.
 */
export function runChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stderr }));
    child.stdin.end(input);
  });
}
