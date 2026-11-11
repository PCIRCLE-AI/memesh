import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigPath } from '../../src/core/config.js';
import { refreshPluginCache, removeRetiredConfigKeys } from '../../src/core/doctor-fixes.js';

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

describe('the plugin cache repair is the verified reinstall, started in the background', () => {
  let dir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-reinstall-'));
    previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = path.join(dir, 'data');
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function stubPlugin(): { root: string; argvFile: string } {
    const root = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
    const argvFile = path.join(dir, 'argv.txt');
    // The runner the repair starts: it only records how it was called.
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join(' '));\n`);
    return { root, argvFile };
  }

  async function waitForFile(file: string): Promise<string> {
    for (let i = 0; i < 100 && !fs.existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 100));
    return fs.readFileSync(file, 'utf8');
  }

  it.each(['claude-code', 'codex'] as const)('%s: starts the runner with --reinstall (never --manual, never a host command), and says so', async (host) => {
    const { root, argvFile } = stubPlugin();
    const result = refreshPluginCache(root, host);
    expect(result).toMatchObject({ host, command: 'memesh update --reinstall', exitCode: 0, restartRequired: true });
    expect(result.output).toContain('verified reinstall');
    expect(result.output).toContain('auto-update.log');
    const argv = await waitForFile(argvFile);
    expect(argv).toMatch(/auto-update\.lock --reinstall$/);
    // No host command ran: the old repair ran `codex plugin marketplace upgrade` / the unpinned upgrade script.
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('says what is wrong when the runner is missing, instead of reporting a repair that never started', () => {
    expect(() => refreshPluginCache(path.join(dir, 'nowhere'), 'codex')).toThrow(/runner is missing/);
  });
});
