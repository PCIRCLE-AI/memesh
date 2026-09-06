import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigUnreadableError,
  getConfigDir,
  getConfigPath,
  readConfig,
  readConfigResult,
  updateConfig,
} from '../../src/core/config.js';

describe('FTS-only config', () => {
  let dir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-config-'));
    previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    expect(path.relative(path.resolve(dir), path.resolve(getConfigPath()))).toBe('config.json');
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function rawConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
  }

  it('treats an absent file as an empty supported configuration', () => {
    expect(readConfigResult()).toEqual({ config: {}, state: 'absent' });
    expect(readConfig()).toEqual({});
  });

  it('round-trips only the four retained settings', () => {
    updateConfig({
      autoCapture: false,
      sessionLimit: 7,
      autoUpdate: 'minor',
      setupCompleted: true,
    });
    expect(readConfig()).toEqual({
      autoCapture: false,
      sessionLimit: 7,
      autoUpdate: 'minor',
      setupCompleted: true,
    });
    expect(getConfigDir()).toBe(dir);
  });

  it('removes retired provider/key/vector fields on the next successful write', () => {
    const legacy = {
      llm: { provider: 'openai', apiKey: 'fixture-secret' },
      embedder: { provider: 'ollama' },
      transcriptMining: true,
      language: 'zh-TW',
      futureSetting: { keep: true },
      autoUpdate: 'patch',
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(legacy));

    expect(readConfig()).toEqual({ autoUpdate: 'patch' });
    updateConfig({ sessionLimit: 12 });

    expect(rawConfig()).toEqual({ futureSetting: { keep: true }, autoUpdate: 'patch', sessionLimit: 12 });
    expect(readConfig()).toEqual({ autoUpdate: 'patch', sessionLimit: 12 });
  });

  it('preserves unknown extension keys while removing known retired keys', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({
      llm: { provider: 'anthropic', apiKey: 'fixture-secret' },
      futureSetting: { keep: true },
      autoCapture: false,
      sessionLimit: 99,
    }));

    updateConfig({ autoCapture: undefined, sessionLimit: undefined, autoUpdate: 'off' });

    expect(rawConfig()).toEqual({
      futureSetting: { keep: true },
      autoUpdate: 'off',
    });
  });

  it('updateConfig can remove one retained setting without touching other data', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({
      llm: { provider: 'ollama' },
      autoCapture: true,
      autoUpdate: 'major',
    }));
    expect(updateConfig({ autoCapture: undefined })).toEqual({ autoUpdate: 'major' });
    expect(rawConfig()).toEqual({ autoUpdate: 'major' });
  });

  it('does not expose malformed retained values', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({
      autoCapture: 'yes',
      sessionLimit: 'ten',
      autoUpdate: 'automatic',
      setupCompleted: 1,
    }));
    expect(readConfig()).toEqual({});
  });

  it('hardens the settings directory and file on POSIX systems', () => {
    updateConfig({ sessionLimit: 5 });
    if (process.platform !== 'win32') {
      expect(fs.statSync(getConfigDir()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('traces corrupt JSON once and refuses to overwrite it', () => {
    fs.writeFileSync(getConfigPath(), '{ broken');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(readConfigResult()).toEqual({ config: {}, state: 'unreadable' });
      expect(readConfig()).toEqual({});
      expect(() => updateConfig({ autoUpdate: 'patch' })).toThrow(ConfigUnreadableError);
      expect(writes.filter((line) => line.includes('[memesh config]'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe('{ broken');
  });

  it('rejects a non-object top-level value as unreadable', () => {
    fs.writeFileSync(getConfigPath(), '[]');
    expect(readConfigResult().state).toBe('unreadable');
    expect(() => updateConfig({ autoCapture: true })).toThrow(ConfigUnreadableError);
  });
});
