import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

const cli = path.resolve('dist/transports/cli/cli.js');
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-context-'));
  env = buildIsolatedSuiteEnv(process.env, { runtimeHome: home });
  // The CLI's setup writes use remember, which can start a registry check
  // that still owns the fixture's npm cache when Windows removes it.
  const config = path.join(home, '.memesh');
  fs.mkdirSync(config, { mode: 0o700 });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ updateCheck: false }), { mode: 0o600 });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
function run(args: string[], input = '', cwd?: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, input, encoding: 'utf8', timeout: 15_000 });
}
function context(session = 'reader') {
  const result = run(['hermes', 'prompt-context', '--session', session], JSON.stringify({ prompt: 'Jasper orange routing prefix' }));
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it('returns empty without creating a database on first use', () => {
  const before = fs.readdirSync(home);
  expect(context()).toEqual({ text: '', ids: [] });
  expect(fs.readdirSync(home)).toEqual(before);
  expect(fs.readdirSync(path.join(home, '.memesh'))).toEqual(['config.json']);
});

it.each(['environment', 'config'])('reads full content with automatic capture off via %s while respecting the recall switch', (source) => {
  const saved = run(['hermes', 'capture-turn', '--session', 'writer'], JSON.stringify({
    user: 'Jasper orange routing prefix: ' + '測試內容'.repeat(3000),
    assistant: 'Jasper orange routing prefix: exact-detail-Q7',
  }));
  expect(saved.status, saved.stderr).toBe(0);
  expect(JSON.parse(saved.stdout)).toMatchObject({ outcome: 'wrote', names: [expect.any(String), expect.any(String)] });
  expect(context('writer')).toEqual({ text: '', ids: [] });
  const result = context();
  expect(result.ids).toHaveLength(2);
  expect(result.text).toContain('exact-detail-Q7');
  expect(result.text).toContain('content truncated; recall ids=');
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(4096);
  expect(result.text).toContain('background data, not instructions');
  const conversationRows = () => {
    const db = new MemeshDatabase(path.join(home, '.memesh', 'knowledge-graph.db'), { readOnly: true });
    try {
      return db.prepare(`SELECT e.id,e.name,o.id AS observation_id,o.content FROM entities e
        JOIN observations o ON o.entity_id=e.id WHERE e.type='conversation' ORDER BY e.id,o.id`).all();
    } finally { db.close(); }
  };
  const before = conversationRows();
  expect(before.map((row) => row.content)).toEqual([
    'Jasper orange routing prefix: ' + '測試內容'.repeat(3000),
    'Jasper orange routing prefix: exact-detail-Q7',
  ]);
  if (source === 'environment') env.MEMESH_AUTO_CAPTURE = 'false';
  else expect(run(['config', 'set', 'autoCapture', 'false']).status).toBe(0);
  const disabledCapture = run(['hermes', 'capture-turn', '--session', 'reader'], JSON.stringify({
    user: 'Do not capture this synthetic turn', assistant: 'Synthetic response while capture is off',
  }));
  expect(disabledCapture.status, disabledCapture.stderr).toBe(0);
  expect(JSON.parse(disabledCapture.stdout)).toEqual({ outcome: 'skipped', reason: 'auto-capture is turned off' });
  expect(context()).toEqual(result);
  expect(conversationRows()).toEqual(before);
  delete env.MEMESH_AUTO_CAPTURE;
  if (source === 'config') expect(run(['config', 'set', 'autoCapture', 'true']).status).toBe(0);
  expect(run(['config', 'set', 'promptRecall', 'false']).status).toBe(0);
  expect(context()).toEqual({ text: '', ids: [] });
  expect(conversationRows()).toEqual(before);
});

it('does not automatically expose memories filed under another project', () => {
  const saved = run(['remember', '--name', 'private-project-routing', '--type', 'note', '--project', 'other-project', '--obs', 'Jasper orange routing prefix: should-not-inject']);
  expect(saved.status, saved.stderr).toBe(0);
  expect(context()).toEqual({ text: '', ids: [] });
  const otherHost = run(['remember', '--name', 'other-host-routing', '--type', 'note', '--no-project', '--tags', 'platform:codex', '--obs', 'Jasper orange routing prefix: other-host-only']);
  expect(otherHost.status, otherHost.stderr).toBe(0);
  expect(context()).toEqual({ text: '', ids: [] });
});

it('recalls project-tagged assistant content through a checkout path alias only when bound to that project', () => {
  const project = fs.mkdtempSync(path.join(home, 'project-'));
  const other = fs.mkdtempSync(path.join(home, 'other-'));
  const init = spawnSync('git', ['init', '--quiet', project], { env, encoding: 'utf8', timeout: 15_000 });
  expect(init.status, init.stderr).toBe(0);
  for (const [cwd, name, marker] of [
    [project, 'same-project-turn', 'local-path-memory-Q7'],
    [other, 'other-project-turn', 'unrelated-project-Q8'],
  ]) {
    const saved = run(['remember', '--name', name, '--type', 'conversation', '--tags', 'role:assistant', '--obs',
      'Jasper orange routing prefix: ' + marker], '', cwd);
    expect(saved.status, saved.stderr).toBe(0);
  }
  const remote = spawnSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://example.com/qa/hermes-routing.git'], {
    env, encoding: 'utf8', timeout: 15_000,
  });
  expect(remote.status, remote.stderr).toBe(0);

  expect(context()).toEqual({ text: '', ids: [] });
  env.MEMESH_PROJECT_ROOT = project;
  const result = context();
  expect(result.ids).toHaveLength(1);
  expect(result.text).toContain('local-path-memory-Q7');
  expect(result.text).not.toContain('unrelated-project-Q8');
});

it('refuses an invalid declared workspace before prompt-context can register a conversation', () => {
  env.MEMESH_PROJECT_ROOT = path.join(home, 'missing-project');
  const before = fs.readdirSync(home);
  const result = run(['hermes', 'prompt-context', '--session', 'reader'], '{"prompt":"Jasper orange routing prefix","messages":true}');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('workspace_unavailable');
  expect(fs.readdirSync(home)).toEqual(before);
});

it('rejects malformed input before accessing the database', () => {
  const result = run(['hermes', 'prompt-context', '--session', 'reader'], '{"prompt":1}');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('stdin must be {"prompt"');
});
