import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db.js';
import { handleTool, resetFirstCallNoticeForTests } from '../src/transports/mcp/handlers.js';

const CURRENT_VERSION = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version as string;

let tmpDir: string;
let previousMemeshDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-notice-'));
  previousMemeshDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = tmpDir;
  openDatabase(path.join(tmpDir, 'test.db'));
  resetFirstCallNoticeForTests();
});

afterEach(() => {
  closeDatabase();
  if (previousMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousMemeshDir;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('MCP first tool call carries the update notice (#308: any entry point)', () => {
  it('appends one notice item on the first successful call only, leaving content[0] intact', async () => {
    fs.writeFileSync(path.join(tmpDir, `update-check.${CURRENT_VERSION}.json`), JSON.stringify({
      currentVersion: CURRENT_VERSION, latestVersion: '99.0.0', checkSucceeded: true,
      lastSuccessfulCheckAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(),
    }));
    const first = await handleTool('recall', { query: 'anything' });
    expect(first.isError).toBeFalsy();
    // Gemini parses content[0] as JSON into structuredContent: it must still be the object envelope.
    expect(JSON.parse(first.content[0].text)).toHaveProperty('entities');
    expect(first.content).toHaveLength(2);
    expect(first.content[1].text).toContain('[memesh update] 99.0.0 is available');
    const second = await handleTool('recall', { query: 'anything' });
    expect(second.content).toHaveLength(1);
  });

  it('says nothing when the snooze is active, and nothing on an error result', async () => {
    fs.writeFileSync(path.join(tmpDir, `update-check.${CURRENT_VERSION}.json`), JSON.stringify({
      currentVersion: CURRENT_VERSION, latestVersion: '99.0.0', checkSucceeded: true,
      lastSuccessfulCheckAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(tmpDir, 'update-snooze.json'), JSON.stringify({ target: '99.0.0', level: 1, since: new Date().toISOString() }));
    const quiet = await handleTool('recall', { query: 'anything' });
    expect(quiet.content).toHaveLength(1);
    resetFirstCallNoticeForTests();
    fs.rmSync(path.join(tmpDir, 'update-snooze.json'));
    const failed = await handleTool('recall', { limit: 'not-a-number' });
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
  });
});
