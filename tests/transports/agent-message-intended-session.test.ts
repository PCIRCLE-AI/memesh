/**
 * #497 at the transport boundary: the `send` fields (`intended_session`,
 * `fallback_to_principal`), the fallback itself (issue step 2), and the
 * intake/disposition guard as MCP, CLI and HTTP each see the caller's session
 * (issue step 4). The waiting-count half is in
 * tests/core/agent-message-intended-session.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { MessageSchema } from '../../src/transports/schemas.js';
import { hostSessionFromEnv } from '../../src/core/host-session.js';
import { unreadMessageRefsFor } from '../../src/core/agent-message-inbox.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession, sendIntendedPrincipalMessage } from '../helpers/agent-session-fixture.js';

useTestDatabase('memesh-intended-session-transport-');

const PROJECT = 'proj-497';
const PRINCIPAL = 'claude-proj-497-1';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const originalSessionEnv = process.env.CLAUDE_CODE_SESSION_ID;
afterEach(() => {
  if (originalSessionEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = originalSessionEnv;
});

const refused = { sendRouterRequest: async () => ({ delivered: false }) };

function sessionSend(overrides: Record<string, unknown> = {}) {
  return {
    action: 'send',
    project: PROJECT,
    sender: 'codex-lead',
    recipient: SESSION_A,
    target_kind: 'session',
    fallback_to_principal: true,
    idempotency_key: 'instruction-1',
    payload: 'work instruction for owner A',
    ...overrides,
  };
}

type FallbackResult = {
  message_id: string;
  delivery_id: string;
  recipient: string;
  target_kind: string;
  intended_session: string | null;
  fallback: { reason: string; from: { message_id: string; recipient: string; target_kind: string } };
};

describe('Feature: #497 send can fall back to the principal and keep the intended session', () => {
  it('step 2: a refused session send with fallback_to_principal lands on the principal, meant for A only', async () => {
    // A's registration exists (so its principal is known) but it is not live.
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_A, disconnected: true, adapterKind: 'claude-channel' });

    const result = await executeAgentMessageAction(getDatabase(), sessionSend(), {
      transport: 'mcp', sourceHost: 'codex',
    }, refused) as FallbackResult;

    expect(result).toMatchObject({
      recipient: PRINCIPAL,
      target_kind: 'principal',
      intended_session: SESSION_A,
      fallback: { reason: 'recipient_unavailable', from: { recipient: SESSION_A, target_kind: 'session' } },
    });
    expect(unreadMessageRefsFor(getDatabase(), PRINCIPAL, SESSION_A)).toEqual([
      { project: PROJECT, message_id: result.message_id },
    ]);
    expect(unreadMessageRefsFor(getDatabase(), PRINCIPAL, SESSION_B)).toEqual([]);

    // A retry of the same call is idempotent: the same principal message.
    const retried = await executeAgentMessageAction(getDatabase(), sessionSend(), {
      transport: 'mcp', sourceHost: 'codex',
    }, refused) as FallbackResult;
    expect(retried.message_id).toBe(result.message_id);
    expect(retried.fallback.from.message_id).toBe(result.fallback.from.message_id);
  });

  it('#518: the sender is told when the intended session is not connected, so no session can take the message now', async () => {
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_A, disconnected: true, adapterKind: 'claude-channel' });

    const result = await executeAgentMessageAction(getDatabase(), sessionSend(), {
      transport: 'mcp', sourceHost: 'codex',
    }, refused) as FallbackResult & { fallback: { intended_session_connected: boolean; note?: string } };

    expect(result.fallback.intended_session_connected).toBe(false);
    expect(result.fallback.note).toContain(SESSION_A);
    expect(result.fallback.note).toContain('without intended_session');
  });

  it('#518: a connected session that refused is reported as connected, with no warning', async () => {
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_A, adapterKind: 'claude-channel' });

    const result = await executeAgentMessageAction(getDatabase(), sessionSend(), {
      transport: 'mcp', sourceHost: 'codex',
    }, refused) as FallbackResult & { fallback: { intended_session_connected: boolean; note?: string } };

    expect(result.fallback.intended_session_connected).toBe(true);
    expect(result.fallback.note).toBeUndefined();
  });

  it('without the flag, a refused session send still fails with recipient_unavailable', async () => {
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_A, disconnected: true });

    await expect(executeAgentMessageAction(getDatabase(), sessionSend({ fallback_to_principal: undefined }), {
      transport: 'mcp', sourceHost: 'codex',
    }, refused)).rejects.toMatchObject({ code: 'recipient_unavailable' });
    expect(unreadMessageRefsFor(getDatabase(), PRINCIPAL, SESSION_A)).toEqual([]);
  });

  it('says why it cannot fall back when the session was never registered, so its principal is unknown', async () => {
    await expect(executeAgentMessageAction(getDatabase(), sessionSend(), {
      transport: 'mcp', sourceHost: 'codex',
    }, refused)).rejects.toMatchObject({
      code: 'recipient_unavailable',
      message: expect.stringMatching(/no principal fallback/),
    });
  });

  it('names a project with line separators as one escaped literal in the no-fallback refusal', async () => {
    const project = 'sep\u2028line\u2029para';
    const err = await executeAgentMessageAction(getDatabase(), sessionSend({ project }), {
      transport: 'mcp', sourceHost: 'codex',
    }, refused).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/no principal fallback/);
    expect(err!.message).not.toMatch(/[\u2028\u2029]/);
    const m = err!.message.match(/in project ("(?:[^"\\]|\\.)*")/);
    expect(m, err!.message).not.toBeNull();
    expect(JSON.parse(m![1])).toBe(project);
  });

  it('does not fall back from a refused acp session: nothing there could ever record intake for it', async () => {
    registerAgentSession(PROJECT, 'acp-principal', { sessionId: SESSION_A, disconnected: true, adapterKind: 'acp' });

    await expect(executeAgentMessageAction(getDatabase(), sessionSend(), {
      transport: 'mcp', sourceHost: 'claude-code',
    }, refused)).rejects.toMatchObject({
      code: 'recipient_unavailable',
      message: expect.stringMatching(/no principal fallback.*"acp".*Only Claude Code sessions and Codex CLI threads/),
    });
    expect(getDatabase().prepare(
      "SELECT COUNT(*) AS n FROM agent_message_deliveries WHERE target_kind = 'principal'",
    ).get()).toEqual({ n: 0 });
  });

  it('does not fall back when the router is unreachable (only a refusal triggers it)', async () => {
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_A, disconnected: true });

    await expect(executeAgentMessageAction(getDatabase(), sessionSend(), {
      transport: 'mcp', sourceHost: 'codex',
    }, { sendRouterRequest: async () => { throw new Error('connect ENOENT'); } }))
      .rejects.toMatchObject({ code: 'router_unreachable' });
  });

  it('validates the two new fields against target_kind at the boundary', () => {
    expect(MessageSchema.safeParse(sessionSend()).success).toBe(true);
    expect(MessageSchema.safeParse(sessionSend({ target_kind: 'principal', recipient: PRINCIPAL })).success).toBe(false);
    expect(MessageSchema.safeParse({
      ...sessionSend({ fallback_to_principal: undefined }), intended_session: SESSION_A,
    }).success).toBe(false);
    expect(MessageSchema.safeParse({
      ...sessionSend({ fallback_to_principal: undefined, target_kind: 'principal', recipient: PRINCIPAL }),
      intended_session: SESSION_A,
    }).success).toBe(true);
  });
});

describe('Feature: #497 only the intended session can record intake or a disposition', () => {
  function intake(messageId: string) {
    return {
      action: 'intake', project: PROJECT, recipient: PRINCIPAL, message_id: messageId,
      intake_state: 'ingested', idempotency_key: `intake-${messageId}`,
    };
  }

  it('step 4: rejects B\'s intake and keeps A waiting; accepts A\'s', async () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-t4');

    await expect(executeAgentMessageAction(getDatabase(), intake(sent.message_id), {
      transport: 'mcp', sourceHost: 'claude-code', hostSession: SESSION_B,
    })).rejects.toMatchObject({ code: 'intended_for_other_session' });
    expect(unreadMessageRefsFor(getDatabase(), PRINCIPAL, SESSION_A)).toHaveLength(1);

    await executeAgentMessageAction(getDatabase(), intake(sent.message_id), {
      transport: 'mcp', sourceHost: 'claude-code', hostSession: SESSION_A,
    });
    expect(unreadMessageRefsFor(getDatabase(), PRINCIPAL, SESSION_A)).toEqual([]);
  });

  it('rejects a disposition from B', async () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-t4d');

    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'disposition', project: PROJECT, recipient: PRINCIPAL, message_id: sent.message_id,
      disposition: 'accepted', idempotency_key: 'disp-b',
    }, { transport: 'cli', sourceHost: 'cli', hostSession: SESSION_B }))
      .rejects.toMatchObject({ code: 'intended_for_other_session' });
  });

  it('HTTP has no session, so it is refused', async () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-http');

    await expect(executeAgentMessageAction(getDatabase(), intake(sent.message_id), {
      transport: 'http', sourceHost: 'http',
    })).rejects.toMatchObject({ code: 'intended_for_other_session' });
  });

  it('the MCP tool takes the caller\'s session from CLAUDE_CODE_SESSION_ID', async () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-mcp');

    process.env.CLAUDE_CODE_SESSION_ID = SESSION_B;
    const asB = await handleTool('message', intake(sent.message_id), 'claude-code');
    expect(asB.isError).toBe(true);
    expect(asB.content[0].text).toContain('intended_for_other_session');

    process.env.CLAUDE_CODE_SESSION_ID = SESSION_A;
    const asA = await handleTool('message', intake(sent.message_id), 'claude-code');
    expect(asA.isError).toBeUndefined();
    expect(unreadMessageRefsFor(getDatabase(), PRINCIPAL, SESSION_A)).toEqual([]);
  });
});

describe('hostSessionFromEnv', () => {
  it('reads CLAUDE_CODE_SESSION_ID, trimmed and NFC-normalised, and nothing when unset or blank', () => {
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: ` ${SESSION_A} ` })).toBe(SESSION_A);
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: 'Café' })).toBe('Café');
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: '  ' })).toBeUndefined();
    expect(hostSessionFromEnv({})).toBeUndefined();
  });

  it('ignores a value no session id can be (a filesystem path)', () => {
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: '/tmp/x' })).toBeUndefined();
    expect(hostSessionFromEnv({ CODEX_THREAD_ID: '/tmp/x' })).toBeUndefined();
  });

  it('uses CODEX_THREAD_ID when CLAUDE_CODE_SESSION_ID is unset, and Claude wins when both are set', () => {
    const thread = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(hostSessionFromEnv({ CODEX_THREAD_ID: thread })).toBe(thread);
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: '  ', CODEX_THREAD_ID: thread })).toBe(thread);
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: SESSION_A, CODEX_THREAD_ID: thread })).toBe(SESSION_A);
  });
});
