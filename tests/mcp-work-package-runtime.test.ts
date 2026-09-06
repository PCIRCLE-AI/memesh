import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';
import { getProjectName } from '../src/core/paths.js';
import { projectTranscriptSlug } from '../src/core/transcript-source.js';

it('stages digest and visible transcript work through the actual MCP stdio process with read-only deferral', async () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const require = createRequire(import.meta.url);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-work-package-'));
  const runtimeCwd = fs.realpathSync(runtime);
  const dbPath = path.join(runtime, 'memory.db');
  const project = 'mcp-runtime-digest';
  const secret = 'sk-' + 'z'.repeat(40); // Synthetic credential shape, never a real key.
  // Only named fixture settings reach the child; no ambient provider configuration.
  const env = {
    HOME: runtime, USERPROFILE: runtime, MEMESH_DIR: runtime,
    MEMESH_DB_PATH: dbPath,
    PATH: path.dirname(process.execPath),
  };
  const client = new Client({ name: 'work-package-runtime-test', version: '1' });
  const transport = new StdioClientTransport({
    // Reuse the absolute executable of the pinned verification runner.
    command: process.execPath,
    args: [path.join(runtime, 'dist/mcp/server.js')],
    cwd: runtimeCwd, env, stderr: 'pipe',
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
    const cli = (args: string[]) => spawnSync(process.execPath, [path.join(runtime, 'dist/transports/cli/cli.js'), ...args], {
      cwd: runtimeCwd, env, encoding: 'utf8', timeout: 5000,
    });
    const help = cli(['--help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).not.toMatch(/^ {2}(?:telemetry|consolidate|patterns|verify)\b/m);
    expect(cli(['pin', '--help']).status).toBe(0);
    expect(cli(['unpin', '--help']).status).toBe(0);
    const dreamHelp = cli(['dream', '--help']);
    expect(dreamHelp.status, dreamHelp.stderr).toBe(0);
    expect(dreamHelp.stdout).toMatch(/list/);
    expect(dreamHelp.stdout).toMatch(/show/);
    expect(dreamHelp.stdout).toMatch(/accept/);
    expect(dreamHelp.stdout).toMatch(/reject/);
    expect(dreamHelp.stdout).not.toMatch(/\b(?:run|patterns|conflicts)\b/);
    for (const args of [['dream', 'run'], ['dream', 'patterns'], ['dream', 'conflicts'], ['telemetry'], ['consolidate'], ['patterns'], ['verify'], ['doctor', '--probe'], ['reindex']]) {
      const rejected = cli(args);
      expect(rejected.status, `${args.join(' ')}: ${rejected.stdout} ${rejected.stderr}`).not.toBe(0);
    }
    for (const key of ['llm.provider', 'embedder.provider', 'language', 'transcriptMining']) {
      const rejected = cli(['config', 'set', key, 'removed']);
      expect(rejected.status, rejected.stderr).toBe(1);
    }
    expect(fs.existsSync(path.join(runtime, 'config.json'))).toBe(false);
    await client.connect(transport, { timeout: 5000 });
    const childPid = transport.pid;
    expect(childPid).toBeTypeOf('number');
    expect(childPid).not.toBe(process.pid);
    expect(client.getServerVersion()?.name).toBe('memesh');
    const { tools } = await client.listTools();
    const definition = tools.find(tool => tool.name === 'work_package');
    expect(definition?.description).toContain('transcript');

    for (let i = 0; i < 5; i++) {
      const remembered = await call('remember', {
        name: `runtime-parser-commit-${i}-${secret}`, type: 'commit',
        observations: [`Parser cleanup step ${i} completed. ${secret}`], tags: [`project:${project}`],
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
    expect(JSON.stringify(pkg)).not.toContain(secret);
    expect(pkg.sources[0].name).toContain('***REDACTED***');
    expect(pkg.sources[0].observations[0]).toContain('***REDACTED***');
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

    const transcriptProject = getProjectName(runtimeCwd);
    const transcriptDir = path.join(runtime, '.claude/projects', projectTranscriptSlug(runtimeCwd));
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, 'runtime-session.jsonl');
    fs.writeFileSync(transcriptPath, [
      { type: 'user', cwd: runtimeCwd, message: { content: 'Use the smaller parser.' } },
      { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>RUNTIME_SCAFFOLDING' }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'RUNTIME_PRIVATE' }, { type: 'text', text: `The smaller parser satisfies our requirements. ${secret}` }, { type: 'tool_use', input: 'RUNTIME_TOOL' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    const transcript = await call('work_package', { action: 'prepare', kind: 'transcript', project: transcriptProject });
    expect(transcript.response.isError).not.toBe(true);
    expect(transcript.data.status).toBe('available');
    const transcriptPackage = transcript.data.package;
    expect(transcriptPackage.ref).toMatchObject({ kind: 'transcript', project: transcriptProject, session_id: 'runtime-session' });
    expect(transcriptPackage.sources).toEqual([{ role: 'user', text: 'Use the smaller parser.' }, { role: 'assistant', text: 'The smaller parser satisfies our requirements. ***REDACTED***' }]);
    expect(transcriptPackage.coverage).toEqual({ truncated: false, total_turns: 2, included_turns: 2 });
    expect(JSON.stringify(transcriptPackage)).not.toMatch(/RUNTIME_PRIVATE|RUNTIME_TOOL|RUNTIME_SCAFFOLDING/);
    expect(JSON.stringify(transcriptPackage)).not.toContain(secret);
    expect(transcriptPackage.ref).not.toHaveProperty('path');
    const transcriptDeferred = await call('work_package', { action: 'defer', package_id: transcriptPackage.id, ref: transcriptPackage.ref, reason: 'not_now' });
    expect(transcriptDeferred.data).toEqual({ status: 'deferred', durable_change: false, available_action: [] });
    expect(proposalCount()).toMatchObject({ n: 1 });
    expect((await call('work_package', { action: 'prepare', kind: 'transcript', project: transcriptProject })).data.package).toEqual(transcriptPackage);
    const transcriptResult = { name: 'runtime-parser-decision', type: 'decision', observations: ['Use the smaller parser.'], tags: ['parser'] };
    const transcriptStaged = await call('work_package', { action: 'submit', package_id: transcriptPackage.id, ref: transcriptPackage.ref, result: transcriptResult });
    expect(transcriptStaged.response.isError).not.toBe(true);
    expect(transcriptStaged.data).toMatchObject({ status: 'staged', proposal_status: 'pending' });
    const existing = { status: 'existing', proposal_id: transcriptStaged.data.proposal_id, proposal_status: 'pending', available_action: [] };
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', cwd: `${runtimeCwd}-foreign`, message: { content: 'FOREIGN_PRIVATE_TEXT' } }));
    expect((await call('work_package', { action: 'submit', package_id: transcriptPackage.id, ref: transcriptPackage.ref, result: transcriptResult })).data).toEqual(existing);
    fs.unlinkSync(transcriptPath);
    expect((await call('work_package', { action: 'defer', package_id: transcriptPackage.id, ref: transcriptPackage.ref, reason: 'not_now' })).data).toEqual(existing);
    const conflict = await call('work_package', { action: 'submit', package_id: transcriptPackage.id, ref: transcriptPackage.ref, result: { ...transcriptResult, name: 'conflicting-result' } });
    expect(conflict.response.isError).toBe(true);
    expect(conflict.data.error).toBe('submission_conflict');
    expect(proposalCount()).toMatchObject({ n: 2 });
    await client.close();
    expect(transport.pid).toBeNull();
    const reindexed = cli(['reindex', '--fts', '--json']);
    expect(reindexed.status, reindexed.stderr).toBe(0);
    expect(JSON.parse(reindexed.stdout).entities).toBe(5);
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT * FROM dream_proposals').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: staged.data.proposal_id, project, status: 'pending', prompt_version: 'work-package-v1' });
      expect(JSON.parse(rows[0].source_ids as string)).toEqual(pkg.ref.source_ids);
      expect(JSON.parse(rows[0].proposed_digest as string)).toMatchObject({ ...result, work_package: { id: pkg.id, ref: pkg.ref } });
      expect(rows[1]).toMatchObject({ id: transcriptStaged.data.proposal_id, project: transcriptProject, status: 'pending', source_kind: 'transcript', kind: 'digest', prompt_version: 'work-package-v1' });
      expect(JSON.parse(rows[1].source_ids as string)).toEqual({ sessionId: 'runtime-session' });
      expect(JSON.parse(rows[1].proposed_digest as string)).toMatchObject({ ...transcriptResult, work_package: { id: transcriptPackage.id, ref: transcriptPackage.ref } });
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
