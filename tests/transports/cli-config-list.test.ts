/**
 * `memesh config list` shows every retained settable key and ignores retired
 * provider/credential keys that may remain in a legacy config file; it also
 * always shows the briefing level in effect. `memesh config get <key>` shows
 * one stored value the way `list` shows it.
 *
 * Spawns the built CLI with HOME pointed at a tmpdir so it reads an isolated
 * config.json (paths.ts is HOME-first).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
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
      // An ambient level would beat what the config file says (`list` shows the
      // level in effect), so it is dropped.
      env: { ...process.env, HOME: home, MEMESH_DB_PATH: path.join(home, '.memesh', 'kg.db'), MEMESH_BRIEFING: undefined },
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
    expect(out).toContain('nothing stored');
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
    // The stored value stays visible — now inside the note that says it is
    // not in effect (`minimal` is), instead of as a bare `briefing: null`.
    expect(out).toContain('briefing: minimal (default; the value in config.json is invalid: null)');
  });
});

/** Run the built CLI against an isolated HOME whose config.json holds `config`. */
function runCli(home: string, args: string[], config: object | null, env: Record<string, string | undefined> = {}) {
  fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
  if (config !== null) fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify(config));
  const r = spawnSync('node', [path.resolve('dist/transports/cli/cli.js'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      MEMESH_DB_PATH: path.join(home, '.memesh', 'kg.db'),
      // An ambient level would beat whatever this test stores.
      MEMESH_BRIEFING: undefined,
      ...env,
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('memesh config list: the briefing level in effect', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-level-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const briefingLines = (out: string) => out.split('\n').filter((l) => /^\s*briefing:/.test(l));

  it('nothing stored: the default level is shown and says it is the default', () => {
    const r = runCli(home, ['config', 'list'], {});
    expect(r.status, r.stderr).toBe(0);
    expect(briefingLines(r.stdout)).toEqual(['  briefing: minimal (default)']);
    expect(r.stdout, 'nothing was stored, and list still says so').toContain('nothing stored');
  });

  it('a stored level is shown once, with where it comes from', () => {
    const r = runCli(home, ['config', 'list'], { briefing: 'standard' });
    expect(briefingLines(r.stdout)).toEqual(['  briefing: standard (config.json)']);
  });

  it('the environment beats the stored level, and is named as the source', () => {
    const r = runCli(home, ['config', 'list'], { briefing: 'standard' }, { MEMESH_BRIEFING: 'full' });
    expect(briefingLines(r.stdout)).toEqual(['  briefing: full (env MEMESH_BRIEFING)']);
  });

  it('an invalid stored value resolves to the default and says the stored value is invalid', () => {
    const r = runCli(home, ['config', 'list'], { briefing: 'banana' });
    expect(briefingLines(r.stdout)).toHaveLength(1);
    expect(briefingLines(r.stdout)[0]).toMatch(/^ {2}briefing: minimal \(default; the value in config\.json is invalid: .*banana.*\)$/);
  });

  it('an invalid environment value resolves to the default WITHOUT consulting config, and says so', () => {
    const r = runCli(home, ['config', 'list'], { briefing: 'full' }, { MEMESH_BRIEFING: 'bogus' });
    expect(briefingLines(r.stdout)).toHaveLength(1);
    expect(briefingLines(r.stdout)[0]).toMatch(/^ {2}briefing: minimal \(default; the value in env MEMESH_BRIEFING is invalid: .*bogus.*\)$/);
  });

  it('the briefing line sits in key order among the stored keys, which are unchanged', () => {
    const r = runCli(home, ['config', 'list'], { sessionLimit: 42, autoUpdate: 'patch', autoCapture: false });
    const keys = r.stdout.split('\n').map((l) => /^ {2}(\w+):/.exec(l)?.[1]).filter(Boolean);
    expect(keys).toEqual(['autoCapture', 'autoUpdate', 'briefing', 'sessionLimit']);
    expect(r.stdout).toContain('sessionLimit: 42');
    expect(r.stdout).toContain('autoCapture: false');
    expect(r.stdout).toContain('autoUpdate: patch');
  });
});

describe('memesh config get', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-get-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it('prints a stored value exactly as the same row of `config list` shows it', () => {
    const config = { sessionLimit: 42, autoCapture: false, autoUpdate: 'patch', updateCheck: true };
    for (const [key, shown] of [['sessionLimit', '42'], ['autoCapture', 'false'], ['autoUpdate', 'patch'], ['updateCheck', 'true']]) {
      const got = runCli(home, ['config', 'get', key], config);
      expect(got.status, `${key}: ${got.stderr}`).toBe(0);
      expect(got.stdout, key).toBe(`${shown}\n`);
      expect(runCli(home, ['config', 'list'], config).stdout, `list shows ${key} the same way`).toContain(`  ${key}: ${shown}\n`);
    }
  });

  it('prints the STORED briefing value (what `set` wrote), not the level in effect', () => {
    expect(runCli(home, ['config', 'set', 'briefing', 'standard'], {}).status).toBe(0);
    const got = runCli(home, ['config', 'get', 'briefing'], null, { MEMESH_BRIEFING: 'full' });
    expect(got.status, got.stderr).toBe(0);
    expect(got.stdout).toBe('standard\n');
  });

  it('shows a stored non-level briefing as stored, like `list` did before it explained it', () => {
    const got = runCli(home, ['config', 'get', 'briefing'], { briefing: null });
    expect(got.status).toBe(0);
    expect(got.stdout).toBe('null\n');
  });

  it('a valid key with nothing stored says it is not set — a line on stdout, exit 0', () => {
    const got = runCli(home, ['config', 'get', 'briefing'], {});
    expect(got.status, got.stderr).toBe(0);
    expect(got.stdout).toBe('briefing is not set in config.json\n');
    expect(got.stderr).toBe('');
  });

  it('"not set" states only what is stored: an environment override does not make it claim the default applies', () => {
    const got = runCli(home, ['config', 'get', 'briefing'], {}, { MEMESH_BRIEFING: 'full' });
    expect(got.status, got.stderr).toBe(0);
    expect(got.stdout).toBe('briefing is not set in config.json\n');
    // ...while `list` says what a session would really get
    expect(runCli(home, ['config', 'list'], {}, { MEMESH_BRIEFING: 'full' }).stdout).toContain('briefing: full (env MEMESH_BRIEFING)');
  });

  it('an unknown key fails exactly like `config set` does: same two lines, exit 1, nothing on stdout', () => {
    const got = runCli(home, ['config', 'get', 'nonsense'], {});
    const set = runCli(home, ['config', 'set', 'nonsense', 'x'], {});
    expect(got.status).toBe(1);
    expect(got.stdout).toBe('');
    expect(got.stderr).toBe('Unknown key: nonsense\nAllowed keys: autoCapture, autoUpdate, briefing, sessionLimit, updateCheck\n');
    expect(got.stderr, 'get and set must not word the refusal differently').toBe(set.stderr);
    expect(runCli(home, ['config', 'unset', 'nonsense'], {}).stderr, 'nor unset').toBe(set.stderr);
  });

  it('a retired key is unknown too (nothing stored under it is ever printed)', () => {
    const got = runCli(home, ['config', 'get', 'llm'], { llm: { apiKey: 'sk-should-not-print' } });
    expect(got.status).toBe(1);
    expect(got.stdout).not.toContain('sk-should-not-print');
    expect(got.stderr).toContain('Unknown key: llm');
  });

  it('is listed by `memesh config --help`', () => {
    const help = runCli(home, ['config', '--help'], {});
    expect(help.stdout).toMatch(/^\s+get <key>\s/m);
  });
});
