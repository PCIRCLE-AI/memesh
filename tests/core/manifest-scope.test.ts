/**
 * The covered scope is one definition shared by the build and by `memesh doctor`. This pins them together on the
 * real repository: what the scope finds on disk is exactly what the committed manifest lists, no more, no less.
 * If someone adds a skill or a hook and forgets the build, or the generator grows a list of its own, this is red.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { manifestScope } from '../../src/core/manifest-scope.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });

describe('manifestScope', () => {
  it('finds, in this repository, exactly the files the committed skills manifest lists', () => {
    const root = path.resolve('.');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'skills-manifest.json'), 'utf8')) as { entries: Array<{ path: string }> };
    const scope = manifestScope(root);
    expect(scope.missingRequired).toEqual([]);
    expect(scope.files.length).toBeGreaterThan(20);
    expect(scope.files).toEqual(manifest.entries.map((e) => e.path).sort());
  });

  it('covers skills recursively, hook scripts (.js and .mjs) recursively, and the wiring files; nothing else', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-scope-'));
    dirs.push(root);
    const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
    for (const rel of ['skills/a/SKILL.md', 'skills/a/notes/deep.txt', 'scripts/hooks/h.js', 'scripts/hooks/r.mjs', 'scripts/hooks/_generated/g.js', 'scripts/hooks/readme.md', 'scripts/other.js', 'dist/x.js', 'hooks/hooks.json']) put(rel);
    const scope = manifestScope(root);
    expect(scope.files).toEqual(['hooks/hooks.json', 'scripts/hooks/_generated/g.js', 'scripts/hooks/h.js', 'scripts/hooks/r.mjs', 'skills/a/SKILL.md', 'skills/a/notes/deep.txt']);
    expect(scope.missingRequired).toEqual(['hooks/native-memory.js', '.claude-plugin/mcp.json', '.claude-plugin/plugin.json', '.codex-plugin/mcp.json', '.codex-plugin/plugin.json']);
  });

  it('reports a covered directory that is not there', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-scope-'));
    dirs.push(root);
    expect(manifestScope(root).missingRequired).toEqual(expect.arrayContaining(['skills/', 'scripts/hooks/']));
  });

  const tree = (): { root: string; put: (rel: string) => void } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-scope-'));
    dirs.push(root);
    const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
    return { root, put };
  };

  it('leaves out the names npm pack never ships (npm-packlist default rules), and covers the ones it would ship', () => {
    const { root, put } = tree();
    for (const rel of [
      'skills/a/SKILL.md',
      // never in a published package:
      'skills/.DS_Store', 'skills/a/.DS_Store', 'skills/a/._SKILL.md', 'skills/a/.SKILL.md.swp', 'skills/a/old.orig',
      'skills/a/.git/config', 'skills/a/CVS/Root', 'skills/a/.npmrc', 'skills/a/npm-debug.log', 'skills/a/.gitignore', 'skills/a/.npmignore',
      'scripts/hooks/.DS_Store', 'scripts/hooks/._h.js', 'scripts/hooks/.h.js.swp',
      // npm would ship these, so they are covered:
      'skills/a/SKILL.md.swp', 'skills/a/Thumbs.db', 'skills/a/desktop.ini', 'skills/a/notes.orig.md',
    ]) put(rel);
    expect(manifestScope(root).files.filter((f) => f.startsWith('skills/') || f.startsWith('scripts/')))
      .toEqual(['skills/a/SKILL.md', 'skills/a/SKILL.md.swp', 'skills/a/Thumbs.db', 'skills/a/desktop.ini', 'skills/a/notes.orig.md']);
  });

  it('covers a hook script whatever the case of its extension', () => {
    const { root, put } = tree();
    put('scripts/hooks/h.JS'); put('scripts/hooks/r.MJS'); put('scripts/hooks/notes.JSON');
    expect(manifestScope(root).files).toEqual(['scripts/hooks/h.JS', 'scripts/hooks/r.MJS']);
  });

  it.skipIf(process.platform === 'win32')('reports symbolic links and never follows them (a file link, a folder link, a wiring-file link)', () => {
    const { root, put } = tree();
    put('skills/a/SKILL.md');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-scope-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'evil.md'), 'x');
    fs.symlinkSync(path.join(outside, 'evil.md'), path.join(root, 'skills/a/EVIL.md'));
    fs.symlinkSync(outside, path.join(root, 'skills/evil-dir'));
    put('hooks/native-memory.js.real');
    fs.symlinkSync(path.join(root, 'hooks/native-memory.js.real'), path.join(root, 'hooks/native-memory.js'));
    const scope = manifestScope(root);
    expect(scope.symlinks).toEqual(['hooks/native-memory.js', 'skills/a/EVIL.md', 'skills/evil-dir']);
    expect(scope.files).toEqual(['skills/a/SKILL.md']);
    expect(scope.missingRequired, 'a linked wiring file is reported as a link, not also as missing').not.toContain('hooks/native-memory.js');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a folder it cannot read instead of treating it as empty', () => {
    const { root, put } = tree();
    put('scripts/hooks/h.js'); put('scripts/hooks/_generated/g.js'); put('skills/a/SKILL.md');
    const locked = path.join(root, 'scripts/hooks/_generated');
    fs.chmodSync(locked, 0o000);
    try {
      expect(() => fs.readdirSync(locked), 'the folder is readable: this test would prove nothing').toThrow();
      const scope = manifestScope(root);
      expect(scope.unreadable).toEqual(['scripts/hooks/_generated/']);
      expect(scope.files).not.toContain('scripts/hooks/_generated/g.js');
      expect(scope.missingRequired).not.toContain('scripts/hooks/');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  describe.skipIf(process.platform === 'win32')('a covered folder, or a folder on the way to a covered file, that is itself a symbolic link', () => {
    const outsideWith = (...files: string[]): string => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-scope-outside-'));
      dirs.push(outside);
      for (const rel of files) { fs.mkdirSync(path.dirname(path.join(outside, rel)), { recursive: true }); fs.writeFileSync(path.join(outside, rel), 'x'); }
      return outside;
    };

    it('skills/ and scripts/hooks/ as links are reported, and nothing is walked through them', () => {
      const { root } = tree();
      const outside = outsideWith('a/SKILL.md', 'h.js');
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.symlinkSync(outside, path.join(root, 'skills'));
      fs.symlinkSync(outside, path.join(root, 'scripts', 'hooks'));
      const scope = manifestScope(root);
      expect(scope.symlinks).toEqual(['scripts/hooks', 'skills']);
      expect(scope.files, 'files behind a link were counted as the package\'s own').toEqual([]);
      expect(scope.missingRequired, 'a linked folder is a link, not a missing folder').not.toContain('skills/');
    });

    it('scripts/ as a link is reported as that link', () => {
      const { root } = tree();
      const outside = outsideWith('hooks/h.js');
      fs.symlinkSync(outside, path.join(root, 'scripts'));
      const scope = manifestScope(root);
      expect(scope.symlinks).toContain('scripts');
      expect(scope.files).not.toContain('scripts/hooks/h.js');
    });

    it.each([['hooks'], ['.claude-plugin'], ['.codex-plugin']])('the folder above a wiring file (%s/) as a link is reported, and the file is not read through it', (folder) => {
      const { root } = tree();
      const outside = outsideWith('hooks.json', 'native-memory.js', 'mcp.json', 'plugin.json');
      fs.symlinkSync(outside, path.join(root, folder));
      const scope = manifestScope(root);
      expect(scope.symlinks).toEqual([folder]);
      expect(scope.files.filter((f) => f.startsWith(`${folder}/`))).toEqual([]);
    });

    it('the package root itself being a link (npm link, pnpm) is how it is installed: not reported', () => {
      const { root, put } = tree();
      for (const rel of ['skills/a/SKILL.md', 'scripts/hooks/h.js', 'hooks/hooks.json']) put(rel);
      const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-scope-holder-'));
      dirs.push(holder);
      const viaLink = path.join(holder, 'linked-package');
      fs.symlinkSync(root, viaLink);
      const scope = manifestScope(viaLink);
      expect(scope.symlinks).toEqual([]);
      expect(scope.files).toEqual(['hooks/hooks.json', 'scripts/hooks/h.js', 'skills/a/SKILL.md']);
    });
  });

  it('a FOLDER named like something npm pack leaves out is reported, not skipped: what is inside it is loaded all the same', () => {
    const { root, put } = tree();
    for (const rel of ['skills/a/SKILL.md', 'skills/CVS/SKILL.md', 'skills/evil.orig/SKILL.md', 'skills/.git/SKILL.md', 'skills/._x/SKILL.md', 'scripts/hooks/h.js', 'scripts/hooks/.hg/evil.js']) put(rel);
    const scope = manifestScope(root);
    expect(scope.strayFolders).toEqual(['scripts/hooks/.hg/', 'skills/._x/', 'skills/.git/', 'skills/CVS/', 'skills/evil.orig/']);
    expect(scope.files.filter((f) => /CVS|evil|\.git|\._x|\.hg/.test(f)), 'a stray folder was walked').toEqual([]);
    expect(scope.files).toEqual(['scripts/hooks/h.js', 'skills/a/SKILL.md']);
  });

  it('a FILE named .git, CVS, .svn or .hg is not shipped by npm, so it is not covered, and is not a stray folder either', () => {
    const { root, put } = tree();
    for (const rel of ['skills/a/SKILL.md', 'skills/a/.git', 'skills/a/CVS', 'skills/a/.svn', 'skills/a/.hg']) put(rel);
    const scope = manifestScope(root);
    expect(scope.files.filter((f) => f.startsWith('skills/'))).toEqual(['skills/a/SKILL.md']);
    expect(scope.strayFolders).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('an entry that is not a file, a folder or a link (a named pipe) is reported, and never read', () => {
    const { root, put } = tree();
    put('skills/a/SKILL.md');
    const pipe = path.join(root, 'skills', 'a', 'PIPE.md');
    const made = spawnSync('mkfifo', [pipe]);
    expect(made.status, 'mkfifo is not available: this test would prove nothing').toBe(0);
    const scope = manifestScope(root);
    expect(scope.special).toEqual(['skills/a/PIPE.md']);
    expect(scope.files).toEqual(['skills/a/SKILL.md']);
  });
});
