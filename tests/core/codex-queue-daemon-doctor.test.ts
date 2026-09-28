import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { recordAgentReceipt, sendAgentMessage } from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-codex-queue-daemon-doctor-');

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

function doctor() {
  return runDoctor({
    packageRoot: process.cwd(),
    packageVersion: 'test',
    openDatabaseImpl: () => getDatabase(),
    closeDatabaseImpl: () => undefined,
    isDatabaseOpenImpl: () => true,
    getConfigPathImpl: () => path.join(dbHandle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

/** A host_activation receipt shaped like the one the Codex release writes
 *  (codex-cli-queue.ts), with each field overridable. */
function releaseReceipt(opts: {
  key: string; actor?: string; idempotencyKey?: string; recipient?: string;
  activation: 'woken' | 'unsupported'; reason?: string;
}) {
  const recipient = opts.recipient ?? 'codex-thread';
  const sent = sendAgentMessage(getDatabase(), {
    project: 'doctor-codex-queue', sender: 'memesh-router', recipient,
    idempotency_key: `message-${opts.key}`, content_type: 'application/json',
    payload: { body: 'stuck message' },
  });
  recordAgentReceipt(getDatabase(), {
    project: 'doctor-codex-queue', recipient, message_id: sent.message_id,
    actor: opts.actor ?? 'memesh-router',
    idempotency_key: opts.idempotencyKey ?? `codex-queue-release-${opts.key}`,
    receipt_kind: 'host_activation', host_activation: opts.activation,
    detail: opts.reason ? { codex_queue: 'unavailable', checks: 30, reason: opts.reason } : { codex_queue: 'started', checks: 1 },
  });
}

describe('doctor codex queue-release daemon availability', () => {
  const row = async () => (await doctor()).checks.find((check) => check.id === 'codex-queue-daemon');

  it('reports PASS/INFO with no warning when there are no host_activation receipts', async () => {
    const found = await row();
    expect(found?.status).toBe('pass');
    expect(found?.informational).toBe(true);
  });

  it('reports PASS/INFO with no warning when the daemon activation succeeded', async () => {
    releaseReceipt({ key: 'woken', activation: 'woken' });
    const found = await row();
    expect(found?.status).toBe('pass');
    expect(found?.informational).toBe(true);
  });

  it('warns and names the daemon-missing consequence when a receipt reports no_daemon', async () => {
    releaseReceipt({ key: 'no-daemon', activation: 'unsupported', reason: 'no_daemon' });

    const result = await doctor();
    const found = result.checks.find((check) => check.id === 'codex-queue-daemon');
    expect(found?.status).toBe('warn');
    expect(found?.informational).toBeUndefined();
    expect(found?.summary).toContain('app-server daemon');
    expect(found?.summary).toMatch(/message queued there .* stays in that thread's queue/);
    expect(found?.fix).toBeTruthy();
    expect(result.status).not.toBe('PASS');
  });

  // Any agent can record a host_activation receipt through the public
  // `activation` action; its `unsupported` says nothing about Codex's daemon.
  // Each filter gets its own case, so dropping either one alone goes red.
  it('does not warn for a no_daemon receipt with the release key but another actor', async () => {
    releaseReceipt({ key: 'actor', actor: 'codex-thread', activation: 'unsupported', reason: 'no_daemon' });
    expect((await row())?.status).toBe('pass');
  });

  it('does not warn for a no_daemon receipt from the router actor but another key', async () => {
    releaseReceipt({ key: 'k', idempotencyKey: 'my-own-activation', activation: 'unsupported', reason: 'no_daemon' });
    expect((await row())?.status).toBe('pass');
  });

  it('does not warn for a no_daemon receipt older than 7 days', async () => {
    releaseReceipt({ key: 'old', activation: 'unsupported', reason: 'no_daemon' });
    getDatabase().prepare(
      "UPDATE agent_message_receipts SET created_at = datetime('now', '-8 days') WHERE idempotency_key = 'codex-queue-release-old'",
    ).run();
    expect((await row())?.summary).toContain('No Codex host_activation receipts');
  });

  it('does not warn once the thread\'s newest release found the daemon', async () => {
    releaseReceipt({ key: 'before', activation: 'unsupported', reason: 'no_daemon' });
    getDatabase().prepare(
      "UPDATE agent_message_receipts SET created_at = datetime('now', '-2 days') WHERE idempotency_key = 'codex-queue-release-before'",
    ).run();
    releaseReceipt({ key: 'after', activation: 'woken' });
    expect((await row())?.status).toBe('pass');
  });

  it('names each thread whose newest release had no daemon', async () => {
    releaseReceipt({ key: 'a', recipient: 'codex-thread-a', activation: 'unsupported', reason: 'no_daemon' });
    releaseReceipt({ key: 'b', recipient: 'codex-thread-b', activation: 'woken' });
    const warned = await row();
    expect(warned?.status).toBe('warn');
    expect(warned?.summary).toContain('1 Codex thread(s)');
    expect(warned?.summary).toContain('codex-thread-a in doctor-codex-queue');
    expect(warned?.summary).not.toContain('codex-thread-b');
  });
});
