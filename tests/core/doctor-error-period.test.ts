/**
 * Doctor rows (and a few messages) that quote an error ("...: <error>. ...")
 * printed `..` when the error text already ended in a full stop, as MeMesh's
 * own messages do. The template's stop is now the only one. And a Node below
 * the floor is said once (the Database row), with the right fix everywhere.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectNodeRuntime, runDoctor } from '../../src/core/doctor.js';
import { NothingToClaimError } from '../../src/core/dreamer.js';
import { withoutFinalPeriod } from '../../src/core/sentence.js';
import { SqliteSelfCheckError, UnsupportedNodeError, nodeProblem } from '../../src/storage/sqlite.js';
import { OLD_NODE_VERSION, TOO_OLD_MESSAGE, TOO_OLD_PROBLEM, tooOldError } from '../helpers/node-floor.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) removeTempDir(r); });

type DoctorOptions = Parameters<typeof runDoctor>[0];

async function doctor(over: Partial<DoctorOptions>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-period-'));
  roots.push(root);
  return runDoctor({
    packageRoot: root,
    packageVersion: '4.0.3',
    pluginCacheDiscoveryImpl: () => [],
    closeDatabaseImpl: () => undefined,
    getConfigPathImpl: () => path.join(root, 'config.json'),
    getUpdateCheckImpl: async () => ({}) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({
      channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
      recommendedCommand: 'memesh update', guidance: '',
    }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
    ...over,
  } as DoctorOptions);
}

async function rowsFor(errorText: string) {
  const result = await doctor({ openDatabaseImpl: () => { throw new Error(errorText); } });
  return result.checks.filter((c) => c.id === 'hook-activity' || c.id === 'capture-liveness');
}

describe('Feature: error text quoted in a sentence of ours', () => {
  it('withoutFinalPeriod trims one trailing stop and nothing else', () => {
    expect(withoutFinalPeriod('needs Node 22.16 or newer.')).toBe('needs Node 22.16 or newer');
    expect(withoutFinalPeriod('no stop')).toBe('no stop');
    expect(withoutFinalPeriod('a.b')).toBe('a.b');
    // Only ONE stop, and a stop followed by trailing blanks still counts as final.
    expect(withoutFinalPeriod('wait...')).toBe('wait..');
    expect(withoutFinalPeriod('ends with a stop.  \n')).toBe('ends with a stop');
    expect(withoutFinalPeriod('x. y')).toBe('x. y');
  });

  it('hook-activity and capture-liveness: an error ending in a stop gives one stop, not two', async () => {
    const rows = await rowsFor('Upgrade the thing and run memesh again.');
    expect(rows.map((r) => r.id).sort()).toEqual(['capture-liveness', 'hook-activity']);
    for (const row of rows) {
      expect(row.summary).toContain('again. ');
      expect(row.summary).toContain(row.id === 'hook-activity' ? 'again. Capture health is unknown' : 'again. Whether anything is being saved is unknown');
      expect(row.summary).not.toContain('..');
    }
  });

  it('an error without a final stop still reads as a sentence', async () => {
    const rows = await rowsFor('database disk image is malformed');
    for (const row of rows) expect(row.summary).toContain('malformed. ');
  });

  it.each([false, true])('update-status (deprecation unknown, update available: %s): one stop, not two', async (updateAvailable) => {
    const result = await doctor({
      openDatabaseImpl: () => { throw new Error('x'); },
      getUpdateCheckImpl: async () => ({
        currentVersion: '4.0.3', latestVersion: updateAvailable ? '9.9.9' : null, checkedAt: null, lastAttemptAt: null,
        lastSuccessfulCheckAt: null, lastError: 'registry said no.', updateAvailable,
        checkSucceeded: true, source: 'cache', freshness: 'cached',
        currentVersionDeprecated: false, deprecationMessage: null,
      }) as never,
    });
    const row = result.checks.find((c) => c.id === 'update-status');
    expect(row?.summary).toContain('registry said no.');
    expect(row?.summary).not.toContain('..');
  });

  it('message-capability probe failure: one stop, not two', async () => {
    const result = await doctor({
      openDatabaseImpl: () => { throw new Error('x'); },
      probeMessageCapability: true,
      messageCapabilityProbeImpl: () => ({ ok: false, message: 'adapter import failed.' }),
    });
    const row = result.checks.find((c) => c.id === 'message-capability');
    expect(row?.summary).toContain('adapter import failed.');
    expect(row?.summary).not.toContain('..');
  });

  it('NothingToClaimError: one stop, not two', () => {
    const err = new NothingToClaimError(7, 'every source is archived.');
    expect(err.message).toContain('every source is archived. Nothing was written');
    expect(err.message).not.toContain('..');
  });
});

describe('Feature: doctor on a Node below the floor', () => {
  it('says the sentence once (Database row) and gives the upgrade fix on every database row', async () => {
    const result = await doctor({
      openDatabaseImpl: () => { throw tooOldError(); },
      nativeBindingProbeImpl: () => ({ ok: false, message: TOO_OLD_MESSAGE, fix: tooOldError().fix }),
    });
    const rows = result.checks.filter((c) => ['database', 'hook-activity', 'capture-liveness', 'native-binding'].includes(c.id));
    expect(rows.map((r) => r.id).sort()).toEqual(['capture-liveness', 'database', 'hook-activity', 'native-binding']);
    for (const row of rows) {
      expect(row.fix, row.id).toContain('22.16');
      expect(row.fix, row.id).not.toMatch(/disk is not full|reinstall|Backup and reset/i);
    }
    const everything = result.checks.map((c) => `${c.summary}\n${c.fix ?? ''}`).join('\n');
    expect(everything.split('lacks the full-text search').length - 1).toBe(1);
  });
});

describe('Feature: doctor on a Node that cannot run MeMesh, by cause', () => {
  const real = process.versions.node;
  const fakeNode = (version: string) => Object.defineProperty(process.versions, 'node', { value: version, configurable: true });
  afterEach(() => fakeNode(real));
  const yes = () => true;
  const causes: Array<[string, ReturnType<typeof nodeProblem>]> = [
    ['too old', nodeProblem('22.15.1', yes)],
    ['node:sqlite switched off', nodeProblem('24.0.0', yes, false)],
    ['built without FTS5', nodeProblem('24.0.0', () => false)],
  ];

  it.each(causes)('%s: the Database row and the rows that need the database give that cause\'s repair, and say the sentence once', async (_name, problem) => {
    const err = new UnsupportedNodeError(problem!);
    const result = await doctor({
      openDatabaseImpl: () => { throw err; },
      nativeBindingProbeImpl: () => ({ ok: false, message: err.message, fix: err.fix }),
    });
    for (const id of ['database', 'hook-activity', 'capture-liveness', 'native-binding']) {
      const row = result.checks.find((c) => c.id === id);
      expect(row?.fix, id).toContain(problem!.fix);
      if (problem!.kind !== 'too-old') expect(row?.fix, id).not.toMatch(/upgrade/i);
    }
    const everything = result.checks.map((c) => `${c.summary}\n${c.fix ?? ''}`).join('\n');
    expect(everything.split(problem!.message).length - 1).toBe(1);
  });

  it('the SQLite row asks the real probe: on a Node below the floor it gives the upgrade fix, not "reinstall"', async () => {
    fakeNode(OLD_NODE_VERSION);
    const result = await doctor({ nativeBindingProbeImpl: undefined, openDatabaseImpl: () => { throw tooOldError(); } });
    const row = result.checks.find((c) => c.id === 'native-binding');
    expect(row?.status).toBe('fail');
    expect(row?.fix).toBe(TOO_OLD_PROBLEM.fix);
    expect(row?.summary).not.toContain('could not open a database');
  });

  it('the Node runtime row fails (it used to pass) when node:sqlite is missing from a new-enough Node, and says what helps', () => {
    const root = path.join(__dirname, '..', '..');
    const row = inspectNodeRuntime(root, fs.existsSync, fs.readFileSync, 'v24.15.0', '137', () => false);
    expect(row.status).toBe('fail');
    expect(row.fix).toContain('--no-experimental-sqlite');
    expect(row.fix).not.toMatch(/upgrade/i);
    expect(inspectNodeRuntime(root, fs.existsSync, fs.readFileSync, 'v24.15.0', '137', () => true).status).toBe('pass');
  });

  it('the Update status row does not tell a Node that cannot run MeMesh to run `memesh status`', async () => {
    const unavailable = async () => ({
      currentVersion: '4.0.3', latestVersion: null, checkedAt: null, lastAttemptAt: null, lastSuccessfulCheckAt: null,
      lastError: 'offline', updateAvailable: false, checkSucceeded: false, source: 'cache', freshness: 'unavailable',
      currentVersionDeprecated: false, deprecationMessage: null,
    }) as never;
    fakeNode(OLD_NODE_VERSION);
    const old = await doctor({ openDatabaseImpl: () => { throw tooOldError(); }, getUpdateCheckImpl: unavailable });
    expect(old.checks.find((c) => c.id === 'update-status')?.fix).toContain(TOO_OLD_PROBLEM.fix);
    fakeNode(real);
    const fine = await doctor({ openDatabaseImpl: () => { throw new Error('x'); }, getUpdateCheckImpl: unavailable });
    expect(fine.checks.find((c) => c.id === 'update-status')?.fix).toContain('memesh status');
  });

  it('a damaged database is sent to the Database row\'s repair, not to "check that the folder is readable"', async () => {
    const result = await doctor({ openDatabaseImpl: () => { throw new Error('file is not a database'); } });
    for (const id of ['hook-activity', 'capture-liveness']) {
      const row = result.checks.find((c) => c.id === id);
      expect(row?.fix, id).toContain('damaged');
      expect(row?.fix, id).not.toMatch(/disk is not full/);
    }
  });

  it('a SQLite self-check that could not finish does not send the user to move a healthy database away', async () => {
    const err = new SqliteSelfCheckError(new Error('out of memory'));
    const result = await doctor({ openDatabaseImpl: () => { throw err; }, nativeBindingProbeImpl: () => ({ ok: false, message: err.message, fix: err.advice }) });
    for (const id of ['database', 'hook-activity', 'capture-liveness', 'native-binding']) {
      const row = result.checks.find((c) => c.id === id);
      expect(row?.fix, id).toContain('Your database is not the problem');
      expect(row?.fix, id).not.toMatch(/Backup and reset|\bmv\b|upgrade/i);
    }
  });
});
