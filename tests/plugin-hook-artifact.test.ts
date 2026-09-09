import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
