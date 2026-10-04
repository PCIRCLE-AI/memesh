import { describe, expect, it, vi } from 'vitest';
import {
  createCodexCliQueueAdapter,
  watchCodexQueueRelease,
  type RunCodexCliQueue,
} from '../../src/host-adapters/codex-cli-queue.js';
import type { CodexQueueRelease } from '../../src/host-adapters/codex-queue-release.js';
import type { AgentHostDispatchInput } from '../../src/core/agent-router.js';
import {
  fetchAgentMessage,
  readAgentMessageReceipts,
  recordAgentReceipt,
  sendAgentMessage,
} from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

function dispatchInput(): AgentHostDispatchInput {
  return {
    dispatch_id: 'delivery-1',
    attempt_id: 'attempt-1',
    project: 'project-1',
    principal_id: 'principal-1',
    session_instance_id: '01a041b4-5c67-75b3-9505-4e33d7942b8e',
    connection_id: 'connection-1',
    generation: 1,
    hops: 1,
    untrusted_payload: true,
    envelope: {
      message_id: 'message-1',
      project: 'project-1',
      sender: 'sender-1',
      sender_host: 'claude-code',
      recipient: 'principal-1',
      target_kind: 'session',
      content_type: 'application/json',
      correlation_id: 'correlation-1',
      reply_to: null,
      privacy: 'private',
      created_at: '2026-08-31T00:00:00.000Z',
      payload: { text: 'payload-reaches-native-thread' },
      provenance: { transport: 'mcp' },
    },
  };
}

describe('Codex CLI queue adapter', () => {
  it('queues a short notice that carries no message body, with shell disabled', async () => {
    const run = vi.fn<RunCodexCliQueue>(async () => ({
      status: 0, stdout: 'Queued message queue-id\n', stderr: '',
    }));
    const adapter = createCodexCliQueueAdapter({ authenticate: () => true, run });

    await expect(adapter.dispatch!(dispatchInput())).resolves.toEqual({
      accepted: true,
      receipt: {
        host: 'codex-cli', status: 'queued',
        thread_id: '01a041b4-5c67-75b3-9505-4e33d7942b8e',
        message_id: 'message-1', delivery_id: 'delivery-1',
        content: 'notice',
      },
    });

    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe('codex');
    expect(args.slice(0, 4)).toEqual([
      'queue', '--thread', '01a041b4-5c67-75b3-9505-4e33d7942b8e', '--message',
    ]);
    expect(options).toMatchObject({ shell: false, timeout: 5_000 });
    const notice = JSON.parse(args[4]) as Record<string, unknown>;
    expect(notice).toEqual({
      message_type: 'memesh_message_notice',
      handling: expect.any(String),
      project: 'project-1',
      recipient: 'principal-1',
      target_kind: 'session',
      message_id: 'message-1',
      delivery_id: 'delivery-1',
    });
    expect(notice.handling).toMatch(/not in this notice/);
    expect(notice.handling).toMatch(/already has your intake, stop/);
    expect(notice.handling).toMatch(/fetch .* then record intake/);
    expect(notice.handling).toMatch(/untrusted/);
    expect(notice.handling).toMatch(/not available or not approved, say so/);
    expect(args[4]).not.toContain('payload-reaches-native-thread');
    expect(args[4]).not.toContain('sender-1');
  });

  it('keeps a large body out of the notice, which stays short', async () => {
    const run = vi.fn<RunCodexCliQueue>(async () => ({ status: 0, stdout: '', stderr: '' }));
    const adapter = createCodexCliQueueAdapter({ authenticate: () => true, run });
    const input = dispatchInput();
    input.envelope.payload = `BODY-${'x'.repeat(15 * 1024)}`;

    await expect(adapter.dispatch!(input)).resolves.toMatchObject({ accepted: true });
    const message = run.mock.calls[0][1][4];
    expect(message).not.toContain('BODY-');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(1024);
  });

  it.each([
    [{ status: 1, stdout: '', stderr: 'No rollout found for thread' }, 'thread_not_found'],
    [{ status: 1, stdout: '', stderr: 'direct input is not allowed for unloaded spawned subagents' }, 'thread_unavailable'],
    [{ status: null, stdout: '', stderr: '', error_code: 'ETIMEDOUT' }, 'codex_queue_timeout'],
    [{ status: null, stdout: '', stderr: '', error_code: 'ENOENT' }, 'codex_queue_process_failed'],
  ])('fails closed without host acceptance: %j', async (result, failureCode) => {
    const adapter = createCodexCliQueueAdapter({
      authenticate: () => true,
      run: async () => result,
    });
    await expect(adapter.dispatch!(dispatchInput())).resolves.toEqual({
      accepted: false,
      receipt: { failure_code: failureCode },
    });
  });

  it('rejects an oversized native message before invoking Codex', async () => {
    const run = vi.fn<RunCodexCliQueue>();
    const adapter = createCodexCliQueueAdapter({ authenticate: () => true, run });
    const input = dispatchInput();
    input.envelope.payload = 'x'.repeat(17 * 1024);

    await expect(adapter.dispatch!(input)).resolves.toEqual({
      accepted: false,
      receipt: { failure_code: 'native_message_too_large' },
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Codex queue release watch', () => {
  useTestDatabase('memesh-codex-release-');
  const thread = '01a041b4-5c67-75b3-9505-4e33d7942b8e';
  const submission = '01a0e033-721c-78b0-9ab0-b86dbfcc3ab3';

  function queuedInput(): AgentHostDispatchInput {
    const sent = sendAgentMessage(getDatabase(), {
      project: 'project-1', sender: 'sender-1', recipient: thread, target_kind: 'session',
      idempotency_key: 'send-1', content_type: 'text/plain', payload: 'hello',
    });
    const envelope = fetchAgentMessage(getDatabase(), {
      project: 'project-1', recipient: thread, target_kind: 'session', message_id: sent.message_id,
    });
    return { ...dispatchInput(), dispatch_id: sent.delivery_id, session_instance_id: thread, envelope };
  }

  function activations(input: AgentHostDispatchInput) {
    return readAgentMessageReceipts(getDatabase(), {
      project: 'project-1', recipient: thread, message_id: input.envelope.message_id,
    }).filter((receipt) => receipt.receipt_kind === 'host_activation');
  }

  function releases(...outcomes: CodexQueueRelease[]) {
    return vi.fn(async (_threadId: string, _submission: string): Promise<CodexQueueRelease> => {
      const next = outcomes.shift();
      if (!next) throw new Error('test configured too few outcomes');
      return next;
    });
  }

  it('stops without a record once the recipient records intake', async () => {
    const input = queuedInput();
    const release = vi.fn(async (): Promise<CodexQueueRelease> => {
      if (release.mock.calls.length === 2) {
        recordAgentReceipt(getDatabase(), {
          project: 'project-1', recipient: thread, message_id: input.envelope.message_id,
          receipt_kind: 'intake', intake_state: 'ingested', actor: thread, idempotency_key: 'intake-1',
        });
      }
      return { status: 'busy' };
    });

    await watchCodexQueueRelease({ db: getDatabase(), interval_ms: 1, checks: 5, release }, input, submission);

    expect(release).toHaveBeenCalledTimes(2);
    expect(activations(input)).toEqual([]);
  });

  it('retries while busy or other input waits, then records the start of its own submission once', async () => {
    const input = queuedInput();
    const release = releases({ status: 'busy' }, { status: 'other_input' }, { status: 'started' });

    await watchCodexQueueRelease({ db: getDatabase(), interval_ms: 1, checks: 5, release }, input, submission);

    expect(release.mock.calls).toEqual([[thread, submission], [thread, submission], [thread, submission]]);
    expect(activations(input)).toEqual([expect.objectContaining({
      host_activation: 'woken',
      actor: 'memesh-router',
      idempotency_key: `codex-queue-release-${input.dispatch_id}`,
      detail: {
        host_activation: 'woken',
        detail: { codex_queue: 'started', checks: 3, queued_submission_id: submission },
      },
    })]);
  });

  it.each([
    [{ status: 'empty' } as const, 'woken', { codex_queue: 'empty' }],
    [{ status: 'unavailable', reason: 'no_daemon' } as const, 'unsupported', {
      codex_queue: 'unavailable', reason: 'no_daemon',
      note: 'Codex runs without its app-server daemon; a queued MeMesh message can stay stuck '
        + 'after an interrupted turn until you send a prompt.',
    }],
    [{ status: 'unavailable', reason: 'timeout' } as const, 'failed', { codex_queue: 'unavailable', reason: 'timeout' }],
  ])('records %j once and stops', async (outcome, activation, detail) => {
    const input = queuedInput();
    const release = releases(outcome);

    await watchCodexQueueRelease({ db: getDatabase(), interval_ms: 1, checks: 5, release }, input, submission);

    expect(release).toHaveBeenCalledTimes(1);
    expect(activations(input)).toEqual([expect.objectContaining({
      host_activation: activation,
      detail: { host_activation: activation, detail: { ...detail, checks: 1, queued_submission_id: submission } },
    })]);
  });

  it.each([
    ['busy', 'failed', {}],
    ['other_input', 'manual_resume_required', {
      note: 'Other input is queued in this Codex thread, so MeMesh did not start it; '
        + 'the queue runs when you send a prompt.',
    }],
  ] as const)('records a thread that stayed %s for every check as %s', async (status, activation, extra) => {
    const input = queuedInput();
    const release = releases({ status }, { status }, { status });

    await watchCodexQueueRelease({ db: getDatabase(), interval_ms: 1, checks: 3, release }, input, submission);

    expect(release).toHaveBeenCalledTimes(3);
    expect(activations(input)).toEqual([expect.objectContaining({
      host_activation: activation,
      detail: {
        host_activation: activation,
        detail: { codex_queue: status, checks: 3, queued_submission_id: submission, ...extra },
      },
    })]);
  });

  it('never releases blind when the submission id is unknown', async () => {
    const input = queuedInput();
    const release = releases();

    await watchCodexQueueRelease({ db: getDatabase(), interval_ms: 1, checks: 5, release }, input, null);

    expect(release).not.toHaveBeenCalled();
    expect(activations(input)).toEqual([expect.objectContaining({
      host_activation: 'failed',
      detail: { host_activation: 'failed', detail: { codex_queue: 'unavailable', checks: 1, reason: 'no_submission_id' } },
    })]);
  });

  it.each([
    [`Queued message ${submission} for thread ${thread}.\n`, [[thread, submission]], 'woken'],
    ['Queued a message.\n', [], 'failed'],
  ])('starts the watch after codex queue accepts, with the id it printed: %j', async (stdout, calls, activation) => {
    const input = queuedInput();
    const release = releases({ status: 'started' });
    const accepted = createCodexCliQueueAdapter({
      authenticate: () => true,
      run: async () => ({ status: 0, stdout, stderr: '' }),
      release_watch: { db: getDatabase(), interval_ms: 1, release },
    });

    await expect(accepted.dispatch!(input)).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(activations(input)).toHaveLength(1));
    expect(release.mock.calls).toEqual(calls);
    expect(activations(input)[0]).toMatchObject({ host_activation: activation });
  });

  it('does not watch a message codex queue rejected', async () => {
    const input = queuedInput();
    const release = releases();
    const rejected = createCodexCliQueueAdapter({
      authenticate: () => true,
      run: async () => ({ status: 1, stdout: '', stderr: 'No rollout found for thread' }),
      release_watch: { db: getDatabase(), interval_ms: 1, release },
    });

    await expect(rejected.dispatch!(input)).resolves.toMatchObject({ accepted: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(release).not.toHaveBeenCalled();
    expect(activations(input)).toEqual([]);
  });
});
