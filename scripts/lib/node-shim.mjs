import fs from 'node:fs';
import path from 'node:path';

/**
 * Write an extensionless Node executable (a stand-in `npm` or `codex` put on
 * PATH by a release check) whose module type cannot be changed by where it
 * lands.
 *
 * Node decides whether an extensionless file is CommonJS or an ES module from
 * the nearest package.json above it. These shims live under TMPDIR, so a
 * stray package.json with "type": "module" anywhere above it turned a
 * CommonJS shim into `require is not defined in ES module scope` (#477). A
 * package.json in the shim's own directory is the nearest one, so it decides.
 *
 * @param {string} dir directory that goes on PATH; holds nothing but shims of this type
 * @param {string} name executable name
 * @param {string} source file contents, starting with `#!/usr/bin/env node`
 * @param {'commonjs' | 'module'} type module system the source is written in
 * @returns {string} the executable's path
 */
export function writeNodeShim(dir, name, source, type) {
  if (type !== 'commonjs' && type !== 'module') throw new Error(`writeNodeShim: unknown module type ${String(type)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ type })}\n`);
  const executable = path.join(dir, name);
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}
