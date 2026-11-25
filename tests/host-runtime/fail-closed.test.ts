import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runHostEntry } from '../../src/host-runtime/entry.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';

// Exercise the compiled Channel entry and its shared startup error wrapper.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOSTS = [
  { bin: 'memesh-host-claude', dist: 'dist/host-runtime/claude.js' },
] as const;

describe.skipIf(process.platform === 'win32')('host runtimes fail closed with a reason', () => {
  for (const host of HOSTS) {
    it(`${host.bin} names the missing host session and does not print a stack trace`, () => {
      const entry = path.join(repoRoot, host.dist);
      expect(fs.existsSync(entry), `${host.dist} is not built — run npm run build`).toBe(true);

      const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-failclosed-'));
      try {
        const result = spawnSync(process.execPath, [entry], {
          input: '',
          encoding: 'utf8',
          timeout: 30_000,
          // No actual native session identity is supplied.
          env: buildIsolatedRuntimeEnv({
            PATH: path.dirname(process.execPath), MEMESH_AUTO_UPDATE: 'off', MEMESH_AUTO_CAPTURE: 'false',
          }, { runtimeHome: memeshDir, memeshDir, dbPath: path.join(memeshDir, 'knowledge-graph.db') }),
        });

        expect(result.status, `${host.bin} must exit non-zero`).not.toBe(0);
        const stderr = result.stderr ?? '';

        // The reason, not a generic apology.
        expect(stderr).toContain(host.bin);
        expect(stderr).toMatch(/Claude Channel requires the actual host session/);
        expect(stderr).not.toMatch(/config file|router/i);
        expect(fs.existsSync(path.join(memeshDir, 'knowledge-graph.db'))).toBe(false);
        expect(fs.existsSync(path.join(memeshDir, 'messages.db'))).toBe(false);

        // Not a stack trace: no frame lines, no source-location banner.
        expect(stderr).not.toMatch(/^\s+at /m);
        expect(stderr).not.toMatch(/file:\/\/\/.*\.js:\d+/);

        // One line, so it fits wherever a host client shows it.
        expect(stderr.trim().split('\n')).toHaveLength(1);
      } finally {
        fs.rmSync(memeshDir, { recursive: true, force: true });
      }
    });
  }
});

/**
 * The same contract at source level. The spawn tests above prove the wiring —
 * that each shipped binary really routes through this — but they run `dist/`,
 * so a mutation to `src/` cannot make them fail until a rebuild happens. These
 * pin the behaviour where the code lives, with no build in between.
 */
describe('runHostEntry', () => {
  const capture = () => {
    const written: string[] = [];
    return { written, stream: { write: (chunk: string) => { written.push(chunk); return true; } } };
  };

  it('returns 0 and writes nothing when the host starts', async () => {
    const { written, stream } = capture();
    await expect(runHostEntry('memesh-host-test', async () => {}, stream)).resolves.toBe(0);
    expect(written).toEqual([]);
  });

  it('names the binary and the real reason, on one line, and returns 1', async () => {
    const { written, stream } = capture();
    const code = await runHostEntry('memesh-host-test', async () => {
      throw new Error('A host config file is required via --config or MEMESH_HOST_CONFIG.');
    }, stream);
    expect(code).toBe(1);
    expect(written).toEqual([
      'memesh-host-test: A host config file is required via --config or MEMESH_HOST_CONFIG.\n',
    ]);
  });

  it('does not swallow the reason behind a generic message', async () => {
    // The `claude` host used to print "session startup failed." and discard
    // the error — fail-closed, but it threw away the sentence that says what
    // to do. This is the assertion that would have caught that.
    const { written, stream } = capture();
    await runHostEntry('memesh-host-test', async () => { throw new Error('the actual reason'); }, stream);
    expect(written.join('')).toContain('the actual reason');
    expect(written.join('')).not.toMatch(/failed\.?$/);
  });

  it('reports a non-Error throw rather than printing [object Object]', async () => {
    const { written, stream } = capture();
    await runHostEntry('memesh-host-test', async () => { throw 'plain string failure'; }, stream);
    expect(written.join('')).toBe('memesh-host-test: plain string failure\n');
  });
});
