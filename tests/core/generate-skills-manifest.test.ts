/**
 * The build step that writes dist/skills-manifest.json refuses, with exit 1, to write an incomplete one: a covered
 * location that is missing, a symbolic link where files are covered, a folder it cannot read. Each used to be
 * either skipped or silently dropped, which left the manifest short and `memesh doctor` still saying PASS.
 *
 * Runs the real generator against a throwaway copy of the layout it expects (its own scripts/ and the compiled
 * scope module under dist/), so the repository's own manifest is never touched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';
import { canDenyReads } from '../helpers/permissions.js';

const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });

function layout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-gen-manifest-'));
  dirs.push(root);
  const copy = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    fs.copyFileSync(path.resolve(from), path.join(root, to));
  };
  copy('scripts/generate-skills-manifest.mjs', 'scripts/generate-skills-manifest.mjs');
  copy('dist/core/manifest-scope.js', 'dist/core/manifest-scope.js');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
  for (const rel of ['hooks/hooks.json', 'hooks/native-memory.js', '.claude-plugin/mcp.json', '.claude-plugin/plugin.json',
    '.codex-plugin/mcp.json', '.codex-plugin/plugin.json', 'skills/a/SKILL.md', 'scripts/hooks/h.js', 'scripts/hooks/_generated/g.js']) put(rel);
  return root;
}

function generate(root: string) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-skills-manifest.mjs')], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stderr: r.stderr ?? '' };
}

const listed = (root: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(root, 'dist', 'skills-manifest.json'), 'utf8')) as { entries: Array<{ path: string }> }).entries.map((e) => e.path);

describe('generate-skills-manifest', () => {
  it('writes every covered file of a complete layout, and leaves out what npm pack never ships', () => {
    const root = layout();
    fs.writeFileSync(path.join(root, 'skills', '.DS_Store'), 'finder');
    const r = generate(root);
    expect(r.status, r.stderr).toBe(0);
    expect(listed(root)).toHaveLength(9);
    expect(listed(root)).not.toContain('skills/.DS_Store');
  });

  it('exits 1 when a covered wiring file is missing, and writes no manifest', () => {
    const root = layout();
    fs.rmSync(path.join(root, 'hooks', 'native-memory.js'));
    const r = generate(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hooks/native-memory.js');
    expect(fs.existsSync(path.join(root, 'dist', 'skills-manifest.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('exits 1 on a symbolic link where files are covered', () => {
    const root = layout();
    fs.symlinkSync(path.join(root, 'skills', 'a', 'SKILL.md'), path.join(root, 'skills', 'a', 'LINK.md'));
    const r = generate(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('skills/a/LINK.md');
    expect(fs.existsSync(path.join(root, 'dist', 'skills-manifest.json'))).toBe(false);
  });

  it.skipIf(!canDenyReads)('exits 1 when a covered folder cannot be read, instead of writing a short manifest', () => {
    const root = layout();
    const locked = path.join(root, 'scripts', 'hooks', '_generated');
    fs.chmodSync(locked, 0o000);
    try {
      const r = generate(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('scripts/hooks/_generated/');
      expect(fs.existsSync(path.join(root, 'dist', 'skills-manifest.json'))).toBe(false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it.skipIf(process.platform === 'win32').each([
    ['skills', 'skills'],
    ['scripts/hooks', 'scripts/hooks'],
    ['hooks', 'hooks'],
    ['.claude-plugin', '.claude-plugin'],
  ])('exits 1 when the covered folder %s is itself a symbolic link, and writes no manifest', (rel, named) => {
    const root = layout();
    const real = path.join(root, 'outside');
    fs.renameSync(path.join(root, rel), real);
    fs.symlinkSync(real, path.join(root, rel));
    const r = generate(root);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(named);
    expect(fs.existsSync(path.join(root, 'dist', 'skills-manifest.json'))).toBe(false);
  });

  it('exits 1 on a folder named like something npm pack leaves out (a skill under skills/CVS/ would be loaded all the same)', () => {
    const root = layout();
    fs.mkdirSync(path.join(root, 'skills', 'CVS'));
    fs.writeFileSync(path.join(root, 'skills', 'CVS', 'SKILL.md'), 'x');
    const r = generate(root);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('skills/CVS/');
    expect(fs.existsSync(path.join(root, 'dist', 'skills-manifest.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('exits 1 on an entry that is not a file (a named pipe)', () => {
    const root = layout();
    const made = spawnSync('mkfifo', [path.join(root, 'skills', 'a', 'PIPE.md')]);
    expect(made.status, 'mkfifo is not available: this test would prove nothing').toBe(0);
    const r = generate(root);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('skills/a/PIPE.md');
    expect(fs.existsSync(path.join(root, 'dist', 'skills-manifest.json'))).toBe(false);
  });
});
