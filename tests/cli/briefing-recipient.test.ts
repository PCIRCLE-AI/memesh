import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { seedLegacyMessage } from '../helpers/agent-session-fixture.js';
import { remember } from '../../src/core/operations.js';

const cliLoader = `
  import { createServer } from 'vite';
  const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts');
    await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]);
  } finally {
    await server.close();
  }
`;

function runCli(home: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
    MEMESH_DIR: path.join(home, '.memesh'), MEMESH_DB_PATH: path.join(home, '.memesh', 'knowledge-graph.db'),
    MEMESH_AUTO_CAPTURE: 'false' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'MEMESH_SESSION_ID']) delete env[key];
  return spawnSync(process.execPath, ['--input-type=module', '--eval', cliLoader, ...args], {
    encoding: 'utf8',
    input: '{}',
    env,
  });
}

function send(home: string, recipient: string, key: string, includeMemory = true) {
  // Legacy rows remain intact, but briefing no longer renders their notices.
  const directory = path.join(home, '.memesh');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ updateCheck: false, autoUpdate: 'off' }), { mode: 0o600 });
  const db = openDatabase(path.join(directory, 'knowledge-graph.db'));
  try {
    seedLegacyMessage(db, { project: 'briefing-cli-project', sender: 'sender', recipient,
      idempotency_key: key, content_type: 'application/json', payload: {} });
    if (includeMemory) remember({ name: 'briefing-memory', type: 'note', title: 'CLI memory sentinel',
      observations: ['Keep ordinary project context'], project: 'briefing-cli-project' });
  } finally { closeDatabase(); }
}

function legacyRows(home: string) {
  const db = openDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
  try { return ['agent_messages', 'agent_message_deliveries', 'agent_message_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all()); }
  finally { closeDatabase(); }
}

describe('CLI briefing recipient scope', () => {
  it('keeps project memory but no legacy inbox instructions with or without recipient', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-briefing-'));
    try {
      send(home, 'recipient-one', 'cli-briefing-one');
      send(home, 'recipient-two', 'cli-briefing-two');
      const before = legacyRows(home);

      const generic = runCli(home, 'briefing', '--project', 'briefing-cli-project', '--json');
      expect(generic.status, generic.stderr).toBe(0);
      expect(JSON.parse(generic.stdout).text).not.toContain('message waiting');
      expect(JSON.parse(generic.stdout).hasTaskState).toBe(false);

      const scoped = runCli(
        home, 'briefing', '--project', 'briefing-cli-project', '--recipient', 'recipient-one', '--json',
      );
      expect(scoped.status, scoped.stderr).toBe(0);
      const text = JSON.parse(scoped.stdout).text as string;
      expect(text).toContain('CLI memory sentinel');
      expect(text).toBe(JSON.parse(generic.stdout).text);
      expect(text).not.toMatch(/message waiting|poll the message tool|fetch each message_id|intake/);
      expect(text).not.toContain('recipient-two');
      // Legacy inbox rows are not task state.
      expect(JSON.parse(scoped.stdout).hasTaskState).toBe(false);
      expect(legacyRows(home)).toEqual(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('an empty briefing points at the first memory without a legacy reminder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-briefing-hint-'));
    try {
      send(home, 'recipient-one', 'cli-briefing-hint', false);
      fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({
        updateCheck: false, autoUpdate: 'off', briefing: 'standard',
      }), { mode: 0o600 });
      const before = legacyRows(home);
      const text = runCli(home, 'briefing', '--project', 'briefing-cli-project', '--recipient', 'recipient-one');
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).not.toContain('1 message waiting for "recipient-one"');
      expect(text.stdout).toContain('Nothing to brief at level standard');
      expect(text.stdout).toContain('memesh remember --name first-memory');
      expect(text.stdout).not.toMatch(/poll the message tool|fetch each message_id|intake/);
      expect(legacyRows(home)).toEqual(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
