// The only file that names the native package. It is imported only by the
// bridge's own modules, and the bridge runs only as a child process: a damaged
// native file can kill a process with a signal no try/catch can catch, so it must
// never be loaded into anything a person is relying on.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IrohModule } from './iroh-types.js';
import { currentLibc, platformPackages } from './runtime-platform.js';
import { errorMessage } from './types.js';

/**
 * Load from the runtime folder and nowhere else. Plain package resolution walks up
 * through parent node_modules and NODE_PATH, and the package's own loader does the
 * same for its platform file, so an absent platform package could silently be
 * replaced by a copy the pinned checksums never covered. Checked before loading:
 * once the file is loaded it is too late.
 */
export function loadNative(runtimeDirectory: string): IrohModule {
  const lockText = fs.readFileSync(path.join(runtimeDirectory, 'package-lock.json'), 'utf8');
  const packages = platformPackages(lockText, process.platform, process.arch, currentLibc());
  if (!packages.some((name) => fs.existsSync(path.join(runtimeDirectory, 'node_modules', name, 'package.json')))) {
    throw new Error(`the native networking file for ${process.platform}-${process.arch} is missing from the install`);
  }
  const requireFromRuntime = createRequire(path.join(runtimeDirectory, 'package.json'));
  return requireFromRuntime(path.join(runtimeDirectory, 'node_modules', '@number0', 'iroh')) as IrohModule;
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
  if (messages.length === 1 && ['MODULE_NOT_FOUND', 'ENOENT'].includes(String((err as NodeJS.ErrnoException).code))) {
    return 'the networking component is not installed';
  }
  const absent = messages.find((message) => /is missing from the install$/.test(message));
  if (absent) return absent;
  const mismatch = messages.find((message) => /version mismatch/.test(message));
  if (mismatch) return `the installed networking files do not match each other (${mismatch})`;
  const damaged = messages.find((message) => /dlopen|slice is not valid|too short|file too|not a mach-o|invalid ELF|wrong ELF|code signature/i.test(message));
  if (damaged) return `the native networking file is damaged or cannot run here (${damaged.split('\n')[0].slice(0, 200)})`;
  if (messages.some((message) => /npm has a bug|Cannot find native binding/.test(message))) {
    return `the native networking file for ${process.platform}-${process.arch} is missing from the install`;
  }
  return errorMessage(err).split('\n')[0];
}
