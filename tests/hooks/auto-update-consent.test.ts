import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  claimUpdatePrompt,
  finalizeUpdatePromptClaim,
  findAutoUpdateConsent,
  parseAutoUpdateConsent,
  readUpdatePromptClaim,
  writeAutoUpdateConsent,
} from '../../scripts/hooks/_shared.js';

const CURRENT_VERSION = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version as string;
// The "newer release" the fixtures offer is DERIVED from the current version,
// never written down: a literal is right until the release that catches up
// with it, and then every "upgrade available" scenario silently reads as up
// to date (that is exactly how the 4.10.0 bump went red).
const bumpMinor = (by: number) => {
  const [major, minor] = CURRENT_VERSION.split('.').map(Number);
  return `${major}.${minor + by}.0`;
};
const NEWER_VERSION = bumpMinor(1);
const EVEN_NEWER_VERSION = bumpMinor(2);
const NEWEST_VERSION = bumpMinor(3);

describe('Feature: per-session update consent', () => {
  it('gives a channel-accurate first-use action for a source checkout', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'memesh-update-consent-'));
    const dbPath = path.join(dir, 'memesh.db');
    const cachePath = path.join(dir, 'update-cache.json');
    writeFileSync(cachePath, JSON.stringify({
      currentVersion: CURRENT_VERSION,
      latestVersion: NEWER_VERSION,
      lastSuccessfulCheckAt: new Date().toISOString(),
    }));
    const env = { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: dbPath, MEMESH_UPDATE_CHECK_PATH: cachePath };
    const sessionStart = path.resolve('scripts/hooks/session-start.js');
    const first = JSON.parse(execFileSync('node', [sessionStart], {
      input: JSON.stringify({ cwd: dir, session_id: 'consent-session-1' }),
      env,
      encoding: 'utf8',
    }).trim());
    expect(String(first.systemMessage)).toContain('cannot be upgraded automatically');
    expect(String(first.systemMessage)).toContain('git pull && npm install && npm run build');
    expect(String(first.systemMessage).match(new RegExp(`MeMesh ${NEWER_VERSION.replace(/\./g, '\\.')} is available`, 'g'))).toHaveLength(1);
    // One update message, in any wording: the routine "update available:" banner
    // must not follow the consent prompt on the no-database path either.
    expect(String(first.systemMessage).match(/available/g)).toHaveLength(1);
    expect(String(first.systemMessage)).toContain('“Never ask again”');
    expect(String(first.hookSpecificOutput?.additionalContext)).toContain('no safe in-session installer');
    expect(String(first.hookSpecificOutput?.additionalContext)).not.toContain('Ask the user whether to upgrade');

    const second = JSON.parse(execFileSync('node', [sessionStart], {
      input: JSON.stringify({ cwd: dir, session_id: 'consent-session-1' }),
      env,
      encoding: 'utf8',
    }).trim());
    expect(String(second.systemMessage)).not.toContain('Reply “Upgrade”');
    expect(String(second.systemMessage)).not.toContain('MeMesh update available');
    expect(existsSync(path.join(dir, 'update-consent'))).toBe(false);
  });

  it('records Not now, suppresses the same session, and isolates another session/channel', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'memesh-update-decline-'));
    const dbPath = path.join(dir, 'memesh.db');
    const cachePath = path.join(dir, 'update-cache.json');
    writeFileSync(cachePath, JSON.stringify({
      currentVersion: CURRENT_VERSION, latestVersion: NEWER_VERSION,
      lastSuccessfulCheckAt: new Date().toISOString(),
    }));
    const env = { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: dbPath, MEMESH_UPDATE_CHECK_PATH: cachePath };
    const sessionStart = path.resolve('scripts/hooks/session-start.js');
    const input = (session_id: string) => JSON.stringify({ cwd: dir, session_id });
    const runStart = (session_id: string) => JSON.parse(execFileSync('node', [sessionStart], {
      input: input(session_id), env, encoding: 'utf8',
    }).trim());
    expect(String(runStart('decline-session').systemMessage)).toContain('cannot be upgraded automatically');
    // A first-use SessionStart must not let its detached update refresh create
    // a partially migrated database behind the next hook invocation.
    expect(existsSync(dbPath)).toBe(false);

    const userPrompt = path.resolve('scripts/hooks/user-prompt-intent.js');
    execFileSync('node', [userPrompt], {
      input: JSON.stringify({ session_id: 'decline-session', prompt: 'Upgrade' }), env, encoding: 'utf8',
    });
    expect(String(runStart('decline-session').systemMessage)).not.toContain('Reply “Upgrade”');
    expect(String(runStart('new-session').systemMessage)).toContain('cannot be upgraded automatically');
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(path.join(dir, 'update-consent'))).toBe(false);

    const previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try {
      writeAutoUpdateConsent('channel-session', CURRENT_VERSION, NEWER_VERSION, 'npm-global', 'approved');
      expect(findAutoUpdateConsent('channel-session', CURRENT_VERSION, NEWER_VERSION, 'plugin-marketplace')).toBeNull();
    } finally {
      if (previousDir === undefined) delete process.env.MEMESH_DIR;
      else process.env.MEMESH_DIR = previousDir;
    }
  });

  it('atomically claims one first-use notice for concurrent host hooks', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'memesh-update-claim-'));
    const previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try {
      expect(claimUpdatePrompt('same-session', CURRENT_VERSION, NEWER_VERSION, 'source-checkout')).toBe(true);
      expect(claimUpdatePrompt('same-session', CURRENT_VERSION, NEWER_VERSION, 'plugin-marketplace')).toBe(false);
      expect(readUpdatePromptClaim('same-session', CURRENT_VERSION, NEWER_VERSION)).toMatchObject({
        sessionId: 'same-session',
        channel: 'source-checkout',
        decision: 'pending',
      });
      expect(finalizeUpdatePromptClaim('same-session', CURRENT_VERSION, NEWER_VERSION)).toBe(true);
      expect(claimUpdatePrompt('same-session', CURRENT_VERSION, NEWER_VERSION, 'source-checkout')).toBe(false);
    } finally {
      if (previousDir === undefined) delete process.env.MEMESH_DIR;
      else process.env.MEMESH_DIR = previousDir;
    }
  });

  it('reclaims a pending claim when its owner process crashed before emission', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'memesh-update-crash-'));
    const shared = path.resolve('scripts/hooks/_shared.js');
    const env = { ...process.env, MEMESH_DIR: dir };
    const previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { claimUpdatePrompt } from ${JSON.stringify(pathToFileURL(shared).href)};\n`
        + `process.exit(claimUpdatePrompt('crashed-session', ${JSON.stringify(CURRENT_VERSION)}, ${JSON.stringify(NEWER_VERSION)}, 'source-checkout') ? 0 : 1);`,
      ], { env, encoding: 'utf8' });
      expect(child.status, child.stderr).toBe(0);
      expect(claimUpdatePrompt('crashed-session', CURRENT_VERSION, NEWER_VERSION, 'source-checkout')).toBe(true);
    } finally {
      if (previousDir === undefined) delete process.env.MEMESH_DIR;
      else process.env.MEMESH_DIR = previousDir;
    }
  });

  it('does not dispatch at Stop without approval, but does dispatch the approved channel path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'memesh-update-stop-'));
    const dbPath = path.join(dir, 'memesh.db');
    const cachePath = path.join(dir, 'update-cache.json');
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    writeFileSync(cachePath, JSON.stringify({
      currentVersion: CURRENT_VERSION, latestVersion: NEWER_VERSION,
      lastSuccessfulCheckAt: new Date().toISOString(),
    }));
    writeFileSync(transcriptPath, [
      { type: 'user', message: { role: 'user', content: 'update check' } },
      ...['one.ts', 'two.ts', 'three.ts'].map((file) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `/tmp/${file}` } }] },
      })),
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const env = {
      ...process.env,
      MEMESH_DIR: dir,
      MEMESH_DB_PATH: dbPath,
      MEMESH_UPDATE_CHECK_PATH: cachePath,
      MEMESH_AUTO_UPDATE: 'major',
      MEMESH_AUTO_CAPTURE: 'true',
    };
    const stop = path.resolve('scripts/hooks/session-summary.js');
    const input = { session_id: 'stop-consent-session', transcript_path: transcriptPath, cwd: dir, was_in_agentic_loop: true };
    const firstStop = spawnSync('node', [stop], { input: JSON.stringify(input), env, encoding: 'utf8' });
    expect(firstStop.status, firstStop.stderr).toBe(0);
    expect(() => readFileSync(path.join(dir, 'auto-update.log'), 'utf8')).toThrow();

    const previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try {
      writeAutoUpdateConsent('stop-consent-session', CURRENT_VERSION, NEWER_VERSION, 'source-checkout', 'approved');
      writeAutoUpdateConsent('stop-consent-session', CURRENT_VERSION, NEWER_VERSION, 'unknown', 'approved');
      for (const channel of ['npm-global', 'npm-local', 'plugin-marketplace']) {
        writeAutoUpdateConsent('stop-consent-session', CURRENT_VERSION, NEWER_VERSION, channel, 'approved');
      }
      expect(findAutoUpdateConsent('stop-consent-session', CURRENT_VERSION, NEWER_VERSION, 'source-checkout')).toMatchObject({ decision: 'approved' });
    } finally {
      if (previousDir === undefined) delete process.env.MEMESH_DIR;
      else process.env.MEMESH_DIR = previousDir;
    }
    const secondStop = spawnSync('node', [stop], { input: JSON.stringify(input), env, encoding: 'utf8' });
    expect(secondStop.status, secondStop.stderr).toBe(0);
    const updateLog = path.join(dir, 'auto-update.log');
    expect(existsSync(updateLog), `stdout=${secondStop.stdout}\nstderr=${secondStop.stderr}\nfiles=${readdirSync(dir).join(',')}`).toBe(true);
    expect(readFileSync(updateLog, 'utf8')).toContain('auto-update SKIPPED');
  });
});

describe('Feature: escalating snooze, never-ask, upgrade receipt, loud unknown (#308)', () => {
  const sessionStart = path.resolve('scripts/hooks/session-start.js');
  const userPrompt = path.resolve('scripts/hooks/user-prompt-intent.js');
  const cacheFor = (latest: string) => JSON.stringify({
    currentVersion: CURRENT_VERSION, latestVersion: latest, checkSucceeded: true,
    lastSuccessfulCheckAt: new Date().toISOString(),
  });
  function harness(prefix: string) {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    const cachePath = path.join(dir, 'update-cache.json');
    const env = { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'memesh.db'), MEMESH_UPDATE_CHECK_PATH: cachePath };
    const start = (session_id: string) => JSON.parse(execFileSync('node', [sessionStart], {
      input: JSON.stringify({ cwd: dir, session_id }), env, encoding: 'utf8',
    }).trim());
    const answer = (session_id: string, prompt: string) => execFileSync('node', [userPrompt], {
      input: JSON.stringify({ session_id, prompt }), env, encoding: 'utf8',
    });
    return { dir, cachePath, env, start, answer };
  }

  it('parses "never ask again" as its own decision', () => {
    expect(parseAutoUpdateConsent('Never ask again')).toBe('never');
    expect(parseAutoUpdateConsent("don't ask me again")).toBe('never');
    expect(parseAutoUpdateConsent('不要再問')).toBe('never');
    expect(parseAutoUpdateConsent('Not now')).toBe('declined');
    expect(parseAutoUpdateConsent('後で')).toBe('declined');
    expect(parseAutoUpdateConsent('Ne plus demander')).toBe('never');
    // Ordinary words are not decisions: "never" alone appears in normal talk.
    expect(parseAutoUpdateConsent('never')).toBeNull();
    expect(parseAutoUpdateConsent('never mind the tests, run them')).toBeNull();
  });

  it('"Not now" snoozes that target across NEW sessions, escalates, and a newer target is offered again', () => {
    const h = harness('memesh-update-snooze-');
    writeFileSync(h.cachePath, cacheFor(NEWER_VERSION));
    expect(String(h.start('s1').systemMessage)).toContain(`MeMesh ${NEWER_VERSION} is available`);
    h.answer('s1', 'Not now');
    const snoozePath = path.join(h.dir, 'update-snooze.json');
    expect(JSON.parse(readFileSync(snoozePath, 'utf8'))).toMatchObject({ target: NEWER_VERSION, level: 1 });
    // A brand-new session used to be asked again; now it is quiet while snoozed —
    // including the routine 24h banner, so clear its throttle marker first to
    // prove the resolver (not the throttle) is what keeps it quiet.
    for (const f of readdirSync(h.dir)) if (f.startsWith('last-update-banner.')) rmSync(path.join(h.dir, f));
    expect(String(h.start('s2').systemMessage)).not.toMatch(/available/);
    // Once s1 has answered, later ordinary words from s1 are not decisions.
    h.answer('s1', 'no');
    h.answer('s1', 'later');
    expect(JSON.parse(readFileSync(snoozePath, 'utf8'))).toMatchObject({ target: NEWER_VERSION, level: 1 });
    // A second decline escalates only when a session was shown the notice again:
    // age the snooze past its 24h window (the record stays, its level is remembered).
    const aged = JSON.parse(readFileSync(snoozePath, 'utf8'));
    writeFileSync(snoozePath, JSON.stringify({ ...aged, since: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
    expect(String(h.start('s4').systemMessage)).toContain(`MeMesh ${NEWER_VERSION} is available`);
    h.answer('s4', 'later');
    expect(JSON.parse(readFileSync(snoozePath, 'utf8'))).toMatchObject({ target: NEWER_VERSION, level: 2 });
    // A newer release resets the snooze and is offered.
    writeFileSync(h.cachePath, cacheFor(EVEN_NEWER_VERSION));
    expect(String(h.start('s3').systemMessage)).toContain(`MeMesh ${EVEN_NEWER_VERSION} is available`);
  });

  it('an answer from a session that never saw the notice is not a decision', () => {
    const h = harness('memesh-update-stray-');
    writeFileSync(h.cachePath, cacheFor(NEWER_VERSION));
    h.answer('never-prompted', 'Not now');
    expect(existsSync(path.join(h.dir, 'update-snooze.json'))).toBe(false);
  });

  it('"Never ask again" turns checks off in config and silences every later session', () => {
    const h = harness('memesh-update-never-');
    writeFileSync(h.cachePath, cacheFor(NEWER_VERSION));
    expect(String(h.start('n1').systemMessage)).toContain('is available');
    h.answer('n1', 'never ask again');
    expect(JSON.parse(readFileSync(path.join(h.dir, 'config.json'), 'utf8'))).toMatchObject({ updateCheck: false });
    writeFileSync(h.cachePath, cacheFor(NEWEST_VERSION));
    // Clear every throttle marker: silence must come from the config, not from a 24h lock.
    for (const f of readdirSync(h.dir)) if (f.endsWith('.lock')) rmSync(path.join(h.dir, f));
    expect(String(h.start('n2').systemMessage)).not.toMatch(/available/);
  });

  it('announces a just-landed upgrade exactly once, with the restart caveat', () => {
    const h = harness('memesh-update-receipt-');
    writeFileSync(h.cachePath, cacheFor(CURRENT_VERSION));
    writeFileSync(path.join(h.dir, 'just-upgraded.json'), JSON.stringify({ from: '4.0.0', to: CURRENT_VERSION, at: new Date().toISOString() }));
    const first = String(h.start('r1').systemMessage);
    expect(first).toContain(`MeMesh upgraded 4.0.0 → ${CURRENT_VERSION}`);
    expect(first).toMatch(/until they restart/);
    expect(existsSync(path.join(h.dir, 'just-upgraded.json'))).toBe(false);
    expect(String(h.start('r2').systemMessage)).not.toContain('MeMesh upgraded');
  });

  it('two host hooks starting together announce the receipt exactly once', async () => {
    const h = harness('memesh-update-receipt-race-');
    writeFileSync(h.cachePath, cacheFor(CURRENT_VERSION));
    writeFileSync(path.join(h.dir, 'just-upgraded.json'), JSON.stringify({ from: '4.0.0', to: CURRENT_VERSION, at: new Date().toISOString() }));
    const run = (session_id: string) => new Promise<string>((resolve) => {
      const child = spawn('node', [sessionStart], { env: h.env });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('close', () => resolve(out));
      child.stdin.end(JSON.stringify({ cwd: h.dir, session_id }));
    });
    const outputs = await Promise.all([run('race-a'), run('race-b'), run('race-c')]);
    const announced = outputs.filter((o) => o.includes('MeMesh upgraded')).length;
    expect(announced).toBe(1);
  });

  it('a failed registry check is announced as unknown, never as up to date', () => {
    const h = harness('memesh-update-failed-');
    writeFileSync(h.cachePath, JSON.stringify({
      currentVersion: CURRENT_VERSION, latestVersion: null, checkSucceeded: false,
      lastSuccessfulCheckAt: null, lastAttemptAt: new Date().toISOString(), lastError: 'ENOTFOUND registry.npmjs.org',
    }));
    const msg = String(h.start('f1').systemMessage);
    expect(msg).toContain('could not confirm whether an update exists (ENOTFOUND registry.npmjs.org)');
    expect(msg).not.toContain('is available');
    // Once a day, not every session.
    expect(String(h.start('f2').systemMessage)).not.toContain('could not confirm');
  });
});

