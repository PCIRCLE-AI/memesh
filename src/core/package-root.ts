/**
 * The directory of this package (the one holding its package.json), found by walking up from a module's own URL.
 * One answer for every entry point: the CLI, the MCP server and the update notice used three hand-counted `../..`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function findPackageRoot(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no package.json above ${fileURLToPath(moduleUrl)}`);
    dir = up;
  }
}
