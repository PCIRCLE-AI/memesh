import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claimUpdatePrompt,
  findAutoUpdateConsent,
  readUpdatePromptClaim,
  writeAutoUpdateConsent,
} from '../../scripts/hooks/_shared.js';

describe('Feature: per-session update consent', () => {
  it('gives a channel-accurate first-use action for a source checkout', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'memesh-update-consent-'));
    const dbPath = path.join(dir, 'memesh.db');
    const cachePath = path.join(dir, 'update-cache.json');
    writeFileSync(cachePath, JSON.stringify({
      currentVersion: '4.9.0',
      latestVersion: '4.10.0',
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
    expect(String(first.systemMessage).match(/MeMesh 4\.10\.0 is available/g)).toHaveLength(1);
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
      currentVersion: '4.9.0', latestVersion: '4.10.0',
      lastSuccessfulCheckAt: new Date().toISOString(),
    }));
    const env = { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: dbPath, MEMESH_UPDATE_CHECK_PATH: cachePath };
    const sessionStart = path.resolve('scripts/hooks/session-start.js');
    const input = (session_id: string) => JSON.stringify({ cwd: dir, session_id });
    const runStart = (session_id: string) => JSON.parse(execFileSync('node', [sessionStart], {
      input: input(session_id), env, encoding: 'utf8',
    }).trim());
    expect(String(runStart('decline-session').systemMessage)).toContain('cannot be upgraded automatically');

    const userPrompt = path.resolve('scripts/hooks/user-prompt-intent.js');
    execFileSync('node', [userPrompt], {
      input: JSON.stringify({ session_id: 'decline-session', prompt: 'Upgrade' }), env, encoding: 'utf8',
    });
    expect(String(runStart('decline-session').systemMessage)).not.toContain('Reply “Upgrade”');
    expect(String(runStart('new-session').systemMessage)).toContain('cannot be upgraded automatically');
    expect(existsSync(path.join(dir, 'update-consent'))).toBe(false);

    const previousDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try {
      writeAutoUpdateConsent('channel-session', '4.9.0', '4.10.0', 'npm-global', 'approved');
      expect(findAutoUpdateConsent('channel-session', '4.9.0', '4.10.0', 'plugin-marketplace')).toBeNull();
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
      expect(claimUpdatePrompt('same-session', '4.9.0', '4.10.0', 'source-checkout')).toBe(true);
      expect(claimUpdatePrompt('same-session', '4.9.0', '4.10.0', 'plugin-marketplace')).toBe(false);
      expect(readUpdatePromptClaim('same-session', '4.9.0', '4.10.0')).toMatchObject({
        sessionId: 'same-session',
        channel: 'source-checkout',
        decision: 'pending',
      });
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
      currentVersion: '4.9.0', latestVersion: '4.10.0',
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
      writeAutoUpdateConsent('stop-consent-session', '4.9.0', '4.10.0', 'source-checkout', 'approved');
      writeAutoUpdateConsent('stop-consent-session', '4.9.0', '4.10.0', 'unknown', 'approved');
      for (const channel of ['npm-global', 'npm-local', 'plugin-marketplace']) {
        writeAutoUpdateConsent('stop-consent-session', '4.9.0', '4.10.0', channel, 'approved');
      }
      expect(findAutoUpdateConsent('stop-consent-session', '4.9.0', '4.10.0', 'source-checkout')).toMatchObject({ decision: 'approved' });
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
