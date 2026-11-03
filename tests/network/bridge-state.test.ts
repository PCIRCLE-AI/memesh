// Process identity, the lock and start/stop, with stand-in bridges: no native file.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import {
  acquireLock, identifyProcess, lockPath, readStatus, removeStaleLock, statusPath, writeStatus,
} from '../../src/network/bridge-state.js';
import { createLink, getNetworkStatus } from '../../src/network/operations.js';
import { openNetworkStore, insertConfig } from '../../src/network/store.js';
import { NetworkError, type NetworkContext } from '../../src/network/types.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { createRoster, signRoster } from '../../src/network/roster.js';
import { buildTree, contextFor, makeHome, removeTree, type Tree } from './helpers.js';

const POSIX = process.platform !== 'win32';
const FAKE_SOURCE = path.resolve(import.meta.dirname, 'fixtures/fake-bridge.mjs');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!POSIX)('the bridge lock and process identity', () => {
  let tree: Tree;
  let scratch: string;
  let fakeBridge: string;
  let home: string;
  let ctx: NetworkContext;
  const children: ChildProcess[] = [];
  const originalPath = process.env.PATH;
  const originalPlatform = process.platform;

  const setPlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value }); };
  /** A directory holding a fake `ps` (or `powershell`), used as the whole PATH. */
  const fakeTool = (name: string, body: string): string => {
    const dir = fs.mkdtempSync(path.join(scratch, 'tool-'));
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return dir;
  };

  /** A live process with a bridge's command line, holding this data dir's lock. */
  const startFake = async (mode: string, dataDir = ctx.dataDir): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [fakeBridge, 'serve', dataDir], {
      stdio: 'ignore', env: { ...process.env, PATH: originalPath, FAKE_MODE: mode },
    });
    children.push(child);
    await expect.poll(() => fs.existsSync(lockPath(dataDir)) && fs.existsSync(statusPath(dataDir)), { timeout: 10_000 }).toBe(true);
    return child;
  };

  const seedJoined = (target: NetworkContext, relay = 'off'): void => {
    const identity = ensureIdentity(target.dataDir);
    const signed = signRoster(identity, createRoster('0123456789abcdef0123456789abcdef', {
      machine_id: identity.machineId, name: 'mac', person: 'kt', joined_at: new Date().toISOString(),
    }));
    const db = openNetworkStore(target.dbPath);
    insertConfig(db, {
      network_id: '0123456789abcdef0123456789abcdef', owner_id: identity.machineId, machine_id: identity.machineId,
      machine_name: 'mac', person: 'kt', relay_url: relay, roster_json: signed.roster_json, roster_signature: signed.signature,
    }, Date.now());
    db.close();
  };

  beforeAll(async () => {
    tree = await buildTree({ cli: true });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-network-state-'));
    fs.mkdirSync(path.join(scratch, 'fake'));
    fakeBridge = path.join(scratch, 'fake', 'bridge.js');
    fs.copyFileSync(FAKE_SOURCE, fakeBridge);
    fs.writeFileSync(path.join(scratch, 'fake', 'package.json'), '{"type":"module"}\n');
  });
  beforeEach(() => {
    home = makeHome();
    ctx = { ...contextFor(tree, home), bridgeEntry: fakeBridge };
    fs.mkdirSync(path.join(ctx.dataDir, 'network'), { recursive: true });
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    setPlatform(originalPlatform);
    for (const child of children.splice(0)) child.kill('SIGKILL');
    removeTree(home);
  });
  afterAll(() => {
    removeTree(tree.root);
    removeTree(scratch);
  });

  describe('three states', () => {
    it('recognises this data dir\'s bridge, and refuses another data dir\'s', async () => {
      const child = await startFake('running');
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('bridge');
      expect(identifyProcess(child.pid as number, `${ctx.dataDir}-other`)).toBe('not-bridge');
      expect(identifyProcess(child.pid as number, `/x${ctx.dataDir}`)).toBe('not-bridge');
    });

    it('an unrelated live process, a dead pid and another user\'s pid are not bridges', () => {
      expect(identifyProcess(process.pid, ctx.dataDir)).toBe('not-bridge');
      expect(identifyProcess(2 ** 30, ctx.dataDir)).toBe('not-bridge');
      expect(identifyProcess(1, ctx.dataDir)).toBe('not-bridge');
    });

    it.runIf(originalPlatform === 'linux')('on Linux it reads /proc and needs no ps', async () => {
      const child = await startFake('running');
      process.env.PATH = fakeTool('unused', 'exit 0');
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('bridge');
    });

    it('no ps on PATH: unknown', async () => {
      const child = await startFake('running');
      setPlatform('darwin');
      process.env.PATH = fakeTool('unused', 'exit 0');
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('unknown');
    });

    it('ps exiting 1 while the process is alive: unknown', async () => {
      const child = await startFake('running');
      setPlatform('darwin');
      process.env.PATH = fakeTool('ps', 'exit 1');
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('unknown');
    });

    it('ps hanging: unknown, in bounded time', async () => {
      const child = await startFake('running');
      setPlatform('darwin');
      const sleepBin = spawnSync('which', ['sleep'], { encoding: 'utf8' }).stdout.trim();
      process.env.PATH = fakeTool('ps', `exec ${sleepBin} 30`);
      const started = Date.now();
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('unknown');
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 30_000);

    it('Windows with no way to ask: unknown', async () => {
      const child = await startFake('running');
      setPlatform('win32');
      process.env.PATH = fakeTool('unused', 'exit 0');
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('unknown');
    });

    it('Windows asks for the command line: a reused pid is told apart from the bridge', async () => {
      const child = await startFake('running');
      setPlatform('win32');
      process.env.PATH = fakeTool('powershell', 'echo "C:\\Windows\\notepad.exe"');
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('not-bridge');
      process.env.PATH = fakeTool('powershell', `printf '%s\\n' '"C:\\node.exe" "C:\\m\\bridge.js" serve "${ctx.dataDir}"'`);
      expect(identifyProcess(child.pid as number, ctx.dataDir)).toBe('bridge');
    });
  });

  describe('unknown means hands off', () => {
    const withUnknown = async (): Promise<ChildProcess> => {
      const child = await startFake('running');
      setPlatform('darwin');
      process.env.PATH = fakeTool('unused', 'exit 0');
      return child;
    };

    it('down does not signal it and says it could not confirm', async () => {
      const child = await withUnknown();
      const kills = vi.spyOn(process, 'kill');
      await expect(stopBridge(ctx)).rejects.toMatchObject({ code: 'bridge_unconfirmed', message: expect.stringMatching(/could not confirm/) });
      // It did look at the process (signal 0), and sent nothing else.
      expect(kills.mock.calls.length).toBeGreaterThan(0);
      expect(kills.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      kills.mockRestore();
      expect(alive(child.pid as number)).toBe(true);
      expect(fs.readFileSync(lockPath(ctx.dataDir), 'utf8').trim()).toBe(String(child.pid));
    });

    it('up refuses with a sentence and starts nothing', async () => {
      const child = await withUnknown();
      const spawned = { ...ctx, bridgeEntry: path.join(scratch, 'must-not-run.js') };
      await expect(startBridge(spawned)).rejects.toMatchObject({ code: 'bridge_unconfirmed' });
      expect(fs.readFileSync(lockPath(ctx.dataDir), 'utf8').trim()).toBe(String(child.pid));
    });

    it('a starting bridge does not take the lock', async () => {
      const child = await withUnknown();
      expect(await acquireLock(ctx.dataDir)).toBe('unconfirmed');
      expect(fs.readFileSync(lockPath(ctx.dataDir), 'utf8').trim()).toBe(String(child.pid));
    });

    it('status says it cannot tell', async () => {
      seedJoined(ctx);
      const child = await withUnknown();
      const status = getNetworkStatus(ctx);
      expect(status.joined && status.bridge).toMatchObject({ running: false, cannot_tell: true, pid: child.pid });
      setPlatform(originalPlatform);
      const result = spawnSync(process.execPath, [tree.cli, 'network', 'status'], {
        encoding: 'utf8',
        // A PATH with no ps. On Linux /proc still answers, so the words are only checked elsewhere.
        env: { ...process.env, HOME: home, PATH: fakeTool('unused', 'exit 0') },
      });
      expect(result.status).toBe(0);
      if (originalPlatform !== 'linux') expect(result.stdout).toMatch(/cannot tell/);
    });
  });

  describe('taking the lock', () => {
    it('a lock naming a dead pid or an unrelated live process is stale', async () => {
      fs.writeFileSync(lockPath(ctx.dataDir), `${2 ** 30}\n`);
      expect(await acquireLock(ctx.dataDir)).toBe('acquired');
      fs.writeFileSync(lockPath(ctx.dataDir), '1\n');
      expect(await acquireLock(ctx.dataDir)).toBe('acquired');
    });

    it('refuses while this data dir\'s bridge holds it', async () => {
      const child = await startFake('running');
      expect(await acquireLock(ctx.dataDir)).toBe('held');
      expect(fs.readFileSync(lockPath(ctx.dataDir), 'utf8').trim()).toBe(String(child.pid));
    });

    it('a lock naming the bridge\'s own pid is from an earlier life, not another bridge', async () => {
      const dir = fs.mkdtempSync(path.join(scratch, 'self-'));
      const entry = path.join(dir, 'bridge.mjs');
      await build({
        entryPoints: [path.resolve(import.meta.dirname, 'fixtures/lock-self.ts')],
        outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      });
      // Named so its command line is what a bridge's is.
      const named = path.join(dir, 'bridge.js');
      fs.renameSync(entry, named);
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
      const result = spawnSync(process.execPath, [named, 'serve', ctx.dataDir], { encoding: 'utf8' });
      expect(result.stdout.trim()).toBe('acquired');
    });

    it('clearing a stale lock leaves a lock another starter just took', () => {
      fs.writeFileSync(lockPath(ctx.dataDir), '4242\n');
      expect(removeStaleLock(ctx.dataDir, 999)).toBe(false);
      expect(fs.readFileSync(lockPath(ctx.dataDir), 'utf8').trim()).toBe('4242');
      expect(removeStaleLock(ctx.dataDir, 4242)).toBe(true);
      expect(fs.existsSync(lockPath(ctx.dataDir))).toBe(false);
      expect(removeStaleLock(ctx.dataDir, 4242)).toBe(false);
    });
  });

  describe('starting', () => {
    it('waits for another starter\'s bridge to be running', async () => {
      const child = await startFake('starting-then-running');
      expect(readStatus(ctx.dataDir)?.state).toBe('starting');
      const result = await startBridge(ctx);
      expect(result).toEqual({ pid: child.pid, started: false });
      expect(readStatus(ctx.dataDir)?.state).toBe('running');
    });

    it('if that bridge dies instead, it starts one of its own', async () => {
      const first = await startFake('starting-then-die');
      const result = await startBridge({ ...ctx, env: { ...ctx.env, FAKE_MODE: 'running' } });
      expect(result.started).toBe(true);
      expect(result.pid).not.toBe(first.pid);
      process.kill(result.pid, 'SIGKILL');
    });
  });

  describe('stopping', () => {
    it('removes the lock itself when the bridge exits without cleaning up, and records it', async () => {
      const child = await startFake('term-no-cleanup');
      const result = await stopBridge(ctx);
      expect(result).toEqual({ stopped: true, pid: child.pid, forced: false });
      expect(fs.existsSync(lockPath(ctx.dataDir))).toBe(false);
      expect(readStatus(ctx.dataDir)?.state).toBe('stopped');
    });

    it('kills a bridge that ignores the request, confirms it, and says so', async () => {
      const child = await startFake('ignore-term');
      await sleep(200);
      const result = await stopBridge(ctx);
      expect(result).toEqual({ stopped: true, pid: child.pid, forced: true });
      await expect.poll(() => alive(child.pid as number)).toBe(false);
      expect(readStatus(ctx.dataDir)?.last_error).toMatch(/was killed/);
    }, 30_000);

    it('says so when a killed bridge does not die, and does not claim it stopped', async () => {
      const child = await startFake('ignore-term');
      await sleep(200);
      const realKill = process.kill.bind(process);
      const kills = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 'SIGKILL') return true;
        return realKill(pid, signal);
      }) as typeof process.kill);
      try {
        await expect(stopBridge(ctx)).rejects.toThrowError(/did not exit after being killed/);
      } finally {
        kills.mockRestore();
      }
      expect(alive(child.pid as number)).toBe(true);
      expect(fs.existsSync(lockPath(ctx.dataDir))).toBe(true);
    }, 30_000);
  });

  it('status ignores live fields from an earlier bridge\'s file', async () => {
    seedJoined(ctx);
    const child = await startFake('running');
    const written = readStatus(ctx.dataDir);
    if (!written) throw new Error('no status');
    writeStatus(ctx.dataDir, { ...written, pid: 1, relay_state: 'online', started_at: 'stale', joins_accepted: 9 });
    const status = getNetworkStatus(ctx);
    expect(status.joined && status.bridge).toMatchObject({ running: true, pid: child.pid, started_at: null, relay_state: null, joins_accepted: 0 });
  });

  it('--include-addresses with none found says so, and the link has none', async () => {
    seedJoined(ctx, 'https://relay.example/');
    await startFake('running');
    const result = await createLink(ctx, { includeAddresses: true });
    expect(result.addressesMissing).toBe(true);
    const fields = JSON.parse(Buffer.from(result.link.slice('memesh://join/'.length), 'base64url').toString()) as Record<string, unknown>;
    expect(fields).not.toHaveProperty('addrs');
    const plain = await createLink(ctx);
    expect(plain.addressesMissing).toBe(false);
  }, 30_000);

  it('a fractional --ttl-hours still makes a link join can read', async () => {
    seedJoined(ctx, 'https://relay.example/');
    await startFake('running');
    const { link, expiresAtMs } = await createLink(ctx, { ttlHours: 0.123456 });
    expect(Number.isSafeInteger(expiresAtMs)).toBe(true);
    const { parseLink } = await import('../../src/network/invites.js');
    expect(parseLink(link).expires_at_ms).toBe(expiresAtMs);
  });

  it('every NetworkError here is the expected class', () => {
    expect(new NetworkError('bridge_unconfirmed', 'x')).toBeInstanceOf(Error);
  });
});
