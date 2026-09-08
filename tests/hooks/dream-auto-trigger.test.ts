import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

it('Stop captures and indexes rules without provider requests, dream spawn, or scheduling writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stop-offline-'));
  const dbPath = path.join(dir, 'memory.db');
  const transcript = path.join(dir, 'session.jsonl');
  const probe = path.join(dir, 'forbidden-call');
  const preload = path.join(dir, 'probe.cjs');
  try {
    openDatabase(dbPath);
    closeDatabase();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      autoUpdate: 'off', llm: { provider: 'ollama' }, transcriptMining: true,
    }));
    fs.writeFileSync(transcript, [
      ...Array.from({ length: 4 }, (_, i) => ({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'edit-' + i, name: 'Edit', input: { file_path: path.join(dir, 'file-' + i + '.ts') } },
      ] } })),
      { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Synthetic test failed before edit' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    fs.writeFileSync(preload, `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const mark = () => { fs.writeFileSync(${JSON.stringify(probe)}, 'forbidden'); throw new Error('forbidden provider or generator'); };
      globalThis.fetch = mark;
      const original = cp.spawn;
      cp.spawn = function(command, args, options) {
        if (/dream|failure-analy|ollama|anthropic|openai/.test([command, ...(args || [])].join(' '))) return mark();
        return original.call(this, command, args, options);
      };
      require('node:module').syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--require', preload, path.resolve('scripts/hooks/session-summary.js')], {
      input: JSON.stringify({ session_id: 'offline-stop', transcript_path: transcript, cwd: dir }),
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { HOME: dir, USERPROFILE: dir, MEMESH_DIR: dir, MEMESH_DB_PATH: dbPath, PATH: path.dirname(process.execPath), MEMESH_AUTO_CAPTURE: 'true' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(probe)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'dream-history.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'dream-runs'))).toBe(false);
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM dream_proposals').get()).toMatchObject({ n: 0 });
      const memories = db.prepare("SELECT id FROM entities WHERE type = 'session-insight'").all() as Array<{ id: number }>;
      expect(memories.length).toBeGreaterThan(0);
      for (const memory of memories) expect(db.prepare('SELECT count(*) AS n FROM entities_fts WHERE rowid = ?').get(memory.id)).toMatchObject({ n: 1 });
      expect(db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get()).toMatchObject({ run_count: 1 });
    } finally { db.close(); }
  } finally {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
