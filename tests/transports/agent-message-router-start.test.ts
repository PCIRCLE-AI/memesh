import { describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { AgentRouterProtocolError } from '../../src/core/agent-router.js';
import { executeAgentMessageAction, type AgentMessageTransportDependencies } from '../../src/transports/agent-messaging.js';
import { startRouterIfDown } from '../../src/host-runtime/router-client.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-router-start-');
const context = { transport: 'cli' as const, sourceHost: 'cli' };
const discover = { action: 'discover', project: 'demo', limit: 1 };
const sessionSend = { action: 'send', project: 'demo', sender: 'a', recipient: 'session-1', target_kind: 'session', idempotency_key: 'k', payload: 'x' };
const run = (input: Record<string, unknown>, dependencies: AgentMessageTransportDependencies) =>
  executeAgentMessageAction(getDatabase(), input, context, dependencies);
const down = (): never => { throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); };

describe('commands that need the router when it is not running', () => {
  it('discover and an exact-session send end in the same sentence, naming the command to run', async () => {
    const messages: string[] = [];
    for (const input of [discover, sessionSend]) {
      const failure = await run(input, { sendRouterRequest: async () => down() }).catch((e: Error) => e);
      expect(failure).toMatchObject({ code: 'router_unreachable' });
      messages.push((failure as Error).message);
    }
    const sentence = 'router_unreachable: the MeMesh message router is not running. Start it with `memesh-router` (leave it running), then retry.';
    expect(messages[0]).toBe(sentence);
    expect(messages[1]).toBe(`${sentence} The durable message is preserved.`);
  });

  it('starts the router once and retries when nothing listens and the transport can start it', async () => {
    const calls: string[] = [];
    let up = false;
    const startRouterIfDown = vi.fn(async (socket: string) => { calls.push(socket); up = true; return true; });
    const result = await run(discover, { sendRouterRequest: async () => (up ? { live: true } : down()), startRouterIfDown });
    expect(result).toEqual({ live: true });
    expect(startRouterIfDown).toHaveBeenCalledTimes(1);
    expect(calls[0]).toContain('agent-router');
  });

  it('says why when the router could not be started', async () => {
    const failure = await run(discover, {
      sendRouterRequest: async () => down(),
      startRouterIfDown: async () => { throw new Error('the router stopped right after starting (exit code 1)'); },
    }).catch((e: Error) => e);
    expect(failure).toMatchObject({ code: 'router_unreachable' });
    expect((failure as Error).message).toBe('router_unreachable: the MeMesh message router is not running and could not be started (the router stopped right after starting (exit code 1)). Run `memesh-router` in a terminal to see why, then retry.');
  });

  it('keeps the original error when the starter says it is not a "nothing listens" error', async () => {
    const original = new AgentRouterProtocolError('invalid_response', 'bad');
    const startRouterIfDown = vi.fn(async () => false);
    const failure = await run(discover, { sendRouterRequest: async () => { throw original; }, startRouterIfDown }).catch((e: unknown) => e);
    expect(failure).toBe(original);
    expect(startRouterIfDown).toHaveBeenCalledWith(expect.any(String), original);
  });
});

describe('startRouterIfDown', () => {
  it.each([
    ['a protocol error from a router that is there', new AgentRouterProtocolError('invalid_response', 'bad')],
    ['a timeout from a router that is there', new AgentRouterProtocolError('timeout', 'slow')],
    ['a reset connection', Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
    ['an error with no code', new Error('offline')],
  ])('starts nothing for %s', async (_label, error) => {
    await expect(startRouterIfDown('/nonexistent-memesh-dir/r.sock', error)).resolves.toBe(false);
  });
});
