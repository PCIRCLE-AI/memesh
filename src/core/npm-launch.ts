import fs from 'node:fs';
import path from 'node:path';

/**
 * On Windows run npm's script with this Node, without cmd.exe: a timeout must
 * kill npm itself. Node's Windows installer keeps this script beside node.exe.
 * Other layouts fail closed instead of falling back to a shell.
 */
export function npmInvocation(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists: (file: string) => boolean = fs.existsSync,
): { command: string; args: string[] } | null {
  if (platform !== 'win32') return { command: 'npm', args };
  const cli = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return exists(cli) ? { command: execPath, args: [cli, ...args] } : null;
}

export class NpmStartError extends Error {}

export function requireNpmInvocation(args: string[]): { command: string; args: string[] } {
  const invocation = npmInvocation(args);
  if (!invocation) throw new NpmStartError('could not start npm: npm-cli.js was not found beside Node');
  return invocation;
}
