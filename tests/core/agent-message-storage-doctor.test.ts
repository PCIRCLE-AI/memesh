import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentMessageExpiry } from '../../src/core/agent-message-expiry.js';
import { runDoctor } from '../../src/core/doctor.js';
import { recordAgentReceipt, recordAgentWorkflowFact, sendAgentMessage } from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-agent-message-storage-doctor-');

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

function doctor(policy?: { storage_quota_bytes?: number }) {
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
    agentMessageStoragePolicy: policy,
  });
}

describe('doctor agent-message storage pressure', () => {
  it('reports real SQLite pressure read-only and names policy/quota state without activating cleanup', async () => {
    const sent = sendAgentMessage(getDatabase(), {
      project: 'doctor-storage', sender: 'sender', recipient: 'recipient', idempotency_key: 'message-1',
      content_type: 'application/json', payload: { body: 'retained-until-an-owner-policy-says-otherwise' },
    });
    recordAgentReceipt(getDatabase(), {
      project: 'doctor-storage', recipient: 'recipient', message_id: sent.message_id,
      actor: 'recipient', idempotency_key: 'ack-1', receipt_kind: 'ack',
    });
    recordAgentWorkflowFact(getDatabase(), {
      delivery_id: sent.delivery_id, actor: 'recipient', workflow_state: 'completed', idempotency_key: 'complete-1',
    });
    const before = getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages
    `).all();

    const configured = await doctor({ storage_quota_bytes: 1024 * 1024 });
    const configuredRow = configured.checks.find((check) => check.id === 'agent_message_storage');
    expect(configuredRow).toMatchObject({ status: 'pass', informational: true });
    expect(configuredRow?.summary).toMatch(/logical payload/);
    expect(configuredRow?.summary).toMatch(/unresolved\/protected/);
    expect(configuredRow?.summary).toMatch(/SQLite freelist reusable/);
    expect(configuredRow?.summary).toMatch(/WAL/);
    expect(configuredRow?.summary).toMatch(/quota 1\.0 MiB/);
    expect(configuredRow?.summary).toContain('messages are kept one day, then deleted');
    expect(configuredRow?.summary).toMatch(/did not delete messages.*VACUUM/);

    const unconfigured = await doctor();
    const unconfiguredRow = unconfigured.checks.find((check) => check.id === 'agent_message_storage');
    expect(unconfiguredRow?.summary).toContain('quota not configured');
    expect(unconfiguredRow?.summary).not.toContain('not configured; terminal');
    expect(getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages
    `).all()).toEqual(before);
  });

  it('shows the last expiry pass, and no longer counts an expired message as unresolved', async () => {
    const send = (key: string) => sendAgentMessage(getDatabase(), {
      project: 'doctor-storage', sender: 'sender', recipient: 'recipient', idempotency_key: key,
      content_type: 'application/json', payload: { body: key },
    });
    const sent = send('expired-1');
    getDatabase().prepare("UPDATE agent_messages SET created_at = datetime('now', '-2 days') WHERE message_id = ?").run(sent.message_id);
    getDatabase().prepare("UPDATE agent_message_deliveries SET created_at = datetime('now', '-2 days') WHERE message_id = ?").run(sent.message_id);

    const waiting = await doctor();
    const storage = waiting.checks.find((check) => check.id === 'agent_message_storage');
    expect(storage?.summary).toContain('0 unresolved/protected');
    expect(storage?.summary).toContain('1 past that are waiting for the next expiry pass');
    const noPass = waiting.checks.find((check) => check.id === 'agent_message_expiry');
    expect(noPass).toMatchObject({ status: 'warn' });
    expect(noPass?.summary).toContain('No expiry pass has run');

    await runAgentMessageExpiry(getDatabase(), { trigger: 'doctor-test' });
    const after = await doctor();
    const row = after.checks.find((check) => check.id === 'agent_message_expiry');
    expect(row).toMatchObject({ status: 'pass', informational: true });
    expect(row?.summary).toContain('Last pass');
    expect(row?.summary).toContain('deleted');
    expect(row?.summary).toContain('1 message(s) deleted (1 with no intake, acknowledgement, disposition or reply; 1 sender notice(s))');
    expect(row?.summary).toContain('started by doctor-test');
    expect(row?.summary).toContain('Deleted messages are kept one more day in');
    expect(after.checks.find((check) => check.id === 'agent_message_storage')?.summary).not.toContain('waiting for the next expiry pass');
  });

  it('warns when the last expiry pass failed, naming what to do', async () => {
    getDatabase().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, detail)
      VALUES (?, ?, 'router', 'archive_failed', 'could not archive the rows of 3 message(s) before deleting them (disk full); nothing in this batch was deleted')
    `).run(Date.now(), Date.now());
    const row = (await doctor()).checks.find((check) => check.id === 'agent_message_expiry');
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('disk full');
    expect(row?.fix).toContain('Nothing more is deleted while this fails');
  });

  it('reports the named owner quota environment policy without enabling retention', async () => {
    const original = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
    process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = '4096';
    try {
      const result = await doctor();
      const row = result.checks.find((check) => check.id === 'agent_message_storage');
      expect(row?.summary).toContain('quota 4.0 KiB');
      expect(row?.summary).toContain('messages are kept one day, then deleted');
    } finally {
      if (original === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
      else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = original;
    }
  });

  it.each(['1e3', ' 1000', '1000 ', '+1000', '-1', '1.0', '9007199254740992'])(
    'warns and changes the overall state when quota %j is rejected by send syntax', async (raw) => {
      const original = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
      process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = raw;
      try {
        const result = await doctor();
        const row = result.checks.find((check) => check.id === 'agent_message_storage');
        expect(row?.status).toBe('warn');
        expect(row?.informational).toBeUndefined();
        expect(row?.summary).toContain('configured quota is invalid');
        expect(row?.summary).toContain('Send enforcement rejects this quota configuration');
        expect(result.status).not.toBe('PASS');
      } finally {
        if (original === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
        else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = original;
      }
    },
  );

  it.each(['0', '4096'])(
    'keeps canonical quota %j as a valid informational report', async (raw) => {
      const original = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
      process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = raw;
      try {
        const result = await doctor();
        const row = result.checks.find((check) => check.id === 'agent_message_storage');
        expect(row).toMatchObject({ status: 'pass', informational: true });
        expect(row?.summary).not.toContain('configured quota is invalid');
        expect(row?.summary).toContain(raw === '0' ? 'quota 0 B' : 'quota 4.0 KiB');
      } finally {
        if (original === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
        else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = original;
      }
    },
  );
});
