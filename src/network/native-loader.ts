// The only file that loads the native package. It is imported only by the bridge's
// own modules, and the bridge runs only as a child process: a damaged native file
// can kill a process with a signal no try/catch can catch, so it must never be
// loaded into anything a person is relying on.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IrohModule } from './iroh-types.js';
import { currentLibc, platformPackage } from './runtime-platform.js';
import { errorMessage } from './types.js';

/**
 * Load the `.node` file itself, by full path, from the platform package the lock
 * names for this computer. The package's own index.js is not used: it tries other
 * package names first (a universal build, a WASI fallback) by walking up through
 * parent node_modules, and honours an environment variable naming any file, so it
 * could run code the pinned checksums never covered. Its exports are this file's
 * (measured: the same 26 names, the same objects).
 */
export function loadNative(runtimeDirectory: string): IrohModule {
  const lockText = fs.readFileSync(path.join(runtimeDirectory, 'package-lock.json'), 'utf8');
  const name = platformPackage(lockText, process.platform, process.arch, currentLibc());
  const directory = path.join(runtimeDirectory, 'node_modules', name ?? 'none');
  let main: string;
  try {
    main = (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as { main: string }).main;
  } catch {
    throw new Error(`the native networking file for ${process.platform}-${process.arch} is missing from the install`);
  }
  return createRequire(path.join(runtimeDirectory, 'package.json'))(path.join(directory, main)) as IrohModule;
}

/** Why a load failed, in a person's terms. */
export function explainLoadFailure(err: unknown): string {
  const message = errorMessage(err).split('\n')[0];
  if (/is missing from the install$/.test(message)) return message;
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'the networking component is not installed';
  return `the native networking file is damaged or cannot run here (${message.slice(0, 200)})`;
}
