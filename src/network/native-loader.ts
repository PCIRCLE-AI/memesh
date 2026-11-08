// The only file that loads the native package. It is imported only by the bridge's
// own modules, and the bridge runs only as a child process: a damaged native file
// can kill a process with a signal no try/catch can catch, so it must never be
// loaded into anything a person is relying on.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IrohModule } from './iroh-types.js';
import { currentLibc, nativeFileName, platformPackage } from './runtime-platform.js';
import { errorMessage } from './types.js';

/**
 * Load the `.node` file itself, by full path, from the platform package the lock
 * names for this computer. The package's own index.js is not used: it tries other
 * package names first (a universal build, a WASI fallback) by walking up through
 * parent node_modules, and honours an environment variable naming any file, so it
 * could run code the pinned checksums never covered. Its exports are this file's
 * (measured: the same 26 names, the same objects). The name is fixed, not read from
 * a package.json, and a symlink out of the runtime folder is refused.
 */
export function loadNative(runtimeDirectory: string): IrohModule {
  const lockText = fs.readFileSync(path.join(runtimeDirectory, 'package-lock.json'), 'utf8');
  const name = platformPackage(lockText, process.platform, process.arch, currentLibc());
  const missing = `the native networking file for ${process.platform}-${process.arch} is missing from the install`;
  if (name === null) throw new Error(missing);
  let file: string;
  try {
    file = fs.realpathSync(path.join(runtimeDirectory, 'node_modules', name, nativeFileName(name)));
  } catch {
    throw new Error(missing);
  }
  if (!file.startsWith(fs.realpathSync(runtimeDirectory) + path.sep)) {
    throw new Error('the native networking file points outside the install, so it was not loaded');
  }
  return createRequire(path.join(runtimeDirectory, 'package.json'))(file) as IrohModule;
}

/** Why a load failed, in a person's terms. */
export function explainLoadFailure(err: unknown): string {
  const message = errorMessage(err).split('\n')[0];
  if (/is missing from the install$|points outside the install/.test(message)) return message;
  // Windows reports a damaged .node file in words, not in its code: checked before ENOENT.
  const windowsDamaged = /is not a valid Win32 application|dynamic link library \(DLL\) initialization routine failed/i.test(errorMessage(err));
  if (!windowsDamaged && (err as NodeJS.ErrnoException).code === 'ENOENT') return 'the networking component is not installed';
  return `the native networking file is damaged or cannot run here (${message.slice(0, 200)})`;
}
