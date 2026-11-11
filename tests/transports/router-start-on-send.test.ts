import { describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';

useTestDatabase('memesh-router-start-on-send-');
const project = 'start-on-send';

const notRunning = (code: 'ENOENT' | 'ECONNREFUSED') => Object.assign(new Error(`connect ${code}`), { code });
const context = { transport: 'http' as const, sourceHost: 'http' };
const discover = { action: 'discover', project };

describe('a sender that is not a host starts a router that is not running', () => {
  it.each(['ENOENT', 'ECONNREFUSED'] as const)('starts it once on %s and asks again', async (code) => {
    const send = vi.fn()
      .mockRejectedValueOnce(notRunning(code))
      .mockResolvedValue({ cards: [] });
    const startRouter = vi.fn(async () => undefined);
    const result = await executeAgentMessageAction(getDatabase(), discover, context, { sendRouterRequest: send as never, startRouter });
    expect(result).toEqual({ cards: [] });
    expect(startRouter).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps asking for a few attempts while the new router comes up, then gives the unreachable error', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(notRunning('ENOENT'))
      .mockRejectedValueOnce(notRunning('ENOENT'))
      .mockRejectedValueOnce(notRunning('ECONNREFUSED'))
      .mockResolvedValue({ cards: [] });
    const result = await executeAgentMessageAction(getDatabase(), discover, context, { sendRouterRequest: send as never, startRouter: async () => undefined });
    expect(result).toEqual({ cards: [] });
    expect(send).toHaveBeenCalledTimes(4);
  }, 10_000);

  it('does not start a router for any other failure, and says router_unreachable when starting it fails', async () => {
    const startRouter = vi.fn(async () => undefined);
    await expect(executeAgentMessageAction(getDatabase(), discover, context, {
      sendRouterRequest: (async () => { throw Object.assign(new Error('Router request timed out.'), { code: 'timeout' }); }) as never, startRouter,
    })).rejects.toMatchObject({ code: 'router_unreachable' });
    expect(startRouter).not.toHaveBeenCalled();
    await expect(executeAgentMessageAction(getDatabase(), discover, context, {
      sendRouterRequest: (async () => { throw notRunning('ENOENT'); }) as never,
      startRouter: async () => { throw new Error('spawn failed'); },
    })).rejects.toMatchObject({ code: 'router_unreachable' });
  });

  it('lets a session send with fallback_to_principal fall back after the router was started, instead of failing with router_unreachable', async () => {
    const session = registerAgentSession(project, 'bob', { sessionId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', adapterKind: 'claude-channel', disconnected: true });
    const send = vi.fn()
      .mockRejectedValueOnce(notRunning('ENOENT'))
      .mockResolvedValue({ delivered: false });
    const result = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project, sender: 'alice', recipient: session, target_kind: 'session', fallback_to_principal: true,
      idempotency_key: 'after-idle', payload: 'hello',
    }, context, { sendRouterRequest: send as never, startRouter: async () => undefined }) as { fallback?: unknown };
    expect(result.fallback).toBeDefined();
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM agent_message_deliveries WHERE project = ? AND target_kind = 'principal' AND recipient = 'bob'").get(project)).toEqual({ n: 1 });
  });
});
