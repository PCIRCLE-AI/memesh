import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { AgentRouter, AGENT_ROUTER_PROTOCOL_VERSION, sendAgentRouterRequest } from '../../src/core/agent-router.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const fixture = useTestDatabase('memesh-handles-router-');

describe('discover handles', () => {
  it('returns a computed handle on a live router card for a dashed project name', async () => {
    const socketPath = `${fixture.tmpDir}/router.sock`;
    const router = new AgentRouter({ db: getDatabase(), socket_path: socketPath, memesh_version: '1.0.0', limits: { lease_ms: 5000 }, adapters: [{ kind: 'claude-channel', authenticate: () => true }] });
    await router.start();
    const socket = net.createConnection(socketPath);
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      const registration = new Promise<void>((resolve, reject) => {
        let buffer = '';
        socket.on('data', chunk => {
          buffer += chunk.toString();
          const line = buffer.split('\n')[0];
          if (!buffer.includes('\n')) return;
          const frame = JSON.parse(line) as { ok?: boolean };
          if (frame.ok) resolve(); else reject(new Error('registration refused'));
        });
      });
      socket.write(`${JSON.stringify({ version: AGENT_ROUTER_PROTOCOL_VERSION, type: 'register', request_id: randomUUID(), project: 'my-project~abc', principal_id: 'claude-p', session_instance_id: 'session-a0d1', adapter_kind: 'claude-channel', hops: 0 })}\n`);
      await registration;
      const response = await sendAgentRouterRequest(socketPath, { version: AGENT_ROUTER_PROTOCOL_VERSION, type: 'discover', request_id: randomUUID(), project: 'my-project~abc', limit: 10, hops: 0 });
      expect(response.cards).toEqual([expect.objectContaining({ session_id: 'session-a0d1', host_kind: 'claude', handle: 'my-project-claude-a0d1', model: null })]);
    } finally { socket.destroy(); await router.stop(); }
  });
});
