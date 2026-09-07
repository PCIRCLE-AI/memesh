/**
 * Unit tests for the pure half of `scripts/qa/live-journey.mjs`.
 *
 * The live check itself cannot run here — it needs the owner's Codex login or a
 * human at an interactive Claude session, and a test suite that shells out to
 * either would be a test that passes by not running. What CAN be pinned is
 * everything the live run *decides*: how it parses its arguments, when it
 * refuses to start, and — the part that matters — whether each assertion
 * actually rejects the evidence it is supposed to reject.
 *
 * The fixtures below are the recorded shapes from a real journey on 87edb292:
 * `codex exec --json` event lines, a `message send` result with its
 * `native_delivery` block, and a `message receipts` projection. They are inline
 * rather than read from disk on purpose — this suite must pass on a clean
 * clone, and the original logs live outside the repository.
 *
 * Every assertion is tested from BOTH sides. A test that only feeds an
 * assertion the input it accepts proves the happy path and nothing else; the
 * negative cases here are the ones that would have caught a `qa_sentinel`-only
 * check, an intake-free receipts projection, or a send whose native delivery
 * never happened.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WAIT_MS,
  MAX_SOCKET_PATH_BYTES,
  REQUIRED_DIST,
  assertClaudeModelIntakeArmingConfirmation,
  assertClaudePluginIsolationConfirmation,
  assertCodexRanNoCommands,
  assertCodexReply,
  assertInstalledCodexPluginJourney,
  assertCompanionRunning,
  assertDistPresent,
  assertExactCodexQueueRouting,
  assertHostAcceptOnly,
  assertNoHostOutcomeReceipts,
  assertIntakeReceipt,
  assertMcpDiscoverCards,
  assertMcpDenied,
  assertMcpFetchedMessage,
  assertNativeAccepted,
  assertNoLiveRegistrations,
  assertNotCi,
  assertSupportedPlatform,
  assertOutsideOwnerMemesh,
  assertTaskOwnedCodexHome,
  assertRecipientUnavailable,
  assertSocketPathFits,
  awaitSessionDisconnect,
  buildJourneyEnv,
  buildLiveJourneyPayload,
  claudeTrustedIntakePrompt,
  collectCodexAgentMessages,
  findIntakeReceipt,
  findLiveCards,
  helpText,
  isDistStale,
  parseArgs,
  parseCodexThreadId,
  realpathAsFarAsPossible,
  requestClaudePluginIsolationConfirmation,
  requestClaudeModelIntakeArmingConfirmation,
  shouldRemoveWorkingDirectories,
} from '../../scripts/qa/live-journey.mjs';
import {
  CLAUDE_PLUGIN_ISOLATION_CONFIRMATION,
  LIVE_JOURNEY_SCHEMA_VERSION,
  REQUIRED_LIVE_JOURNEY_STEPS,
  REQUIRED_REGISTRATION_EVIDENCE,
} from '../../scripts/lib/live-journey-contract.mjs';

const THREAD = '01a05ead-98e8-7091-a770-81f7339d3b29';
const MESSAGE_ID = 'b234ba88-fe4b-4f75-98b2-259c17097f41';
const DELIVERY_ID = '92f1bda2-5bd9-4da3-86f6-f083253a7ed1';
const SENTINEL = 'codex-4f19ab27';

/** `codex exec --json` output, in the shape a real turn emits it. */
function codexTurn(
  messages: string[],
  options: { threadId?: string; extraItems?: Record<string, unknown>[] } = {},
): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: options.threadId ?? THREAD }),
    JSON.stringify({ type: 'turn.started' }),
    ...messages.map((text, index) => JSON.stringify({
      type: 'item.completed',
      item: { id: `item_${index}`, type: 'agent_message', text },
    })),
    ...(options.extraItems ?? []).map((item) => JSON.stringify({ type: 'item.completed', item })),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    '',
  ].join('\n');
}

const GOOD_REPLY = codexTurn([
  'Acknowledged. No action taken.',
  `CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`,
]);

const ACCEPTED_SEND = {
  message_id: MESSAGE_ID,
  delivery_id: DELIVERY_ID,
  project: 'memesh-live-journey',
  sender: 'memesh-live-journey-harness',
  recipient: THREAD,
  target_kind: 'session',
  native_delivery: {
    status: 'native_accepted',
    delivery_id: DELIVERY_ID,
    adapter_kind: 'codex-cli-queue',
    receipt: { host: 'codex-cli', status: 'queued', thread_id: THREAD },
    accepted_at: '2026-09-01 20:34:52',
  },
};

/** A `message receipts` projection: host_accept present, intake present. */
const RECEIPTS_WITH_INTAKE = [
  {
    fact_source: 'agent_host_accept',
    receipt_kind: 'host_accept',
    message_id: MESSAGE_ID,
    recipient: THREAD,
    actor: 'claude-channel',
    created_at: '2026-09-01 20:48:48',
  },
  {
    fact_source: 'agent_message_receipt',
    receipt_id: '2aef2959-ac4e-4040-9820-c84f9b33dec7',
    receipt_kind: 'intake',
    intake_state: 'ingested',
    message_id: MESSAGE_ID,
    recipient: THREAD,
    actor: THREAD,
    created_at: '2026-09-01 20:50:13',
  },
];

/** The same projection with the model's own intake missing — host_accept only. */
const RECEIPTS_WITHOUT_INTAKE = [RECEIPTS_WITH_INTAKE[0]];

describe('parseArgs', () => {
  it('accepts the bounded automatic Codex registration mode without a host', () => {
    expect(parseArgs(['--codex-session-auto-registration'])).toMatchObject({
      host: null,
      mode: 'codex-session-auto-registration',
    });
  });

  it('accepts each supported host', () => {
    expect(parseArgs(['--host', 'codex', '--codex-home', '/private/tmp/codex-home']).host).toBe('codex');
    expect(parseArgs(['--host', 'claude']).host).toBe('claude');
  });

  it('defaults out/keep/wait-ms', () => {
    const parsed = parseArgs(['--host', 'codex', '--codex-home', '/private/tmp/codex-home']);
    expect(parsed.out).toBeNull();
    expect(parsed.keep).toBe(false);
    expect(parsed.waitMs).toBe(DEFAULT_WAIT_MS);
  });

  it('reads --out, --keep and --wait-ms', () => {
    const parsed = parseArgs(['--host', 'claude', '--out', 'report.json', '--keep', '--wait-ms', '30000']);
    expect(parsed).toMatchObject({ host: 'claude', out: 'report.json', keep: true, waitMs: 30_000 });
  });

  it('requires an isolated Codex home instead of falling back to the owner configuration', () => {
    expect(() => parseArgs(['--host', 'codex'])).toThrow(/requires --codex-home/);
    expect(() => parseArgs(['--host', 'claude', '--codex-home', '/private/tmp/codex-home']))
      .toThrow(/only with --host codex/);
  });

  it('requires a host', () => {
    expect(() => parseArgs([])).toThrow(/--host is required.*codex-session-auto-registration/);
  });

  it('rejects combining automatic registration with a host mode', () => {
    expect(() => parseArgs(['--codex-session-auto-registration', '--host', 'codex', '--codex-home', '/private/tmp/codex-home']))
      .toThrow(/cannot be combined with --host/);
  });

  it('rejects an unsupported host rather than guessing one', () => {
    expect(() => parseArgs(['--host', 'gemini'])).toThrow(/must be codex or claude/);
  });

  it('rejects unknown arguments instead of ignoring them', () => {
    expect(() => parseArgs(['--host', 'codex', '--print'])).toThrow(/Unknown argument --print/);
  });

  it('rejects a flag whose value is missing', () => {
    expect(() => parseArgs(['--host'])).toThrow(/--host requires a value/);
    expect(() => parseArgs(['--host', 'codex', '--out', '--keep'])).toThrow(/--out requires a value/);
  });

  it('bounds --wait-ms', () => {
    expect(() => parseArgs(['--host', 'codex', '--wait-ms', '10'])).toThrow(/between 1000 and 3600000/);
    expect(() => parseArgs(['--host', 'codex', '--wait-ms', 'soon'])).toThrow(/between 1000 and 3600000/);
  });

  it('does not demand a host when only --help was asked for', () => {
    expect(parseArgs(['--help'])).toMatchObject({ help: true, host: null });
  });
});

describe('--help', () => {
  it('says print mode is unsupported and names the issue', () => {
    const text = helpText();
    expect(text).toMatch(/claude -p/);
    expect(text).toMatch(/NOT supported/);
    expect(text).toMatch(/issue #275/);
  });

  it('documents the isolated installed-plugin Codex registration', () => {
    expect(helpText()).toMatch(/--codex-home/);
    expect(helpText()).toMatch(/never starts the companion itself/);
  });

  it('documents the bounded automatic-registration invocation', () => {
    expect(helpText()).toMatch(/npm run qa:live-journey -- --codex-session-auto-registration/);
    expect(helpText()).toMatch(/fresh HOME.*fake `codex queue`/);
  });

  it('pins router socket and token state inside the task-owned journey directory', () => {
    const env = buildJourneyEnv({
      MEMESH_ROUTER_SOCKET: '/owner/router.sock',
      MEMESH_ROUTER_TOKEN_FILE: '/owner/router.token',
    }, {
      memeshDir: '/task/memesh',
      dbPath: '/task/memesh/knowledge-graph.db',
      socketPath: '/task/memesh/agent-router-v2.sock',
    });
    expect(env.MEMESH_ROUTER_SOCKET).toBe('/task/memesh/agent-router-v2.sock');
    expect(env.MEMESH_ROUTER_TOKEN_FILE).toBe('/task/memesh/agent-router.token');
  });

  it('warns that the launched Claude session is outside the isolation', () => {
    const text = helpText();
    expect(text).toMatch(/OUTSIDE the temporary-directory isolation/);
    expect(text).toMatch(/would write the REAL ~\/\.memesh/);
    expect(text).toMatch(/\/hooks and \/mcp/);
    expect(text).toContain(CLAUDE_PLUGIN_ISOLATION_CONFIRMATION);
    expect(text).toMatch(/operator attestation, not programmatic inspection/i);
    expect(text).toMatch(/before the nonce is generated or sent/i);
  });

  it('names the invocation that was actually verified', () => {
    expect(helpText()).toMatch(/TMPDIR=\/private\/tmp npm run qa:live-journey/);
  });
});

describe('Claude plugin-isolation confirmation', () => {
  it('accepts only the exact token and labels the result as operator attestation', () => {
    expect(assertClaudePluginIsolationConfirmation(CLAUDE_PLUGIN_ISOLATION_CONFIRMATION)).toEqual({
      kind: 'operator_attestation',
      scope: 'installed MeMesh plugin hooks and MCP servers only',
      confirmed: true,
      programmatic_inspection: false,
    });
  });

  it.each([
    null,
    '',
    'NO',
    ` ${CLAUDE_PLUGIN_ISOLATION_CONFIRMATION}`,
    `${CLAUDE_PLUGIN_ISOLATION_CONFIRMATION} `,
    'MEMESH_PLUGIN_ISOLATION_CONFIRM',
  ])('rejects non-exact confirmation %j before nonce send', value => {
    expect(() => assertClaudePluginIsolationConfirmation(value)).toThrow(/nonce was not generated or sent/);
  });

  it('fails closed when the operator input ends', async () => {
    await expect(requestClaudePluginIsolationConfirmation(async () => {
      throw new Error('EOF');
    })).rejects.toThrow(/ended before input.*nonce was not generated or sent/);
  });
});

describe('Claude trusted intake arming', () => {
  it('keeps the native payload inert and free of instructions', () => {
    expect(buildLiveJourneyPayload('claude-deadbeef')).toEqual({
      purpose: 'MeMesh owner-run live journey check',
      qa_sentinel: 'claude-deadbeef',
    });
  });

  it('gives the model a trusted operator instruction before native delivery', () => {
    const prompt = claudeTrustedIntakePrompt();
    expect(prompt).toMatch(/next memesh-channel message/i);
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toMatch(/action [`"]?intake/i);
    expect(prompt).toMatch(/idempotency_key.*intake-.*exact message_id/i);
    expect(prompt).toMatch(/only these six fields/i);
    expect(prompt).toMatch(/do not pass target_kind, sender, payload/i);
    expect(prompt).toMatch(/run no other tools/i);
  });

  it('accepts only the exact arming token and labels it as operator attestation', () => {
    expect(assertClaudeModelIntakeArmingConfirmation('MEMESH_MODEL_INTAKE_ARMED')).toEqual({
      kind: 'operator_attestation',
      scope: 'trusted Claude intake prompt submitted before nonce delivery',
      confirmed: true,
      programmatic_inspection: false,
    });
  });

  it.each([null, '', 'NO', ' MEMESH_MODEL_INTAKE_ARMED', 'MEMESH_MODEL_INTAKE_ARMED '])(
    'rejects non-exact arming confirmation %j before nonce send',
    value => {
      expect(() => assertClaudeModelIntakeArmingConfirmation(value)).toThrow(/nonce was not generated or sent/);
    },
  );

  it('fails closed when arming confirmation ends', async () => {
    await expect(requestClaudeModelIntakeArmingConfirmation(async () => {
      throw new Error('EOF');
    })).rejects.toThrow(/ended before input.*nonce was not generated or sent/);
  });
});

describe('live-journey report contract', () => {
  it('uses v3 and requires distinct model-visible and stopped-session steps for both real hosts', () => {
    expect(LIVE_JOURNEY_SCHEMA_VERSION).toBe('memesh-live-journey/v3');
    for (const host of ['codex', 'claude'] as const) {
      expect(REQUIRED_LIVE_JOURNEY_STEPS[host].some(name => name.includes('model-visible'))).toBe(true);
      expect(REQUIRED_LIVE_JOURNEY_STEPS[host]).toContain(
        'a send to the stopped session fails closed and the durable row survives',
      );
    }
    expect(REQUIRED_REGISTRATION_EVIDENCE.codex).toEqual({
      source: 'codex_plugin_session_start',
      plugin_loader_verified: true,
    });
    expect(REQUIRED_REGISTRATION_EVIDENCE.claude).toEqual({
      source: 'interactive_development_channel',
      operator_attestation_recorded: true,
      trusted_instruction_attested: true,
    });
    expect(REQUIRED_LIVE_JOURNEY_STEPS.codex).toContain('Codex lease renewed before expiry');
    expect(REQUIRED_LIVE_JOURNEY_STEPS.codex).toContain(
      'Codex resume registration superseded the prior generation',
    );
    expect(REQUIRED_LIVE_JOURNEY_STEPS.codex).toContain('Codex resumed lease renewed before expiry');
    expect(REQUIRED_LIVE_JOURNEY_STEPS.claude).toContain('Claude lease renewed before expiry');
    expect(REQUIRED_LIVE_JOURNEY_STEPS.claude).toContain(
      'operator attested that the trusted intake prompt was submitted and READY observed',
    );
    expect(REQUIRED_REGISTRATION_EVIDENCE.claude).toMatchObject({
      trusted_instruction_attested: true,
    });
  });
});

// POSIX path literals below: on Windows `path.resolve('/Users/example')` gains a
// drive letter and never matches the fixture, and `/tmp` does not exist. The
// runtime under test is macOS/Linux only, so this follows the repo's idiom.
describe.skipIf(process.platform === 'win32')('assertOutsideOwnerMemesh', () => {
  const home = '/Users/example';
  const identity = (candidate: string) => candidate;

  it('allows a temporary directory outside the owner’s memesh directory', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: {
        MEMESH_DIR: '/private/tmp/memesh-lj-abc/memesh',
        MEMESH_DB_PATH: '/private/tmp/memesh-lj-abc/memesh/knowledge-graph.db',
      },
      home,
      realpath: identity,
    })).not.toThrow();
  });

  it('refuses when MEMESH_DIR is the owner’s memesh directory', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: { MEMESH_DIR: `${home}/.memesh` },
      home,
      realpath: identity,
    })).toThrow(/Refusing to run: MEMESH_DIR/);
  });

  it('refuses when MEMESH_DB_PATH sits under the owner’s memesh directory', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: { MEMESH_DB_PATH: `${home}/.memesh/knowledge-graph.db` },
      home,
      realpath: identity,
    })).toThrow(/Refusing to run: MEMESH_DB_PATH/);
  });

  it('refuses a SYMLINKED temp root that really lands in ~/.memesh', () => {
    // The case a resolve-only prefix test cannot see: the literal path is
    // outside, the real path is inside, and deleting it would destroy memory.
    const realpath = (candidate: string) => (
      candidate.startsWith('/private/tmp/looks-safe')
        ? candidate.replace('/private/tmp/looks-safe', `${home}/.memesh/hidden`)
        : candidate
    );
    expect(() => assertOutsideOwnerMemesh({
      candidates: { TMPDIR: '/private/tmp/looks-safe' },
      home,
      realpath,
    })).toThrow(/Refusing to run: TMPDIR/);
  });

  it('does not confuse a sibling directory with a prefix match', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: { MEMESH_DIR: `${home}/.memesh-scratch/memesh` },
      home,
      realpath: identity,
    })).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('realpathAsFarAsPossible', () => {
  it('resolves an existing directory', () => {
    expect(realpathAsFarAsPossible('/tmp')).toBe(fs.realpathSync('/tmp'));
  });

  it('resolves the existing ancestor of a path that does not exist yet', () => {
    const resolved = realpathAsFarAsPossible('/tmp/memesh-lj-does-not-exist-yet/memesh');
    expect(resolved).toBe(path.join(fs.realpathSync('/tmp'), 'memesh-lj-does-not-exist-yet', 'memesh'));
  });
});

describe('assertSupportedPlatform', () => {
  it('refuses on Windows, naming the documented boundary', () => {
    expect(() => assertSupportedPlatform('win32')).toThrow(/macOS\/Linux only/);
  });

  it('allows the platforms the host-native runtime supports', () => {
    expect(() => assertSupportedPlatform('darwin')).not.toThrow();
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });
});

describe('assertNotCi', () => {
  it('allows an ordinary owner shell', () => {
    expect(() => assertNotCi({})).not.toThrow();
    expect(() => assertNotCi({ CI: '' })).not.toThrow();
    expect(() => assertNotCi({ CI: 'false' })).not.toThrow();
  });

  it('refuses under CI, where neither host can exist', () => {
    expect(() => assertNotCi({ CI: 'true' })).toThrow(/Refusing to run: CI is set/);
    expect(() => assertNotCi({ CI: '1' })).toThrow(/Refusing to run: CI is set/);
  });
});

describe('assertSocketPathFits', () => {
  it('accepts a short temporary root', () => {
    expect(() => assertSocketPathFits('/private/tmp/memesh-lj-abc123/memesh/agent-router-v2.sock')).not.toThrow();
  });

  it('refuses a path over the AF_UNIX limit and names the fix', () => {
    const tooLong = `/private/tmp/${'d'.repeat(MAX_SOCKET_PATH_BYTES)}/memesh/agent-router-v2.sock`;
    expect(() => assertSocketPathFits(tooLong)).toThrow(/TMPDIR=\/private\/tmp/);
  });

  it('measures bytes, not characters', () => {
    // 61 characters — comfortably under the limit — but 121 UTF-8 bytes, which
    // is what the kernel counts. A `.length` check would pass this.
    const twoByteChars = `/${'é'.repeat(60)}`;
    expect(twoByteChars.length).toBeLessThan(MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(twoByteChars, 'utf8')).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    expect(() => assertSocketPathFits(twoByteChars)).toThrow(/AF_UNIX limit/);
  });
});

describe('isDistStale', () => {
  it('is stale when any dist artefact predates the newest source file', () => {
    expect(isDistStale({ newestSrcMs: 2_000, oldestDistMs: 1_000 })).toBe(true);
  });

  it('is fresh when every dist artefact is at least as new as the newest source', () => {
    expect(isDistStale({ newestSrcMs: 1_000, oldestDistMs: 1_000 })).toBe(false);
    expect(isDistStale({ newestSrcMs: 1_000, oldestDistMs: 2_000 })).toBe(false);
  });
});

describe('assertDistPresent', () => {
  it('names every missing artefact rather than the first one', () => {
    expect(() => assertDistPresent('/repo', () => false))
      .toThrow(/router\.js.*cli\.js.*codex-session\.js/s);
  });

  it('passes when every required artefact exists', () => {
    expect(() => assertDistPresent('/repo', () => true)).not.toThrow();
    expect(REQUIRED_DIST).toContain('dist/host-runtime/router.js');
  });
});

describe('parseCodexThreadId', () => {
  it('reads the thread id Codex printed', () => {
    expect(parseCodexThreadId(GOOD_REPLY)).toBe(THREAD);
  });

  it('fails closed when Codex started no thread', () => {
    expect(() => parseCodexThreadId('{"type":"turn.completed"}\n')).toThrow(/no `thread.started` event/);
  });

  it('ignores non-JSON noise interleaved on the stream', () => {
    expect(parseCodexThreadId(`warning: something\n${GOOD_REPLY}`)).toBe(THREAD);
  });
});

describe('collectCodexAgentMessages', () => {
  it('collects every agent message in the turn, not just the last', () => {
    expect(collectCodexAgentMessages(GOOD_REPLY)).toEqual([
      'Acknowledged. No action taken.',
      `CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`,
    ]);
  });

  it('ignores non-agent-message items such as command executions', () => {
    const withCommand = [
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', command: 'ls', exit_code: 0 },
      }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'READY' } }),
    ].join('\n');
    expect(collectCodexAgentMessages(withCommand)).toEqual(['READY']);
  });
});

describe('assertCodexReply', () => {
  const expected = { sentinel: SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID };

  it('accepts a reply quoting the sentinel and both ids', () => {
    expect(assertCodexReply({ jsonl: GOOD_REPLY, ...expected }))
      .toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('rejects a reply carrying the WRONG message_id', () => {
    const wrong = codexTurn([`CODEX_RECEIVED_${SENTINEL} 00000000-0000-4000-8000-000000000000 ${DELIVERY_ID}`]);
    expect(() => assertCodexReply({ jsonl: wrong, ...expected }))
      .toThrow(/does not quote message_id b234ba88/);
  });

  it('rejects a reply with the sentinel but no ids at all', () => {
    expect(() => assertCodexReply({ jsonl: codexTurn([`CODEX_RECEIVED_${SENTINEL}`]), ...expected }))
      .toThrow(/does not quote message_id/);
  });

  it('rejects a reply carrying the wrong delivery_id', () => {
    const wrong = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} 11111111-1111-4111-8111-111111111111`]);
    expect(() => assertCodexReply({ jsonl: wrong, ...expected }))
      .toThrow(/does not quote delivery_id/);
  });

  it('rejects an otherwise-perfect reply from a turn that ran a command', () => {
    const withCommand = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
      extraItems: [{ id: 'item_9', type: 'command_execution', command: 'cat turn1.jsonl', exit_code: 0 }],
    });
    expect(() => assertCodexReply({ jsonl: withCommand, ...expected }))
      .toThrow(/non-answer items \(item:command_execution\)/);
  });

  it('allows only the installed plugin skill auto-load when it contains none of the proof values', () => {
    const skill = '/tmp/plugin/skills/memesh/SKILL.md';
    const withSkillLoad = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
      extraItems: [{ id: 'item_9', type: 'command_execution', command: `cat ${skill}`, aggregated_output: 'skill text', exit_code: 0 }],
    });
    expect(assertCodexReply({ jsonl: withSkillLoad, ...expected, allowedSkillPath: skill }))
      .toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('rejects a skill auto-load whose output contains a proof identifier', () => {
    const skill = '/tmp/plugin/skills/memesh/SKILL.md';
    const leaking = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
      extraItems: [{ id: 'item_9', type: 'command_execution', command: `cat ${skill}`, aggregated_output: MESSAGE_ID, exit_code: 0 }],
    });
    expect(() => assertCodexReply({ jsonl: leaking, ...expected, allowedSkillPath: skill }))
      .toThrow(/non-answer items/);
  });

  it('allows only the failed automatic work-package probe when it contains no proof identifier', () => {
    const project = 'memesh-live-journey~scope';
    const withProbe = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
      extraItems: [{
        id: 'item_9', type: 'mcp_tool_call', server: 'memesh', tool: 'work_package', status: 'failed',
        arguments: { action: 'prepare', kind: 'digest', project },
      }],
    });
    expect(assertCodexReply({ jsonl: withProbe, ...expected, allowedProject: project }))
      .toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('rejects NO_ENVELOPE with the reason, not a generic mismatch', () => {
    expect(() => assertCodexReply({ jsonl: codexTurn(['NO_ENVELOPE']), ...expected }))
      .toThrow(/not visible to the model/);
  });

  it('rejects a turn that produced no agent message', () => {
    expect(() => assertCodexReply({ jsonl: '{"type":"turn.completed"}', ...expected }))
      .toThrow(/no agent message/);
  });
});

describe('assertCodexRanNoCommands', () => {
  it('accepts a turn that only answered', () => {
    expect(() => assertCodexRanNoCommands(GOOD_REPLY)).not.toThrow();
  });

  it('tolerates Codex’s own error notices, which are not model actions', () => {
    const withNotice = codexTurn(['READY'], {
      extraItems: [{ id: 'item_9', type: 'error', message: 'Skill descriptions were shortened.' }],
    });
    expect(() => assertCodexRanNoCommands(withNotice)).not.toThrow();
  });

  it('REJECTS a turn that ran a command — the model could have read the ids off disk', () => {
    const withCommand = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
      extraItems: [{
        id: 'item_9',
        type: 'command_execution',
        command: '/bin/zsh -lc \'cat ../memesh/knowledge-graph.db\'',
        exit_code: 0,
      }],
    });
    expect(() => assertCodexRanNoCommands(withCommand)).toThrow(/command_execution/);
  });

  it('rejects an unrecognised item type rather than assuming it is harmless', () => {
    const withTool = codexTurn(['ok'], { extraItems: [{ id: 'item_9', type: 'mcp_tool_call', name: 'read_file' }] });
    expect(() => assertCodexRanNoCommands(withTool)).toThrow(/mcp_tool_call/);
  });

  it('tolerates a reasoning item — thinking is not a model action', () => {
    const withReasoning = codexTurn(['ok'], { extraItems: [{ id: 'item_9', type: 'reasoning', text: 'considering' }] });
    expect(() => assertCodexRanNoCommands(withReasoning)).not.toThrow();
  });

  it('rejects an unrecognised EVENT type, not only an unrecognised item type', () => {
    // A native tool surfaced under some event other than item.* must not slip
    // past an item-only scan.
    const withForeignEvent = `${GOOD_REPLY}\n${JSON.stringify({ type: 'tool.call', name: 'read_file', path: '../memesh/knowledge-graph.db' })}`;
    expect(() => assertCodexRanNoCommands(withForeignEvent)).toThrow(/event:tool\.call/);
  });

  it('rejects a command that only STARTED (item.started) even if it never completed', () => {
    const withStartedCommand = `${GOOD_REPLY}\n${JSON.stringify({ type: 'item.started', item: { id: 'item_9', type: 'command_execution', command: 'cat x' } })}`;
    expect(() => assertCodexRanNoCommands(withStartedCommand)).toThrow(/item:command_execution/);
  });
});

describe('assertNativeAccepted', () => {
  it('accepts a send whose exact session took the frame', () => {
    expect(assertNativeAccepted(ACCEPTED_SEND, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toMatchObject({ messageId: MESSAGE_ID, deliveryId: DELIVERY_ID });
  });

  it('rejects a durable send with NO native_delivery block', () => {
    const { native_delivery: _dropped, ...durableOnly } = ACCEPTED_SEND;
    expect(() => assertNativeAccepted(durableOnly, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/no native_delivery block/);
  });

  it('rejects a send whose native delivery was not accepted', () => {
    const unavailable = {
      ...ACCEPTED_SEND,
      native_delivery: { ...ACCEPTED_SEND.native_delivery, status: 'recipient_unavailable' },
    };
    expect(() => assertNativeAccepted(unavailable, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/not "native_accepted"/);
  });

  it('rejects acceptance by the wrong adapter', () => {
    expect(() => assertNativeAccepted(ACCEPTED_SEND, { adapterKind: 'claude-channel', recipient: THREAD }))
      .toThrow(/adapter_kind is "codex-cli-queue"/);
  });

  it('rejects an acceptance whose delivery_id belongs to a different delivery', () => {
    const mismatched = {
      ...ACCEPTED_SEND,
      native_delivery: { ...ACCEPTED_SEND.native_delivery, delivery_id: 'ffffffff-0000-4000-8000-000000000000' },
    };
    expect(() => assertNativeAccepted(mismatched, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/describes a different delivery/);
  });

  it('rejects a host receipt naming a different thread', () => {
    const wrongThread = {
      ...ACCEPTED_SEND,
      native_delivery: {
        ...ACCEPTED_SEND.native_delivery,
        receipt: { ...ACCEPTED_SEND.native_delivery.receipt, thread_id: 'ffffffff-0000-4000-8000-000000000000' },
      },
    };
    expect(() => assertNativeAccepted(wrongThread, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/not the session we addressed/);
  });

  it('rejects a send whose recipient is not the session we addressed', () => {
    expect(() => assertNativeAccepted(ACCEPTED_SEND, { adapterKind: 'codex-cli-queue', recipient: 'someone-else' }))
      .toThrow(/reports recipient/);
  });

  it('rejects a result that is not an object', () => {
    expect(() => assertNativeAccepted('ok', { adapterKind: 'codex-cli-queue', recipient: THREAD })).toThrow(/no JSON object/);
  });
});

describe('assertRecipientUnavailable', () => {
  it('accepts a non-zero exit naming recipient_unavailable', () => {
    expect(() => assertRecipientUnavailable({
      status: 1,
      stderr: 'Error: recipient_unavailable: the exact active session did not accept the native message.\n',
    })).not.toThrow();
  });

  it('rejects a send to a stopped session that SUCCEEDED', () => {
    expect(() => assertRecipientUnavailable({ status: 0, stderr: '' }))
      .toThrow(/did not fail closed/);
  });

  it('rejects a KILLED send process — no exit status is not a decision', () => {
    expect(() => assertRecipientUnavailable({ status: null, stderr: 'recipient_unavailable' }))
      .toThrow(/killed before it produced an exit status/);
  });

  it('rejects a different failure wearing a non-zero exit code', () => {
    expect(() => assertRecipientUnavailable({ status: 1, stderr: 'Error: native_message_too_large' }))
      .toThrow(/Expected recipient_unavailable/);
  });
});

describe('assertHostAcceptOnly', () => {
  const expected = {
    messageId: MESSAGE_ID,
    deliveryId: DELIVERY_ID,
    adapterKind: 'codex-cli-queue',
    recipient: THREAD,
  };
  const receipts = [{
    receipt_kind: 'host_accept',
    message_id: MESSAGE_ID,
    recipient: THREAD,
    delivery_id: DELIVERY_ID,
    host_accept_id: 'host-accept-1',
    adapter_kind: 'codex-cli-queue',
  }];

  it('accepts durable host_accept readback without lifecycle receipts', () => {
    expect(assertHostAcceptOnly(receipts, expected)).toMatchObject({
      receipt_kind: 'host_accept',
      delivery_id: DELIVERY_ID,
    });
  });

  it('rejects a send response-shaped input without durable readback', () => {
    expect(() => assertHostAcceptOnly(ACCEPTED_SEND, expected)).toThrow(/JSON array/);
  });

  it('rejects host_accept readback with an ACK or disposition', () => {
    expect(() => assertHostAcceptOnly([
      ...receipts,
      { receipt_kind: 'ack', message_id: MESSAGE_ID },
    ], expected)).toThrow(/ACK or disposition/);
    expect(() => assertHostAcceptOnly([
      ...receipts,
      { receipt_kind: 'disposition', message_id: MESSAGE_ID },
    ], expected)).toThrow(/ACK or disposition/);
  });

  it('rejects a durable host_accept for a different delivery or adapter', () => {
    expect(() => assertHostAcceptOnly([
      { ...receipts[0], delivery_id: 'other-delivery' },
    ], expected)).toThrow(/names delivery/);
    expect(() => assertHostAcceptOnly([
      { ...receipts[0], adapter_kind: 'claude-channel' },
    ], expected)).toThrow(/names adapter/);
  });
});

describe('assertNoHostOutcomeReceipts', () => {
  it('accepts a durable failed-send projection with no host or model outcome', () => {
    expect(assertNoHostOutcomeReceipts([
      { receipt_kind: 'intake', message_id: MESSAGE_ID },
    ], { messageId: MESSAGE_ID })).toHaveLength(1);
  });

  it('rejects host_accept, ACK, and disposition facts', () => {
    for (const receipt_kind of ['host_accept', 'ack', 'disposition']) {
      expect(() => assertNoHostOutcomeReceipts([
        { receipt_kind, message_id: MESSAGE_ID },
      ], { messageId: MESSAGE_ID })).toThrow(/no host_accept, ACK, or disposition/);
    }
  });

  it('ignores receipts belonging to another message', () => {
    expect(assertNoHostOutcomeReceipts([
      { receipt_kind: 'host_accept', message_id: 'other-message' },
    ], { messageId: MESSAGE_ID })).toEqual([]);
  });
});

describe('assertExactCodexQueueRouting', () => {
  const messages = [
    { sessionId: 'thread-a', messageId: 'message-a', deliveryId: 'delivery-a', project: 'project', sender: 'sender-a', contentType: 'application/json', payload: { qa_sentinel: 'sentinel-a' } },
    { sessionId: 'thread-b', messageId: 'message-b', deliveryId: 'delivery-b', project: 'project', sender: 'sender-b', contentType: 'application/json', payload: { qa_sentinel: 'sentinel-b' } },
  ];
  const invocation = (message: (typeof messages)[number]) => ({
    thread_id: message.sessionId,
    serialized_message: JSON.stringify({
      message_type: 'memesh_message',
      delivery_id: message.deliveryId,
      envelope: {
        message_id: message.messageId,
        project: message.project,
        sender: message.sender,
        recipient: message.sessionId,
        target_kind: 'session',
        content_type: message.contentType,
        payload: message.payload,
      },
    }),
  });

  it('accepts exactly one matching native envelope for each exact-session send', () => {
    expect(assertExactCodexQueueRouting(messages.map(invocation), messages)).toHaveLength(2);
  });

  it('rejects extra, duplicate, or crossed queue delivery', () => {
    expect(() => assertExactCodexQueueRouting([
      ...messages.map(invocation), invocation(messages[0]),
    ], messages)).toThrow(/3 invocations for 2 sends/);
    expect(() => assertExactCodexQueueRouting([
      invocation(messages[0]), invocation(messages[0]),
    ], messages)).toThrow(/2 invocations for thread-a/);
    expect(() => assertExactCodexQueueRouting([
      invocation(messages[0]),
      { ...invocation(messages[1]), thread_id: 'thread-b', serialized_message: invocation(messages[0]).serialized_message },
    ], messages)).toThrow(/crossed exact-session boundaries/);
  });

  it('rejects a native envelope whose private payload differs despite matching ids', () => {
    const wrongPayload = invocation(messages[0]);
    const serialized = JSON.parse(wrongPayload.serialized_message);
    serialized.envelope.payload = { qa_sentinel: 'wrong' };
    wrongPayload.serialized_message = JSON.stringify(serialized);
    expect(() => assertExactCodexQueueRouting([
      wrongPayload, invocation(messages[1]),
    ], messages)).toThrow(/crossed exact-session boundaries/);
  });
});

describe('MCP message readback and access denial', () => {
  const expected = {
    messageId: MESSAGE_ID,
    project: 'memesh-live-journey',
    sender: 'codex-thread-a',
    recipient: THREAD,
    contentType: 'application/json',
    payload: { qa_sentinel: SENTINEL, body: 'unpredictable payload' },
  };
  const fetched = {
    message_id: expected.messageId,
    project: expected.project,
    sender: expected.sender,
    recipient: expected.recipient,
    target_kind: 'session',
    content_type: expected.contentType,
    payload: expected.payload,
  };

  it('accepts only an exact project, recipient, content type, and payload readback', () => {
    expect(assertMcpFetchedMessage(fetched, expected)).toMatchObject(fetched);
  });

  it('rejects matching ids with the wrong project, recipient, or payload', () => {
    expect(() => assertMcpFetchedMessage({ ...fetched, project: 'wrong' }, expected)).toThrow(/scope.*payload-mismatched/);
    expect(() => assertMcpFetchedMessage({ ...fetched, recipient: 'wrong' }, expected)).toThrow(/scope.*payload-mismatched/);
    expect(() => assertMcpFetchedMessage({ ...fetched, payload: { qa_sentinel: 'wrong' } }, expected)).toThrow(/scope.*payload-mismatched/);
  });

  it('requires explicit MCP failure without echoing the private sentinel', () => {
    const denied = { isError: true, content: [{ type: 'text', text: 'Agent message is not available.' }] };
    expect(assertMcpDenied(denied, { label: 'wrong scope', error: /not available/, sentinel: SENTINEL }))
      .toContain('not available');
    expect(() => assertMcpDenied({ ...denied, isError: false }, {
      label: 'wrong scope', error: /not available/, sentinel: SENTINEL,
    })).toThrow(/did not fail/);
    expect(() => assertMcpDenied({
      isError: true, content: [{ type: 'text', text: `not available: ${SENTINEL}` }],
    }, { label: 'wrong scope', error: /not available/, sentinel: SENTINEL })).toThrow(/leaked/);
    expect(() => assertMcpDenied({
      isError: true,
      content: [{ type: 'text', text: 'not available' }],
      structuredContent: { payload: { qa_sentinel: SENTINEL } },
    }, { label: 'wrong scope', error: /not available/, sentinel: SENTINEL })).toThrow(/leaked/);
  });
});

describe('assertMcpDiscoverCards', () => {
  const expected = [
    { session_id: 'thread-a', principal_id: 'codex-thread-thread-a', project: 'memesh-live-journey' },
    { session_id: 'thread-b', principal_id: 'codex-thread-thread-b', project: 'memesh-live-journey' },
  ];

  it('accepts the exact pair of thread-scoped Codex cards', () => {
    expect(assertMcpDiscoverCards({ cards: expected.map((card) => ({ ...card, host_kind: 'codex' })) }, expected))
      .toHaveLength(2);
  });

  it('rejects missing or identity-mismatched cards', () => {
    expect(() => assertMcpDiscoverCards({ cards: [expected[0]] }, expected)).toThrow(/expected exactly 2/);
    expect(() => assertMcpDiscoverCards({
      cards: expected.map((card, index) => ({ ...card, host_kind: 'codex', ...(index === 1 ? { principal_id: 'wrong' } : {}) })),
    }, expected)).toThrow(/identity-mismatched/);
    expect(() => assertMcpDiscoverCards({
      cards: [{ ...expected[0], host_kind: 'codex' }, { ...expected[0], host_kind: 'codex' }],
    }, expected)).toThrow(/identity-mismatched/);
  });
});

describe('ordinary MCP registration boundary', () => {
  it('accepts only a discover result with zero live registrations', () => {
    expect(assertNoLiveRegistrations({ cards: [] })).toEqual([]);
    expect(() => assertNoLiveRegistrations({ cards: [{ host_kind: 'codex' }] }))
      .toThrow(/MCP-only control created or observed 1 live registrations/);
    expect(() => assertNoLiveRegistrations({})).toThrow(/invalid number/);
  });

  it('rejects a SessionStart companion that exited before registration readback', () => {
    expect(() => assertCompanionRunning({ exitCode: null, signalCode: null }, 'companion')).not.toThrow();
    expect(() => assertCompanionRunning({ exitCode: 0, signalCode: null }, 'companion'))
      .toThrow(/exited before its live registration was verified/);
    expect(() => assertCompanionRunning({ exitCode: null, signalCode: 'SIGTERM' }, 'companion'))
      .toThrow(/exited before its live registration was verified/);
  });
});

describe('installed Codex plugin lifecycle proof', () => {
  const startupCard = {
    session_id: THREAD,
    principal_id: `codex-thread-${THREAD}`,
    host_kind: 'codex',
    generation: 1,
  };
  const complete = (): Parameters<typeof assertInstalledCodexPluginJourney>[0] => ({
    isolatedCodexHome: true,
    candidatePluginInstalled: true,
    candidateCacheVerified: true,
    hookTrustBypass: true,
    runnerStartedCompanion: false,
    startupLeaseRenewed: true,
    resumeLeaseRenewed: true,
    threadId: THREAD,
    startupCard,
    resumedCard: { ...startupCard, generation: 2 },
  });

  it('accepts a candidate-installed, plugin-loaded startup followed by a real resume supersession', () => {
    expect(assertInstalledCodexPluginJourney(complete())).toMatchObject({
      startup: startupCard,
      resumed: { generation: 2 },
    });
  });

  it('rejects a hook-trust flag by itself', () => {
    const evidence = complete();
    evidence.candidatePluginInstalled = false;
    evidence.candidateCacheVerified = false;
    expect(() => assertInstalledCodexPluginJourney(evidence)).toThrow(/hook flags alone are not proof/);
  });

  it('rejects a fake or unverified candidate cache', () => {
    const evidence = complete();
    evidence.candidateCacheVerified = false;
    expect(() => assertInstalledCodexPluginJourney(evidence)).toThrow(/candidate plugin installation and cache identity/);
  });

  it('rejects a runner that manually started the companion', () => {
    const evidence = complete();
    evidence.runnerStartedCompanion = true;
    expect(() => assertInstalledCodexPluginJourney(evidence)).toThrow(/manually started a companion/);
  });

  it('rejects an absent exact-thread registration', () => {
    const evidence = complete();
    evidence.startupCard = null;
    expect(() => assertInstalledCodexPluginJourney(evidence)).toThrow(/registration was not observed/);
  });

  it('rejects a resume that does not increment exactly one generation', () => {
    const evidence = complete();
    evidence.resumedCard = { ...startupCard, generation: 1 };
    expect(() => assertInstalledCodexPluginJourney(evidence)).toThrow(/did not supersede/);
  });

  it('rejects a resumed session without its own heartbeat renewal', () => {
    const evidence = complete();
    evidence.resumeLeaseRenewed = false;
    expect(() => assertInstalledCodexPluginJourney(evidence)).toThrow(/both the startup and resumed active sessions/);
  });
});

describe.skipIf(process.platform === 'win32')('task-owned Codex home boundary', () => {
  const identity = (candidate: string) => candidate;

  it('accepts only an existing temporary home outside the owner configuration', () => {
    const temporary = fs.mkdtempSync(path.join('/private/tmp', 'memesh-codex-home-test-'));
    try {
      expect(assertTaskOwnedCodexHome({
        codexHome: temporary,
        ownerCodexHome: '/Users/example/.codex',
        temporaryRoot: '/private/tmp',
        realpath: identity,
      })).toBe(temporary);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('rejects owner and non-temporary homes', () => {
    expect(() => assertTaskOwnedCodexHome({
      codexHome: '/Users/example/.codex',
      ownerCodexHome: '/Users/example/.codex',
      temporaryRoot: '/private/tmp',
      realpath: identity,
    })).toThrow(/owner CODEX_HOME/);
    expect(() => assertTaskOwnedCodexHome({
      codexHome: '/Users/example/codex-test',
      ownerCodexHome: '/Users/example/.codex',
      temporaryRoot: '/private/tmp',
      realpath: identity,
    })).toThrow(/outside the allowed temporary root/);
  });
});

describe('intake receipts', () => {
  it('finds the intake the recipient session wrote', () => {
    expect(findIntakeReceipt(RECEIPTS_WITH_INTAKE, { messageId: MESSAGE_ID, actor: THREAD }))
      .toMatchObject({ receipt_kind: 'intake', actor: THREAD });
  });

  it('rejects a projection carrying host_accept but NO intake', () => {
    expect(() => assertIntakeReceipt(RECEIPTS_WITHOUT_INTAKE, { messageId: MESSAGE_ID, actor: THREAD }))
      .toThrow(/No intake receipt written by/);
  });

  it('rejects an intake written by a different session', () => {
    expect(() => assertIntakeReceipt(RECEIPTS_WITH_INTAKE, { messageId: MESSAGE_ID, actor: 'someone-else' }))
      .toThrow(/No intake receipt written by someone-else/);
  });

  it('rejects an intake for a different message', () => {
    expect(() => assertIntakeReceipt(RECEIPTS_WITH_INTAKE, { messageId: 'other-message', actor: THREAD }))
      .toThrow(/No intake receipt/);
  });

  it.each([
    ['wrong fact source', { fact_source: 'agent_host_accept' }],
    ['wrong recipient', { recipient: 'someone-else' }],
    ['wrong intake state', { intake_state: 'fetched' }],
  ])('rejects an intake with %s', (_label, override) => {
    const receipts = RECEIPTS_WITH_INTAKE.map(fact => (
      fact.receipt_kind === 'intake' ? { ...fact, ...override } : fact
    ));
    expect(() => assertIntakeReceipt(receipts, { messageId: MESSAGE_ID, actor: THREAD }))
      .toThrow(/No intake receipt/);
  });

  it('treats an empty projection as no proof', () => {
    expect(findIntakeReceipt([], { messageId: MESSAGE_ID, actor: THREAD })).toBeNull();
    expect(findIntakeReceipt(null, { messageId: MESSAGE_ID, actor: THREAD })).toBeNull();
  });
});

describe('shutdown decision', () => {
  const noSleep = () => Promise.resolve();

  it('is immediately safe when no session was ever registered', async () => {
    const announce = vi.fn();
    await expect(awaitSessionDisconnect({
      sessionId: null,
      isGone: () => false,
      waitMs: 30_000,
      now: () => 0,
      sleep: noSleep,
      announce,
    })).resolves.toBe(true);
    expect(announce).not.toHaveBeenCalled();
  });

  it('is safe once the session has left the router directory', async () => {
    let calls = 0;
    await expect(awaitSessionDisconnect({
      sessionId: 'abc',
      isGone: () => (calls += 1) > 2,
      waitMs: 30_000,
      now: () => 0,
      sleep: noSleep,
      announce: () => {},
    })).resolves.toBe(true);
  });

  it('tells the operator what to do, once, while it waits', async () => {
    let calls = 0;
    const announce = vi.fn();
    await awaitSessionDisconnect({
      sessionId: 'abc',
      isGone: () => (calls += 1) > 3,
      waitMs: 30_000,
      now: () => 0,
      sleep: noSleep,
      announce,
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0][0]).toMatch(/detached replacement/);
  });

  it('is NOT safe when the session is still connected at the bound', async () => {
    // The orphan case: a connected host whose router disappears spawns a
    // detached replacement that recreates this very directory.
    let clock = 0;
    await expect(awaitSessionDisconnect({
      sessionId: 'abc',
      isGone: () => false,
      waitMs: 5_000,
      now: () => (clock += 2_000),
      sleep: noSleep,
      announce: () => {},
    })).resolves.toBe(false);
  });

  it('keeps the directory when a session is still connected, and removes it otherwise', () => {
    expect(shouldRemoveWorkingDirectories({ keep: false, keptForSafety: false })).toBe(true);
    expect(shouldRemoveWorkingDirectories({ keep: false, keptForSafety: true })).toBe(false);
    expect(shouldRemoveWorkingDirectories({ keep: true, keptForSafety: false })).toBe(false);
  });
});

describe('findLiveCards', () => {
  const discovered = {
    cards: [
      { session_id: THREAD, principal_id: 'codex-live-journey', host_kind: 'codex', active: true, generation: 1 },
      { session_id: 'abc', principal_id: 'claude-live-journey', host_kind: 'claude', active: true, generation: 1 },
    ],
  };

  it('filters by host kind', () => {
    expect(findLiveCards(discovered, { hostKind: 'claude' }).map((card) => card.session_id)).toEqual(['abc']);
  });

  it('filters by session id', () => {
    expect(findLiveCards(discovered, { sessionId: THREAD })).toHaveLength(1);
  });

  it('returns nothing for a router answer with no cards array', () => {
    expect(findLiveCards({}, { hostKind: 'claude' })).toEqual([]);
    expect(findLiveCards(null)).toEqual([]);
  });
});
