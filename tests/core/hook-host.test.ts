import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectHookHost } from '../../src/core/capture-liveness.js';
import { pluginRootIsHookRoot } from '../../scripts/hooks/_shared.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Codex runs the same hooks/hooks.json as Claude Code, and its payloads carry
 * hook_event_name, so every Codex hook run was recorded as `claude-code`
 * until PLUGIN_ROOT (the Codex companion's own signal) was checked first (#325).
 */
describe('detectHookHost', () => {
  it('labels a Codex hook run codex although its payload looks like Claude Code', () => {
    expect(detectHookHost({ hook_event_name: 'PreCompact', transcript_path: '/t' }, { PLUGIN_ROOT: '/p/memesh/4.10.5' })).toBe('codex');
  });

  it('labels it codex when a Claude plugin root is also set to the same directory', () => {
    const env = { PLUGIN_ROOT: '/p/memesh/4.10.5', CLAUDE_PLUGIN_ROOT: '/p/memesh/4.10.5' };
    expect(detectHookHost({ hook_event_name: 'PreCompact' }, env)).toBe('codex');
  });

  it('does not let an inherited PLUGIN_ROOT relabel a Claude plugin hook', () => {
    const env = { PLUGIN_ROOT: '/somewhere/else', CLAUDE_PLUGIN_ROOT: '/p/memesh/4.10.5' };
    expect(detectHookHost({ hook_event_name: 'Stop' }, env)).toBe('claude-code');
  });

  it('labels a Claude Code hook run claude-code', () => {
    expect(detectHookHost({ hook_event_name: 'Stop' }, { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PROJECT_DIR: '/r' })).toBe('claude-code');
  });

  it('keeps the explicit override first', () => {
    expect(detectHookHost(null, { MEMESH_HOOK_HOST: 'claude-code', PLUGIN_ROOT: '/p' })).toBe('claude-code');
  });

  it('returns unknown with no signal at all', () => {
    expect(detectHookHost(null, {})).toBe('unknown');
  });

  it('treats an empty PLUGIN_ROOT as absent', () => {
    expect(detectHookHost(null, { PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '/p' })).toBe('claude-code');
  });

  // A `memesh install-hooks` (settings.json) install has no CLAUDE_PLUGIN_ROOT at
  // run time, so an inherited PLUGIN_ROOT alone used to relabel it codex. The hook
  // now passes whether PLUGIN_ROOT is its own plugin root (Codex sets it to the
  // directory the hook runs from).
  it('a stray PLUGIN_ROOT does not relabel a settings.json-installed Claude hook', () => {
    const env = { PLUGIN_ROOT: '/somewhere/else', CLAUDECODE: '1' };
    expect(detectHookHost({ hook_event_name: 'Stop' }, env, { pluginRootIsHookRoot: false })).toBe('claude-code');
  });

  it('PLUGIN_ROOT that is the hook\'s own plugin root reads as codex', () => {
    expect(detectHookHost({ hook_event_name: 'Stop' }, { PLUGIN_ROOT: '/p' }, { pluginRootIsHookRoot: true })).toBe('codex');
  });
});

describe('detectHookHost with a PLUGIN_ROOT that is not the hook root (#447)', () => {
  it('reads unknown rather than guessing claude-code from the payload', () => {
    expect(detectHookHost({ hook_event_name: 'Stop' }, { PLUGIN_ROOT: '/x' }, { pluginRootIsHookRoot: false })).toBe('unknown');
  });

  it('still reads claude-code when a Claude signal is present', () => {
    expect(detectHookHost({ hook_event_name: 'Stop' }, { PLUGIN_ROOT: '/x', CLAUDECODE: '1' }, { pluginRootIsHookRoot: false })).toBe('claude-code');
  });
});

describe('pluginRootIsHookRoot', () => {
  it('is true when PLUGIN_ROOT is the directory the hooks run from', () => {
    expect(pluginRootIsHookRoot({ PLUGIN_ROOT: repoRoot })).toBe(true);
  });

  it('is false for another directory, a missing one, or no PLUGIN_ROOT', () => {
    expect(pluginRootIsHookRoot({ PLUGIN_ROOT: path.join(repoRoot, 'src') })).toBe(false);
    expect(pluginRootIsHookRoot({ PLUGIN_ROOT: '/no/such/dir/for/memesh' })).toBe(false);
    expect(pluginRootIsHookRoot({})).toBe(false);
  });

  it('says on stderr when PLUGIN_ROOT cannot be resolved, once per run, instead of failing silently (#447)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const env = { PLUGIN_ROOT: '/no/such/dir/for/memesh-stderr-probe' };
      expect(pluginRootIsHookRoot(env)).toBe(false);
      expect(pluginRootIsHookRoot(env)).toBe(false);
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('PLUGIN_ROOT'));
      expect(lines).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
