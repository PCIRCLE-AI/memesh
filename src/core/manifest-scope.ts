/**
 * Which files of an installed package the skills manifest covers: everything
 * that is loaded as a prompt or run as a hook. One definition, two users: the
 * build (`scripts/generate-skills-manifest.mjs`) writes the manifest from it,
 * and `memesh doctor` scans the installed package with it and compares what it
 * finds with what the manifest lists. If the two had their own lists, a file
 * could be in the one and not the other and nothing would notice.
 *
 * It lives in the code, not in the manifest: a manifest that declared its own
 * scope could be edited together with the files it is supposed to guard.
 */
import fs from 'fs';
import path from 'path';

/** Single files (declarative host wiring) that must exist in a complete package. */
export const MANIFEST_WIRING_FILES = [
  'hooks/hooks.json',
  'hooks/native-memory.js',
  '.claude-plugin/mcp.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/mcp.json',
  '.codex-plugin/plugin.json',
] as const;

/** Directories walked recursively: every file under `skills/`; the `.js` / `.mjs` files under `scripts/hooks/`. */
export const MANIFEST_SKILLS_DIR = 'skills';
export const MANIFEST_HOOKS_DIR = 'scripts/hooks';

export interface ManifestScope {
  /** Package-relative posix paths of every covered file that exists, sorted. */
  files: string[];
  /** Covered locations that must exist and do not (a directory or a wiring file). */
  missingRequired: string[];
  /** Unsafe or unreadable locations, each with its relative path and reason. Never included in files or read through. */
  issues: string[];
}

/**
 * Names `npm pack` leaves out of a package whatever the package says (the default rules of npm-packlist: the
 * version-control names, editor and OS litter, and the files npm itself keeps out). They are in no installed
 * package, so a copy of the package that has one FILE of such a name (macOS Finder writes `.DS_Store` into any
 * folder it opens) is not tampered with. Matching npm's own list, not a longer one: a name npm would ship is covered.
 * Only files get this pass: a folder with such a name could still contain a loaded skill, so report it without walking it.
 */
const PACK_IGNORED_VCS = new Set(['.git', '.svn', '.hg', 'CVS']);
const PACK_IGNORED_FILE = /^(\.npmignore|\.gitignore|\.npmrc|npm-debug\.log|\.DS_Store|\._.*|\..*\.swp|.*\.orig)$/;
const isPackIgnoredName = (name: string) => PACK_IGNORED_VCS.has(name) || PACK_IGNORED_FILE.test(name);

const isHookFile = (name: string) => /\.(js|mjs)$/i.test(name);

type Found = Pick<ManifestScope, 'files' | 'issues'>;

const posix = (relative: string) => relative.split(path.sep).join('/');

/**
 * Walk down from the package root, one segment at a time, and say whether any segment is a symbolic link. The root
 * itself is not looked at. Returns the package-relative path of the first link, `'absent'` when a segment is missing,
 * or null when every segment is a real folder (or, for the last one, whatever it is).
 */
function firstLinkOnPath(root: string, segments: readonly string[]): string | 'absent' | null {
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : null;
    }
    if (stat.isSymbolicLink()) return posix(path.relative(root, current));
  }
  return null;
}

function walk(root: string, dir: string, keep: (name: string) => boolean, out: Found): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that is not there is the caller's missing location; one that is there and cannot be read
    // is a different fact and must not read as empty.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    out.issues.push(`${posix(path.relative(root, dir))}/ (cannot be read)`);
    return true;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = posix(path.relative(root, full));
    if (entry.isSymbolicLink()) { out.issues.push(`${rel} (symbolic link)`); continue; }
    if (entry.isDirectory()) {
      if (isPackIgnoredName(entry.name)) out.issues.push(`${rel}/ (a folder npm pack never ships)`);
      else walk(root, full, keep, out);
    } else if (entry.isFile()) {
      if (!isPackIgnoredName(entry.name) && keep(entry.name)) out.files.push(rel);
    } else {
      out.issues.push(`${rel} (not a file)`);
    }
  }
  return true;
}

/** Walk a covered folder, unless it (or a folder above it) is a link: then report the link and walk nothing. */
function walkCovered(root: string, segments: readonly string[], keep: (name: string) => boolean, out: Found): boolean {
  const link = firstLinkOnPath(root, segments);
  if (link === 'absent') return false;
  if (link !== null) { out.issues.push(`${link} (symbolic link)`); return true; }
  return walk(root, path.join(root, ...segments), keep, out);
}

export function manifestScope(packageRoot: string): ManifestScope {
  const found: Found = { files: [], issues: [] };
  const missingRequired: string[] = [];
  if (!walkCovered(packageRoot, MANIFEST_SKILLS_DIR.split('/'), () => true, found)) missingRequired.push(`${MANIFEST_SKILLS_DIR}/`);
  if (!walkCovered(packageRoot, MANIFEST_HOOKS_DIR.split('/'), isHookFile, found)) missingRequired.push(`${MANIFEST_HOOKS_DIR}/`);
  for (const rel of MANIFEST_WIRING_FILES) {
    const segments = rel.split('/');
    // A link on the way to the file (the folder above it) is reported as that link, and the file is not read through it.
    const linkAbove = firstLinkOnPath(packageRoot, segments.slice(0, -1));
    if (linkAbove !== null && linkAbove !== 'absent') { found.issues.push(`${linkAbove} (symbolic link)`); continue; }
    // lstat, like the walk: a wiring file that is a link is reported, not followed.
    let stat: fs.Stats | undefined;
    try { stat = fs.lstatSync(path.join(packageRoot, rel)); } catch { /* absent */ }
    if (stat?.isSymbolicLink()) found.issues.push(`${rel} (symbolic link)`);
    else if (stat?.isFile()) found.files.push(rel);
    else missingRequired.push(rel);
  }
  const unique = (list: string[]) => [...new Set(list)].sort();
  return {
    files: unique(found.files),
    missingRequired,
    issues: unique(found.issues),
  };
}
