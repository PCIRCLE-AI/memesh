import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectPendingConversations } from '../../src/core/doctor.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';
import { makeWindowsPathsPrivate } from '../../src/core/windows-permissions.js';
import { expectPrivateDir, expectPrivateFile, makeWindowsAclPublic, readWindowsAcl } from '../helpers/permissions.js';
const hookModule = pathToFileURL(path.resolve('scripts/hooks/_shared.js')).href;
function hookEnv(home: string) {
  return {
    ...buildIsolatedSuiteEnv({
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    }, { runtimeHome: home }),
    MEMESH_DIR: home,
    MEMESH_AUTO_CAPTURE: 'true',
  };
}

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
    const env = { ...hookEnv(home), MEMESH_DB_PATH: path.join(home, 'graph.db') };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autoUpdate: 'off', updateCheck: false }));
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      const { captureConversation } = await import(${JSON.stringify(hookModule)});
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
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pending, files[0]), 'utf8')).observations, event.observations);
      } else if (stage === 'pending-unwritable') assert.equal(fs.readFileSync(pending, 'utf8'), 'unchanged sentinel');
      else assert.equal(fs.existsSync(pending), false);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 8000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    if (queued) {
      const pending = path.join(home, 'pending-conversations');
      expectPrivateDir(pending);
      expectPrivateFile(path.join(pending, fs.readdirSync(pending)[0]!));
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'win32')('refuses to replay a public pending file and imports the same event once private', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-conversation-replay-'));
  try {
    const pending = path.join(home, 'custom-data', 'pending-conversations');
    fs.mkdirSync(pending, { recursive: true });
    const dbPath = path.join(path.dirname(pending), 'graph.db');
    const observation = 'synthetic reply retained for private replay';
    const event = JSON.stringify({
      name: 'private-replay-control', type: 'conversation', observations: [observation],
      tags: ['role:assistant', 'session:fixture'], capturedAt: Date.now(),
    });
    const file = path.join(pending, createHash('sha256').update(event).digest('hex').slice(0, 32) + '.json');
    fs.writeFileSync(file, event, { flag: 'wx' });
    makeWindowsPathsPrivate([pending, file]);
    makeWindowsAclPublic(file);
    const publicAcl = readWindowsAcl(file);
    const replay = () => {
      const script = `
        const { replayPendingConversations } = await import(${JSON.stringify(hookModule)});
        replayPendingConversations({ ...process.env, MEMESH_DB_PATH: process.argv[1] });
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dbPath], {
        env: hookEnv(home), encoding: 'utf8', timeout: 8000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      return child.stderr;
    };

    expect(replay()).toContain('[memesh pending-conversations]');
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(event);
    expect(readWindowsAcl(file)).toEqual(publicAcl);

    makeWindowsPathsPrivate([file]);
    expect(replay()).not.toContain('[memesh pending-conversations]');
    expect(fs.readdirSync(pending)).toEqual([]);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT content FROM observations').all()).toEqual([{ content: observation }]);
    } finally { db.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
