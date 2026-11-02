// The only file that names the native package. It is imported only by the
// bridge's own modules, and the bridge runs only as a child process: a damaged
// native file can kill a process with a signal no try/catch can catch, so it must
// never be loaded into anything a person is relying on.

import { createRequire } from 'node:module';
import path from 'node:path';
import type { IrohModule } from './iroh-types.js';
import { errorMessage } from './types.js';

export function loadNative(runtimeDirectory: string): IrohModule {
  const requireFromRuntime = createRequire(path.join(runtimeDirectory, 'package.json'));
  return requireFromRuntime('@number0/iroh') as IrohModule;
}

/**
 * Turn a load failure into its real reason. When the platform package is absent
 * the loader says "npm has a bug related to optional dependencies" and tells you
 * to delete your lockfile, which is wrong and would remove the pinned checksums.
 * What actually happened is in the error's `cause` chain.
 */
export function explainLoadFailure(err: unknown): string {
  const messages: string[] = [];
  for (let at: unknown = err; at instanceof Error && messages.length < 16; at = at.cause) {
    messages.push(at.message);
  }
  const specific = messages.find((message) => /^Unsupported /.test(message));
  if (specific) return `this computer is not supported (${specific})`;
  if (messages.length === 1 && (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
    return 'the networking component is not installed';
  }
  const mismatch = messages.find((message) => /version mismatch/.test(message));
  if (mismatch) return `the installed networking files do not match each other (${mismatch})`;
  const damaged = messages.find((message) => /dlopen|slice is not valid|too short|file too|not a mach-o|invalid ELF|wrong ELF|code signature/i.test(message));
  if (damaged) return `the native networking file is damaged or cannot run here (${damaged.split('\n')[0].slice(0, 200)})`;
  if (messages.some((message) => /npm has a bug|Cannot find native binding/.test(message))) {
    return `the native networking file for ${process.platform}-${process.arch} is missing from the install`;
  }
  return errorMessage(err).split('\n')[0];
}
