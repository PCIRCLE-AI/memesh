import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isAutoCaptureEnabled,
  resolveAutoUpdatePolicy,
  resolveSessionLimit,
  resolveBriefingLevel,
  readHookConfig,
  readHookConfigResult,
} from '../../scripts/hooks/_shared.js';

// Item #11 regression: env-only feature flags now have config-file
// fallbacks. Pin the precedence rules: env > config > default.
//
// Drift-fix follow-up: `readHookConfig` now always reads
// `<homedir>/.memesh/config.json` to match `src/core/config.ts`. Tests
// override HOME (and USERPROFILE on Windows) to redirect homedir().

let tmpDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

function writeConfig(obj: Record<string, unknown>) {
  const dir = path.join(tmpDir, '.memesh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj));
}

function envFor(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // env arg is now ignored by readHookConfig (homedir is canonical),
  // but other helpers in _shared.js still consult env for env-vs-config
  // precedence. Keep MEMESH_DB_PATH for any helper that legitimately
  // uses it, plus pass through any test-supplied extras.
  return {
    MEMESH_DB_PATH: path.join(tmpDir, '.memesh', 'kg.db'),
    ...extra,
  } as NodeJS.ProcessEnv;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-prec-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  // Redirect homedir() so writeConfig() lands where readHookConfig() looks.
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('isAutoCaptureEnabled — env > config > default(true)', () => {
  it('default on when neither env nor config sets it', () => {
    expect(isAutoCaptureEnabled(envFor())).toBe(true);
  });

  it('config { autoCapture: false } disables it', () => {
    writeConfig({ autoCapture: false });
    expect(isAutoCaptureEnabled(envFor())).toBe(false);
  });

  it('env=false wins over config=true', () => {
    writeConfig({ autoCapture: true });
    expect(isAutoCaptureEnabled(envFor({ MEMESH_AUTO_CAPTURE: 'false' }))).toBe(false);
  });

  it('env=true wins over config=false', () => {
    writeConfig({ autoCapture: false });
    expect(isAutoCaptureEnabled(envFor({ MEMESH_AUTO_CAPTURE: 'true' }))).toBe(true);
  });
});

describe('resolveSessionLimit — env > config > default(10)', () => {
  it('default 10 when neither env nor config sets it', () => {
    expect(resolveSessionLimit(envFor())).toBe(10);
  });

  it('config sessionLimit=25 takes effect', () => {
    writeConfig({ sessionLimit: 25 });
    expect(resolveSessionLimit(envFor())).toBe(25);
  });

  it('env=50 wins over config=25', () => {
    writeConfig({ sessionLimit: 25 });
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: '50' }))).toBe(50);
  });

  it('invalid env value falls back to config', () => {
    writeConfig({ sessionLimit: 25 });
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: 'not-a-number' }))).toBe(25);
  });

  it('zero or negative env values fall back', () => {
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: '0' }))).toBe(10);
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: '-5' }))).toBe(10);
  });
});

describe('resolveAutoUpdatePolicy — env > config > default(off)', () => {
  it('default off when neither env nor config sets it', () => {
    expect(resolveAutoUpdatePolicy(envFor())).toBe('off');
  });

  it("config { autoUpdate: 'patch' } takes effect", () => {
    writeConfig({ autoUpdate: 'patch' });
    expect(resolveAutoUpdatePolicy(envFor())).toBe('patch');
  });

  it('env wins over config', () => {
    writeConfig({ autoUpdate: 'patch' });
    expect(resolveAutoUpdatePolicy(envFor({ MEMESH_AUTO_UPDATE: 'minor' }))).toBe('minor');
    expect(resolveAutoUpdatePolicy(envFor({ MEMESH_AUTO_UPDATE: 'off' }))).toBe('off');
  });

  it('case-insensitive', () => {
    writeConfig({ autoUpdate: 'MAJOR' });
    expect(resolveAutoUpdatePolicy(envFor())).toBe('major');
    expect(resolveAutoUpdatePolicy(envFor({ MEMESH_AUTO_UPDATE: 'Patch' }))).toBe('patch');
  });

  it('invalid explicit env value fails closed instead of uncovering permissive config', () => {
    writeConfig({ autoUpdate: 'minor' });
    expect(resolveAutoUpdatePolicy(envFor({ MEMESH_AUTO_UPDATE: 'yolo' }))).toBe('off');
    expect(resolveAutoUpdatePolicy(envFor({ MEMESH_AUTO_UPDATE: '' }))).toBe('off');
    expect(resolveAutoUpdatePolicy(envFor({ MEMESH_AUTO_UPDATE: 'off ' }))).toBe('off');
    expect(resolveAutoUpdatePolicy({ MEMESH_AUTO_UPDATE: null } as unknown as NodeJS.ProcessEnv)).toBe('off');
  });

  it('invalid config value falls through to default', () => {
    writeConfig({ autoUpdate: 'auto' });
    expect(resolveAutoUpdatePolicy(envFor())).toBe('off');
  });
});

// #360: resolveBriefingLevel — env `MEMESH_BRIEFING` > config `briefing` >
// default('standard'). Same file, same env-redirected-HOME pattern as the
// suites above, since readHookConfig() resolves through homedir() the same
// way for every one of these resolvers.
describe("resolveBriefingLevel — env > config.briefing > default('standard')", () => {
  it("defaults to 'standard' when neither env nor config sets it", () => {
    expect(resolveBriefingLevel(envFor())).toEqual({ level: 'standard', invalid: null });
  });

  it('config briefing=minimal takes effect', () => {
    writeConfig({ briefing: 'minimal' });
    expect(resolveBriefingLevel(envFor())).toEqual({ level: 'minimal', invalid: null });
  });

  it('env wins over config', () => {
    writeConfig({ briefing: 'full' });
    expect(resolveBriefingLevel(envFor({ MEMESH_BRIEFING: 'minimal' })))
      .toEqual({ level: 'minimal', invalid: null });
  });

  // #360 round 6 (Codex round 5 re-review, item 3): `value` is the real
  // `JSON.stringify('banana')` form (quoted) — see
  // tests/core/briefing-level.test.ts for the dedicated whitespace-evidence
  // tests this rendering change was for.
  it('an invalid env value defaults AND is reported as invalid (source: env) — config is not consulted', () => {
    writeConfig({ briefing: 'full' });
    expect(resolveBriefingLevel(envFor({ MEMESH_BRIEFING: 'banana' })))
      .toEqual({ level: 'standard', invalid: { source: 'env', value: '"banana"' } });
  });

  it('an invalid config value (no env set) defaults AND is reported as invalid (source: config)', () => {
    writeConfig({ briefing: 'banana' });
    expect(resolveBriefingLevel(envFor()))
      .toEqual({ level: 'standard', invalid: { source: 'config', value: '"banana"' } });
  });
});

// #360 round 6 (Codex round 5 re-review, item 2): `readHookConfig()` used to
// swallow EVERY way a config document itself could be unusable — malformed
// JSON, a truncated file, a non-object top-level value — into a plain `{}`,
// indistinguishable from "file legitimately empty/absent". The hook then
// silently used every default with no trace, while `core/config.ts` (CLI/MCP)
// already reported this state. `readHookConfigResult()` is the state-aware
// reader session-start.js now checks in addition to (not instead of) the
// plain `readHookConfig()` every existing caller in `_shared.js` still uses
// unchanged.
describe('readHookConfigResult — malformed/non-object config document classification', () => {
  it('an absent file is "absent", not "unreadable" — no false alarm on first run', () => {
    expect(readHookConfigResult(envFor())).toEqual({ config: {}, state: 'absent' });
  });

  it('a normal object config is "ok"', () => {
    writeConfig({ briefing: 'full' });
    expect(readHookConfigResult(envFor())).toEqual({ config: { briefing: 'full' }, state: 'ok' });
  });

  it.each([
    ['a bare array', '[]'],
    ['a bare string', '"x"'],
    ['a bare number', '42'],
    ['a bare boolean', 'true'],
    ['a bare null', 'null'],
    ['truncated JSON', '{"briefing": "fu'],
    ['not JSON at all', 'not json at all'],
  ])('%s top-level document is classified "unreadable", config defaults to {}', (_label, raw) => {
    const dir = path.join(tmpDir, '.memesh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), raw);
    expect(readHookConfigResult(envFor())).toEqual({ config: {}, state: 'unreadable' });
  });

  // Explicitly re-asserted per the coordinator's requirement: this is a
  // DIFFERENT case from a broken document — the document is a perfectly
  // valid object, `briefing` merely is not a TOP-LEVEL key in it (it is
  // nested under an unrelated key). That is a legitimate "not set", not a
  // malformed document, and must stay "ok" with `briefing` absent.
  it('{"nested":{"briefing":"full"}} stays a plain "not set" — the object itself is valid', () => {
    writeConfig({ nested: { briefing: 'full' } });
    const result = readHookConfigResult(envFor());
    expect(result.state).toBe('ok');
    expect(result.config.briefing).toBeUndefined();
    expect(resolveBriefingLevel(envFor())).toEqual({ level: 'standard', invalid: null });
  });

  it('readHookConfig() (the plain wrapper every other caller uses) is unaffected — still returns {} for every unreadable case', () => {
    const dir = path.join(tmpDir, '.memesh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '[]');
    expect(readHookConfig(envFor())).toEqual({});
  });
});
