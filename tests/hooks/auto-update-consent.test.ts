import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('Feature: per-session update consent', () => {
  it('asks once on SessionStart and records an explicit Upgrade response', () => {
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
    expect(String(first.systemMessage)).toContain('Reply “Upgrade”');
    expect(String(first.hookSpecificOutput?.additionalContext)).toContain('Ask the user whether to upgrade');

    const second = JSON.parse(execFileSync('node', [sessionStart], {
      input: JSON.stringify({ cwd: dir, session_id: 'consent-session-1' }),
      env,
      encoding: 'utf8',
    }).trim());
    expect(String(second.systemMessage)).not.toContain('Reply “Upgrade”');

    const userPrompt = path.resolve('scripts/hooks/user-prompt-intent.js');
    execFileSync('node', [userPrompt], {
      input: JSON.stringify({ session_id: 'consent-session-1', prompt: 'Upgrade' }),
      env,
      encoding: 'utf8',
    });
    const consentFiles = readdirSync(path.join(dir, 'update-consent'));
    expect(consentFiles).toHaveLength(1);
    const consent = JSON.parse(readFileSync(path.join(dir, 'update-consent', consentFiles[0]), 'utf8'));
    expect(consent).toMatchObject({ sessionId: 'consent-session-1', decision: 'approved' });
  });
});
