import { afterAll, afterEach, expect, it } from 'vitest';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { NETWORK_METADATA_SCHEMA_SQL } from '../../src/storage/agent-network-schema.js';
import { memberRoutes, peerRoute, receivePeerRoutes, rememberPeer, type Joined } from '../../src/network/courier.js';
import { FRAME_MAX_BYTES, parseConversationFrame, peerRouteFrames, type PeerRoute } from '../../src/network/frames.js';

const owner = 'a'.repeat(64), self = 'b'.repeat(64), other = 'c'.repeat(64), unknown = 'd'.repeat(64);
const db = new MemeshDatabase(':memory:');
db.exec(NETWORK_METADATA_SCHEMA_SQL);
afterEach(() => db.exec('DELETE FROM agent_network_peers'));
afterAll(() => db.close());
const joined = {
  config: { machine_id: self, owner_id: owner },
  roster: { members: [owner, self, other].map(machine_id => ({ machine_id })) },
} as Joined;
const route: PeerRoute = { machine_id: other, relay: null, addrs: ['192.0.2.1:4000'] };

it('accepts owner hints for other signed-roster members only, without partial writes', () => {
  receivePeerRoutes(db, joined, owner, [route]);
  expect(peerRoute(db, other)).toEqual({ relay: null, addrs: route.addrs });
  receivePeerRoutes(db, joined, owner, [{ ...route, addrs: ['192.0.2.2:5000'] }]);
  expect(peerRoute(db, other)!.addrs).toEqual(route.addrs);
  for (const sender of [self, other, unknown]) expect(() => receivePeerRoutes(db, joined, sender, [{ ...route, addrs: ['192.0.2.2:5000'] }])).toThrow(/Only the owner/);
  for (const machine_id of [owner, self, unknown]) {
    expect(() => receivePeerRoutes(db, joined, owner, [{ ...route, addrs: ['192.0.2.2:5000'] }, { ...route, machine_id }])).toThrow(/current member/);
    expect(peerRoute(db, other)!.addrs).toEqual(route.addrs);
    expect(peerRoute(db, machine_id)).toBeNull();
  }
});

it('exports only current members other than the sender and recipient', () => {
  for (const machine_id of [owner, self, other, unknown]) rememberPeer(db, machine_id, null, route.addrs, 0);
  expect(memberRoutes(db, joined, owner)).toEqual([route]);
});

it('batches large directories within the wire limit with no dropped routes', () => {
  const routes = Array.from({ length: 255 }, (_, i) => ({ machine_id: i.toString(16).padStart(64, '0'), relay: null, addrs: Array.from({ length: 64 }, () => '[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]:65535') }));
  const frames = peerRouteFrames(routes);
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.flatMap(frame => frame.kind === 'peer-routes' ? frame.routes : [])).toEqual(routes);
  for (const frame of frames) {
    const bytes = Buffer.from(JSON.stringify(frame));
    expect(bytes.length).toBeLessThanOrEqual(FRAME_MAX_BYTES);
    expect(parseConversationFrame(bytes)).toEqual(frame);
  }
});

it('rejects extra fields, invalid identities, duplicate entries and oversized routes', () => {
  const parse = (routes: unknown[], extra = {}) => parseConversationFrame(Buffer.from(JSON.stringify({ version: 2, kind: 'peer-routes', routes, ...extra })));
  expect(() => parse([route, route])).toThrow();
  expect(() => parse([{ ...route, machine_id: 'invalid' }])).toThrow();
  expect(() => parse([{ ...route, private_memory: 'never accepted' }])).toThrow();
  expect(() => parse([{ ...route, addrs: Array(65).fill('192.0.2.1:4000') }])).toThrow();
  expect(() => parse([route], { work_summary: 'never accepted' })).toThrow();
});
