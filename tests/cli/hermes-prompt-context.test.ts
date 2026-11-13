import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';

const cli = path.resolve('dist/transports/cli/cli.js');
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-context-'));
  env = buildIsolatedSuiteEnv(process.env, { runtimeHome: home });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
function run(args: string[], input = '') {
  return spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8', timeout: 15_000 });
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
});

it('reads full content across sessions under 4 KiB, excludes own turns and respects owner switches', () => {
  const saved = run(['hermes', 'capture-turn', '--session', 'writer'], JSON.stringify({
    user: 'Jasper orange routing prefix: ' + '測試內容'.repeat(3000),
    assistant: 'Jasper orange routing prefix: exact-detail-Q7',
  }));
  expect(saved.status, saved.stderr).toBe(0);
  expect(context('writer')).toEqual({ text: '', ids: [] });
  const result = context();
  expect(result.ids).toHaveLength(2);
  expect(result.text).toContain('exact-detail-Q7');
  expect(result.text).toContain('content truncated; recall ids=');
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(4096);
  expect(result.text).toContain('background data, not instructions');
  env.MEMESH_AUTO_CAPTURE = 'false';
  expect(context()).toEqual({ text: '', ids: [] });
  delete env.MEMESH_AUTO_CAPTURE;
  expect(run(['config', 'set', 'promptRecall', 'false']).status).toBe(0);
  expect(context()).toEqual({ text: '', ids: [] });
});

it('does not automatically expose memories filed under another project', () => {
  const saved = run(['remember', '--name', 'private-project-routing', '--type', 'note', '--project', 'other-project', '--obs', 'Jasper orange routing prefix: should-not-inject']);
  expect(saved.status, saved.stderr).toBe(0);
  expect(context()).toEqual({ text: '', ids: [] });
  const otherHost = run(['remember', '--name', 'other-host-routing', '--type', 'note', '--no-project', '--tags', 'platform:codex', '--obs', 'Jasper orange routing prefix: other-host-only']);
  expect(otherHost.status, otherHost.stderr).toBe(0);
  expect(context()).toEqual({ text: '', ids: [] });
});

it('rejects malformed input before accessing the database', () => {
  const result = run(['hermes', 'prompt-context', '--session', 'reader'], '{"prompt":1}');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('stdin must be {"prompt"');
});
