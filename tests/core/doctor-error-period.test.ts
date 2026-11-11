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
import { runDoctor } from '../../src/core/doctor.js';
import { NothingToClaimError } from '../../src/core/dreamer.js';
import { withoutFinalPeriod } from '../../src/core/sentence.js';
import { TOO_OLD_MESSAGE, tooOldError } from '../helpers/node-floor.js';
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
  });

  it('hook-activity and capture-liveness: an error ending in a stop gives one stop, not two', async () => {
    const rows = await rowsFor('Upgrade the thing and run memesh again.');
    expect(rows.map((r) => r.id).sort()).toEqual(['capture-liveness', 'hook-activity']);
    for (const row of rows) {
      expect(row.summary).toContain('again. ');
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
      nativeBindingProbeImpl: () => ({ ok: false, message: TOO_OLD_MESSAGE, nodeTooOld: true }),
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
