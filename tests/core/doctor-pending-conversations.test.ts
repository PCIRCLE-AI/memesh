import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectPendingConversations } from '../../src/core/doctor.js';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-pending-'));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it('reports the pending count without reading private event bodies', () => {
  expect(inspectPendingConversations(dir).params?.count).toBe(0);
  const pending = path.join(dir, 'pending-conversations');
  fs.mkdirSync(pending);
  const event = path.join(pending, 'a'.repeat(32) + '.json');
  fs.writeFileSync(event, 'private conversation not valid JSON', { mode: 0o000 });
  fs.writeFileSync(path.join(pending, 'unfinished.tmp'), 'ignored');
  const result = inspectPendingConversations(dir);
  expect(result.status).toBe('warn');
  expect(result.params?.count).toBe(1);
  expect(JSON.stringify(result)).not.toContain('private conversation');
  fs.chmodSync(event, 0o600);
});

it.each([
  ['EIO', 'write', true], ['SQLITE_IOERR', 'write', true],
  ['extended-io', 'write', true], ['EIO', 'open', false],
  ['EACCES', 'write', false], ['SQLITE_SCHEMA', 'write', false],
  ['EIO', 'pending-unwritable', false],
] as const)('conversation failure %s at %s only queues eligible writes', (code, stage, queued) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-conversation-fault-'));
  try {
    const env = buildIsolatedSuiteEnv({ PATH: process.env.PATH }, { runtimeHome: home });
    env.MEMESH_DIR = home;
    env.MEMESH_DB_PATH = path.join(home, 'graph.db');
    env.MEMESH_AUTO_CAPTURE = 'true';
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autoUpdate: 'off', updateCheck: false }));
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      const { captureConversation } = await import(${JSON.stringify(pathToFileURL(path.resolve('scripts/hooks/_shared.js')).href)});
      const code = ${JSON.stringify(code)}, stage = ${JSON.stringify(stage)};
      const failure = () => Object.assign(new Error('synthetic fixed SQL seam'), code === 'extended-io' ? { code: 'ERR_SQLITE_ERROR', errcode: 266 } : { code });
      const event = { name: 'conversation-fault', type: 'conversation', observations: ['synthetic body'], tags: ['role:assistant', 'session:fixture'] };
      const prepare = DatabaseSync.prototype.prepare;
      const exec = DatabaseSync.prototype.exec;
      let hit = false;
      if (stage === 'open') DatabaseSync.prototype.exec = function () { hit = true; throw failure(); };
      else DatabaseSync.prototype.prepare = function (sql) {
        const stmt = prepare.call(this, sql);
        if (/^INSERT OR IGNORE INTO entities\\s*\\(name, type, metadata/.test(sql)) {
          const run = stmt.run;
          stmt.run = function (...args) {
            if (args[0] === event.name) { hit = true; throw failure(); }
            return run.apply(this, args);
          };
        }
        return stmt;
      };
      const pending = path.join(process.env.HOME, 'pending-conversations');
      if (stage === 'pending-unwritable') fs.writeFileSync(pending, 'unchanged sentinel', { mode: 0o600 });
      let result, thrown;
      try { result = captureConversation(event); } catch (error) { thrown = error; }
      finally { DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; }
      assert.equal(hit, true);
      assert.equal(result?.queued === true, ${queued});
      assert.equal(Boolean(thrown), ${!queued});
      if (${queued}) {
        const files = fs.readdirSync(pending); assert.equal(files.length, 1);
        assert.equal(fs.statSync(path.join(pending, files[0])).mode & 511, 384);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pending, files[0]), 'utf8')).observations, event.observations);
      } else if (stage === 'pending-unwritable') assert.equal(fs.readFileSync(pending, 'utf8'), 'unchanged sentinel');
      else assert.equal(fs.existsSync(pending), false);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 8000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
