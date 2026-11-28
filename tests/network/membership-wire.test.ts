import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildTree, contextFor, installRuntimeOnce, linkRuntime, loadIrohForTest, makeHome, reportBridgeFailure } from './helpers.js';
import { bindEndpoint, deadline, toBytes } from '../../src/network/endpoint.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { createRoster, signRoster } from '../../src/network/roster.js';
import { insertConfig, openNetworkStore, readConfig } from '../../src/network/store.js';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { probeBridge } from '../../src/network/control-socket.js';
import { exchangeRosterStream } from '../../src/network/frames.js';
import { MEMBERSHIP_ALPN, NET_ALPN, networkMetadataPath } from '../../src/network/types.js';
import { parseMembershipAck } from '../../src/network/membership.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';

it('real management lost ACK is idempotent and NET/2 counts only proven nonmembership', async () => {
  const tree = await buildTree();
  const home = makeHome('mm-wire-');
  const ctx = contextFor(tree, home);
  ctx.env = buildIsolatedRuntimeEnv(process.env, { runtimeHome: home, memeshDir: ctx.dataDir, dbPath: ctx.dbPath });
  const owner = ensureIdentity(ctx.dataDir), peer = ensureIdentity(path.join(home, 'synthetic-peer'));
  const members = [owner, peer].map((id, i) => ({ machine_id: id.machineId, name: i ? 'beta' : 'alpha', person: 'synthetic', joined_at: new Date().toISOString() }));
  const roster = { ...createRoster('c'.repeat(32), members[0]), members };
  const signed = signRoster(owner, roster);
  const db = openNetworkStore(networkMetadataPath(ctx.dataDir));
  const errors: unknown[] = [];
  const close: Array<() => void | Promise<void>> = [() => db.close()];
  let started: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    insertConfig(db, { network_id: roster.network_id, owner_id: owner.machineId, machine_id: owner.machineId, machine_name: 'alpha', person: 'synthetic', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature }, Date.now());
    const runtime = installRuntimeOnce(tree); linkRuntime(ctx, runtime);
    const iroh = loadIrohForTest(runtime);
    const client = await bindEndpoint(iroh, peer.secret, 'off', []);
    close.unshift(() => client.close());
    started = await startBridge(ctx);
    await expect.poll(() => readStatus(ctx.dataDir)?.direct_addresses.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(owner.machineId), null, readStatus(ctx.dataDir)!.direct_addresses);
    const open = async (alpn = MEMBERSHIP_ALPN) => {
      const connection = await deadline(client.connect(address, toBytes(alpn)), 20_000, 'test native connect');
      close.unshift(() => connection.close(0n, toBytes('test cleanup')));
      return { connection, stream: await deadline(connection.openBi(), 5000, 'test open stream') };
    };
    const call = async (request: unknown) => {
      const { connection, stream } = await open();
      try {
        await stream.send.writeAll(toBytes(JSON.stringify(request))); await stream.send.finish();
        return parseMembershipAck(Buffer.from(await deadline(stream.recv.readToEnd(512), 5000, 'test membership ACK')), roster.network_id);
      } finally {
        try { connection.close(0n, toBytes('test done')); } catch (error) { errors.push(error); }
      }
    };
    const request = { version: 1, op: 'leave-self', network_id: roster.network_id };
    const lost = await open();
    await lost.stream.send.writeAll(toBytes(JSON.stringify(request))); await lost.stream.send.finish();
    await expect.poll(() => JSON.parse(readConfig(db)!.roster_json).version, { timeout: 5000 }).toBe(2);
    // Sender never reads the ACK; durable owner update must survive its disconnect.
    lost.connection.close(0n, toBytes('synthetic lost ACK'));
    expect(await call(request)).toEqual({ version: 1, network_id: roster.network_id, roster_version: 2, member: false });
    expect(await call({ ...request, op: 'self-status' })).toEqual({ version: 1, network_id: roster.network_id, roster_version: 2, member: false });
    await expect(call({ ...request, victim: owner.machineId })).rejects.not.toThrow(/timed out/);
    await expect(call({ ...request, network_id: 'd'.repeat(32) })).rejects.not.toThrow(/timed out/);
    await expect(call({ ...request, op: 'roster', roster: signed })).rejects.not.toThrow(/timed out/);
    expect(JSON.parse(readConfig(db)!.roster_json).version).toBe(2);
    expect(readStatus(ctx.dataDir)!.non_member_refused).toBe(0);
    const business = await open(NET_ALPN);
    await expect(exchangeRosterStream(business.stream, signed, offered => offered, 5000)).rejects.not.toThrow(/timed out/);
    await expect.poll(() => readStatus(ctx.dataDir)!.non_member_refused, { timeout: 5000 }).toBe(1);
    expect(await deadline(business.connection.closed(), 5000, 'refusal closure')).toContain('not_a_member');
    const malformed = await open(NET_ALPN);
    await malformed.stream.send.writeAll(toBytes('{}')); await malformed.stream.send.finish();
    expect(await deadline(malformed.connection.closed(), 5000, 'invalid roster closure')).not.toContain('not_a_member');
    expect(readStatus(ctx.dataDir)!.non_member_refused).toBe(1);
  } catch (error) {
    errors.unshift(error);
  }
  const hadFailure = errors.length > 0;
  if (hadFailure) reportBridgeFailure([ctx.dataDir]);
  for (const dispose of close) {
    try { await dispose(); } catch (error) { errors.push(error); }
  }
  try {
    const stopped = await stopBridge(ctx);
    if (started) expect(stopped).toEqual({ stopped: true, pid: started.pid });
    fs.writeFileSync(path.join(home, 'membership-wire-result.json'), JSON.stringify({ pid: started?.pid, stopped, status: readStatus(ctx.dataDir) }), { mode: 0o600, flag: 'wx' });
    console.log(`Membership wire evidence: ${home}/membership-wire-result.json`);
  } catch (error) {
    errors.push(error);
  }
  if (!hadFailure && errors.length) reportBridgeFailure([ctx.dataDir]);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Membership wire test and cleanup failures', { cause: errors[0] });
}, 120_000);

it('a verified self-removal learned through NET/2 also stops local networking', async () => {
  const tree = await buildTree();
  const home = makeHome('mm-revoke-');
  const ctx = contextFor(tree, home);
  ctx.env = buildIsolatedRuntimeEnv(process.env, { runtimeHome: home, memeshDir: ctx.dataDir, dbPath: ctx.dbPath });
  const member = ensureIdentity(ctx.dataDir), owner = ensureIdentity(path.join(home, 'synthetic-owner'));
  const members = [owner, member].map((id, i) => ({ machine_id: id.machineId, name: i ? 'beta' : 'alpha', person: 'synthetic', joined_at: new Date().toISOString() }));
  const roster = { ...createRoster('e'.repeat(32), members[0]), members };
  const signed = signRoster(owner, roster);
  const removed = signRoster(owner, { ...roster, version: 2, members: [members[0]] });
  const db = openNetworkStore(networkMetadataPath(ctx.dataDir));
  const errors: unknown[] = [];
  const close: Array<() => void | Promise<void>> = [() => db.close()];
  let started: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    insertConfig(db, { network_id: roster.network_id, owner_id: owner.machineId, machine_id: member.machineId, machine_name: 'beta', person: 'synthetic', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature }, Date.now());
    const runtime = installRuntimeOnce(tree); linkRuntime(ctx, runtime);
    const iroh = loadIrohForTest(runtime);
    const client = await bindEndpoint(iroh, owner.secret, 'off', []);
    close.unshift(() => client.close());
    started = await startBridge(ctx);
    await expect.poll(() => readStatus(ctx.dataDir)?.direct_addresses.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(member.machineId), null, readStatus(ctx.dataDir)!.direct_addresses);
    const connection = await deadline(client.connect(address, toBytes(NET_ALPN)), 20_000, 'signed self removal connect');
    close.unshift(() => connection.close(0n, toBytes('test cleanup')));
    const stream = await deadline(connection.openBi(), 5000, 'signed self removal stream');
    await expect(exchangeRosterStream(stream, removed, offered => offered, 5000)).rejects.not.toThrow(/timed out/);
    await expect.poll(() => readConfig(db), { timeout: 5000 }).toBeNull();
    await expect.poll(async () => (await probeBridge(ctx.dataDir)).kind, { timeout: 5000 }).toBe('not-running');
    expect(readStatus(ctx.dataDir)?.membership_departure).toEqual({ network_id: roster.network_id, owner_id: owner.machineId, machine_id: member.machineId });
  } catch (error) {
    errors.push(error);
  }
  const hadFailure = errors.length > 0;
  if (hadFailure) reportBridgeFailure([ctx.dataDir]);
  for (const dispose of close) {
    try { await dispose(); } catch (error) { errors.push(error); }
  }
  try {
    const stopped = await stopBridge(ctx);
    fs.writeFileSync(path.join(home, 'membership-revoke-result.json'), JSON.stringify({ pid: started?.pid, stopped, status: readStatus(ctx.dataDir) }), { mode: 0o600, flag: 'wx' });
    console.log(`Membership NET2 revocation evidence: ${home}/membership-revoke-result.json`);
  } catch (error) {
    errors.push(error);
  }
  if (!hadFailure && errors.length) reportBridgeFailure([ctx.dataDir]);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Membership revocation test and cleanup failures', { cause: errors[0] });
}, 120_000);
