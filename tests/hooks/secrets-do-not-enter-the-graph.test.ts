import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { removeTempDir } from '../helpers/temp-dir.js';

describe('secrets do not enter the graph', () => {
  let testDir: string;
  let dbPath: string;
  let transcriptPath: string;

  // Shapes `redactSecrets` recognises, each in the field it really turns up in.
  const API_KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-secret-capture-'));
    dbPath = path.join(testDir, 'test.db');
    transcriptPath = path.join(testDir, 'transcript.jsonl');
  });

  afterEach(() => {
    removeTempDir(testDir);
  });

  function writeTranscript(entries: object[]): void {
    fs.writeFileSync(transcriptPath, entries.map((e) => JSON.stringify(e)).join('\n'));
  }

  function runHook(lastAssistantMessage?: string): void {
    execFileSync(process.execPath, [path.resolve('scripts/hooks/session-summary.js')], {
      input: JSON.stringify({
        session_id: 'secret-test', transcript_path: transcriptPath, cwd: testDir,
        last_assistant_message: lastAssistantMessage,
      }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: 'true' },
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  /** Every observation the hook wrote, as one string. */
  function storedText(): string {
    if (!fs.existsSync(dbPath)) return '';
    const db = new Database(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT content FROM observations').all() as Array<{ content: string }>;
      return rows.map((r) => r.content).join('\n');
    } finally {
      db.close();
    }
  }

  const assistant = (text: string) => ({
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

  it('redacts a key in the command line the assistant quotes in its final reply', () => {
    const command = 'export ANTHROPIC_API_KEY=' + API_KEY + ' && npm run deploy';
    writeTranscript([{
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: command + ' # tool-only command marker' } }] },
    }]);
    runHook('Command: ' + command);

    const text = storedText();
    expect(text).toContain('Command: export ');
    expect(text).toContain('npm run deploy');
    expect(text).toContain('***REDACTED***');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('tool-only command marker');
  });

  it('redacts a bearer token from the transcript reply and excludes failed tool text', () => {
    const error = '401 Unauthorized. Request sent with Authorization: ' + BEARER;
    writeTranscript([
      assistant('The API rejected the request: ' + error),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'request', name: 'Bash', input: { command: 'call API' } }] },
      },
      {
        type: 'user',
        message: { content: [{
          type: 'tool_result', tool_use_id: 'request', is_error: true, content: error + ' Failed-tool-only marker.',
        }] },
      },
      { ...assistant(error + ' Synthetic-error-only marker.'), isApiErrorMessage: true },
    ]);
    runHook();

    const text = storedText();
    expect(text).toContain('The API rejected the request: 401 Unauthorized.');
    expect(text).toContain('***REDACTED***');
    expect(text).not.toContain(BEARER.split(' ')[1]);
    expect(text).not.toContain('Failed-tool-only marker.');
    expect(text).not.toContain('Synthetic-error-only marker.');
  });

  it('stores the complete reply when there is nothing to redact', () => {
    const text = 'Run npm run deploy --workspace packages/api.\nThe build has already finished.';
    writeTranscript([assistant(text)]);
    runHook();
    expect(storedText()).toBe(text);
  });
});
