// bash-edited-paths — file paths a shell command writes in place, plus the
// filter that keeps a captured token from becoming a `file:` tag when it is
// not actually a path (#495).
//
// Runtime-leaf module (node builtins only): session-insight.ts imports this
// source, the Stop hook imports the generated copy under
// scripts/hooks/_generated/ (see scripts/generate-hook-core.mjs).
//
// Why the filter exists. The six regexes below capture whatever token sits
// where a shell command's file argument usually is. Most of the time that
// token IS a path (`cat > notes.md`), but `tee -a $F` captures the shell
// variable `$F`, and `sed -i '' -E 's#^source' f.md` captures the flag `-E`
// (the regex expects the quoted script to follow `-i` immediately; `-E`
// lands in the capture slot instead, between `-i ''` and the script). Both
// used to become `file:$F` / `file:-E` tags on the entity's `-files` /
// `-fixes` snapshot — shell debris, not a file memesh edited, and noise on
// the exact join pre-edit recall's Strategy 1 uses (`file:<basename>`,
// docs/ARCHITECTURE.md). Measured on a real graph: 14+ such tags across 8
// entities, one entity carrying ~400 of them.

/**
 * Is `name` a plausible file name rather than a shell fragment leaked into
 * the same capture slot? `name` is expected to already be a basename (no
 * path separators left) — the last segment of whatever `bashEditedPaths` or
 * a tool's own `file_path`/`path` argument produced. Every `file:` tag goes
 * through this, from Bash and from Edit/Write alike, and so do the one-time
 * repair and the memory invariant: one rule, so a tag the write path keeps
 * is never one the invariant flags.
 *
 * Rejects: empty; starts with `-` (a flag consumed as the file target) or `~`
 * (a bare home-directory token, as opposed to a real path under one — that
 * reaches this function already basenamed, e.g. `~/notes/y.ts` → `y.ts`); a
 * shell expansion — a bare variable (`$F`, `$1`) or `${…}` / `$(…)` anywhere
 * (`out_${TS}.log`); a brace expansion (`f.{ts,js}`, several names, not one);
 * a sed/regex metacharacter (`#`, `^`, `*`, `?`, a backtick). Keeps ordinary
 * names (`auth.ts`, `README.md`) and two real shapes that look close: a `$`
 * inside a name (`$postId.tsx`, a Remix or TanStack route file) and a
 * template's `{{cookiecutter.slug}}.py`, which has no comma.
 */
export function isPathShapedFileName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith('-') || name.startsWith('~')) return false;
  if (/^\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])$/.test(name) || /\$[{(]/.test(name)) return false;
  if (/\{[^{}]*,[^{}]*\}/.test(name)) return false;
  if (/[#^*?`]/.test(name)) return false;
  return true;
}

/** Basename on either separator — shared by tool `file_path`s and bash-captured
 *  paths. A path ending in a separator names a directory: its basename is ''. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * File paths a shell command writes in place: heredoc redirection, `cat >`,
 * `tee`, `sed -i`, pathlib `write_text`, `fs.writeFileSync`. Anything
 * unmatched is simply uncounted — not asserted as zero.
 *
 * Raw captures: NOT basenamed, NOT filtered. `bashEditedFileNames` below is
 * what callers storing file NAMES want; `bashWritesFiles` (graph-repairs.ts)
 * deliberately uses this unfiltered form — see its docstring for why.
 */
export function bashEditedPaths(cmd: unknown): string[] {
  if (typeof cmd !== 'string') return [];
  const found = new Set<string>();
  for (const re of [
    /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/g,
    /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/g,
    /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/g,
    /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/g,
    /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/g,
    /writeFileSync\(\s*['"]([^'"]+)['"]/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
      if (m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/')) found.add(m[1]);
    }
  }
  return [...found];
}

/**
 * `bashEditedPaths`, basenamed and filtered to path-shaped names only
 * (#495). This is what session-insight.ts and the Stop hook actually store
 * as an edited FILE NAME (and, from there, a `file:<name>` tag) — the filter
 * runs on the basename, not the raw captured token, so `cat > ~/x/y.ts`
 * still keeps the real edit `y.ts` instead of losing it to the `~` rule.
 */
export function bashEditedFileNames(cmd: unknown): string[] {
  const names = new Set<string>();
  for (const p of bashEditedPaths(cmd)) {
    const name = basename(p);
    if (isPathShapedFileName(name)) names.add(name);
  }
  return [...names];
}

/**
 * The file name an Edit/Write-style tool's `file_path` stores as a `file:`
 * tag, under the same basename and path-shape rule as the Bash branch; null
 * when there is none to store.
 */
export function editedFileName(filePath: unknown): string | null {
  const name = typeof filePath === 'string' ? basename(filePath) : '';
  return isPathShapedFileName(name) ? name : null;
}
