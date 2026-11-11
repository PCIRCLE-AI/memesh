/**
 * A PATH on which `tools` cannot be found, and on which everything else still can.
 *
 * A spawned CLI judges "is Codex / Claude Code / Gemini CLI on this machine" by looking for
 * `codex` / `claude` / `gemini` on PATH (and, for the first two, in their config
 * directories), so a test whose fixture means "a machine with none of them" must not
 * inherit the PATH of a developer box that has them installed.
 *
 * Leaving out every directory that holds a tool is not enough: `claude` is very often
 * installed next to `node` (nvm, `npm -g`, a Homebrew prefix), and dropping the
 * directory drops `node` with it. A directory that holds a tool is therefore replaced
 * by a mirror of itself, made of symlinks to everything in it except the tools. The
 * mirrors live under the OS temp directory; `removePathMirrors` deletes them.
 *
 * Three things a mirror has to get right:
 *  - a relative PATH entry is resolved against the folder `pathWithout` is called from, in the
 *    result and in every link (a link target is read from the mirror, not from that folder);
 *  - on a file system that ignores case (macOS, Windows) `Claude` is the tool `claude`;
 *  - a folder that can be searched but not listed (mode 0o111) cannot be mirrored, and dropping it would
 *    silently drop everything else in it, so a tool found in one is an error, not a quiet loss.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const mirrors = new Map<string, string>();
let mirrorRoot: string | undefined;
let cleanupRegistered = false;

/** Remove every mirror this process made. A test file that uses `pathWithout` calls it from `afterAll`. */
export function removePathMirrors(): void {
  if (mirrorRoot) fs.rmSync(mirrorRoot, { recursive: true, force: true });
  mirrorRoot = undefined;
  mirrors.clear();
}

function ensureMirrorRoot(): string {
  if (!mirrorRoot) mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pathmirror-'));
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    // The backstop for a test file that forgot `afterAll`; a killed worker never gets here.
    process.on('exit', () => {
      try { removePathMirrors(); } catch { /* the OS cleans tmp */ }
    });
  }
  return mirrorRoot;
}

const ignoresCase = process.platform === 'darwin' || process.platform === 'win32';
const isTool = (entry: string, tools: string[]): boolean =>
  tools.some((tool) => (ignoresCase ? tool.toLowerCase() === entry.toLowerCase() : tool === entry));

function mirrorWithout(dir: string, entries: string[], tools: string[]): string {
  const key = `${dir}\0${tools.join('\0')}`;
  const known = mirrors.get(key);
  if (known) return known;
  const target = fs.mkdtempSync(path.join(ensureMirrorRoot(), 'dir-'));
  for (const entry of entries) {
    if (isTool(entry, tools)) continue;
    fs.symlinkSync(path.join(dir, entry), path.join(target, entry));
  }
  mirrors.set(key, target);
  return target;
}

export function pathWithout(tools: string | string[], pathValue: string | undefined = process.env.PATH): string {
  const list = Array.isArray(tools) ? tools : [tools];
  const out: string[] = [];
  for (const entry of (pathValue ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const dir = path.resolve(entry);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // A folder that cannot be listed (missing, or searchable only) cannot be mirrored.
      const holdsTool = list.some((tool) => { try { fs.accessSync(path.join(dir, tool), fs.constants.X_OK); return true; } catch { return false; } });
      if (holdsTool) throw new Error(`pathWithout: ${dir} cannot be listed and holds one of ${list.join(', ')}; it cannot be removed from the PATH without losing everything else in it`);
      if (fs.existsSync(dir)) out.push(dir);
      continue;
    }
    out.push(entries.some((name) => isTool(name, list)) ? mirrorWithout(dir, entries, list) : dir);
  }
  return out.join(path.delimiter);
}
