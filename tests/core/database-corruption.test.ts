/**
 * A database whose file opens fine but whose message-table pages are damaged.
 * Briefing used to say nothing, then said "run memesh doctor" while doctor
 * called the database healthy. Both are checked here against a real damaged
 * file, not a stub.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const handle = useTestDatabase('memesh-db-corruption-');

/** Write garbage over the root page of the deliveries table, then reopen the file. */
function damageDeliveriesTable(): void {
  const db = getDatabase();
  const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'agent_message_deliveries'").get() as { rootpage: number };
  const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  closeDatabase();
  const fd = fs.openSync(handle.dbPath, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, (rootpage - 1) * pageSize);
  } finally {
    fs.closeSync(fd);
  }
  openDatabase(handle.dbPath);
}

/** Doctor resolves the database path from the environment, so point it at the file the test damaged. */
async function doctor() {
  const previous = process.env.MEMESH_DB_PATH;
  process.env.MEMESH_DB_PATH = handle.dbPath;
  try {
    return await runDoctorOnce();
  } finally {
    if (previous === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = previous;
  }
}

function runDoctorOnce() {
  return runDoctor({
    packageRoot: process.cwd(),
    packageVersion: 'test',
    openDatabaseImpl: () => getDatabase(),
    closeDatabaseImpl: () => undefined,
    isDatabaseOpenImpl: () => true,
    getConfigPathImpl: () => path.join(handle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

describe('a database with damaged pages', () => {
  const send = () => sendAgentMessage(getDatabase(), {
    project: 'proj-c', sender: 'sender', recipient: 'reader', idempotency_key: 'c-1',
    content_type: 'application/json', payload: { text: 'hello' },
  });

  it('is a healthy file to start with: doctor passes and briefing counts the message', async () => {
    send();
    const report = await doctor();
    expect(report.checks.find((c) => c.id === 'database')?.status).toBe('pass');
    expect(assembleBriefing('proj-c', 'reader').text).toContain('1 message waiting');
  });

  it('makes doctor fail the database row, naming the damage and how to restore', async () => {
    send();
    damageDeliveriesTable();
    const report = await doctor();
    const rows = report.checks.filter((c) => c.id === 'database');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('fail');
    expect(rows[0].summary).toContain('quick integrity check failed');
    // The row names the file that is actually damaged, and the advice starts by copying it.
    expect(rows[0].summary).toContain(handle.dbPath);
    expect(rows[0].fix).toContain(`${handle.dbPath}.damaged`);
    expect(rows[0].fix).toMatch(/\.recover \| sqlite3 /);
    expect(report.status).toBe('FAIL');
  });

  it('makes briefing carry SQLite\'s own error, so "run memesh doctor" leads somewhere', () => {
    send();
    damageDeliveriesTable();
    const text = assembleBriefing('proj-c', 'reader').text;
    expect(text).toContain('could not be read: "');
    expect(text).toMatch(/malformed/i);
    expect(text).toContain('run memesh doctor');
  });
});
