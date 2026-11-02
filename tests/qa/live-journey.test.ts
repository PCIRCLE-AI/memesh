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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WAIT_MS,
  MAX_SOCKET_PATH_BYTES,
  REQUIRED_BUILD_ARTIFACTS,
  REQUIRED_DIST,
  assertClaudeModelIntakeArmingConfirmation,
  assertClaudePluginIsolationConfirmation,
  assertClaudeInboxEnqueue,
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
  assertSessionStartLauncherSucceeded,
  assertSocketPathFits,
  awaitSessionDisconnect,
  buildJourneyEnv,
  buildLiveJourneyPayload,
  appendCodexMessageToolApproval,
  assertCodexProofTurn,
  assertCodexRolloutProof,
  judgeCodexProofTurn,
  checkRequiredJourneySteps,
  runCodexProofTurn,
  installCodexMessageToolApproval,
  CODEX_PLUGIN_CANDIDATE_FILES,
  mcpResultCarries,
  buildCodexMessageToolApprovalToml,
  CODEX_PROOF_PROMPT,
  buildPackedUpgradeReceipt,
  claudeTrustedIntakePrompt,
  claudeInboxTrustedPrompt,
  collectCodexAgentMessages,
  findIntakeReceipt,
  findLiveCards,
  helpText,
  isDistStale,
  parseArgs,
  parseCodexThreadId,
  realpathAsFarAsPossible,
  requestClaudePluginIsolationConfirmation,
  runClaudeInboxDeliveries,
  requestClaudeModelIntakeArmingConfirmation,
  shouldRemoveWorkingDirectories,
  workingDirectoryCleanupReceipt,
} from '../../scripts/qa/live-journey.mjs';
import {
  CLAUDE_PLUGIN_ISOLATION_CONFIRMATION,
  CORE_JOURNEY_IDS,
  LIVE_JOURNEY_SCHEMA_VERSION,
  REQUIRED_LIVE_JOURNEY_STEPS,
  REQUIRED_REGISTRATION_EVIDENCE,
  missingRequiredSteps,
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
  it('accepts a CI-safe core-only mode without host credentials', () => {
    expect(parseArgs(['--core-only'])).toMatchObject({ host: null, mode: 'core-only' });
  });

  it('accepts the bounded automatic Codex registration mode without a host', () => {
    expect(parseArgs(['--codex-session-auto-registration'])).toMatchObject({
      host: null,
      mode: 'codex-session-auto-registration',
    });
  });

  it('accepts each supported host', () => {
    expect(parseArgs(['--host', 'codex', '--codex-home', '/private/tmp/codex-home']).host).toBe('codex');
    expect(parseArgs(['--host', 'claude']).host).toBe('claude');
    expect(parseArgs(['--host', 'claude-inbox']).host).toBe('claude-inbox');
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

  it('rejects combining core-only with a host mode', () => {
    expect(() => parseArgs(['--core-only', '--host', 'claude']))
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
  it('documents the core-only golden-journey invocation', () => {
    expect(helpText()).toMatch(/npm run qa:live-journey -- --core-only/);
    expect(helpText()).toMatch(/remember.*SessionStart.*quiet commit.*Stop.*packed upgrade/is);
  });

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
    expect(env.MEMESH_ROUTER_TOKEN_FILE).toBe(path.join('/task/memesh', 'agent-router.token'));
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
    expect(helpText()).toMatch(
      /TMPDIR=\/private\/tmp npm run qa:live-journey -- --host codex --codex-home <isolated-home>/,
    );
  });
});

describe('packed upgrade receipt', () => {
  const stdout = [
    'candidate: version=4.10.0 tarball=pcircle-memesh-4.10.0.tgz sha256=' + 'a'.repeat(64),
    'upgrade: from=4.9.4 version=4.10.0 package=/tmp/pkg data=/tmp/data',
    'failure-path: from=4.9.4 the auto-update install failure was reported without SUCCESS; the candidate CLI and pre-existing data remain readable',
    '✅ Packaged upgrade smoke passed — 1 upgrade path(s) proved: 4.9.4 -> 4.10.0',
  ].join('\n');

  it('requires success, failure, effect readback, digest, and empty cleanup root', () => {
    expect(buildPackedUpgradeReceipt({ status: 0, stdout, stderr: '', leftovers: [] })).toMatchObject({
      id: 'packed-upgrade',
      status: 'PASS',
      boundary: 'packed-consumer',
      success: { observed: true },
      failure: { observed: true },
      effect_readback: { observed: true },
      cleanup: { status: 'PASS', removed: true },
      artifact_sha256: 'a'.repeat(64),
    });
  });

  it('fails closed on a green exit with incomplete or leaked evidence', () => {
    expect(() => buildPackedUpgradeReceipt({ status: 0, stdout: 'smoke passed', stderr: '', leftovers: [] }))
      .toThrow(/incomplete/);
    expect(() => buildPackedUpgradeReceipt({ status: 0, stdout, stderr: '', leftovers: ['leaked'] }))
      .toThrow(/cleanup/);
    expect(() => buildPackedUpgradeReceipt({ status: 0, stdout, stderr: '', leftovers: undefined }))
      .toThrow(/cleanup/);
    expect(() => buildPackedUpgradeReceipt({ status: 1, stdout, stderr: 'boom', leftovers: [] }))
      .toThrow(/exit 1/);
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
  it('uses v4, requires the core product journeys, and keeps distinct real-host delivery steps', () => {
    expect(LIVE_JOURNEY_SCHEMA_VERSION).toBe('memesh-live-journey/v4');
    expect(CORE_JOURNEY_IDS).toEqual([
      'memory-round-trip',
      'session-start-briefing',
      'quiet-commit-capture',
      'stop-session-insight',
      'packed-upgrade',
    ]);
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
  it('compares only generated build artefacts, not directly executed hook or QA sources', () => {
    expect(REQUIRED_BUILD_ARTIFACTS.length).toBeGreaterThan(0);
    expect(REQUIRED_BUILD_ARTIFACTS.every((file) => file.startsWith('dist/'))).toBe(true);
    expect(REQUIRED_BUILD_ARTIFACTS).not.toContain('scripts/hooks/post-commit.js');
    expect(REQUIRED_BUILD_ARTIFACTS).not.toContain('scripts/qa/core-live-journeys.mjs');
  });

  // #477: after `git switch`, src/ is newer than an unchanged dist/ although a
  // clean tree runs exactly the committed, mirror-checked build.
  it('is fresh in a clean tree whatever the file times say', () => {
    expect(isDistStale({ dirty: false, newestSrcMs: 2_000, oldestDistMs: 1_000 })).toBe(false);
  });

  it('a clean tree runs committed artefacts: every required one is tracked by git', () => {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', ...REQUIRED_BUILD_ARTIFACTS], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
    });
    expect(tracked.stderr).toBe('');
    expect(tracked.status).toBe(0);
  });

  it('in a dirty tree, is stale when any dist artefact predates the newest source file', () => {
    expect(isDistStale({ dirty: true, newestSrcMs: 2_000, oldestDistMs: 1_000 })).toBe(true);
  });

  it('in a dirty tree, is fresh when every dist artefact is at least as new as the newest source', () => {
    expect(isDistStale({ dirty: true, newestSrcMs: 1_000, oldestDistMs: 1_000 })).toBe(false);
    expect(isDistStale({ dirty: true, newestSrcMs: 1_000, oldestDistMs: 2_000 })).toBe(false);
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
  const project = 'memesh-live-journey~scope';
  const allowedMessage = { project, recipient: THREAD };
  const expected = { sentinel: SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID, allowedProject: project, allowedMessage };
  const reply = `CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`;
  const call = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: 'item_9', type: 'mcp_tool_call', server: 'memesh', tool: 'message', status: 'completed',
    arguments: { project, recipient: THREAD, message_id: MESSAGE_ID, ...args }, ...extra,
  });
  const body = { content: [{ type: 'text', text: JSON.stringify({ message_id: MESSAGE_ID, payload: { qa_sentinel: SENTINEL } }) }] };
  const fetchCall = (extra: Record<string, unknown> = {}) => call({ action: 'fetch', target_kind: 'session' }, { result: body, error: null, ...extra });
  const intakeCall = () => call({ action: 'intake', intake_state: 'ingested', idempotency_key: `intake-${MESSAGE_ID}` });
  /** A started event followed by its completed event, as `codex exec --json` emits a real tool call. */
  const startedAndCompleted = (args: Record<string, unknown>) => [
    { ...call(args, { status: 'in_progress', result: null, error: null }), _event: 'item.started' },
    { ...call(args, { result: args.action === 'fetch' ? body : { content: [{ type: 'text', text: '{"ok":true}' }] }, error: null }), _event: 'item.completed' },
  ];
  const turn = (messages: string[], items: Record<string, unknown>[]) => [
    JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
    JSON.stringify({ type: 'turn.started' }),
    ...items.map((item) => {
      const { _event, ...rest } = item as { _event?: string };
      return JSON.stringify({ type: _event ?? 'item.completed', item: rest });
    }),
    ...messages.map((text, index) => JSON.stringify({ type: 'item.completed', item: { id: `m${index}`, type: 'agent_message', text } })),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    '',
  ].join('\n');
  const check = (items: Record<string, unknown>[], messages = [reply], overrides: Record<string, unknown> = {}) =>
    assertCodexReply({ jsonl: turn(messages, items), ...expected, ...overrides } as Parameters<typeof assertCodexReply>[0]);
  const proof = () => [fetchCall(), intakeCall()];

  it('accepts a reply quoting the sentinel and both ids after fetch and intake', () => {
    expect(check(proof())).toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('accepts receipts, fetch and intake, with started and completed events and result/error fields', () => {
    const receipts = startedAndCompleted({ action: 'receipts', target_kind: 'session' });
    const fetched = startedAndCompleted({ action: 'fetch', target_kind: 'session' });
    const intake = startedAndCompleted({ action: 'intake', intake_state: 'ingested', idempotency_key: 'intake-x' });
    expect(check([...receipts, ...fetched, ...intake])).toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('requires allowedMessage: without it the notice-only proof cannot be judged', () => {
    const withoutMessage = { jsonl: turn([reply], proof()), sentinel: SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID };
    expect(() => assertCodexReply(withoutMessage as Parameters<typeof assertCodexReply>[0])).toThrow(/needs allowedMessage/);
  });

  it('rejects correct ids with NO sentinel — the ids come from the notice, only the sentinel proves the body was read', () => {
    expect(() => check(proof(), [`CODEX_RECEIVED_ ${MESSAGE_ID} ${DELIVERY_ID}`])).toThrow(/does not contain CODEX_RECEIVED_codex-4f19ab27/);
    expect(() => check(proof(), [`${MESSAGE_ID} ${DELIVERY_ID}`])).toThrow(/does not contain CODEX_RECEIVED/);
  });

  it('rejects a reply carrying the WRONG sentinel', () => {
    expect(() => check(proof(), [`CODEX_RECEIVED_codex-00000000 ${MESSAGE_ID} ${DELIVERY_ID}`])).toThrow(/does not contain CODEX_RECEIVED_codex-4f19ab27/);
  });

  it('rejects a reply carrying the WRONG message_id', () => {
    expect(() => check(proof(), [`CODEX_RECEIVED_${SENTINEL} 00000000-0000-4000-8000-000000000000 ${DELIVERY_ID}`]))
      .toThrow(/does not quote message_id b234ba88/);
  });

  it('rejects a reply with the sentinel but no ids at all', () => {
    expect(() => check(proof(), [`CODEX_RECEIVED_${SENTINEL}`])).toThrow(/does not quote message_id/);
  });

  it('rejects a reply carrying the wrong delivery_id', () => {
    expect(() => check(proof(), [`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} 11111111-1111-4111-8111-111111111111`]))
      .toThrow(/does not quote delivery_id/);
  });

  it('rejects a reply from a turn that never fetched the body', () => {
    expect(() => check([intakeCall()])).toThrow(/never fetched/);
    expect(() => check([])).toThrow(/never fetched/);
  });

  it('rejects a fetch whose result does not contain the sentinel — the body must have travelled', () => {
    const empty = fetchCall({ result: { content: [{ type: 'text', text: '{"status":"unavailable"}' }] } });
    expect(() => check([empty, intakeCall()])).toThrow(/No completed fetch returned the message body/);
    expect(() => check([fetchCall({ result: null }), intakeCall()])).toThrow(/No completed fetch returned the message body/);
    expect(() => check([fetchCall({ result: undefined }), intakeCall()])).toThrow(/No completed fetch returned the message body/);
  });

  it('rejects a fetch that reports an error, even if the sentinel text appears in it', () => {
    const withSentinel = { content: [{ type: 'text', text: `denied ${SENTINEL}` }] };
    expect(() => check([fetchCall({ error: { message: 'denied' }, result: withSentinel }), intakeCall()])).toThrow(/No completed fetch returned the message body/);
    expect(() => check([fetchCall({ result: { ...withSentinel, isError: true } }), intakeCall()])).toThrow(/No completed fetch returned the message body/);
    expect(() => check([fetchCall({ result: { ...withSentinel, is_error: true } }), intakeCall()])).toThrow(/No completed fetch returned the message body/);
  });

  it('accepts the body in structured content as well, and a Codex plan item', () => {
    const structured = fetchCall({ result: { content: [], structuredContent: { payload: { qa_sentinel: SENTINEL } } } });
    const plan = { id: 'item_1', type: 'todo_list', items: [{ text: 'fetch', completed: false }] };
    expect(check([plan, structured, intakeCall()])).toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('refuses to judge a reply without a sentinel, message id and delivery id to look for', () => {
    for (const name of ['sentinel', 'messageId', 'deliveryId']) {
      expect(() => check(proof(), [reply], { [name]: '' })).toThrow(new RegExp(`non-empty ${name}`));
      expect(() => check(proof(), [reply], { [name]: undefined })).toThrow(new RegExp(`non-empty ${name}`));
    }
  });

  it('rejects a fetch that did not complete', () => {
    expect(() => check([call({ action: 'fetch', target_kind: 'session' }, { status: 'failed' }), intakeCall()])).toThrow(/never fetched/);
    expect(() => check([{ ...fetchCall(), status: 'in_progress', _event: 'item.started' }, intakeCall()])).toThrow(/never fetched/);
  });

  it('rejects a turn that fetched but never recorded intake', () => {
    expect(() => check([fetchCall()])).toThrow(/never completed an intake/);
    expect(() => check([fetchCall(), call({ action: 'intake', intake_state: 'fetched', idempotency_key: 'k' })])).toThrow(/never completed an intake/);
    expect(() => check([fetchCall(), call({ action: 'intake', intake_state: 'ingested', idempotency_key: 'k' }, { status: 'failed' })]))
      .toThrow(/never completed an intake/);
  });

  it('rejects a shell command in the turn even though the message tool is allowed', () => {
    const command = { id: 'item_8', type: 'command_execution', command: 'cat ../memesh/knowledge-graph.db', exit_code: 0 };
    expect(() => check([...proof(), command])).toThrow(/item:command_execution/);
  });

  it('allows only the installed plugin skill auto-load when it contains none of the proof values', () => {
    const skill = '/tmp/plugin/skills/memesh/SKILL.md';
    const load = { id: 'item_8', type: 'command_execution', command: `cat ${skill}`, aggregated_output: 'skill text', exit_code: 0 };
    expect(check([...proof(), load], [reply], { allowedSkillPath: skill })).toContain(`CODEX_RECEIVED_${SENTINEL}`);
    expect(() => check([...proof(), { ...load, aggregated_output: MESSAGE_ID }], [reply], { allowedSkillPath: skill })).toThrow(/non-answer items/);
  });

  it('allows only the failed automatic work-package probe when it contains no proof identifier', () => {
    const probe = { id: 'item_8', type: 'mcp_tool_call', server: 'memesh', tool: 'work_package', status: 'failed', arguments: { action: 'prepare', kind: 'digest', project } };
    expect(check([...proof(), probe])).toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('rejects a tool other than the message tool, even with message-shaped arguments', () => {
    const recall = { id: 'item_8', type: 'mcp_tool_call', server: 'memesh', tool: 'recall', status: 'completed', arguments: { query: 'x' } };
    expect(() => check([...proof(), recall])).toThrow(/item:mcp_tool_call/);
    expect(() => check([...proof(), call({ action: 'fetch', target_kind: 'session' }, { tool: 'remember' })])).toThrow(/item:mcp_tool_call/);
    expect(() => check([...proof(), call({ action: 'fetch', target_kind: 'session' }, { tool: 'work_package' })])).toThrow(/item:mcp_tool_call/);
  });

  it('rejects a message tool that belongs to another server', () => {
    expect(() => check([...proof(), call({ action: 'fetch' }, { server: 'other' })])).toThrow(/item:mcp_tool_call/);
  });

  it('rejects message actions other than receipts, fetch and intake', () => {
    expect(() => check([...proof(), call({ action: 'send', sender: 'x' })])).toThrow(/item:mcp_tool_call/);
    expect(() => check([...proof(), call({ action: 'poll' })])).toThrow(/item:mcp_tool_call/);
  });

  it('rejects a call about another message, project or recipient', () => {
    const other = '00000000-0000-4000-8000-000000000000';
    expect(() => check([...proof(), call({ action: 'fetch', message_id: other })])).toThrow(/item:mcp_tool_call/);
    expect(() => check([...proof(), call({ action: 'fetch', project: 'another~project' })])).toThrow(/item:mcp_tool_call/);
    expect(() => check([...proof(), call({ action: 'fetch', recipient: 'someone-else' })])).toThrow(/item:mcp_tool_call/);
  });

  it('rejects a call that targets the principal inbox instead of this session', () => {
    expect(() => check([...proof(), call({ action: 'fetch', target_kind: 'principal' })])).toThrow(/item:mcp_tool_call/);
  });

  it('rejects a call whose arguments already carry the sentinel or the delivery id', () => {
    expect(() => check([...proof(), call({ action: 'intake', intake_state: 'ingested', idempotency_key: SENTINEL })])).toThrow(/item:mcp_tool_call/);
    expect(() => check([...proof(), call({ action: 'intake', intake_state: 'ingested', idempotency_key: DELIVERY_ID })])).toThrow(/item:mcp_tool_call/);
  });

  it('rejects an empty turn: nothing was fetched, so nothing can be judged', () => {
    expect(() => assertCodexReply({ jsonl: '{"type":"turn.completed"}', ...expected } as Parameters<typeof assertCodexReply>[0]))
      .toThrow(/never fetched the message body/);
  });
});

describe('assertCodexProofTurn', () => {
  const project = 'memesh-live-journey~scope';
  const allowedMessage = { project, recipient: THREAD };
  const item = (args: Record<string, unknown>) => ({
    id: 'i', type: 'mcp_tool_call', server: 'memesh', tool: 'message', status: 'completed',
    arguments: { project, recipient: THREAD, message_id: MESSAGE_ID, ...args },
  });
  const jsonl = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
    extraItems: [
      { ...item({ action: 'fetch', target_kind: 'session' }), result: { content: [{ type: 'text', text: `{"payload":{"qa_sentinel":"${SENTINEL}"}}` }] }, error: null },
      item({ action: 'intake', intake_state: 'ingested', idempotency_key: 'k' }),
    ],
  });
  const base = { jsonl, sentinel: SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID, allowedProject: project, allowedMessage };

  it('passes when the turn and the durable intake receipt agree', () => {
    expect(assertCodexProofTurn({ ...base, receipts: RECEIPTS_WITH_INTAKE })).toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('fails when the model claims intake but no intake receipt exists', () => {
    expect(() => assertCodexProofTurn({ ...base, receipts: RECEIPTS_WITHOUT_INTAKE })).toThrow(/No intake receipt/);
    expect(() => assertCodexProofTurn({ ...base, receipts: [] })).toThrow(/No intake receipt/);
  });

  it('fails when only the receipts belong to someone else — the turn itself stays valid', () => {
    const foreign = (field: 'actor' | 'recipient') => RECEIPTS_WITH_INTAKE.map(fact => (fact.receipt_kind === 'intake' ? { ...fact, [field]: 'someone-else' } : fact));
    expect(() => assertCodexProofTurn({ ...base, receipts: foreign('actor') })).toThrow(/No intake receipt/);
    expect(() => assertCodexProofTurn({ ...base, receipts: foreign('recipient') })).toThrow(/No intake receipt/);
    const bothForeign = RECEIPTS_WITH_INTAKE.map(fact => (fact.receipt_kind === 'intake' ? { ...fact, actor: 'someone-else', recipient: 'someone-else' } : fact));
    expect(() => assertCodexProofTurn({ ...base, receipts: bothForeign })).toThrow(/No intake receipt/);
    expect(assertCodexProofTurn({ ...base, receipts: RECEIPTS_WITH_INTAKE })).toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });
});

describe('judgeCodexProofTurn', () => {
  const project = 'memesh-live-journey~scope';
  const REAL_SENTINEL = 'codex-startup-4f19ab27';
  const item = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: 'i', type: 'mcp_tool_call', server: 'memesh', tool: 'message', status: 'completed',
    arguments: { project, recipient: THREAD, message_id: MESSAGE_ID, ...args }, ...extra,
  });
  const turn = codexTurn([`CODEX_RECEIVED_${REAL_SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
    extraItems: [
      item({ action: 'fetch', target_kind: 'session' }, { result: { content: [{ type: 'text', text: `{"payload":{"qa_sentinel":"${REAL_SENTINEL}"}}` }] }, error: null }),
      item({ action: 'intake', intake_state: 'ingested', idempotency_key: 'k' }),
    ],
  });
  const noticeLine = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ message_type: 'memesh_message_notice', message_id: MESSAGE_ID, delivery_id: DELIVERY_ID }) }] },
  });
  const homes: string[] = [];
  afterEach(() => { for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const codexHomeWith = (rollout: string | null) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-judge-'));
    homes.push(home);
    if (rollout !== null) {
      const dir = path.join(home, 'sessions', '2026', '11', '02');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `rollout-2026-11-02T00-00-00-${THREAD}.jsonl`), rollout);
    }
    return home;
  };
  const makeJourney = (receipts: unknown = RECEIPTS_WITH_INTAKE) => {
    const steps: Array<{ name: string; detail: Record<string, unknown> }> = [];
    const calls: string[][] = [];
    return {
      steps, calls,
      journey: {
        project,
        cliJson: (args: string[]) => { calls.push(args); return receipts; },
        step: (name: string, detail: Record<string, unknown>) => { steps.push({ name, detail }); },
      },
    };
  };
  const input = (codexHome: string, overrides: Record<string, unknown> = {}) => ({
    prompt: CODEX_PROOF_PROMPT, turnStdout: turn, sentinel: REAL_SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID,
    threadId: THREAD, codexHome, ...overrides,
  });
  const goodRollout = `${noticeLine}\n`;

  it('records the proof step, with receipts read from the CLI for this message and thread, when every part holds', () => {
    const { journey, steps, calls } = makeJourney();
    const reply = judgeCodexProofTurn(journey, input(codexHomeWith(goodRollout)));
    expect(reply).toContain(`CODEX_RECEIVED_${REAL_SENTINEL}`);
    expect(calls).toEqual([['message', 'receipts', '--project', project, '--recipient', THREAD, '--message-id', MESSAGE_ID]]);
    expect(steps.map(step => step.name)).toEqual(['the Codex model fetched the message body and quoted its sentinel (model-visible proof)']);
    expect(steps[0].detail).toMatchObject({ message_id: MESSAGE_ID, delivery_id: DELIVERY_ID, rollout_notice_lines: 1 });
  });

  it('uses the receipts the CLI returns, never ones it made up', () => {
    const { journey, steps } = makeJourney(RECEIPTS_WITHOUT_INTAKE);
    expect(() => judgeCodexProofTurn(journey, input(codexHomeWith(goodRollout)))).toThrow(/No intake receipt/);
    expect(steps).toEqual([]);
  });

  it('fails on receipts written by another actor or for another recipient, or by a consistent other session', () => {
    const consistent = RECEIPTS_WITH_INTAKE.map(fact => (fact.receipt_kind === 'intake' ? { ...fact, actor: 'someone-else', recipient: 'someone-else' } : fact));
    const { journey: other, steps: otherSteps } = makeJourney(consistent);
    expect(() => judgeCodexProofTurn(other, input(codexHomeWith(goodRollout)))).toThrow(/No intake receipt/);
    expect(otherSteps).toEqual([]);
    for (const field of ['actor', 'recipient']) {
      const foreign = RECEIPTS_WITH_INTAKE.map(fact => (fact.receipt_kind === 'intake' ? { ...fact, [field]: 'someone-else' } : fact));
      const { journey, steps } = makeJourney(foreign);
      expect(() => judgeCodexProofTurn(journey, input(codexHomeWith(goodRollout)))).toThrow(/No intake receipt/);
      expect(steps).toEqual([]);
    }
  });

  it('fails as a whole when the rollout is absent, lacks the notice, or leaks the sentinel', () => {
    for (const rollout of [null, '', `${noticeLine.replace(MESSAGE_ID, '00000000-0000-4000-8000-000000000000')}\n`]) {
      const { journey, steps } = makeJourney();
      expect(() => judgeCodexProofTurn(journey, input(codexHomeWith(rollout)))).toThrow(/rollout/);
      expect(steps).toEqual([]);
    }
    const leaking = noticeLine.replace('memesh_message_notice', `memesh_message_notice ${REAL_SENTINEL}`);
    const { journey, steps } = makeJourney();
    expect(() => judgeCodexProofTurn(journey, input(codexHomeWith(`${leaking}\n`)))).toThrow(/qa_sentinel/);
    expect(steps).toEqual([]);
  });

  it('fails when the turn itself is not valid proof, even with good receipts and rollout', () => {
    const { journey, steps } = makeJourney();
    const noFetch = codexTurn([`CODEX_RECEIVED_${REAL_SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {});
    expect(() => judgeCodexProofTurn(journey, input(codexHomeWith(goodRollout), { turnStdout: noFetch }))).toThrow(/never fetched/);
    expect(steps).toEqual([]);
  });

  it('refuses a prompt that names the sentinel (in its real codex-startup-<8hex> form), the message id or the delivery id', () => {
    for (const leak of [REAL_SENTINEL, MESSAGE_ID, DELIVERY_ID]) {
      const { journey, steps } = makeJourney();
      expect(() => judgeCodexProofTurn(journey, input(codexHomeWith(goodRollout), { prompt: `${CODEX_PROOF_PROMPT} ${leak}` })))
        .toThrow(/names a proof value/);
      expect(steps).toEqual([]);
    }
    expect(() => judgeCodexProofTurn(makeJourney().journey, input(codexHomeWith(goodRollout), { prompt: undefined }))).toThrow(/names a proof value/);
  });

  it('refuses empty proof values instead of matching everything', () => {
    for (const name of ['sentinel', 'messageId', 'deliveryId', 'threadId']) {
      expect(() => judgeCodexProofTurn(makeJourney().journey, input(codexHomeWith(goodRollout), { [name]: '' }))).toThrow(new RegExp(`non-empty ${name}`));
    }
  });

  it('the shipped prompt carries none of the real-format proof values', () => {
    expect(CODEX_PROOF_PROMPT).not.toMatch(/codex-(?:startup|auto-first)-[0-9a-f]{8}/);
  });
});

describe('runCodexProofTurn', () => {
  const project = 'memesh-live-journey~scope';
  const REAL_SENTINEL = 'codex-startup-4f19ab27';
  const tool = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: 'i', type: 'mcp_tool_call', server: 'memesh', tool: 'message', status: 'completed',
    arguments: { project, recipient: THREAD, message_id: MESSAGE_ID, ...args }, ...extra,
  });
  const goodTurn = codexTurn([`CODEX_RECEIVED_${REAL_SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
    extraItems: [
      tool({ action: 'fetch', target_kind: 'session' }, { result: { content: [{ type: 'text', text: `{"qa_sentinel":"${REAL_SENTINEL}"}` }] }, error: null }),
      tool({ action: 'intake', intake_state: 'ingested', idempotency_key: 'k' }),
    ],
  });
  const noticeLine = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ message_type: 'memesh_message_notice', message_id: MESSAGE_ID }) }] },
  });
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const tmp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };

  function setup(overrides: { status?: number; stdout?: string; withRollout?: boolean } = {}) {
    const dir = tmp('proof-turn-');
    const codexHome = tmp('proof-home-');
    if (overrides.withRollout !== false) {
      const rolloutDir = path.join(codexHome, 'sessions', '2026', '11', '02');
      fs.mkdirSync(rolloutDir, { recursive: true });
      fs.writeFileSync(path.join(rolloutDir, `rollout-x-${THREAD}.jsonl`), `${noticeLine}\n`);
    }
    const events: string[] = [];
    const steps: string[] = [];
    const cliCalls: string[][] = [];
    const tracked: unknown[] = [];
    const journey = {
      project, dir,
      trackCodexProcess: (child: unknown) => { events.push('track'); tracked.push(child); },
      cliJson: (args: string[]) => { cliCalls.push(args); return RECEIPTS_WITH_INTAKE; },
      step: (name: string) => { steps.push(name); },
    };
    const execCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const child = { pid: 1 };
    const exec = (command: string, args: string[], options: Record<string, unknown>) => {
      events.push('exec');
      execCalls.push({ command, args, options });
      return {
        child,
        completed: new Promise((resolve) => { resolve({ status: overrides.status ?? 0, stdout: overrides.stdout ?? goodTurn, stderr: 'boom' }); }),
      };
    };
    const input = {
      workspace: '/work/space', threadId: THREAD, codexHome, env: { CODEX_HOME: codexHome },
      skillPath: '/cache/skills/memesh/SKILL.md', sentinel: REAL_SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID,
      whileRunning: async () => { events.push('while-running'); return { resumedCard: { generation: 2 } }; },
    };
    return { journey, input, exec, execCalls, events, steps, cliCalls, tracked, child, dir, codexHome };
  }

  it('starts the resume exec with the shipped prompt, the real thread, workspace and env, and tracks its process', async () => {
    const f = setup();
    await runCodexProofTurn(f.journey, f.input, { exec: f.exec as never });
    expect(f.execCalls).toHaveLength(1);
    const { command, args, options } = f.execCalls[0];
    expect(command).toBe('codex');
    expect(args.slice(0, 5)).toEqual(['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s']);
    expect(args.slice(args.indexOf('-C'))).toEqual(['-C', '/work/space', 'resume', THREAD, CODEX_PROOF_PROMPT]);
    expect(options).toEqual({ env: { CODEX_HOME: f.codexHome } });
    expect(f.tracked).toEqual([f.child]);
  });

  it('runs the caller\'s waits while the turn is in flight, and returns what they produced', async () => {
    const f = setup();
    const result = await runCodexProofTurn(f.journey, f.input, { exec: f.exec as never });
    expect(f.events).toEqual(['exec', 'track', 'while-running']);
    expect(result.during).toEqual({ resumedCard: { generation: 2 } });
    expect(result.reply).toContain(`CODEX_RECEIVED_${REAL_SENTINEL}`);
  });

  it('judges exactly once, with the prompt it sent, the real thread and home, and the turn it received', async () => {
    const f = setup();
    const judge = vi.fn(() => 'judged-reply');
    const result = await runCodexProofTurn(f.journey, f.input, { exec: f.exec as never, judge: judge as never });
    expect(judge).toHaveBeenCalledTimes(1);
    const [journeyArg, judged] = judge.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(journeyArg).toBe(f.journey);
    expect(judged.prompt).toBe(f.execCalls[0].args[f.execCalls[0].args.length - 1]);
    expect(judged).toMatchObject({
      turnStdout: goodTurn, sentinel: REAL_SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID,
      threadId: THREAD, codexHome: f.codexHome, skillPath: '/cache/skills/memesh/SKILL.md',
    });
    expect(result.reply).toBe('judged-reply');
  });

  it('keeps the raw turn for the report before judging it', async () => {
    const f = setup();
    await runCodexProofTurn(f.journey, f.input, { exec: f.exec as never });
    expect(fs.readFileSync(path.join(f.dir, 'codex-resume.jsonl'), 'utf8')).toBe(goodTurn);
  });

  it('runs the real judgement end to end: it records the proof step and reads the receipts of this message', async () => {
    const f = setup();
    await runCodexProofTurn(f.journey, f.input, { exec: f.exec as never });
    expect(f.steps).toEqual(['the Codex model fetched the message body and quoted its sentinel (model-visible proof)']);
    expect(f.cliCalls).toEqual([['message', 'receipts', '--project', project, '--recipient', THREAD, '--message-id', MESSAGE_ID]]);
  });

  it('propagates a failed judgement and records no proof step', async () => {
    const f = setup({ withRollout: false });
    await expect(runCodexProofTurn(f.journey, f.input, { exec: f.exec as never })).rejects.toThrow(/no rollout file/);
    expect(f.steps).toEqual([]);
    const boom = vi.fn(() => { throw new Error('judge said no'); });
    await expect(runCodexProofTurn(f.journey, f.input, { exec: f.exec as never, judge: boom as never })).rejects.toThrow('judge said no');
  });

  it('fails on a non-zero exit, with the reason from stdout and stderr, and never judges', async () => {
    const f = setup({ status: 2, stdout: '{"type":"turn.failed","error":"usage limit"}' });
    const judge = vi.fn();
    await expect(runCodexProofTurn(f.journey, f.input, { exec: f.exec as never, judge: judge as never }))
      .rejects.toThrow(/codex exec resume exited 2.*boom.*usage limit/);
    expect(judge).not.toHaveBeenCalled();
  });

  it('propagates a failure of the caller\'s waits without judging', async () => {
    const f = setup();
    const judge = vi.fn();
    const failing = { ...f.input, whileRunning: async () => { throw new Error('lease never renewed'); } };
    await expect(runCodexProofTurn(f.journey, failing, { exec: f.exec as never, judge: judge as never })).rejects.toThrow('lease never renewed');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('required journey steps before PASS', () => {
  const asSteps = (names: readonly string[]) => names.map((name, index) => ({ step: index + 1, name, status: 'PASS' }));

  it('passes a run that has every required step in order, for each host with a list', () => {
    for (const host of ['codex', 'claude'] as const) {
      const steps = asSteps(['extra before', ...REQUIRED_LIVE_JOURNEY_STEPS[host], 'extra after']);
      expect(missingRequiredSteps(steps, host)).toEqual([]);
      expect(checkRequiredJourneySteps(steps, { host, mode: null })).toEqual({ checked: true });
    }
  });

  it('fails a run that lacks any one required step, naming it', () => {
    for (const host of ['codex', 'claude'] as const) {
      for (const missing of REQUIRED_LIVE_JOURNEY_STEPS[host]) {
        const steps = asSteps(REQUIRED_LIVE_JOURNEY_STEPS[host].filter(name => name !== missing));
        expect(missingRequiredSteps(steps, host)).toEqual([missing]);
        expect(() => checkRequiredJourneySteps(steps, { host, mode: null })).toThrow(new RegExp(`missing or has out of order required steps for host ${host}.*`));
      }
    }
  });

  it('fails a run whose required steps are out of order', () => {
    const names = [...REQUIRED_LIVE_JOURNEY_STEPS.codex];
    [names[2], names[3]] = [names[3], names[2]];
    expect(missingRequiredSteps(asSteps(names), 'codex')).not.toEqual([]);
    expect(() => checkRequiredJourneySteps(asSteps(names), { host: 'codex', mode: null })).toThrow(/out of order/);
  });

  it('does not take one host\'s steps for another\'s', () => {
    expect(missingRequiredSteps(asSteps(REQUIRED_LIVE_JOURNEY_STEPS.claude), 'codex')).toContain('real Codex thread created');
    expect(missingRequiredSteps(asSteps(REQUIRED_LIVE_JOURNEY_STEPS.codex), 'claude')).toContain('the Claude model called intake itself (model-visible proof)');
  });

  it('skips, saying why, for hosts and modes with no required list', () => {
    expect(missingRequiredSteps([], 'claude-inbox')).toBeNull();
    expect(checkRequiredJourneySteps([], { host: 'claude-inbox', mode: null })).toMatchObject({ checked: false, skippedBecause: expect.stringMatching(/claude-inbox has no required step list/) });
    expect(checkRequiredJourneySteps([], { host: null, mode: 'core-only' })).toMatchObject({ checked: false, skippedBecause: expect.stringMatching(/core-only/) });
    expect(checkRequiredJourneySteps([], { host: null, mode: 'codex-session-auto-registration' })).toMatchObject({ checked: false });
  });
});

describe('installCodexMessageToolApproval', () => {
  const server = { command: 'node', args: ['./dist/mcp/server.js'], env_vars: ['MEMESH_DIR', 'MEMESH_DB_PATH', 'MEMESH_PROJECT_ROOT'] };
  const homes: string[] = [];
  afterEach(() => { for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const home = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-')); homes.push(dir); return dir; };

  it('writes the journey directory and database into the server entry and records the limitation', () => {
    const notes: string[] = [];
    const codexHome = home();
    installCodexMessageToolApproval({ memeshDir: '/j/dir', dbPath: '/j/dir/k.db', note: (text: string) => notes.push(text) }, { codexHome, cachePath: '/cache/1.0.0', server });
    const written = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(written).toContain('env = { MEMESH_DIR = "/j/dir", MEMESH_DB_PATH = "/j/dir/k.db" }');
    expect(written).toContain('approval_mode = "approve"');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/rewritten config\.toml/);
  });

  it('throws, and writes nothing, when the journey has no directory or database to pass', () => {
    for (const journey of [{ note: () => {} }, { memeshDir: '/j', note: () => {} }, { dbPath: '/j/k.db', note: () => {} }]) {
      const codexHome = home();
      expect(() => installCodexMessageToolApproval(journey as never, { codexHome, cachePath: '/cache/1.0.0', server })).toThrow(/MEMESH_/);
      expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
    }
  });
});

describe('assertCodexRolloutProof', () => {
  const noticeJson = JSON.stringify({ message_type: 'memesh_message_notice', handling: 'x', message_id: MESSAGE_ID, delivery_id: DELIVERY_ID });
  const userLine = (text: string, role = 'user') => JSON.stringify({
    timestamp: 't', ordinal: 1, type: 'response_item',
    payload: { type: 'message', id: 'm', role, content: [{ type: 'input_text', text }] },
  });
  const expected = { messageId: MESSAGE_ID, sentinel: SENTINEL };

  it('counts the user-role notice line and accepts it when it holds no sentinel', () => {
    expect(assertCodexRolloutProof(`${userLine(noticeJson)}\n${userLine('hello')}\n`, expected)).toEqual({ noticeLines: 1 });
  });

  it('fails when the rollout file is missing — a check that saw nothing proved nothing', () => {
    expect(() => assertCodexRolloutProof(null, expected)).toThrow(/no rollout file/);
  });

  it('fails when the notice is not in the rollout', () => {
    expect(() => assertCodexRolloutProof(`${userLine('hello')}\n`, expected)).toThrow(/not in the Codex rollout/);
    expect(() => assertCodexRolloutProof('', expected)).toThrow(/not in the Codex rollout/);
    const other = noticeJson.replace(MESSAGE_ID, '00000000-0000-4000-8000-000000000000');
    expect(() => assertCodexRolloutProof(`${userLine(other)}\n`, expected)).toThrow(/not in the Codex rollout/);
  });

  it('fails when the notice itself carries the sentinel', () => {
    const leaking = JSON.stringify({ message_type: 'memesh_message_notice', message_id: MESSAGE_ID, qa_sentinel: SENTINEL });
    expect(() => assertCodexRolloutProof(`${userLine(leaking)}\n`, expected)).toThrow(/already contains the qa_sentinel/);
  });

  it('fails when a full-envelope memesh_message line carries the sentinel', () => {
    const envelope = JSON.stringify({ message_type: 'memesh_message', delivery_id: DELIVERY_ID, envelope: { message_id: MESSAGE_ID, payload: { qa_sentinel: SENTINEL } } });
    expect(() => assertCodexRolloutProof(`${userLine(noticeJson)}\n${userLine(envelope)}\n`, expected)).toThrow(/already contains the qa_sentinel/);
  });

  it('fails when compacted history or a non-user message carries a MeMesh message with the sentinel', () => {
    const envelope = JSON.stringify({ message_type: 'memesh_message', envelope: { payload: { qa_sentinel: SENTINEL } } });
    const compacted = JSON.stringify({ type: 'compacted', payload: { replacement_history: [{ role: 'user', content: [{ type: 'input_text', text: envelope }] }] } });
    expect(() => assertCodexRolloutProof(`${userLine(noticeJson)}\n${compacted}\n`, expected)).toThrow(/already contains the qa_sentinel/);
    for (const role of ['developer', 'system', 'tool']) {
      expect(() => assertCodexRolloutProof(`${userLine(noticeJson)}\n${userLine(envelope, role)}\n`, expected)).toThrow(/already contains the qa_sentinel/);
    }
  });

  it('fails when any user-side message holds the sentinel, even one that is not a MeMesh message (a leak in the prompt)', () => {
    expect(() => assertCodexRolloutProof(`${userLine(noticeJson)}\n${userLine(`Reply with ${SENTINEL} please`)}\n`, expected))
      .toThrow(/already contains the qa_sentinel/);
    expect(() => assertCodexRolloutProof(`${userLine(noticeJson)}\n${userLine(`context ${SENTINEL}`, 'developer')}\n`, expected))
      .toThrow(/already contains the qa_sentinel/);
  });

  it('stays quiet on the normal flow: the fetched body is tool output and the reply is the assistant\'s', () => {
    const toolOutput = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: JSON.stringify({ payload: { qa_sentinel: SENTINEL } }) } });
    const toolCall = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'message', arguments: `{"message_id":"${MESSAGE_ID}"}` } });
    const reply = userLine(`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`, 'assistant');
    expect(assertCodexRolloutProof(`${userLine('Fetch the message and reply')}\n${userLine(noticeJson)}\n${toolCall}\n${toolOutput}\n${reply}\n`, expected))
      .toEqual({ noticeLines: 1 });
  });

  it('refuses to look for an empty message id or sentinel', () => {
    expect(() => assertCodexRolloutProof(`${userLine(noticeJson)}\n`, { messageId: '', sentinel: SENTINEL })).toThrow(/non-empty messageId/);
    expect(() => assertCodexRolloutProof(`${userLine(noticeJson)}\n`, { messageId: MESSAGE_ID, sentinel: '' })).toThrow(/non-empty sentinel/);
  });

  it('ignores the assistant quoting the sentinel and tool output that holds it', () => {
    const reply = userLine(`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} memesh_message_notice`, 'assistant');
    const toolOut = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: `memesh_message ${SENTINEL}` } });
    expect(assertCodexRolloutProof(`${userLine(noticeJson)}\n${reply}\n${toolOut}\nnot json memesh_message\n`, expected)).toEqual({ noticeLines: 1 });
  });
});

describe('mcpResultCarries', () => {
  it('needs a non-empty needle, a result and no error flag', () => {
    const ok = { result: { content: [{ type: 'text', text: `a ${SENTINEL} b` }] }, error: null };
    expect(mcpResultCarries(ok, SENTINEL)).toBe(true);
    expect(mcpResultCarries(ok, '')).toBe(false);
    expect(mcpResultCarries(ok, 'other')).toBe(false);
    expect(mcpResultCarries({ ...ok, error: { message: 'x' } }, SENTINEL)).toBe(false);
    expect(mcpResultCarries({ result: { ...ok.result, isError: true } }, SENTINEL)).toBe(false);
    expect(mcpResultCarries({}, SENTINEL)).toBe(false);
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

describe('ordinary Claude inbox journey', () => {
  function fixture() {
    const steps: string[] = []; let discoverCount = 0; let exactCount = 0;
    const card = { session_id: 'session', principal_id: 'principal' };
    const journey = {
      project: 'project', say: () => {}, step: (name: string) => steps.push(name),
      discover: () => ({ cards: [{ ...card, work_summary: ++discoverCount < 3 ? 'idle' : 'busy' }] }),
      until: async (_description: string, fn: () => unknown) => { const result = await fn(); if (!result) throw new Error('not observed'); return result; },
      cli: () => ({ status: 0, stdout: JSON.stringify({ message_id: 'principal-message', delivery_id: 'principal-delivery' }), stderr: '' }),
      cliJson: (args: string[]) => {
        const recipient = args[args.indexOf('--recipient') + 1]; const id = args[args.indexOf('--message-id') + 1];
        return [{ receipt_kind: 'host_accept', adapter_kind: 'claude-inbox', delivery_id: id.replace('message', 'delivery'), message_id: id, recipient }, { fact_source: 'agent_message_receipt', receipt_kind: 'intake', intake_state: 'ingested', message_id: id, recipient, actor: recipient }];
      },
      sendAccepted: () => { const kind = ++exactCount === 1 ? 'exact' : 'busy'; return { messageId: `${kind}-message`, deliveryId: `${kind}-delivery`, native: { adapter_kind: 'claude-inbox', receipt: { confirmation: 'enqueue' } } }; },
    };
    return { journey, card, steps };
  }
  it('requires principal idle, session idle, and session busy evidence', async () => {
    const f = fixture();
    await runClaudeInboxDeliveries(f.journey, f.card, 1000, async (prompt: string) => prompt.includes('CLAUDE_BUSY_NOW') ? 'CLAUDE_BUSY_NOW' : 'OBSERVED_FETCH_AND_REPLY');
    expect(f.steps).toEqual(['idle principal inbox delivery', 'idle exact-session inbox delivery', 'operator attested the Claude task was still busy', 'busy exact-session inbox delivery']);
  });
  it('fails when the exact delivery cannot be accepted', async () => {
    const f = fixture();
    f.journey.sendAccepted = () => { throw new Error('recipient_unavailable'); };
    await expect(runClaudeInboxDeliveries(f.journey, f.card, 1000, async () => 'OBSERVED_FETCH_AND_REPLY')).rejects.toThrow('recipient_unavailable');
  });
});

describe('assertNativeAccepted', () => {
  it('requires a confirmed Claude inbox enqueue for the busy path', () => {
    expect(() => assertClaudeInboxEnqueue({ native: { adapter_kind: 'claude-inbox', receipt: { confirmation: 'enqueue' } } })).not.toThrow();
    expect(() => assertClaudeInboxEnqueue({ native: { adapter_kind: 'claude-inbox', receipt: { confirmation: 'user' } } })).toThrow(/enqueue/);
    expect(() => assertClaudeInboxEnqueue({ native: { adapter_kind: 'claude-channel', receipt: { confirmation: 'enqueue' } } })).toThrow(/enqueue/);
    expect(claudeInboxTrustedPrompt()).toMatch(/next three.*fetch.*intake.*reply/i);
  });
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
  // The Codex queue carries only a notice naming the message; the body stays in the inbox.
  const invocation = (message: (typeof messages)[number]) => ({
    thread_id: message.sessionId,
    serialized_message: JSON.stringify({
      message_type: 'memesh_message_notice',
      handling: 'fetch it from the inbox',
      project: message.project,
      recipient: message.sessionId,
      target_kind: 'session',
      message_id: message.messageId,
      delivery_id: message.deliveryId,
    }),
  });

  it('accepts exactly one matching native notice for each exact-session send', () => {
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

  it('rejects a notice that carries the message body or an envelope', () => {
    const withBody = invocation(messages[0]);
    const serialized = JSON.parse(withBody.serialized_message);
    serialized.note = `sentinel ${messages[0].payload.qa_sentinel}`;
    withBody.serialized_message = JSON.stringify(serialized);
    expect(() => assertExactCodexQueueRouting([
      withBody, invocation(messages[1]),
    ], messages)).toThrow(/crossed exact-session boundaries/);
    const withEnvelope = invocation(messages[0]);
    const enveloped = JSON.parse(withEnvelope.serialized_message);
    enveloped.envelope = { payload: messages[0].payload };
    withEnvelope.serialized_message = JSON.stringify(enveloped);
    expect(() => assertExactCodexQueueRouting([
      withEnvelope, invocation(messages[1]),
    ], messages)).toThrow(/crossed exact-session boundaries/);
  });

  it('rejects a notice naming another delivery, and an inbox fetch whose body differs', () => {
    const wrongDelivery = invocation(messages[0]);
    const serialized = JSON.parse(wrongDelivery.serialized_message);
    serialized.delivery_id = 'delivery-b';
    wrongDelivery.serialized_message = JSON.stringify(serialized);
    expect(() => assertExactCodexQueueRouting([
      wrongDelivery, invocation(messages[1]),
    ], messages)).toThrow(/crossed exact-session boundaries/);
    const fetchedWrong = messages.map((message, index) => ({
      ...message,
      fetched: {
        message_id: message.messageId, sender: message.sender, content_type: message.contentType,
        payload: index === 0 ? { qa_sentinel: 'wrong' } : message.payload,
      },
    }));
    expect(() => assertExactCodexQueueRouting(messages.map(invocation), fetchedWrong))
      .toThrow(/crossed exact-session boundaries/);
    const fetchedRight = messages.map((message) => ({
      ...message,
      fetched: { message_id: message.messageId, sender: message.sender, content_type: message.contentType, payload: message.payload },
    }));
    expect(assertExactCodexQueueRouting(messages.map(invocation), fetchedRight)).toHaveLength(2);
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

  it('accepts a cleanly exited SessionStart launcher after discover proves the detached companion', () => {
    expect(() => assertSessionStartLauncherSucceeded({ exitCode: 0, signalCode: null }, 'launcher')).not.toThrow();
    expect(() => assertSessionStartLauncherSucceeded({ exitCode: null, signalCode: null }, 'launcher')).not.toThrow();
    expect(() => assertSessionStartLauncherSucceeded({ exitCode: 1, signalCode: null }, 'launcher'))
      .toThrow(/failed before its detached companion registered/);
    expect(() => assertSessionStartLauncherSucceeded({ exitCode: null, signalCode: 'SIGTERM' }, 'launcher'))
      .toThrow(/failed before its detached companion registered/);
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

  // codex-cli 0.155.1 (measured 2026-09-23) refuses to fully start with
  // CODEX_HOME under a recognised OS temporary directory ("Refusing to
  // create helper binaries under temporary dir"), so this no longer requires
  // one — an existing directory anywhere outside the owner's real ~/.codex
  // is accepted. The temp-only case is still covered (a disposable home
  // caller-prepared under os.tmpdir() must still work), alongside a home
  // prepared somewhere else entirely.
  it('accepts an existing home outside the owner configuration, temporary or not', () => {
    // KT 2026-09-23: this "non-temporary" fixture must be a REAL non-temp
    // location to mean anything -- codex-cli itself refuses a temp CODEX_HOME
    // (the whole reason assertTaskOwnedCodexHome no longer requires one), so
    // swapping this fixture for another os.tmpdir() path would stop testing
    // the case that actually matters. Guard instead: fail loudly, before
    // creating anything, unless the current HOME is known throwaway -- true
    // whenever this runs through the isolated test runner
    // (scripts/run-tests-isolated.mjs always mkdtemps HOME under
    // os.tmpdir()) OR on CI (ci.yml's and publish-npm.yml's "Run tests"
    // steps run bare `npm test -- --run`, un-isolated, against the runner's
    // own HOME -- e.g. /home/runner -- which never resolves under
    // os.tmpdir() but is itself a fresh, disposable machine with no real
    // knowledge graph to lose; confirmed by reproducing this exact failure
    // locally with a direct `vitest run` before adding the CI exemption).
    // False only when a developer bypassed the isolated runner on their own
    // machine and HOME is their real, persistent developer home. A `finally`
    // cleanup cannot survive SIGKILL; this stops the directory from ever
    // being created against a real home in the first place, the same
    // "refuse before creating anything" shape assertOutsideOwnerMemesh
    // already uses for MEMESH_DIR. Checked against the literal string
    // 'true', not Boolean(process.env.CI) -- a bare truthiness check would
    // also exempt CI=false/CI=0 (any non-empty string is truthy), which a
    // developer's own shell could set for unrelated reasons; GitHub Actions
    // documents that it always sets CI to exactly 'true', and it's the only
    // CI provider this project runs on per .github/workflows/*.yml.
    const home = fs.realpathSync(os.homedir());
    const tmp = fs.realpathSync(os.tmpdir());
    const homeIsThrowaway = home === tmp || home.startsWith(tmp + path.sep) || process.env.CI === 'true';
    if (!homeIsThrowaway) {
      throw new Error(
        `Refusing to create a test fixture under os.homedir() (${home}): it does not resolve `
        + `under os.tmpdir() (${tmp}) and CI is not 'true', so this is not running through the `
        + 'isolated test runner (scripts/run-tests-isolated.mjs) and HOME looks like a real '
        + 'developer home. Run tests via that script instead of a bare `npm test`/`vitest run`.',
      );
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-home-test-'));
    const nonTemporary = fs.mkdtempSync(path.join(os.homedir(), '.memesh-codex-home-test-'));
    try {
      for (const home of [temporary, nonTemporary]) {
        expect(assertTaskOwnedCodexHome({
          codexHome: home,
          ownerCodexHome: '/Users/example/.codex',
          realpath: identity,
        })).toBe(home);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(nonTemporary, { recursive: true, force: true });
    }
  });

  it('rejects the owner home, a path inside it, and a home that does not exist', () => {
    expect(() => assertTaskOwnedCodexHome({
      codexHome: '/Users/example/.codex',
      ownerCodexHome: '/Users/example/.codex',
      realpath: identity,
    })).toThrow(/owner CODEX_HOME/);
    expect(() => assertTaskOwnedCodexHome({
      codexHome: '/Users/example/.codex/plugins',
      ownerCodexHome: '/Users/example/.codex',
      realpath: identity,
    })).toThrow(/owner CODEX_HOME/);
    expect(() => assertTaskOwnedCodexHome({
      codexHome: '/Users/example/codex-test-does-not-exist',
      ownerCodexHome: '/Users/example/.codex',
      realpath: identity,
    })).toThrow(/must already exist/);
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

  it('never emits release-eligible cleanup evidence for retained or failed outer cleanup', () => {
    expect(workingDirectoryCleanupReceipt({ keep: true, keptForSafety: false, attempted: false }))
      .toMatchObject({ status: 'FAIL', removed: false });
    expect(workingDirectoryCleanupReceipt({ keep: false, keptForSafety: true, attempted: false }))
      .toMatchObject({ status: 'FAIL', removed: false });
    expect(workingDirectoryCleanupReceipt({
      keep: false,
      keptForSafety: false,
      attempted: true,
      leftovers: ['/tmp/leftover'],
      errors: ['permission denied'],
    })).toMatchObject({ status: 'FAIL', removed: false, leftovers: ['/tmp/leftover'] });
    expect(workingDirectoryCleanupReceipt({
      keep: false,
      keptForSafety: false,
      attempted: true,
    })).toEqual({ status: 'PASS', removed: true, leftovers: 0 });
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


describe('Codex proof turn configuration', () => {
  const server = { command: 'node', args: ['./dist/mcp/server.js'], env_vars: ['MEMESH_DIR', 'MEMESH_DB_PATH', 'MEMESH_PROJECT_ROOT'] };
  const env = { MEMESH_DIR: '/q/dir', MEMESH_DB_PATH: '/q/dir/k.db' };
  const toml = buildCodexMessageToolApprovalToml({ cachePath: '/home/x/.memesh-codex-qa.A1/plugins/cache/p/memesh/9.9.9', server, env });

  it('approves exactly the message tool of the memesh server, directly under its own table', () => {
    const lines = toml.split('\n');
    const header = lines.indexOf('[mcp_servers.memesh.tools.message]');
    expect(header).toBeGreaterThan(0);
    expect(lines[header + 1]).toBe('approval_mode = "approve"');
    expect(toml.match(/approval_mode/g)).toHaveLength(1);
    expect(toml).not.toMatch(/default_tools_approval_mode/);
    expect(toml).not.toMatch(/approval_policy|sandbox_mode/);
  });

  it('redefines the plugin server with the cache path as its working directory', () => {
    expect(toml).toContain('[mcp_servers.memesh]');
    expect(toml).toContain('cwd = "/home/x/.memesh-codex-qa.A1/plugins/cache/p/memesh/9.9.9"');
    expect(toml).toContain('args = ["./dist/mcp/server.js"]');
  });

  it('passes the journey directory and database explicitly instead of forwarding them by name', () => {
    expect(toml).toContain('env = { MEMESH_DIR = "/q/dir", MEMESH_DB_PATH = "/q/dir/k.db" }');
    expect(toml).toContain('env_vars = ["MEMESH_PROJECT_ROOT"]');
  });

  it('refuses a server definition or cache path it cannot reproduce', () => {
    expect(() => buildCodexMessageToolApprovalToml({ cachePath: '/c', server: { args: [] }, env })).toThrow(/command/);
    expect(() => buildCodexMessageToolApprovalToml({ cachePath: '', server, env })).toThrow(/cache path/);
  });

  it('will not render a server without the journey directory and database: it would open the real ~/.memesh', () => {
    const cachePath = '/c';
    expect(() => buildCodexMessageToolApprovalToml({ cachePath, server } as never)).toThrow(/MEMESH_DIR/);
    expect(() => buildCodexMessageToolApprovalToml({ cachePath, server, env: { MEMESH_DIR: '/q' } })).toThrow(/MEMESH_DB_PATH/);
    expect(() => buildCodexMessageToolApprovalToml({ cachePath, server, env: { MEMESH_DIR: '', MEMESH_DB_PATH: '/q/k.db' } })).toThrow(/MEMESH_DIR/);
  });

  describe.skipIf(process.platform === 'win32')('writing it into the isolated home', () => {
    const makeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-'));

    it('appends to a plain config.toml and returns its path', () => {
      const home = makeHome();
      try {
        fs.writeFileSync(path.join(home, 'config.toml'), '[plugins."memesh@x"]\nenabled = true\n');
        const written = appendCodexMessageToolApproval({ codexHome: home, toml });
        expect(written).toBe(path.join(home, 'config.toml'));
        expect(fs.readFileSync(written, 'utf8')).toContain('[mcp_servers.memesh.tools.message]');
        expect(fs.readFileSync(written, 'utf8')).toContain('enabled = true');
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });

    it('refuses a config.toml that is a symlink and leaves its target untouched', () => {
      const home = makeHome();
      const outside = makeHome();
      try {
        const target = path.join(outside, 'real-config.toml');
        fs.writeFileSync(target, 'model = "x"\n');
        fs.symlinkSync(target, path.join(home, 'config.toml'));
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml })).toThrow(/symlink/);
        expect(fs.readFileSync(target, 'utf8')).toBe('model = "x"\n');
      } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
    });

    it('refuses a config.toml that already configures the memesh server', () => {
      const home = makeHome();
      try {
        fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.memesh]\ncommand = "node"\n');
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml })).toThrow(/already configures the memesh MCP server/);
        fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.memesh.tools.message]\napproval_mode = "prompt"\n');
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml })).toThrow(/already configures/);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  });


  describe.skipIf(process.platform === 'win32')('refusing a config.toml that is not a plain single file', () => {
    const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-'));
    /** Open a path and hand back the descriptor: the file stays alive, so its inode cannot be reused, until the caller closes it. */
    const holdOpen = (file: string): number => fs.openSync(file, 'r');
    /** Replace whatever is at a path with a new file holding `content`. */
    const replaceWith = (file: string, content: string): void => { fs.rmSync(file); fs.writeFileSync(file, content); };
    const cleanup = (...dirs: string[]) => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

    it('refuses a hard link and leaves the other name untouched', () => {
      const home = makeDir();
      const outside = makeDir();
      try {
        const real = path.join(outside, 'real-config.toml');
        fs.writeFileSync(real, 'model = "x"\n');
        fs.linkSync(real, path.join(home, 'config.toml'));
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml })).toThrow(/single link/);
        expect(fs.readFileSync(real, 'utf8')).toBe('model = "x"\n');
      } finally { cleanup(home, outside); }
    });

    it('refuses a second hard link created to the checked file after the check (fstat link count)', () => {
      const home = makeDir();
      try {
        const config = path.join(home, 'config.toml');
        fs.writeFileSync(config, 'a = 1\n');
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml }, {
          afterCheck: (file) => { fs.linkSync(file, path.join(home, 'alias.toml')); },
        })).toThrow(/changed between the check and the open/);
        expect(fs.readFileSync(config, 'utf8')).toBe('a = 1\n');
      } finally { cleanup(home); }
    });

    it('refuses a plain file that appeared after the check where none existed — a new file is created exclusively', () => {
      const home = makeDir();
      try {
        const config = path.join(home, 'config.toml');
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml }, {
          afterCheck: (file) => { fs.writeFileSync(file, 'planted = true\n'); },
        })).toThrow();
        expect(fs.readFileSync(config, 'utf8')).toBe('planted = true\n');
      } finally { cleanup(home); }
    });

    it('refuses a hard link planted where no config.toml existed yet, and leaves the other file alone', () => {
      const home = makeDir();
      const outside = makeDir();
      try {
        const target = path.join(outside, 'real-config.toml');
        fs.writeFileSync(target, 'model = "x"\n');
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml }, {
          afterCheck: (file) => { fs.linkSync(target, file); },
        })).toThrow();
        expect(fs.readFileSync(target, 'utf8')).toBe('model = "x"\n');
      } finally { cleanup(home, outside); }
    });

    it('refuses a file swapped for another one after the check (device and inode must match)', () => {
      const home = makeDir();
      try {
        const config = path.join(home, 'config.toml');
        fs.writeFileSync(config, 'a = 1\n');
        let held: number | null = null;
        try {
          expect(() => appendCodexMessageToolApproval({ codexHome: home, toml }, {
            // Hold the old file open while its replacement is created, so the new file cannot reuse its inode.
            afterCheck: (file) => { held = holdOpen(file); replaceWith(file, 'b = 2\n'); },
          })).toThrow(/changed between the check and the open/);
        } finally { if (held !== null) fs.closeSync(held); }
        expect(fs.readFileSync(config, 'utf8')).toBe('b = 2\n');
      } finally { cleanup(home); }
    });

    it('refuses a symlink swapped in after the check of an existing file', () => {
      const home = makeDir();
      const outside = makeDir();
      try {
        const config = path.join(home, 'config.toml');
        const target = path.join(outside, 'real-config.toml');
        fs.writeFileSync(config, 'a = 1\n');
        fs.writeFileSync(target, 'model = "x"\n');
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml }, {
          afterCheck: (file) => { fs.rmSync(file); fs.symlinkSync(target, file); },
        })).toThrow();
        expect(fs.readFileSync(target, 'utf8')).toBe('model = "x"\n');
      } finally { cleanup(home, outside); }
    });

    it('refuses a symlink planted where no config.toml existed yet', () => {
      const home = makeDir();
      const outside = makeDir();
      try {
        const target = path.join(outside, 'real-config.toml');
        fs.writeFileSync(target, 'model = "x"\n');
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml }, {
          afterCheck: (file) => { fs.symlinkSync(target, file); },
        })).toThrow();
        expect(fs.readFileSync(target, 'utf8')).toBe('model = "x"\n');
      } finally { cleanup(home, outside); }
    });

    it.each([
      ['a bare table', '[mcp_servers.memesh]\ncommand = "node"\n'],
      ['a quoted table name', '[mcp_servers."memesh"]\ncommand = "node"\n'],
      ['a single-quoted table name', "[mcp_servers.'memesh']\ncommand = \"node\"\n"],
      ['spaces inside the header', '[ mcp_servers . memesh ]\ncommand = "node"\n'],
      ['a sub-table only', '[mcp_servers.memesh.tools.message]\napproval_mode = "prompt"\n'],
      ['a dotted key at the root', 'mcp_servers.memesh.command = "node"\n'],
      ['a quoted dotted key', 'mcp_servers."memesh".command = "node"\n'],
      ['the mcp_servers table holding the key', '[mcp_servers]\nmemesh = { command = "node" }\n'],
      ['an inline mcp_servers table', 'mcp_servers = { memesh = { command = "node" } }\n'],
      ['a quoted mcp_servers table', '["mcp_servers".memesh]\ncommand = "node"\n'],
      ['a quoted mcp_servers dotted key', '"mcp_servers".memesh.command = "node"\n'],
    ])('refuses a config that already defines the server as %s', (_label, content) => {
      const home = makeDir();
      try {
        fs.writeFileSync(path.join(home, 'config.toml'), content);
        expect(() => appendCodexMessageToolApproval({ codexHome: home, toml })).toThrow(/already configures/);
        expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(content);
      } finally { cleanup(home); }
    });

    it('still appends to a config that only names other MCP servers', () => {
      const home = makeDir();
      try {
        fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.memesh_other]\ncommand = "node"\n');
        expect(appendCodexMessageToolApproval({ codexHome: home, toml })).toBe(path.join(home, 'config.toml'));
      } finally { cleanup(home); }
    });
  });

  it('asks the model to fetch and record intake instead of forbidding every tool', () => {
    expect(CODEX_PROOF_PROMPT).toMatch(/fetch/i);
    expect(CODEX_PROOF_PROMPT).toMatch(/intake/i);
    expect(CODEX_PROOF_PROMPT).toMatch(/message tool/i);
    expect(CODEX_PROOF_PROMPT).not.toMatch(/do not (run commands or )?call tools\.?$/i);
    expect(CODEX_PROOF_PROMPT).toMatch(/do not run commands/i);
  });

  it('names no identifier the model could copy instead of fetching', () => {
    expect(CODEX_PROOF_PROMPT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(CODEX_PROOF_PROMPT).not.toMatch(/codex-[0-9a-f]{8}/);
  });

  it('verifies the server entry file in the cache like the other plugin files', () => {
    expect(CODEX_PLUGIN_CANDIDATE_FILES).toContain('dist/mcp/server.js');
    expect(CODEX_PLUGIN_CANDIDATE_FILES).toContain('.codex-plugin/mcp.json');
  });

  it.skipIf(process.platform === 'win32' || !fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'mcp', 'server.js')))(
    'a real server started with that env never creates ~/.memesh, and one without it does', async () => {
      const { spawn } = await import('node:child_process');
      const serverJs = path.join(__dirname, '..', '..', 'dist', 'mcp', 'server.js');
      const until = async (done: () => boolean, ms: number) => {
        const deadline = Date.now() + ms;
        while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        return done();
      };
      const probe = async (withEnv: boolean) => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dir-'));
        try {
          const child = spawn(process.execPath, [serverJs], {
            env: { PATH: process.env.PATH ?? '', HOME: home, ...(withEnv ? { MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'k.db') } : {}) },
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          let out = '';
          child.stdout.on('data', (chunk) => { out += chunk; });
          const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
          write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
          expect(await until(() => out.includes('"id":1'), 10_000)).toBe(true);
          write({ jsonrpc: '2.0', method: 'notifications/initialized' });
          write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'message', arguments: { action: 'discover', project: 'p' } } });
          expect(await until(() => out.includes('"id":2'), 10_000)).toBe(true);
          child.kill();
          return { realHomeTouched: fs.existsSync(path.join(home, '.memesh')), dirFiles: fs.readdirSync(dir) };
        } finally {
          fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
        }
      };
      const explicit = await probe(true);
      expect(explicit.realHomeTouched).toBe(false);
      expect(explicit.dirFiles).toContain('k.db');
      const bare = await probe(false);
      expect(bare.realHomeTouched).toBe(true);
    }, 40_000);
});
