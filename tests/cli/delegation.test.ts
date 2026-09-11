import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TOOL_DEFINITIONS } from '../../src/transports/mcp/handlers.js';

const repoRoot = path.join(__dirname, '..', '..');
const CLI_PATH = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');
const ENVELOPE = path.join(repoRoot, 'tests', 'fixtures', 'deepseek', 'harness-envelope.json');
let home: string;

function run(args: string[]) {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-delegation-cli-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('memesh delegation', () => {
  it('records an envelope, then flips it to verified', () => {
    const prompt = path.join(home, 'prompt.txt');
    fs.writeFileSync(prompt, 'Summarise the auth module');
    const rec = run(['delegation', 'record', '--envelope', ENVELOPE, '--prompt-file', prompt, '--json']);
    expect(rec.code, rec.stderr).toBe(0);
    const recorded = JSON.parse(rec.stdout);
    expect(recorded).toMatchObject({ stored: true, verdict: 'unreviewed', trust: 'untrusted-until-verified' });

    const ver = run(['delegation', 'verify', recorded.name, '--verdict', 'accepted', '--json']);
    expect(ver.code, ver.stderr).toBe(0);
    expect(JSON.parse(ver.stdout)).toMatchObject({ previousVerdict: 'unreviewed', verdict: 'accepted', trust: 'verified' });
  });

  it('refuses missing inputs and bad verdicts with a message, not a stack', () => {
    for (const args of [
      ['delegation', 'record', '--envelope', ENVELOPE],
      ['delegation', 'record', '--envelope', path.join(home, 'nope.json'), '--prompt-file', ENVELOPE],
      ['delegation', 'record', '--envelope', ENVELOPE, '--prompt-file', ENVELOPE, '--verdict', 'maybe'],
      ['delegation', 'verify', 'whatever', '--verdict', 'unreviewed'],
      ['delegation', 'verify', 'no-such-delegation', '--verdict', 'accepted'],
    ]) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/Error/);
      expect(r.stderr).not.toMatch(/\n\s+at\s/);
    }
  });
});

describe('the worker sandbox has no write path', () => {
  // The worker can reach nothing on the orchestrator's machine, and memesh
  // must not grow a door it could: delegation records are written only by
  // the local CLI. If an HTTP route or an MCP tool for them appears, this
  // fails and the change has to argue its case.
  it('no HTTP route and no MCP tool mentions delegation', () => {
    const server = fs.readFileSync(path.join(repoRoot, 'src', 'transports', 'http', 'server.ts'), 'utf8');
    const routes = [...server.matchAll(/^app\.(?:get|post|put|delete|patch)\((['"`])([^'"`]+)\1/gm)].map((m) => m[2]);
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.filter((r) => /delegat/i.test(r))).toEqual([]);

    const toolNames = TOOL_DEFINITIONS.map((t) => t.name);
    expect(toolNames.length).toBeGreaterThan(5);
    expect(toolNames.filter((n) => /delegat/i.test(n))).toEqual([]);
  });
});
