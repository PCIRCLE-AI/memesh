import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigUnreadableError,
  findRetiredConfigKeys,
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

  it('detects retired top-level names without reading their values', () => {
    const raw: Record<string, unknown> = {
      futureSetting: { llm: { apiKey: 'nested-extension-value' } },
    };
    for (const key of ['llm', 'llmFallbacks', 'embedder', 'language', 'transcriptMining']) {
      Object.defineProperty(raw, key, {
        enumerable: true,
        get: () => { throw new Error(`read retired value: ${key}`); },
      });
    }

    expect(findRetiredConfigKeys(raw)).toEqual([
      'llm', 'llmFallbacks', 'embedder', 'language', 'transcriptMining',
    ]);
    expect(findRetiredConfigKeys({
      futureSetting: { llm: { apiKey: 'nested-extension-value' } },
    })).toEqual([]);
  });

  it('round-trips only the five retained settings', () => {
    updateConfig({
      autoCapture: false,
      sessionLimit: 7,
      autoUpdate: 'minor',
      setupCompleted: true,
      briefing: 'minimal',
    });
    expect(readConfig()).toEqual({
      autoCapture: false,
      sessionLimit: 7,
      autoUpdate: 'minor',
      setupCompleted: true,
      briefing: 'minimal',
    });
    expect(getConfigDir()).toBe(dir);
  });

  // #360: unlike autoUpdate, `briefing` is passed through UNVALIDATED here —
  // resolveBriefingLevel (core/briefing-level.ts) is where an unknown value
  // is validated AND reported, so a hand-edited config.json with a bad level
  // must still reach that resolver rather than being silently dropped the
  // way a malformed autoUpdate value is (see the field comment on
  // MeMeshConfig.briefing).
  it('passes briefing through even when it is not a known level', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({ briefing: 'banana' }));
    expect(readConfig()).toEqual({ briefing: 'banana' });
  });

  // Codex round 3 re-review, item 2: this used to be `typeof === 'string'`
  // gated, which discarded a NON-string briefing value (a number, `true`,
  // `null`, an array, an object) before `resolveBriefingLevel` ever saw
  // it — the hook (which reads raw JSON directly, not through this file)
  // reported `{"briefing":42}` as invalid; `readConfig()`-based callers
  // (assembleBriefing, the CLI, the MCP tool, GET /v1/config) silently
  // dropped it and used the default with NO recorded reason. Every JSON
  // type now survives this file unfiltered; `resolveBriefingLevel`'s own
  // `isBriefingLevel` check is what decides validity, for every caller.
  it('passes briefing through for every JSON type, not just strings — the real gap Codex found', () => {
    for (const value of [42, true, [], { nested: 'object' }]) {
      fs.writeFileSync(getConfigPath(), JSON.stringify({ briefing: value }));
      expect(readConfig(), JSON.stringify(value)).toEqual({ briefing: value });
    }
  });

  // Round 5 (Codex round 4 re-review, item 2): this file's job is only to
  // not discard `null` before the resolver sees it — `resolveBriefingLevel`
  // now classifies an explicit `null` as INVALID (not "not set"; see
  // tests/core/briefing-level.test.ts), but that is that function's
  // decision, not this one's. This file must still preserve it unfiltered.
  it('an explicit null briefing is preserved too — this file does not decide validity, the resolver does', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({ briefing: null }));
    expect(readConfig()).toEqual({ briefing: null });
  });

  it('preserves retired provider/key/vector values on unrelated successful writes', () => {
    const legacy = {
      llm: { provider: 'openai', apiKey: 'fixture-secret' },
      llmFallbacks: ['google', 'mistral'],
      embedder: { provider: 'ollama', model: 'mxbai', vectorSize: 1024 },
      transcriptMining: true,
      language: 'zh-TW',
      futureSetting: { keep: true },
      autoUpdate: 'patch',
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(legacy));

    expect(readConfig()).toEqual({ autoUpdate: 'patch' });
    updateConfig({ sessionLimit: 12 });

    expect(rawConfig()).toEqual({ ...legacy, sessionLimit: 12 });
    expect(readConfig()).toEqual({ autoUpdate: 'patch', sessionLimit: 12 });
  });

  it('preserves unknown extension and retired keys while updating retained keys', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({
      llm: { provider: 'anthropic', apiKey: 'fixture-secret' },
      futureSetting: { keep: true },
      autoCapture: false,
      sessionLimit: 99,
    }));

    updateConfig({ autoCapture: undefined, sessionLimit: undefined, autoUpdate: 'off' });

    expect(rawConfig()).toEqual({
      llm: { provider: 'anthropic', apiKey: 'fixture-secret' },
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
    expect(rawConfig()).toEqual({ llm: { provider: 'ollama' }, autoUpdate: 'major' });
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
