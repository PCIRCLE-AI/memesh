// The control socket, starting and stopping, with stand-in bridges: no native file.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { readStatus, statusPath, writeStatus } from '../../src/network/bridge-state.js';
import { controlPath, holdControlSocket, identityOf, probeBridge, removeStaleSocket, takeOverStaleLock } from '../../src/network/control-socket.js';
import { ensureIdentity, ensureNetworkDir } from '../../src/network/identity.js';
import { parseLink } from '../../src/network/invites.js';
import { bridgeUp, createLink, createNetwork, getNetworkStatus } from '../../src/network/operations.js';
import { createRoster, signRoster } from '../../src/network/roster.js';
import { insertConfig, openNetworkStore } from '../../src/network/store.js';
import { childEnv, type NetworkContext } from '../../src/network/types.js';
import { buildTree, contextFor, makeHome, removeTree, type Tree } from './helpers.js';

const NETWORK_ID = '0123456789abcdef0123456789abcdef';
const FAKE_SOURCE = path.resolve(import.meta.dirname, 'fixtures/fake-bridge.mjs');
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Windows named pipes are unverified: nobody has run this path there.
describe.skipIf(process.platform === 'win32')('the bridge control socket', () => {
  let tree: Tree;
  let scratch: string;
  let fakeBridge: string;
  let home: string;
  let ctx: NetworkContext;
  const children: ChildProcess[] = [];

  /** A process holding this data dir's socket, behaving as `mode` says. */
  const startFake = async (mode: string, target: NetworkContext = ctx): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [fakeBridge, 'serve'], { stdio: 'ignore', env: { ...childEnv(target), FAKE_MODE: mode } });
    children.push(child);
    await expect.poll(() => fs.existsSync(controlPath(target.dataDir)), { timeout: 10_000 }).toBe(true);
    return child;
  };

  const seedJoined = (target: NetworkContext, relay = 'off'): void => {
    const identity = ensureIdentity(target.dataDir);
    const signed = signRoster(identity, createRoster(NETWORK_ID, {
      machine_id: identity.machineId, name: 'mac', person: 'kt', joined_at: new Date().toISOString(),
    }));
    const db = openNetworkStore(target.dbPath);
    insertConfig(db, {
      network_id: NETWORK_ID, owner_id: identity.machineId, machine_id: identity.machineId,
      machine_name: 'mac', person: 'kt', relay_url: relay, roster_json: signed.roster_json, roster_signature: signed.signature,
    }, Date.now());
    db.close();
  };

  /** A socket file nobody holds: what a killed process leaves behind. */
  const leaveStaleSocket = async (target: NetworkContext): Promise<void> => {
    const child = await startFake('running', target);
    child.kill('SIGKILL');
    await expect.poll(() => alive(child.pid as number)).toBe(false);
    expect(fs.lstatSync(controlPath(target.dataDir)).isSocket()).toBe(true);
  };

  beforeAll(async () => {
    tree = await buildTree({ cli: true });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-sock-'));
    fakeBridge = path.join(scratch, 'fake-bridge.mjs');
    fs.copyFileSync(FAKE_SOURCE, fakeBridge);
  });
  beforeEach(() => {
    home = makeHome('sk-');
    ctx = { ...contextFor(tree, home), bridgeEntry: fakeBridge };
    fs.mkdirSync(path.join(ctx.dataDir, 'network'), { recursive: true });
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    removeTree(home);
  });
  afterAll(() => {
    removeTree(tree.root);
    removeTree(scratch);
  });

  describe('what a probe says', () => {
    it('no socket: not running', async () => {
      expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'not-running' });
    });

    it('a socket file nobody holds: not running', async () => {
      await leaveStaleSocket(ctx);
      expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'not-running' });
    });

    it('a valid reply naming this data dir: running, with the pid it gave', async () => {
      const child = await startFake('running');
      expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'running', pid: child.pid, ready: true });
    });

    it('connected and silent: unresponsive, within the deadline', async () => {
      await startFake('silent');
      const started = Date.now();
      expect(await probeBridge(ctx.dataDir, 300)).toEqual({ kind: 'unresponsive' });
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it('a reply naming another data dir, or nonsense, is not this bridge', async () => {
      const reply = { current: '' };
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.on('data', () => socket.end(reply.current));
      });
      await new Promise<void>((resolve) => { server.listen(controlPath(ctx.dataDir), resolve); });
      try {
        reply.current = `${JSON.stringify({ data_dir: '/some/other/dir', pid: 1, ready: true })}\n`;
        expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'unresponsive' });
        reply.current = 'not json\n';
        expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'unresponsive' });
        reply.current = `${JSON.stringify({ data_dir: fs.realpathSync(ctx.dataDir) })}\n`;
        expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'unresponsive' });
        for (const pid of [-5, 0, 1.5]) {
          reply.current = `${JSON.stringify({ data_dir: fs.realpathSync(ctx.dataDir), pid, ready: true })}\n`;
          expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'unresponsive' });
        }
      } finally {
        server.close();
      }
    });

    it.each(['with space', 'q"uo\'te', '測試 café', 'trail '])('a data dir called %j works, whatever the locale', async (name) => {
      const dataDir = path.join(home, name);
      const weird: NetworkContext = { ...ctx, dataDir, dbPath: path.join(dataDir, 'k.db'), env: { ...ctx.env, LC_ALL: 'C', LANG: 'C' } };
      fs.mkdirSync(path.join(dataDir, 'network'), { recursive: true });
      const child = await startFake('running', weird);
      expect(await probeBridge(dataDir)).toEqual({ kind: 'running', pid: child.pid, ready: true });
      expect(await stopBridge(weird)).toEqual({ stopped: true, pid: child.pid });
    });

    it('a real symlink to the folder is the same bridge', async () => {
      const child = await startFake('running');
      const linked = path.join(home, 'via-link');
      fs.symlinkSync(ctx.dataDir, linked);
      expect(linked).not.toBe(ctx.dataDir);
      expect(await probeBridge(linked)).toEqual({ kind: 'running', pid: child.pid, ready: true });
    });
  });

  describe('holding the socket', () => {
    const handlers = { isReady: () => true, stop: () => {}, onProblem: () => {} };
    /** Send raw bytes to the socket and return everything that came back. */
    const raw = (text: string): Promise<string> => new Promise((resolve) => {
      let received = '';
      const socket = net.createConnection(controlPath(ctx.dataDir), () => socket.write(text));
      socket.on('data', (chunk) => { received += chunk.toString(); });
      socket.on('error', () => resolve(received));
      socket.on('close', () => resolve(received));
    });

    it('takes a free socket in a private folder, and removes it on close', async () => {
      ensureNetworkDir(ctx.dataDir);
      const held = await holdControlSocket(ctx.dataDir, handlers);
      if (held.kind !== 'held') throw new Error(held.kind);
      expect(fs.statSync(path.dirname(controlPath(ctx.dataDir))).mode & 0o777).toBe(0o700);
      expect(await probeBridge(ctx.dataDir)).toEqual({ kind: 'running', pid: process.pid, ready: true });
      held.close();
      await expect.poll(() => fs.existsSync(controlPath(ctx.dataDir))).toBe(false);
    });

    it('replaces a stale socket file', async () => {
      await leaveStaleSocket(ctx);
      const held = await holdControlSocket(ctx.dataDir, handlers);
      expect(held.kind).toBe('held');
      if (held.kind === 'held') held.close();
    });

    it('leaves a live holder alone: answered or silent', async () => {
      const answering = await startFake('running');
      expect((await holdControlSocket(ctx.dataDir, handlers)).kind).toBe('already-running');
      expect(alive(answering.pid as number)).toBe(true);
      expect(await probeBridge(ctx.dataDir)).toMatchObject({ kind: 'running', pid: answering.pid });
      answering.kill('SIGKILL');
      await expect.poll(() => alive(answering.pid as number)).toBe(false);
      fs.rmSync(controlPath(ctx.dataDir), { force: true });

      const silent = await startFake('silent');
      expect((await holdControlSocket(ctx.dataDir, handlers)).kind).toBe('holder-unresponsive');
      expect(alive(silent.pid as number)).toBe(true);
      expect(fs.existsSync(controlPath(ctx.dataDir))).toBe(true);
    }, 30_000);

    it('a startup lock left by a dead process does not block; a live one does', async () => {
      const lock = `${controlPath(ctx.dataDir)}.startup.lock`;
      fs.writeFileSync(lock, `${2 ** 30}\n`, { mode: 0o600 });
      const held = await holdControlSocket(ctx.dataDir, handlers);
      expect(held.kind).toBe('held');
      if (held.kind === 'held') held.close();

      fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
      await expect(holdControlSocket(ctx.dataDir, handlers)).rejects.toThrowError(/is starting/);
      fs.rmSync(lock);
    }, 20_000);

    it('a path over the socket limit is refused plainly, before anything is installed', () => {
      const dataDir = path.join(home, 'x'.repeat(120));
      const long: NetworkContext = { ...ctx, dataDir, dbPath: path.join(dataDir, 'k.db') };
      expect(() => createNetwork(long, { name: 'mac', person: 'kt', relay: 'off' })).toThrowError(/too long/);
      expect(fs.existsSync(dataDir)).toBe(false);
      return expect(probeBridge(dataDir)).resolves.toEqual({ kind: 'not-running' });
    });

    it('junk on the socket is dropped: nothing is stopped, and the bridge goes on answering', async () => {
      const stop = vi.fn();
      const held = await holdControlSocket(ctx.dataDir, { ...handlers, stop });
      if (held.kind !== 'held') throw new Error(held.kind);
      const token = fs.readFileSync(path.join(ctx.dataDir, 'network/control.token'), 'utf8');
      for (const junk of ['nonsense\n', `{"op":"format","token":"${token}"}\n`, 'x'.repeat(4096)]) {
        await raw(junk);
      }
      expect(stop).not.toHaveBeenCalled();
      expect(await probeBridge(ctx.dataDir)).toMatchObject({ kind: 'running', pid: process.pid });
      held.close();
    });

    it('without the token a request gets no data dir, no pid and no action', async () => {
      const stop = vi.fn();
      const held = await holdControlSocket(ctx.dataDir, { ...handlers, stop });
      if (held.kind !== 'held') throw new Error(held.kind);
      const token = fs.readFileSync(path.join(ctx.dataDir, 'network/control.token'), 'utf8');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.statSync(path.join(ctx.dataDir, 'network/control.token')).mode & 0o777).toBe(0o600);
      for (const request of [{ op: 'stop' }, { op: 'hello' }, { op: 'stop', token: 'f'.repeat(64) }, { op: 'hello', token: 'f'.repeat(64) }, { op: 'stop', token: 123 }, { op: 'stop', token: token.slice(1) }]) {
        expect(await raw(`${JSON.stringify(request)}\n`)).toBe('');
      }
      expect(stop).not.toHaveBeenCalled();
      // The right one does get an answer, which is what makes the empties above mean something.
      const reply = JSON.parse(await raw(`${JSON.stringify({ op: 'hello', token })}\n`)) as { pid: number };
      expect(reply.pid).toBe(process.pid);
      await raw(`${JSON.stringify({ op: 'stop', token })}\n`);
      await expect.poll(() => stop.mock.calls.length).toBe(1);
      held.close();
    });

    it('a token file left by a crash, or one that is damaged, does not stop a restart', async () => {
      await leaveStaleSocket(ctx);
      const file = path.join(ctx.dataDir, 'network/control.token');
      fs.writeFileSync(file, 'b'.repeat(64), { mode: 0o600 });
      const first = await holdControlSocket(ctx.dataDir, handlers);
      if (first.kind !== 'held') throw new Error(first.kind);
      expect(await probeBridge(ctx.dataDir)).toMatchObject({ kind: 'running', pid: process.pid });
      first.close();
      await expect.poll(() => fs.existsSync(controlPath(ctx.dataDir))).toBe(false);

      fs.writeFileSync(file, 'not a token', { mode: 0o600 });
      const second = await holdControlSocket(ctx.dataDir, handlers);
      if (second.kind !== 'held') throw new Error(second.kind);
      expect(await probeBridge(ctx.dataDir)).toMatchObject({ kind: 'running', pid: process.pid });
      expect(fs.readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
      second.close();
    });

    it('a holder knows when its path is gone or replaced, and its close leaves the newer socket alone', async () => {
      const older = await holdControlSocket(ctx.dataDir, handlers);
      if (older.kind !== 'held') throw new Error(older.kind);
      expect(older.stillOurs()).toBe(true);
      fs.rmSync(controlPath(ctx.dataDir));
      expect(older.stillOurs()).toBe(false);
      const newer = await holdControlSocket(ctx.dataDir, handlers);
      if (newer.kind !== 'held') throw new Error(newer.kind);
      expect(older.stillOurs()).toBe(false);
      expect(newer.stillOurs()).toBe(true);
      older.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(controlPath(ctx.dataDir))).toBe(true);
      expect(await probeBridge(ctx.dataDir)).toMatchObject({ kind: 'running' });
      newer.close();
    });

    it('a stale socket is removed only if it is still the file that was judged', async () => {
      await leaveStaleSocket(ctx);
      const target = controlPath(ctx.dataDir);
      const judged = identityOf(target);
      if (!judged) throw new Error('no socket');
      removeStaleSocket(target, { dev: judged.dev, ino: judged.ino + 1000000 });
      expect(fs.existsSync(target)).toBe(true);
      removeStaleSocket(target, judged);
      expect(fs.existsSync(target)).toBe(false);
      removeStaleSocket(target, judged); // Already gone is fine.
    });

    it('a lock moved aside for an instant by another starter is still recognised and released', async () => {
      const lock = `${controlPath(ctx.dataDir)}.startup.lock`;
      const realOpen = fs.openSync;
      const realClose = fs.closeSync;
      let aside = false;
      // What a starter clearing a stale lock does: this lock is away as its owner looks at it.
      const open = vi.spyOn(fs, 'openSync').mockImplementation(((file: string, flags: string, mode: number) => {
        const fd = realOpen(file, flags, mode);
        if (file === lock) {
          fs.renameSync(lock, `${lock}.aside`);
          aside = true;
        }
        return fd;
      }) as typeof fs.openSync);
      const close = vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
        realClose(fd);
        if (aside) {
          fs.renameSync(`${lock}.aside`, lock);
          aside = false;
        }
      }) as typeof fs.closeSync);
      try {
        const held = await holdControlSocket(ctx.dataDir, handlers);
        expect(held.kind).toBe('held');
        if (held.kind === 'held') held.close();
      } finally {
        open.mockRestore();
        close.mockRestore();
      }
      // Left behind, it would name a live process and block every later start for 5 s.
      expect(fs.existsSync(lock)).toBe(false);
    });

    it('a starter that lost its startup lock does not touch the socket', async () => {
      await leaveStaleSocket(ctx);
      const target = controlPath(ctx.dataDir);
      const lock = `${target}.startup.lock`;
      const realLstat = fs.lstatSync;
      let done = false;
      // Right after it finds the socket in use, another starter takes the lock over.
      const stat = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: string) => {
        if (file === target && !done) {
          done = true;
          fs.writeFileSync(`${lock}.other`, `${process.pid}\n`, { mode: 0o600 });
          fs.renameSync(`${lock}.other`, lock);
        }
        return realLstat(file);
      }) as typeof fs.lstatSync);
      try {
        await expect(holdControlSocket(ctx.dataDir, handlers)).rejects.toThrowError(/is starting/);
      } finally {
        stat.mockRestore();
      }
      expect(done).toBe(true);
      expect(fs.lstatSync(target).isSocket()).toBe(true);
      expect(fs.existsSync(lock)).toBe(true);
      fs.rmSync(lock);
    }, 20_000);

    it('taking over a stale startup lock leaves a lock another starter just took', () => {
      const lock = `${controlPath(ctx.dataDir)}.startup.lock`;
      fs.writeFileSync(lock, '111\n');
      const judged = identityOf(lock);
      if (!judged) throw new Error('no lock');
      takeOverStaleLock(lock, judged);
      expect(fs.existsSync(lock)).toBe(false);

      fs.writeFileSync(lock, '222\n');
      const fresh = identityOf(lock);
      takeOverStaleLock(lock, { dev: judged.dev, ino: judged.ino + 1000000 });
      expect(fs.readFileSync(lock, 'utf8')).toBe('222\n');
      expect(identityOf(lock)).toEqual(fresh);
      expect(fs.readdirSync(path.dirname(lock)).filter((name) => name.includes('.stale-'))).toEqual([]);
      fs.rmSync(lock);
    });
  });

  describe('starting', () => {
    it('waits for another starter\'s bridge to be ready', async () => {
      const child = await startFake('starting-then-running');
      expect(await probeBridge(ctx.dataDir)).toMatchObject({ ready: false });
      expect(await startBridge(ctx)).toEqual({ pid: child.pid, started: false });
      expect(readStatus(ctx.dataDir)?.state).toBe('running');
    });

    it('if that bridge dies instead, it starts one of its own', async () => {
      const first = await startFake('starting-then-die');
      const result = await startBridge({ ...ctx, env: { ...ctx.env, FAKE_MODE: 'running' } });
      expect(result.started).toBe(true);
      expect(result.pid).not.toBe(first.pid);
      process.kill(result.pid, 'SIGKILL');
    });

    it('its own slow child is simply waited for, with no ps on PATH', async () => {
      const result = await startBridge({ ...ctx, env: { ...ctx.env, FAKE_MODE: 'slow-running', PATH: scratch } });
      expect(result.started).toBe(true);
      expect(alive(result.pid)).toBe(true);
      process.kill(result.pid, 'SIGKILL');
    });

    it('a holder that never answers: refused with how to stop it, and left alone', async () => {
      const holder = await startFake('silent');
      await expect(startBridge(ctx)).rejects.toMatchObject({ code: 'bridge_unresponsive', message: expect.stringMatching(/did not answer/) });
      expect(alive(holder.pid as number)).toBe(true);
    }, 40_000);

    it('a failed start names what the log holds when there is no status of its own', async () => {
      const bad = path.join(scratch, 'exits.mjs');
      fs.writeFileSync(bad, 'process.exit(9);');
      await expect(startBridge({ ...ctx, bridgeEntry: bad })).rejects.toMatchObject({ message: expect.stringMatching(/status 9.*bridge\.log/) });
    });
  });

  describe('stopping', () => {
    it('nothing running: says so', async () => {
      expect(await stopBridge(ctx)).toEqual({ stopped: false, pid: null });
    });

    it('asks over the socket and waits until it has gone, signalling nothing', async () => {
      const child = await startFake('running');
      const kills = vi.spyOn(process, 'kill');
      try {
        expect(await stopBridge(ctx)).toEqual({ stopped: true, pid: child.pid });
      } finally {
        expect(kills).not.toHaveBeenCalled();
        kills.mockRestore();
      }
      await expect.poll(() => alive(child.pid as number)).toBe(false);
    });

    it('a bridge that does not leave: says so with its pid, and sends no signal', async () => {
      const child = await startFake('ignore-stop');
      const kills = vi.spyOn(process, 'kill');
      try {
        await expect(stopBridge(ctx)).rejects.toMatchObject({
          code: 'bridge_unresponsive',
          message: expect.stringContaining(`end process ${child.pid}`),
        });
      } finally {
        expect(kills).not.toHaveBeenCalled();
        kills.mockRestore();
      }
      expect(alive(child.pid as number)).toBe(true);
    }, 30_000);

    it('a holder that does not answer: says so with the pid from its own status, and sends no signal', async () => {
      const child = await startFake('silent');
      const kills = vi.spyOn(process, 'kill');
      try {
        await expect(stopBridge(ctx)).rejects.toMatchObject({ code: 'bridge_unresponsive', message: expect.stringContaining(String(child.pid)) });
      } finally {
        expect(kills).not.toHaveBeenCalled();
        kills.mockRestore();
      }
      expect(alive(child.pid as number)).toBe(true);
    });

    it('--reinstall while the bridge runs refuses, and says to stop it first', async () => {
      seedJoined(ctx);
      const child = await startFake('running');
      await expect(bridgeUp(ctx, { force: true })).rejects.toMatchObject({ message: expect.stringMatching(/Stop it first/) });
      expect(alive(child.pid as number)).toBe(true);
    });

    it('--reinstall against a holder that does not answer refuses too, and leaves the files alone', async () => {
      seedJoined(ctx);
      await startFake('silent');
      const keep = path.join(ctx.dataDir, 'network/runtime/KEEP');
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      fs.writeFileSync(keep, 'x');
      await expect(bridgeUp(ctx, { force: true })).rejects.toMatchObject({ message: expect.stringMatching(/Stop it first/) });
      expect(fs.existsSync(keep)).toBe(true);
    }, 30_000);
  });

  describe('status', () => {
    it('says a bridge is not answering, with the pid from its own earlier status', async () => {
      seedJoined(ctx);
      const child = await startFake('silent');
      const status = await getNetworkStatus(ctx);
      expect(status.joined && status.bridge).toMatchObject({ running: false, unresponsive: true, pid: child.pid });
    });

    it('the real CLI says not answering, and calls the pid what it is', async () => {
      seedJoined(ctx);
      const child = await startFake('silent');
      const { MEMESH_DIR: _dir, MEMESH_DB_PATH: _db, ...env } = process.env;
      const result = spawnSync(process.execPath, [tree.cli, 'network', 'status'], { encoding: 'utf8', env: { ...env, HOME: home, USERPROFILE: home }, timeout: 30_000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Bridge: +not answering/);
      expect(result.stdout).toContain(`last reported is ${child.pid}; check that it really is the bridge`);
    }, 40_000);

    it.each([['"abc"'], ['-5'], ['0'], ['1.5'], ['"1; rm -rf /"'], ['null']])('a status file claiming pid %s prints no pid', async (claimed) => {
      seedJoined(ctx);
      await startFake('silent');
      const raw = JSON.parse(fs.readFileSync(statusPath(ctx.dataDir), 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(statusPath(ctx.dataDir), JSON.stringify({ ...raw, pid: JSON.parse(claimed) as unknown }));
      const status = await getNetworkStatus(ctx);
      expect(status.joined && status.bridge).toMatchObject({ unresponsive: true, pid: null });
      await expect(stopBridge(ctx)).rejects.toMatchObject({ message: expect.not.stringMatching(/last reported is/) });
    });

    it('ignores live fields from a status file whose pid is not the one that answered', async () => {
      seedJoined(ctx);
      const child = await startFake('running');
      const written = readStatus(ctx.dataDir);
      if (!written) throw new Error('no status');
      writeStatus(ctx.dataDir, { ...written, pid: 1, relay_state: 'online', started_at: 'stale', joins_accepted: 9 });
      const status = await getNetworkStatus(ctx);
      expect(status.joined && status.bridge).toMatchObject({ running: true, pid: child.pid, started_at: null, relay_state: null, joins_accepted: 0 });
    });

    it('a stale socket and a stale status file read as not running', async () => {
      seedJoined(ctx);
      await leaveStaleSocket(ctx);
      expect(fs.existsSync(statusPath(ctx.dataDir))).toBe(true);
      const status = await getNetworkStatus(ctx);
      expect(status.joined && status.bridge).toMatchObject({ running: false, unresponsive: false, pid: null });
    });
  });

  it('--include-addresses with none found says so, and the link has none', async () => {
    seedJoined(ctx, 'https://relay.example/');
    await startFake('running');
    const result = await createLink(ctx, { includeAddresses: true });
    expect(result.addressesMissing).toBe(true);
    expect(parseLink(result.link).addrs).toBeUndefined();
    expect((await createLink(ctx)).addressesMissing).toBe(false);
  }, 30_000);

  it('a fractional --ttl-hours still makes a link join can read', async () => {
    seedJoined(ctx, 'https://relay.example/');
    await startFake('running');
    const { link, expiresAtMs } = await createLink(ctx, { ttlHours: 0.123456 });
    expect(Number.isSafeInteger(expiresAtMs)).toBe(true);
    expect(parseLink(link).expires_at_ms).toBe(expiresAtMs);
  });
});
