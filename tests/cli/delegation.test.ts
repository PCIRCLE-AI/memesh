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
    const rec = run(['delegation', 'record', '--envelope', ENVELOPE, '--prompt-file', prompt,
      '--allow-tool', 'read_file', '--allow-tool', 'write_file', '--json']);
    expect(rec.code, rec.stderr).toBe(0);
    const recorded = JSON.parse(rec.stdout);
    expect(recorded).toMatchObject({ stored: true, verdict: 'unreviewed', trust: 'untrusted-until-verified' });
    const shown = run(['recall', recorded.name, '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('read_file, write_file (granted by the orchestrator)');

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
    // Every file in the HTTP transport, not only server.ts: a route could be
    // registered from a router module (review F7).
    const httpDir = path.join(repoRoot, 'src', 'transports', 'http');
    const files = fs.readdirSync(httpDir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(?:ts|js|mjs)$/.test(f));
    expect(files).toContain('server.ts');
    const routes = files.flatMap((f) => {
      const src = fs.readFileSync(path.join(httpDir, f), 'utf8');
      return [...src.matchAll(/['"`](\/v1\/[^'"`\s]*)['"`]/g)].map((m) => m[1]);
    });
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.filter((r) => /delegat/i.test(r))).toEqual([]);

    const toolNames = TOOL_DEFINITIONS.map((t) => t.name);
    expect(toolNames.length).toBeGreaterThan(5);
    expect(toolNames.filter((n) => /delegat/i.test(n))).toEqual([]);
  });
});
