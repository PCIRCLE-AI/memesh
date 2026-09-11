/**
 * #323 — `memesh briefing --index`: the durable-memory index on its own, the
 * same section the full briefing and SessionStart block close with.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  return spawnSync(process.execPath, ['--input-type=module', '--eval', cliLoader, ...args], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
  });
}

const PROJECT = 'briefing-index-cli';

describe('memesh briefing --index', () => {
  it('prints only the index: durable memories with handles, the footer, no ranked sections', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-index-'));
    try {
      for (const [name, type, title] of [
        ['idx-d', 'decision', 'Cap the index at forty lines'],
        ['idx-c', 'commit', 'chore: bump deps'],
      ]) {
        const r = runCli(home, 'remember', '--name', name, '--type', type, '--title', title,
          '--obs', `${title} observation`, '--tags', `project:${PROJECT}`);
        expect(r.status, r.stderr).toBe(0);
      }

      const text = runCli(home, 'briefing', '--project', PROJECT, '--index');
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain(`Index of durable memories for "${PROJECT}" (newest first):`);
      expect(text.stdout).toMatch(/- \[decision\] Cap the index at forty lines.*\[mem:\d+\]/);
      expect(text.stdout).not.toContain('bump deps');
      expect(text.stdout).not.toContain('Decisions and direction');
      expect(text.stdout).toMatch(/\(index cost: 1 line, \d+ bytes ≈ \d+ tokens; cap 40 lines \/ 3072 bytes\)/);

      const json = runCli(home, 'briefing', '--project', PROJECT, '--index', '--json');
      expect(json.status, json.stderr).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed).toMatchObject({ project: PROJECT, shown: 1, more: 0, older: 0 });
      expect(parsed.tokens).toBe(Math.ceil(parsed.bytes / 4));

      const full = runCli(home, 'briefing', '--project', PROJECT, '--json');
      expect(JSON.parse(full.stdout).index.shown).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('an empty project prints the empty-state line', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-index-'));
    try {
      const r = runCli(home, 'briefing', '--project', 'nothing-here', '--index');
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('- No durable memories (decisions, lessons, patterns, references) for "nothing-here" yet.');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
