/**
 * `memesh config list` shows every retained settable key and ignores retired
 * provider/credential keys that may remain in a legacy config file.
 *
 * Spawns the built CLI with HOME pointed at a tmpdir so it reads an isolated
 * config.json (paths.ts is HOME-first).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('memesh config list', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runList(config: object): string {
    fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify(config));
    return execFileSync('node', [path.resolve('dist/transports/cli/cli.js'), 'config', 'list'], {
      env: { ...process.env, HOME: home, MEMESH_DB_PATH: path.join(home, '.memesh', 'kg.db') },
      encoding: 'utf8',
    });
  }

  it('lists retained keys and ignores retired provider settings', () => {
    const out = runList({
      llm: { provider: 'anthropic', apiKey: 'sk-primary-should-not-print', model: 'claude' },
      sessionLimit: 42,
      autoCapture: false,
      autoUpdate: 'patch',
      llmFallbacks: [{ provider: 'openai', apiKey: 'sk-fallback-should-not-print' }],
    });

    // Previously these were invisible in `list`.
    expect(out).toContain('sessionLimit: 42');
    expect(out).toContain('autoCapture: false');
    expect(out).toContain('autoUpdate: patch');
    expect(out).not.toContain('llmFallbacks');
    expect(out).not.toContain('llm.provider');
  });

  it('fully redacts apiKeys — no key bytes at all, primary or fallback chain', () => {
    const out = runList({
      llm: { provider: 'anthropic', apiKey: 'sk-primary-abcd-1234-should-not-print' },
      llmFallbacks: [{ provider: 'openai', apiKey: 'sk-fallback-wxyz-9876-should-not-print' }],
    });
    // Not even the first-4/last-4 fragments maskApiKey would reveal.
    expect(out).not.toMatch(/sk-p|rint|sk-f|9876|abcd|wxyz/);
    expect(out).not.toContain('llm.apiKey');
  });

  it('says nothing is set when the config is empty', () => {
    const out = runList({});
    expect(out).toContain('no keys set');
  });

  // #360 round 5 (Codex round 4 re-review, item 2): `briefing: null` used to
  // be silently OMITTED from `config list` — the one surface in the product
  // that made an explicit invalid stored value invisible instead of showing
  // it (every other invalid value, e.g. `42` or `"banana"`, was already
  // printed as-is). Checked against the real product first: `memesh config
  // unset briefing` deletes the key outright, so a `null` on disk can only
  // be a hand edit or a foreign version's value — an invalid value, not a
  // legitimate "not set".
  it('shows an explicit null briefing rather than hiding it, same as any other invalid value', () => {
    const out = runList({ briefing: null });
    expect(out).toContain('briefing: null');
  });
});
