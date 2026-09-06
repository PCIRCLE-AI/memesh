import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';

it('stages a digest through the actual MCP stdio process and preserves read-only deferral', async () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const require = createRequire(import.meta.url);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-work-package-'));
  const dbPath = path.join(runtime, 'memory.db');
  const project = 'mcp-runtime-digest';
  // Only named fixture settings reach the child; no ambient provider configuration.
  const env = {
    HOME: runtime, USERPROFILE: runtime, MEMESH_DIR: runtime,
    MEMESH_DB_PATH: dbPath, MEMESH_AUTO_DETECT_LLM: '0',
    PATH: path.dirname(process.execPath),
  };
  const client = new Client({ name: 'work-package-runtime-test', version: '1' });
  const transport = new StdioClientTransport({
    // Reuse the absolute executable of the pinned verification runner.
    command: process.execPath,
    args: [path.join(runtime, 'dist/mcp/server.js')],
    cwd: runtime, env, stderr: 'pipe',
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    expect(Array.isArray(response.content)).toBe(true);
    const content = response.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe('text');
    return { response, data: JSON.parse(content[0].text!) };
  };
  const proposalCount = () => {
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS n FROM dream_proposals').get(); }
    finally { db.close(); }
  };
  try {
    // The repository uses tsc, not a TS runtime loader. Build current source into
    // this fixture so registration/dispatch cannot come from stale local dist.
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(repo, 'tsconfig.json'),
      '--outDir', path.join(runtime, 'dist'), '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'],
    { cwd: repo, env, timeout: 20000, stdio: 'pipe' });
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(runtime, 'package.json'));
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(runtime, 'node_modules'), 'dir');
    await client.connect(transport, { timeout: 5000 });
    const childPid = transport.pid;
    expect(childPid).toBeTypeOf('number');
    expect(childPid).not.toBe(process.pid);
    expect(client.getServerVersion()?.name).toBe('memesh');
    const { tools } = await client.listTools();
    const definition = tools.find(tool => tool.name === 'work_package');
    expect(definition?.description).toContain('digest-only');

    for (let i = 0; i < 5; i++) {
      const remembered = await call('remember', {
        name: `runtime-parser-commit-${i}`, type: 'commit',
        observations: [`Parser cleanup step ${i} completed.`], tags: [`project:${project}`],
      });
      expect(remembered.response.isError).not.toBe(true);
      expect(remembered.data.stored).toBe(true);
    }
    const prepared = await call('work_package', { action: 'prepare', project, kind: 'digest' });
    expect(prepared.response.isError).not.toBe(true);
    expect(prepared.data.status).toBe('available');
    expect(prepared.data.available_action).toEqual([{ action: 'submit', actor: 'agent' }, { action: 'defer', actor: 'agent' }]);
    const pkg = prepared.data.package;
    expect(pkg).toMatchObject({
      ref: { project, kind: 'digest' }, selection_mode: 'calendar', trust: 'untrusted',
      coverage: { truncated: false }, limits: { max_output_bytes: 16384, max_results: 1 },
    });
    expect(pkg.sources).toHaveLength(5);
    expect(pkg.ref.source_ids).toEqual(pkg.sources.map((source: { id: number }) => source.id));
    expect(pkg.id).toMatch(/^[a-f0-9]{64}$/);
    expect(pkg.ref.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(JSON.stringify(pkg))).toBeLessThanOrEqual(65536);
    expect(proposalCount()).toMatchObject({ n: 0 });
    const deferred = await call('work_package', { action: 'defer', package_id: pkg.id, ref: pkg.ref, reason: 'not_now' });
    expect(deferred.response.isError).not.toBe(true);
    expect(deferred.data).toEqual({ status: 'deferred', durable_change: false, available_action: [] });
    expect(proposalCount()).toMatchObject({ n: 0 });
    expect((await call('work_package', { action: 'prepare', project, kind: 'digest' })).data.package).toEqual(pkg);

    const result = { name: 'runtime-parser-digest', type: 'digest', observations: ['Five parser cleanup steps completed.'], tags: ['parser'] };
    const invalid = await call('work_package', {
      action: 'submit', package_id: pkg.id, ref: pkg.ref, result: { ...result, tags: ['project:forged'] },
    });
    expect(invalid.response.isError).toBe(true);
    expect(invalid.data.error).toBe('invalid_input');
    expect(proposalCount()).toMatchObject({ n: 0 });
    const staged = await call('work_package', { action: 'submit', package_id: pkg.id, ref: pkg.ref, result });
    expect(staged.response.isError).not.toBe(true);
    expect(staged.data).toMatchObject({ status: 'staged', proposal_status: 'pending', review_authority: 'human' });
    await client.close();
    expect(transport.pid).toBeNull();
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT * FROM dream_proposals').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: staged.data.proposal_id, project, status: 'pending', llm_model: null, prompt_version: 'work-package-v1' });
      expect(JSON.parse(rows[0].source_ids as string)).toEqual(pkg.ref.source_ids);
      expect(JSON.parse(rows[0].proposed_digest as string)).toMatchObject({ ...result, work_package: { id: pkg.id, ref: pkg.ref } });
      expect(db.prepare("SELECT count(*) AS n FROM entities WHERE status = 'active'").get()).toMatchObject({ n: 5 });
    } finally { db.close(); }
  } finally {
    try { await client.close(); }
    finally {
      await transport.close();
      fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}, 30000);
