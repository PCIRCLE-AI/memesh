import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigPath } from '../../src/core/config.js';
import { removeRetiredConfigKeys } from '../../src/core/doctor-fixes.js';

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

