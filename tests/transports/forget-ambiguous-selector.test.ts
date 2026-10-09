// #523: redaction is many-to-one. Two different credentials are both
// stored as `***REDACTED***`, so the redacted spelling of a selector cannot
// say WHICH stored line it meant. forget and the memory tool's str_replace
// act only on an exact stored-text match; when only the redacted spelling is
// stored they refuse as ambiguous and change nothing, and a selector that
// matches neither keeps the not-found answer. Checked through every caller,
// with the stored rows read back after each refusal.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { forget } from '../../src/core/operations.js';
import { handleMemoryCommand, MEMORY_ROOT } from '../../src/core/memory-tool.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';

// Assembled at runtime so no line in the repository looks like a credential.
const SECRET_A = ['token', 'aaaa1111aaaa1111aaaa'].join('=');
const SECRET_C = ['token', 'cccc3333cccc3333cccc'].join('=');
const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');
const REFUSAL = 'No exact stored-text match';

let dir: string;
let dbPath: string;
let server: import('node:http').Server;
let port: number;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-forget-ambiguous-'));
  process.env.MEMESH_DIR = dir;
  dbPath = path.join(dir, 'test.db');
  openDatabase(dbPath);
  const { app } = await import('../../src/transports/http/server.js');
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase();
  delete process.env.MEMESH_DIR;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A memory written before #523: raw SQL. `***REDACTED***` stands for some
 *  OTHER credential that was redacted when it was stored. */
function seed(name: string, observations: string[]): void {
  const db = getDatabase();
  const id = Number(db.prepare("INSERT INTO entities (name, type, namespace) VALUES (?, 'note', 'personal')").run(name).lastInsertRowid);
  for (const o of observations) db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, o);
}

function rows(name: string): string[] {
  return (getDatabase().prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id').all(name) as { content: string }[])
    .map((r) => r.content);
}

async function httpForget(name: string, observation: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/forget`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, observation }),
  });
  return { status: response.status, text: await response.text() };
}

function cliForget(name: string, observation: string, json = false): { status: number; out: string } {
  closeDatabase();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, MEMESH_DIR: dir, MEMESH_DB_PATH: dbPath };
  const r = spawnSync('node', [CLI_PATH, 'forget', '--name', name, '--observation', observation, ...(json ? ['--json'] : [])], { encoding: 'utf8', env, timeout: 30000 });
  openDatabase(dbPath);
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('an exact stored-text match is removed or edited', () => {
  it('forget and str_replace act on the raw line a legacy row still holds, not on its redacted sibling', () => {
    seed('exact-forget', [SECRET_A, '***REDACTED***', 'keep']);
    expect(forget({ name: 'exact-forget', observation: SECRET_A }).observation_removed).toBe(true);
    expect(rows('exact-forget')).toEqual(['***REDACTED***', 'keep']);
    seed('exact-edit', [SECRET_A, '***REDACTED***']);
    const r = handleMemoryCommand({ command: 'str_replace', path: `${MEMORY_ROOT}/personal/exact-edit.md`, old_str: SECRET_A, new_str: 'rotated' });
    expect(r.isError, r.content).toBe(false);
    expect(rows('exact-edit')).toEqual(['rotated', '***REDACTED***']);
  });
});

describe('a different secret that shares the marker is refused as ambiguous, with no effect, on every caller', () => {
  const stored = ['***REDACTED***', 'keep'];

  it('core forget', () => {
    seed('amb-core', stored);
    expect(() => forget({ name: 'amb-core', observation: SECRET_C })).toThrow(REFUSAL);
    expect(rows('amb-core')).toEqual(stored);
  });

  it('MCP forget', async () => {
    seed('amb-mcp', stored);
    const res = await handleTool('forget', { name: 'amb-mcp', observation: SECRET_C });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain(REFUSAL);
    expect(JSON.stringify(res)).not.toContain('cccc3333');
    expect(rows('amb-mcp')).toEqual(stored);
  });

  it('HTTP forget', async () => {
    seed('amb-http', stored);
    const res = await httpForget('amb-http', SECRET_C);
    expect(res.status).toBe(400);
    expect(res.text).toContain(REFUSAL);
    expect(res.text).not.toContain('cccc3333');
    expect(rows('amb-http')).toEqual(stored);
  });

  it('CLI forget, text and --json', () => {
    seed('amb-cli', stored);
    for (const json of [false, true]) {
      const res = cliForget('amb-cli', SECRET_C, json);
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(REFUSAL);
      expect(res.out).not.toContain('cccc3333');
      expect(res.out).not.toMatch(/^\s+at /m);
    }
    expect(rows('amb-cli')).toEqual(stored);
  });

  it('memory-tool str_replace', () => {
    seed('amb-tool', stored);
    const r = handleMemoryCommand({ command: 'str_replace', path: `${MEMORY_ROOT}/personal/amb-tool.md`, old_str: SECRET_C, new_str: 'EDITED' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no exact stored-text match');
    expect(r.content).not.toContain('cccc3333');
    expect(rows('amb-tool')).toEqual(stored);
  });
});

describe('a selector matching neither spelling keeps the not-found answer', () => {
  it('core, MCP, HTTP, CLI and str_replace', async () => {
    const stored = ['***REDACTED***', 'keep'];
    seed('absent', stored);
    expect(forget({ name: 'absent', observation: 'never stored' })).toMatchObject({ observation_removed: false, entity_found: true });
    const mcp = await handleTool('forget', { name: 'absent', observation: 'never stored' });
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp)).toContain('has no observation matching that text');
    const http = await httpForget('absent', 'never stored');
    expect(http.status).toBe(400);
    expect(JSON.parse(http.text).success).toBe(false);
    expect(JSON.parse(http.text).errorCode).toBe('operation.failed');
    expect(JSON.parse(http.text).error).toContain('has no observation matching that text');
    const cli = cliForget('absent', 'never stored');
    expect(cli.status).toBe(1);
    expect(cli.out).toContain('has no observation matching that text');
    const tool = handleMemoryCommand({ command: 'str_replace', path: `${MEMORY_ROOT}/personal/absent.md`, old_str: 'never stored', new_str: 'x' });
    expect(tool.content).toContain('did not appear verbatim');
    expect(rows('absent')).toEqual(stored);
  });

  // A credential-shaped selector whose text and masked spelling are both
  // absent is not-found too, not the ambiguity refusal.
  it('a credential-shaped selector that matches neither spelling', () => {
    seed('absent-cred', ['keep']);
    expect(forget({ name: 'absent-cred', observation: SECRET_C })).toMatchObject({ observation_removed: false, entity_found: true });
    const tool = handleMemoryCommand({ command: 'str_replace', path: `${MEMORY_ROOT}/personal/absent-cred.md`, old_str: SECRET_C, new_str: 'x' });
    expect(tool.content).toContain('did not appear verbatim');
    expect(rows('absent-cred')).toEqual(['keep']);
  });
});
