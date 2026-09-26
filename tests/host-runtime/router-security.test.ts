import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function privateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-security-'));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function runRouter(directory: string, tokenFile: string, envOverride: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.resolve('dist/host-runtime/router.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMESH_DB_PATH: path.join(directory, 'knowledge-graph.db'),
      MEMESH_ROUTER_SOCKET: path.join(directory, 'router.sock'),
      MEMESH_ROUTER_TOKEN_FILE: tokenFile,
      ...envOverride,
    },
    encoding: 'utf8',
    timeout: 3_000,
  });
}

describe.skipIf(process.platform === 'win32')('router token boundary', () => {
  it('rejects a symlink token instead of following its private target', () => {
    const directory = privateDirectory();
    const target = path.join(directory, 'target.token');
    const link = path.join(directory, 'router.token');
    fs.writeFileSync(target, 'a'.repeat(64), { mode: 0o600 });
    fs.symlinkSync(target, link);

    const result = runRouter(directory, link);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ELOOP|symlink|symbolic/i);
  });

  it('rejects an oversized owner-private token before starting the router', () => {
    const directory = privateDirectory();
    const token = path.join(directory, 'router.token');
    fs.writeFileSync(token, 'a'.repeat(8 * 1024 + 1), { mode: 0o600 });

    const result = runRouter(directory, token);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('8192-byte limit');
  });
});

describe.skipIf(process.platform === 'win32')('router socket path validation', () => {
  it('reports a clear error and no raw stack trace when the socket path exceeds the 103-byte limit', () => {
    const directory = privateDirectory();
    const longSocket = path.join(directory, `${'x'.repeat(200)}.sock`);

    const result = runRouter(directory, path.join(directory, 'router.token'), { MEMESH_ROUTER_SOCKET: longSocket });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MeMesh router failed');
    expect(result.stderr).toContain('103 bytes');
    expect(result.stderr).not.toMatch(/\n\s+at /);
    // The error code, and — since the path came from MEMESH_ROUTER_SOCKET
    // here — that env var, are both named so the owner knows exactly what to
    // change.
    expect(result.stderr).toContain('code=invalid_socket_path');
    expect(result.stderr).toContain('MEMESH_ROUTER_SOCKET');
    expect(result.stderr).toContain(String(Buffer.byteLength(longSocket)));
  });
});

// The mkdir/chmod/token-file setup that runs BEFORE the constructor also
// throws synchronously. A failure there is a raw, unhandled stack trace
// unless the whole startup shares one reported path.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('router pre-constructor failures', () => {
  it('reports a clear error, not a raw stack trace, when the data directory cannot be created', () => {
    const directory = privateDirectory();
    fs.chmodSync(directory, 0o500); // no write bit: mkdirSync for a nested dir below fails with EACCES
    const nestedDbPath = path.join(directory, 'nested', 'knowledge-graph.db');

    const result = spawnSync(process.execPath, [path.resolve('dist/host-runtime/router.js')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMESH_DB_PATH: nestedDbPath,
        MEMESH_ROUTER_SOCKET: path.join(directory, 'router.sock'),
        MEMESH_ROUTER_TOKEN_FILE: path.join(directory, 'router.token'),
      },
      encoding: 'utf8',
      timeout: 3_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MeMesh router failed');
    expect(result.stderr).toContain('EACCES');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});

it.runIf(process.platform === 'win32')('rejects router startup before creating runtime files', () => {
  const directory = privateDirectory();
  const token = path.join(directory, 'router.token');
  const result = runRouter(directory, token);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/secure local host runtime is not supported on Windows/i);
  expect(fs.existsSync(path.join(directory, 'knowledge-graph.db'))).toBe(false);
  expect(fs.existsSync(path.join(directory, 'router.sock'))).toBe(false);
  expect(fs.existsSync(token)).toBe(false);
});
