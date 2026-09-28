import { describe, it, expect } from 'vitest';
import { basename, bashEditedFileNames, bashEditedPaths, isPathShapedFileName, editedFileName } from '../../src/core/bash-edited-paths.js';

/**
 * #495: a captured token that is not path-shaped (a shell variable, a flag
 * consumed as the file target, a fragment of a sed/regex script) must not
 * become a `file:` tag. `bashEditedFileNames` is the one function both
 * session-insight.ts and the Stop hook's generated mirror call — this file
 * is its only direct unit test; the hook-level and repair/invariant-level
 * behavior are covered by their own suites.
 */
describe('bashEditedFileNames (#495 junk-token rejection)', () => {
  it('rejects a bare shell variable captured by `tee -a $F`', () => {
    expect(bashEditedFileNames('tee -a $F')).toEqual([]);
  });

  it('rejects a flag consumed as the file target by `sed -i \'\' -E \'s#^source\' f.md`', () => {
    // The sed regex expects the quoted script immediately after `-i`; `-E`
    // sits between `-i ''` and the script and is what actually lands in the
    // capture slot. Only that one junk token is captured from this command —
    // rejecting it means the whole call yields no file name, not a
    // substitute correct one.
    expect(bashEditedFileNames("sed -i '' -E 's#^source' f.md")).toEqual([]);
  });

  it('rejects a quoted shell variable captured by `cat > "$OUT"`', () => {
    expect(bashEditedFileNames('cat > "$OUT"')).toEqual([]);
  });

  it('keeps a real file name from `cat > notes.md`', () => {
    const result = bashEditedFileNames('cat > notes.md');
    expect(result).toHaveLength(1);
    expect(result).toEqual(['notes.md']);
  });

  it('keeps a real file name from `tee out.txt`', () => {
    expect(bashEditedFileNames('tee out.txt')).toEqual(['out.txt']);
  });

  it('keeps the basename of a heredoc target `cat > a/b.ts <<EOF ... EOF`', () => {
    expect(bashEditedFileNames("cat > a/b.ts <<'EOF'\nhello\nEOF")).toEqual(['b.ts']);
  });

  it('keeps ordinary real names: auth.ts, README.md, the basename of docs/x.md', () => {
    expect(bashEditedFileNames('cat > auth.ts')).toEqual(['auth.ts']);
    expect(bashEditedFileNames('cat > README.md')).toEqual(['README.md']);
    expect(bashEditedFileNames('cat > docs/x.md')).toEqual(['x.md']);
  });

  it('rejects a tilde-prefixed shell token but keeps a real file living under one', () => {
    // The rule targets the shell-debris SHAPE, not "touched a tilde" —
    // isPathShapedFileName runs on the BASENAME, so `~/notes/y.ts` still
    // yields the real file `y.ts`.
    expect(bashEditedFileNames('cat > ~notes')).toEqual([]);
    expect(bashEditedFileNames('cat > ~/notes/y.ts')).toEqual(['y.ts']);
  });

  it('still recognises writeFileSync and pathlib write_text targets', () => {
    expect(bashEditedFileNames("writeFileSync('out/report.json', data)")).toEqual(['report.json']);
    expect(bashEditedFileNames("python3 -c \"import pathlib; pathlib.Path('cache/state.json').write_text('{}')\"")).toEqual(['state.json']);
  });

  it('still excludes /dev and /tmp targets', () => {
    expect(bashEditedFileNames('cat > /dev/null')).toEqual([]);
    expect(bashEditedFileNames('tee /tmp/scratch.log')).toEqual([]);
  });
});

describe('isPathShapedFileName', () => {
  it('rejects empty, $-prefixed, --prefixed and ~-prefixed names', () => {
    expect(isPathShapedFileName('')).toBe(false);
    expect(isPathShapedFileName('$F')).toBe(false);
    expect(isPathShapedFileName('-E')).toBe(false);
    expect(isPathShapedFileName('~notes')).toBe(false);
  });

  it('rejects a name containing a shell/regex metacharacter', () => {
    for (const bad of ['s#^source', 'a*b', 'a?b', 'a`b`', 'a^b', '${F}']) {
      expect(isPathShapedFileName(bad), bad).toBe(false);
    }
  });

  it('rejects a shell expansion anywhere in the name, and a brace expansion', () => {
    for (const bad of ['$1', '$OUT', 'out_${TS}.log', 'x-$(date).md', 'f.{ts,js}']) {
      expect(isPathShapedFileName(bad), bad).toBe(false);
    }
  });

  it('accepts ordinary file names', () => {
    // `{{cookiecutter.slug}}.py` is a real template file name, and `$postId.tsx`
    // a real Remix/TanStack route file — neither is debris.
    for (const good of ['auth.ts', 'README.md', 'x.md', 'notes', 'out.txt', '{{cookiecutter.slug}}.py', '$postId.tsx', 'users.$userId.tsx']) {
      expect(isPathShapedFileName(good), good).toBe(true);
    }
  });
});

describe('bashEditedPaths (raw, unfiltered — the extractor bashEditedFileNames builds on)', () => {
  it('returns the raw captured token, not yet basenamed or filtered', () => {
    expect(bashEditedPaths('tee -a $F')).toEqual(['$F']);
    expect(bashEditedPaths("cat > a/b.ts <<'EOF'\nhello\nEOF")).toEqual(['a/b.ts']);
  });
});

describe('basename', () => {
  it('splits on either separator; a path ending in a separator names a directory, so its basename is empty', () => {
    expect(basename('a/b.ts')).toBe('b.ts');
    expect(basename('a\\b.ts')).toBe('b.ts');
    expect(basename('plain.ts')).toBe('plain.ts');
    expect(basename('out/')).toBe('');
  });

  it('a directory target never becomes a file name', () => {
    expect(bashEditedFileNames('cat > out/')).toEqual([]);
  });
});

describe('editedFileName (an Edit/Write file_path, same rule as the Bash branch)', () => {
  it('basenames on either separator and applies the path-shape rule', () => {
    expect(editedFileName('/repo/src/auth.ts')).toBe('auth.ts');
    expect(editedFileName('C:\\repo\\src\\auth.ts')).toBe('auth.ts');
    expect(editedFileName('/repo/{{cookiecutter.slug}}.py')).toBe('{{cookiecutter.slug}}.py');
    expect(editedFileName('/repo/#scratch#')).toBeNull();
    expect(editedFileName(undefined)).toBeNull();
  });
});
