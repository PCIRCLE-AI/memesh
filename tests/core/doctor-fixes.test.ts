import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigPath } from '../../src/core/config.js';
import { PluginRefreshBudgetError, refreshPluginCache, removeRetiredConfigKeys } from '../../src/core/doctor-fixes.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

describe('doctor automatic repairs', () => {
  let dir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-fix-'));
    previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('backs up and removes only known retired top-level keys', () => {
    const original = {
      llm: { provider: 'local', apiKey: 'fixture-secret' },
      llmFallbacks: ['local'],
      embedder: { model: 'legacy' },
      language: 'zh-TW',
      transcriptMining: true,
      autoUpdate: 'patch',
      futureSetting: { keep: true },
    };
    fs.writeFileSync(getConfigPath(), `${JSON.stringify(original)}\n`, { mode: 0o600 });

    const result = removeRetiredConfigKeys();
    expect(result.changed).toBe(true);
    expect(result.removed).toEqual(['llm', 'llmFallbacks', 'embedder', 'language', 'transcriptMining']);
    expect(result.backupPath).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(result.backupPath!, 'utf8'))).toEqual(original);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))).toEqual({
      autoUpdate: 'patch', futureSetting: { keep: true },
    });
  });

  it('does nothing when there are no retired keys', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({ autoCapture: true }));
    expect(removeRetiredConfigKeys()).toMatchObject({ changed: false, removed: [], backupPath: null });
  });
});

describe('plugin cache refresh on Codex runs its two commands under one deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(execFileSync).mockReset();
  });

  /** Every Codex command takes `commandMs`; returns the timeout each command was given. */
  function runWithCommandsTaking(commandMs: number): number[] {
    vi.useFakeTimers({ toFake: ['Date'] });
    const timeouts: number[] = [];
    vi.mocked(execFileSync).mockImplementation(((_cmd: string, _args: string[], options: { timeout?: number }) => {
      timeouts.push(options.timeout ?? 0);
      vi.advanceTimersByTime(commandMs);
      return 'ok';
    }) as unknown as typeof execFileSync);
    refreshPluginCache('/unused', 'codex');
    return timeouts;
  }

  it('gives the second command exactly what the first left of the 120 s budget', () => {
    const timeouts = runWithCommandsTaking(100_000); // the first command took 100 s

    // Two separate 120 s allowances would let the pair run 240 s, past the 150 s
    // the repair button waits.
    expect(timeouts).toEqual([120_000, 20_000]);
  });

  it('still runs the second command when exactly the minimum (5 s) is left', () => {
    expect(runWithCommandsTaking(115_000)).toEqual([120_000, 5_000]);
  });

  it.each([115_001, 120_000, 130_000])(
    'does not start the second command when the first took %i ms: it says the upgrade ran and what to run by hand',
    (commandMs) => {
      let thrown: unknown;
      try { runWithCommandsTaking(commandMs); } catch (error) { thrown = error; }

      expect(thrown).toBeInstanceOf(PluginRefreshBudgetError);
      expect((thrown as Error).name).toBe('PluginRefreshBudgetError');
      expect((thrown as Error).message).toContain('marketplace upgrade ran');
      expect((thrown as Error).message).toContain('codex plugin add memesh@pcircle-memesh');
      expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1); // the upgrade only; `plugin add` never spawned
    },
  );
});
