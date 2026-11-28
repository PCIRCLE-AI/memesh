/**
 * The packaged MCP server, started where the memesh folder cannot be written and holds a cleanly closed WAL
 * database. Before, the server could not open the database at all; now it opens it read-only, so `recall` answers
 * from the stored memories, while `remember` is refused with a message that names the folder and says what to run.
 *
 * Runs the built server (dist/mcp/server.js) over stdio, against a throwaway HOME. Skipped for root and on
 * Windows, where a mode bit is no barrier.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canDenyReads } from './helpers/permissions.js';


async function session<T>(workspace: string, dir: string, body: (client: Client, stderr: () => string) => Promise<T>): Promise<T> {
  // No detached update checker holding the fixture's folder, and nothing outside the throwaway HOME.
  const env = { HOME: workspace, USERPROFILE: workspace, MEMESH_DIR: dir, PATH: path.dirname(process.execPath), MEMESH_AUTO_CAPTURE: 'false', MEMESH_PROJECT_ROOT: workspace };
  const client = new Client({ name: 'readonly-folder-fixture', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/server.js')], cwd: workspace, env, stderr: 'pipe' });
  let stderrText = '';
  try {
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });
    return await body(client, () => stderrText);
  } finally {
    await client.close();
    await transport.close();
  }
}

describe.skipIf(!canDenyReads)('the MCP server in a memesh folder that cannot be written', () => {
  it('recall reads the stored memory; remember is refused, naming the folder and the fix', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-readonly-')));
    const dir = path.join(workspace, '.memesh');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updateCheck: false }));
    try {
      await session(workspace, dir, async (client) => {
        const stored = await client.callTool({ name: 'remember', arguments: { name: 'mcp-readonly-memory', type: 'note', observations: ['the quick brown mcp readonly marker'] } });
        expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
      });
      const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'));
      expect(leftovers, 'the first session left sidecars: not the cleanly-closed state').toEqual([]);
      expect(fs.readdirSync(dir).length, 'the memesh folder is empty').toBeGreaterThan(0);
      fs.chmodSync(dir, 0o555);
      expect(() => fs.writeFileSync(path.join(dir, 'probe'), 'x'), 'the folder is writable: this test would prove nothing').toThrow();

      await session(workspace, dir, async (client, stderr) => {
        const recalled = await client.callTool({ name: 'recall', arguments: { query: 'mcp readonly marker' } });
        expect(recalled.isError, JSON.stringify(recalled)).not.toBe(true);
        expect(JSON.stringify(recalled), 'recall did not return the stored memory').toContain('the quick brown mcp readonly marker');

        const refused = await client.callTool({ name: 'remember', arguments: { name: 'cannot-be-saved', type: 'note', observations: ['refused'] } });
        expect(refused.isError, JSON.stringify(refused)).toBe(true);
        const text = JSON.stringify(refused);
        expect(text, 'the refusal does not name the folder').toContain(dir);
        expect(text).toMatch(/read-only/);
        expect(text).toContain('chmod u+w');
        expect(stderr()).toMatch(/read-only/);

        // An import is refused as a whole, with the same message: not "imported 0" and a list of per-entity errors.
        const importRefused = await client.callTool({ name: 'import', arguments: {
          data: { version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
            entities: [{ name: 'mcp-imported', type: 'note', namespace: 'personal', observations: ['bundle text'], tags: [], relations: [] }] },
          merge_strategy: 'append',
        } });
        expect(importRefused.isError, `an import into a read-only folder was reported as a success: ${JSON.stringify(importRefused)}`).toBe(true);
        expect(JSON.stringify(importRefused)).toContain(dir);
        expect(JSON.stringify(importRefused)).toContain('chmod u+w');
      });

      fs.chmodSync(dir, 0o755);
      const check = await session(workspace, dir, (client) => client.callTool({ name: 'recall', arguments: { query: 'refused' } }));
      expect(JSON.stringify(check), 'a refused write was stored anyway').not.toContain('cannot-be-saved');
    } finally {
      try { fs.chmodSync(dir, 0o755); } catch { /* gone */ }
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
});
