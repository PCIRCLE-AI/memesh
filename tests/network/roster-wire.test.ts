// Real iroh streams against an actual private bridge; no owner identity or relay.
import path from 'node:path';
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { bindEndpoint, deadline, toBytes } from '../../src/network/endpoint.js';
import { ACK_MAX_BYTES, exchangeRosterStream, parseAck } from '../../src/network/frames.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { addMember, createRoster, findMember, signRoster, verifyRoster } from '../../src/network/roster.js';
import { insertConfig, openNetworkStore, readConfig, saveRoster } from '../../src/network/store.js';
import { NET_ALPN, networkMetadataPath } from '../../src/network/types.js';
import { isPlatformSupported } from '../../src/network/runtime.js';
import { buildTree, contextFor, installRuntimeOnce, linkRuntime, loadIrohForTest, makeHome, removeTree } from './helpers.js';

const supported = isPlatformSupported(fs.readFileSync(path.join(import.meta.dirname, '../../src/network/runtime-lock.json'), 'utf8'),
  process.platform, process.arch, process.platform === 'linux' ? 'glibc' : null);

it.skipIf(!supported || process.platform === 'win32')('native NET/2 accepts late signed membership and closes a revoked in-flight peer', async () => {
  const tree = await buildTree();
  const homes = [makeHome('mr-b-'), makeHome('mr-c-'), makeHome('mr-a-')];
  const beta = contextFor(tree, homes[0]);
  const owner = ensureIdentity(path.join(homes[2], '.memesh'));
  const b = ensureIdentity(beta.dataDir);
  const c = ensureIdentity(path.join(homes[1], '.memesh'));
  const now = new Date().toISOString();
  let roster = createRoster('1234567890abcdef1234567890abcdef', {
    machine_id: owner.machineId, name: 'alpha', person: 'owner', joined_at: now,
  });
  roster = addMember(roster, { machine_id: b.machineId, name: 'beta', person: 'b', joined_at: now });
  const old = signRoster(owner, roster);
  roster = addMember(roster, { machine_id: c.machineId, name: 'gamma', person: 'c', joined_at: now });
  const latest = signRoster(owner, roster);
  const runtime = installRuntimeOnce(tree);
  linkRuntime(beta, runtime);
  const db = openNetworkStore(networkMetadataPath(beta.dataDir), { metadataOnly: true });
  insertConfig(db, { network_id: roster.network_id, owner_id: owner.machineId, machine_id: b.machineId,
    machine_name: 'beta', person: 'b', relay_url: 'off', roster_json: old.roster_json, roster_signature: old.signature }, Date.now());
  const iroh = loadIrohForTest(runtime);
  const client = await bindEndpoint(iroh, c.secret, 'off', []);
  const connections: Array<Awaited<ReturnType<typeof client.connect>>> = [];
  let started: { pid: number; started: boolean } | undefined;
  try {
    expect(findMember(verifyRoster(old, owner.machineId, roster.network_id), c.machineId)).toBeUndefined();
    started = await startBridge(beta);
    await expect.poll(() => readStatus(beta.dataDir)?.direct_addresses.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(b.machineId), null, readStatus(beta.dataDir)!.direct_addresses);
    const connect = async (phase: string) => {
      console.info('NATIVE_ROSTER_PHASE', phase);
      // Match bridge-serve's SEND_CONNECT_DEADLINE_MS, rather than a shorter test-only limit.
      const connection = await deadline(client.connect(address, toBytes(NET_ALPN)), 20_000, `${phase}: native peer connect`);
      connections.push(connection);
      const stream = await deadline(connection.openBi(), 5000, `${phase}: native roster stream`);
      await exchangeRosterStream(stream, latest, offered => {
        verifyRoster(offered, owner.machineId, roster.network_id);
        return offered;
      }, 5000);
      return connection;
    };
    const positive = await connect('late-member-positive');
    expect(JSON.parse(readConfig(db)!.roster_json).version).toBe(3);
    const business = await deadline(positive.openBi(), 5000, 'native business stream');
    await business.send.writeAll(toBytes(JSON.stringify({ version: 2, kind: 'conversations', relay: null, addrs: [], entries: [] })));
    await business.send.finish();
    expect(parseAck(Buffer.from(await deadline(business.recv.readToEnd(ACK_MAX_BYTES), 5000, 'native ACK'))).result).toBe('accepted');
    positive.close(0n, toBytes('positive complete'));
    await deadline(positive.closed(), 5000, 'positive connection closure');

    const held = await connect('held-before-revocation');
    const unfinished = await deadline(held.openBi(), 5000, 'held business stream');
    await unfinished.send.writeAll(toBytes('{"version":2'));
    // A newly signed list arrives while readToEnd is waiting for the rest of the frame.
    const removed = signRoster(owner, { ...roster, version: 4, members: roster.members.filter(member => member.machine_id !== c.machineId) });
    saveRoster(db, removed);
    const reason = await deadline(held.closed(), 5000, 'in-flight revocation');
    expect(reason).toContain('not_a_member');
    expect(JSON.parse(readConfig(db)!.roster_json).version).toBe(4);
    // The old, correctly signed version cannot reauthorize the removed machine.
    await expect(connect('revoked-stale-member')).rejects.not.toThrow(/timed out/);
    await expect.poll(() => readStatus(beta.dataDir)?.last_error, { timeout: 5000 }).toBe('not_a_member');
    expect(JSON.parse(readConfig(db)!.roster_json).version).toBe(4);
  } finally {
    for (const connection of connections) connection.close(0n, toBytes('test cleanup'));
    await client.close();
    const stopped = await stopBridge(beta);
    if (started) expect(stopped).toEqual({ stopped: true, pid: started.pid });
    console.info('OWNED_BRIDGE_CLEANUP', JSON.stringify({ started: started?.pid ?? null, stopped }));
    db.close();
    homes.forEach(removeTree);
    removeTree(path.dirname(path.dirname(path.dirname(runtime))));
    removeTree(tree.root);
  }
}, 120_000);
