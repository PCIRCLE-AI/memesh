import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';

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

function send(home: string, recipient: string, key: string) {
  // Briefing's still-supported --recipient reads the legacy inbox, not the
  // conversation store populated by the four-action public message command.
  const directory = path.join(home, '.memesh');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ updateCheck: false, autoUpdate: 'off' }), { mode: 0o600 });
  const db = openDatabase(path.join(directory, 'knowledge-graph.db'));
  try {
    sendAgentMessage(db, { project: 'briefing-cli-project', sender: 'sender', recipient,
      idempotency_key: key, content_type: 'application/json', payload: {} });
  } finally { closeDatabase(); }
}

describe('CLI briefing recipient scope', () => {
  it('hides generic inbox activity and reports only the exact recipient', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-briefing-'));
    try {
      send(home, 'recipient-one', 'cli-briefing-one');
      send(home, 'recipient-two', 'cli-briefing-two');

      const generic = runCli(home, 'briefing', '--project', 'briefing-cli-project', '--json');
      expect(generic.status, generic.stderr).toBe(0);
      expect(JSON.parse(generic.stdout).text).not.toContain('message waiting');
      expect(JSON.parse(generic.stdout).hasTaskState).toBe(false);

      const scoped = runCli(
        home, 'briefing', '--project', 'briefing-cli-project', '--recipient', 'recipient-one', '--json',
      );
      expect(scoped.status, scoped.stderr).toBe(0);
      const text = JSON.parse(scoped.stdout).text as string;
      expect(text).toContain('1 message waiting for "recipient-one"');
      expect(text).toContain('in project "briefing-cli-project"');
      expect(text).not.toContain('recipient-two');
      // The reminder is the ONLY state line here, and it is not a task state:
      // `hasTaskState` said `true` for it before it counted task-state lines only.
      expect(JSON.parse(scoped.stdout).hasTaskState).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // `hasTaskState` gates `memesh briefing`'s "set the task state" hint. With the
  // reminder counted as a task state the hint stayed silent on exactly the
  // project that has none; now it says so, beside the reminder.
  it('a briefing whose only state line is the reminder still points at `memesh task`', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-briefing-hint-'));
    try {
      send(home, 'recipient-one', 'cli-briefing-hint');
      const text = runCli(home, 'briefing', '--project', 'briefing-cli-project', '--recipient', 'recipient-one');
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain('1 message waiting for "recipient-one"');
      expect(text.stdout).toContain('memesh task --goal');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
