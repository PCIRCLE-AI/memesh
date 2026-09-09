import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookTargetsFromManifest, validateArtifactPaths, validateHookTargets, validatePluginEntrypoints } from '../scripts/check-plugin-hook-artifact.mjs';

describe('plugin hook artifact integrity', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-plugin-hook-integrity-'));
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-compact.js' }] }],
    } }));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('fails closed when a declared hook file is missing', () => {
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'session-start.js'), '');
    const result = validateHookTargets(root);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([expect.objectContaining({ event: 'PreCompact', relative: 'scripts/hooks/pre-compact.js' })]);
  });

  it('accepts a complete manifest and rejects an omitted packed target', () => {
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'session-start.js'), '');
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'pre-compact.js'), '');
    const source = validateHookTargets(root);
    expect(source.ok).toBe(true);
    expect(validateArtifactPaths(source.targets, ['hooks/hooks.json', 'scripts/hooks/session-start.js']).ok).toBe(false);
    expect(validateArtifactPaths(source.targets, ['hooks/hooks.json', 'scripts/hooks/session-start.js', 'scripts/hooks/pre-compact.js']).ok).toBe(true);
  });

  it('rejects traversal and shell fragments', () => {
    expect(() => hookTargetsFromManifest({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/../escape.js' }] }] } })).toThrow();
    expect(() => hookTargetsFromManifest({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/x.js --flag' }] }] } })).toThrow();
  });

  it('rejects a hook symlink that escapes the staged plugin', () => {
    const outside = path.join(root, '..', `memesh-hook-outside-${process.pid}.js`);
    fs.writeFileSync(outside, '');
    try {
      fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'session-start.js'), '');
      fs.symlinkSync(outside, path.join(root, 'scripts', 'hooks', 'pre-compact.js'));
      expect(validateHookTargets(root).ok).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('rejects a symlinked directory above a hook target', () => {
    // The lstat-only check saw a regular file at the leaf and passed; the
    // directory it sat in pointed outside the staged plugin.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-outside-dir-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'session-start.js'), '');
      fs.writeFileSync(path.join(outsideDir, 'pre-compact.js'), '');
      fs.rmSync(path.join(root, 'scripts', 'hooks'), { recursive: true, force: true });
      fs.symlinkSync(outsideDir, path.join(root, 'scripts', 'hooks'), 'dir');
      const result = validateHookTargets(root);
      expect(result.ok).toBe(false);
      expect(result.missing).toHaveLength(2);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('loads and passes from the npm tarball, not only from the repository', () => {
    // `memesh upgrade-plugin` prefers the npm-installed copy of the updater,
    // and the updater runs THIS checker fail-closed. v4.9.4's first candidate
    // packed the checker without `scripts/lib/npm-bin.mjs`, so from an npm
    // install it died on import and every upgrade was refused — while
    // `pkg.files` contained the checker and the gate reported PASS. Only
    // executing the unpacked artifact pins the dependency.
    const repoRoot = path.resolve(__dirname, '..');
    const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pack-run-'));
    try {
      const pack = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {
        cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000,
      });
      expect(pack.status, pack.stderr).toBe(0);
      const tarball = path.join(packDir, JSON.parse(pack.stdout)[0].filename);
      const untar = spawnSync('tar', ['-xzf', tarball, '-C', packDir], { encoding: 'utf8', timeout: 60000 });
      expect(untar.status, untar.stderr).toBe(0);
      const packageRoot = path.join(packDir, 'package');
      const run = spawnSync(process.execPath, [
        path.join(packageRoot, 'scripts', 'check-plugin-hook-artifact.mjs'), '--root', packageRoot, '--skip-pack',
      ], { encoding: 'utf8', timeout: 60000 });
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      expect(run.stdout).toMatch(/plugin artifact integrity: PASS/);

      // Through a symlink, explicitly. The guard that decides whether main()
      // runs compares import.meta.url (symlinks resolved by Node) with argv[1]
      // (not resolved); on macOS os.tmpdir() is itself a symlink so the run
      // above already crosses one, on Linux CI it is not, and the regression
      // would pass there. A named symlink makes the pin hold on every OS.
      const linkDir = path.join(packDir, 'linkdir');
      fs.mkdirSync(linkDir);
      const linked = path.join(linkDir, 'checker.mjs');
      fs.symlinkSync(path.join(packageRoot, 'scripts', 'check-plugin-hook-artifact.mjs'), linked);
      const viaLink = spawnSync(process.execPath, [linked, '--root', packageRoot, '--skip-pack'], { encoding: 'utf8', timeout: 60000 });
      expect(viaLink.status, `${viaLink.stdout}${viaLink.stderr}`).toBe(0);
      expect(viaLink.stdout).toMatch(/plugin artifact integrity: PASS/);
    } finally {
      fs.rmSync(packDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 240000);

  it('requires both host MCP manifests and their bundled entrypoint', () => {
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'session-start.js'), '');
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'pre-compact.js'), '');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'memesh', version: '1.2.3', mcpServers: './.claude-plugin/mcp.json' }));
    fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'memesh', version: '1.2.3', mcpServers: './.codex-plugin/mcp.json' }));
    fs.writeFileSync(path.join(root, '.claude-plugin', 'mcp.json'), JSON.stringify({ mcpServers: { memesh: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'] } } }));
    fs.writeFileSync(path.join(root, '.codex-plugin', 'mcp.json'), JSON.stringify({ mcpServers: { memesh: { command: 'node', args: ['./dist/mcp/server.js'] } } }));
    expect(() => validatePluginEntrypoints(root)).toThrow(/entrypoint/);
    fs.writeFileSync(path.join(root, 'dist', 'mcp', 'server.js'), '');
    expect(validatePluginEntrypoints(root).targets.map(({ relative }) => relative)).toContain('dist/mcp/server.js');
  });

  it('runs before the upgrade script swaps the staged cache', () => {
    const upgrade = fs.readFileSync(path.resolve('scripts/upgrade-plugin.sh'), 'utf8');
    const check = upgrade.indexOf('check-plugin-hook-artifact.mjs');
    const swap = upgrade.indexOf('# ─── 5. Swap the staged copy');
    expect(check).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(check);
  });
});
