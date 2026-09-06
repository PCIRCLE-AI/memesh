#!/usr/bin/env node

// Owner-run, repeatable live-journey checks for the two host-native delivery
// paths: an ordinary Codex CLI thread (issue #270) and a Claude Code session
// with the memesh-channel development channel admitted (issue #272).
//
// WHY THIS EXISTS, AND WHY IT IS NOT A TEST
//
// `scripts/smoke-packed-artifact.mjs` proves the installed router and adapter
// plumbing with a fake `codex` executable and a stubbed `connectRouterHost()`.
// That is real evidence of the plumbing and no evidence at all that a live
// model ever saw a message. Both issues asked for the missing half: a check
// that binds a REAL active session identity, sends one exact-session message,
// and then requires proof that came out of the model rather than out of the
// database.
//
// The proof shape differs per host, because the two hosts expose different
// model-visible surfaces:
//
//   codex  — the next turn's reply must quote the `message_id` and
//            `delivery_id` from the injected envelope, AND that turn must have
//            run no commands. Both halves are needed: the ids are only
//            unforgeable if the model could not have read them off disk.
//   claude — the session's own model must call `intake` on that message. The
//            intake receipt is written by the recipient session, not by this
//            harness, so its presence is model-visible proof.
//
// This cannot run in CI. It needs the owner's Codex login, or a human at an
// interactive Claude session. It is deliberately a script under `scripts/qa/`
// and NOT a file under `tests/` — a check that cannot run unattended must not
// sit where an unattended runner will find it, and it refuses outright when
// `CI` is set. The parts that CAN be checked without a live host (argument
// parsing, every refusal, every assertion applied to recorded fixtures) are
// exported from here and exercised by `tests/qa/live-journey.test.ts`.
//
// SAFETY BOUNDARY, AND WHERE IT STOPS
//
// Everything MeMesh writes goes to a fresh `mktemp` MEMESH_DIR that is deleted
// on exit. The script refuses to run if that directory would resolve inside the
// owner's `~/.memesh` — checked on REAL paths, before anything is created, so a
// symlinked TMPDIR cannot get past it. It reads no auth file: the Codex
// precondition is the exit code of `codex login status`.
//
// Two things are outside that boundary and are declared in every report:
//
//   1. `codex exec` creates one throwaway thread in the owner's Codex rollout
//      store and `codex queue` appends one message to it. That is the product
//      path under test, and it is session state rather than configuration.
//   2. The interactive Claude session the operator launches is NOT isolated
//      from the owner's installed plugins. The printed command passes
//      `--setting-sources ""` so no user/project/local settings file is loaded,
//      but whether that also excludes plugin-provided hooks and MCP servers is
//      NOT verified here. A plugin hook that runs in that session inherits no
//      MEMESH_DIR and would therefore write the owner's real `~/.memesh`. The
//      operator is told to confirm with `/hooks` and `/mcp` before proceeding.
//
// SHUTDOWN ORDER IS LOAD-BEARING
//
// `src/host-runtime/router-client.ts` makes a connected host that sees the
// router socket disappear spawn a DETACHED packaged router, inheriting its own
// environment — including this check's `MEMESH_DIR` — and `router.ts` recreates
// the data directory on start. Killing the router while a host is still
// connected therefore resurrects the temp directory as an orphan owned by
// nobody. `Journey.shutdown()` unwinds in the only safe order: companion, then
// live sessions, then router, then the directory; and if a session is still
// connected it keeps the directory rather than racing that spawn.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getProjectName } from '../../dist/core/paths.js';

export const PROJECT = 'memesh-live-journey';
export const DEFAULT_WAIT_MS = 300_000;

/** AF_UNIX `sun_path` is 104 bytes on macOS; the router's socket must fit. */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * `codex exec --json` item types this check tolerates on the proof turn.
 * An allowlist, not a denylist: the whole point of the turn is that the model
 * did nothing but answer, so an unrecognised item type must fail loudly rather
 * than be assumed harmless.
 */
export const ALLOWED_CODEX_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'error']);

/**
 * `codex exec --json` event types that are lifecycle, not model action. The
 * no-command check walks EVERY event, not only `item.completed`: a native tool
 * (read_file, view_image) that surfaced under some other event type would
 * otherwise be invisible to an item-only scan. Anything not listed fails closed.
 */
export const ALLOWED_CODEX_EVENT_TYPES = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed', 'error',
]);

/** dist artefacts this check runs. Missing any of them is a refusal, not a skip. */
export const REQUIRED_DIST = [
  'dist/host-runtime/router.js',
  'dist/transports/cli/cli.js',
  'dist/host-runtime/codex-session.js',
  'dist/host-runtime/claude.js',
  'dist/mcp/server.js',
];

export function helpText() {
  return [
    'memesh qa:live-journey — owner-run live host-native delivery checks',
    '',
    'Usage:',
    '  npm run qa:live-journey -- --host codex  [--out report.json] [--keep] [--wait-ms N]',
    '  npm run qa:live-journey -- --host claude [--out report.json] [--keep] [--wait-ms N]',
    '  npm run qa:live-journey -- --codex-session-auto-registration [--out report.json] [--keep]',
    '',
    'Verified invocation on macOS (the socket path must fit AF_UNIX sun_path):',
    '  TMPDIR=/private/tmp npm run qa:live-journey -- --host codex --out report.json',
    '',
    'Options:',
    '  --host <codex|claude>  Which live path to exercise. Required unless using the bounded',
    '                         --codex-session-auto-registration mode.',
    '  --codex-session-auto-registration  Exercise automatic Codex SessionStart registration',
    '                         with a fresh HOME and a task-owned fake `codex queue` executable.',
    '  --out <path>           Write the JSON evidence report here (also written on failure).',
    '  --keep                 Keep the temporary MEMESH_DIR instead of deleting it on exit.',
    `  --wait-ms <N>          Bound for each wait on the operator or the model, default ${DEFAULT_WAIT_MS}.`,
    '                         Only --host claude waits on a person; the codex path is unattended.',
    '  --help                 Print this text.',
    '',
    'Preconditions:',
    '  codex   — `codex` on PATH and `codex login status` reporting a logged-in owner.',
    '            Costs one or two small Codex turns. Creates one throwaway Codex thread',
    '            in the owner\'s Codex rollout store.',
    '  --codex-session-auto-registration — no owner login is needed. Uses the packaged router,',
    '            CLI, and codex-session entrypoints with a fresh HOME/MEMESH_DIR and a task-owned',
    '            fake `codex` executable that records the native queue invocation and exits 0.',
    '  claude  — `claude` on PATH, and the owner launching one interactive session with',
    '            the command this script prints. Print mode (`claude -p`) is NOT supported:',
    '            a print-mode session does not surface memesh-channel notifications to the',
    '            model even when the channel host reports the frame accepted (issue #275),',
    '            so it can never produce the model-visible proof this check requires.',
    '',
    'Refuses to run on Windows (the host-native runtime it exercises is macOS/Linux only),',
    'when CI is set, when dist/ is not built, or when the temporary MEMESH_DIR would',
    'resolve inside the owner\'s ~/.memesh.',
    '',
    'Two things sit OUTSIDE the temporary-directory isolation, and the report says so:',
    '  - Codex registration is harness-driven. The shipped codex-session companion is fed',
    '    the SessionStart payload the packaged plugin hook would have supplied; only',
    '    dispatch -> `codex queue` -> model-visible reply is product-path evidence.',
    '  - The interactive Claude session you launch runs with the owner\'s installed plugins.',
    '    The printed command passes --setting-sources "" so no settings file is loaded, but',
    '    that is NOT verified to exclude plugin-provided hooks or MCP servers. A plugin hook',
    '    running there inherits no MEMESH_DIR and would write the REAL ~/.memesh. Confirm',
    '    with /hooks and /mcp that only the two servers from --mcp-config are loaded.',
  ].join('\n');
}

/**
 * @param {string[]} argv arguments after the script path
 * @returns {{help: boolean, host: string|null, mode: string|null, out: string|null, keep: boolean, waitMs: number}}
 */
export function parseArgs(argv) {
  const parsed = {
    help: false,
    host: null,
    mode: null,
    out: null,
    keep: false,
    waitMs: DEFAULT_WAIT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value.`);
      index += 1;
      return next;
    };
    if (flag === '--help' || flag === '-h') parsed.help = true;
    else if (flag === '--keep') parsed.keep = true;
    else if (flag === '--codex-session-auto-registration') parsed.mode = 'codex-session-auto-registration';
    else if (flag === '--host') parsed.host = value();
    else if (flag === '--out') parsed.out = value();
    else if (flag === '--wait-ms') {
      const raw = Number(value());
      if (!Number.isSafeInteger(raw) || raw < 1_000 || raw > 3_600_000) {
        throw new Error('--wait-ms must be a whole number of milliseconds between 1000 and 3600000.');
      }
      parsed.waitMs = raw;
    } else throw new Error(`Unknown argument ${flag}. Run with --help.`);
  }
  if (parsed.help) return parsed;
  if (parsed.mode !== null && parsed.host !== null) {
    throw new Error('--codex-session-auto-registration cannot be combined with --host. Run with --help.');
  }
  if (parsed.host === null && parsed.mode === null) {
    throw new Error('--host is required (codex | claude), or use --codex-session-auto-registration. Run with --help.');
  }
  if (parsed.host !== 'codex' && parsed.host !== 'claude') {
    if (parsed.mode !== null) return parsed;
    throw new Error(`--host must be codex or claude, not ${parsed.host}.`);
  }
  return parsed;
}

/**
 * The host-native router, its Unix socket and the managed host adapters are
 * macOS/Linux only (docs/platforms/agent-messaging.md: Windows keeps core
 * memory, durable messaging and MCP, but host-native wakeup fails closed).
 * This check exists to exercise exactly that runtime, so on Windows it has
 * nothing to prove and refuses rather than failing later at a socket it can
 * never bind.
 *
 * @param {string} platform `process.platform`
 */
export function assertSupportedPlatform(platform) {
  if (platform === 'win32') {
    throw new Error(
      'Refusing to run: the host-native router and adapters this check exercises are macOS/Linux only '
      + '(see docs/platforms/agent-messaging.md). On Windows, MeMesh keeps core memory, durable messaging '
      + 'and MCP, but there is no host-native wakeup for this check to prove.',
    );
  }
}

/**
 * "Never runs in CI" is worth nothing as prose. Both checks need either the
 * owner's Codex login or a person at a terminal, so an automated runner that
 * reaches this line is already misconfigured.
 *
 * @param {Record<string, string|undefined>} env
 */
export function assertNotCi(env) {
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0') {
    throw new Error(
      'Refusing to run: CI is set. These checks need the owner\'s Codex login or a person at an '
      + 'interactive Claude session, and must never be wired into an automated pipeline.',
    );
  }
}

/**
 * Refuse to run against the owner's real knowledge graph.
 *
 * This compares REAL paths, and the caller runs it BEFORE creating anything: a
 * `path.resolve` prefix test alone is satisfied by a TMPDIR that is a symlink
 * into `~/.memesh`, which is precisely the case that would delete real memory.
 *
 * @param {{candidates: Record<string, string>, home: string, realpath: (p: string) => string}} input
 */
export function assertOutsideOwnerMemesh(input) {
  const forbidden = input.realpath(path.join(path.resolve(input.home), '.memesh'));
  for (const [label, candidate] of Object.entries(input.candidates)) {
    const resolved = input.realpath(candidate);
    if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(
        `Refusing to run: ${label} resolves to ${resolved}, inside the owner's ${forbidden}. `
        + 'This check creates and deletes its own data directory and must never be pointed at real memory.',
      );
    }
  }
}

/**
 * Resolve as far as the filesystem allows, then normalise the rest. A path that
 * does not exist yet (the temp directory before `mkdtemp`) still has to be
 * judged, and its nearest existing ancestor is what a symlink would hide in.
 *
 * @param {string} candidate
 */
export function realpathAsFarAsPossible(candidate) {
  let current = path.resolve(candidate);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The router's Unix socket lives beside the database. macOS caps `sun_path` at
 * 104 bytes, and the default `os.tmpdir()` on macOS is already ~50 of them, so
 * a long report path or a deep TMPDIR silently produces an unbindable socket.
 * Catch it here, with the fix, instead of as a router that never starts.
 *
 * @param {string} socketPath
 */
export function assertSocketPathFits(socketPath) {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Refusing to run: the router socket path is ${bytes} bytes (${socketPath}), over the ${MAX_SOCKET_PATH_BYTES}-byte `
      + 'AF_UNIX limit. Re-run with a shorter temporary root, e.g. TMPDIR=/private/tmp.',
    );
  }
}

/**
 * @param {string} repoRoot
 * @param {(file: string) => boolean} [exists] injectable for tests
 */
export function assertDistPresent(repoRoot, exists = (file) => fs.existsSync(file)) {
  const missing = REQUIRED_DIST.filter((relative) => !exists(path.join(repoRoot, relative)));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run: this repository has no built dist/ for ${missing.join(', ')}. Run \`npm run build\` first.`,
    );
  }
}

/**
 * A report that names a revision is claiming the code it exercised is that
 * revision. `dist/` is what actually ran, so if any of it predates the newest
 * source file the report must say so rather than imply a rebuild happened.
 *
 * @param {{newestSrcMs: number, oldestDistMs: number}} input
 */
export function isDistStale(input) {
  return input.oldestDistMs < input.newestSrcMs;
}

/** @param {string} text JSONL as emitted by `codex exec --json` */
export function parseJsonl(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A partial or interleaved line is not evidence of anything; the
      // assertions below fail closed when the event they need is absent.
    }
  }
  return events;
}

/** @param {string} text @returns {string} the thread id Codex printed */
export function parseCodexThreadId(text) {
  for (const event of parseJsonl(text)) {
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.length > 0) {
      return event.thread_id;
    }
  }
  throw new Error('Codex emitted no `thread.started` event, so there is no thread to register.');
}

/** @param {string} text @returns {string[]} every agent message in the turn */
export function collectCodexAgentMessages(text) {
  const messages = [];
  for (const event of parseJsonl(text)) {
    const item = event?.item;
    if (event?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      messages.push(item.text);
    }
  }
  return messages;
}

/**
 * The half of the Codex proof that is easy to forget.
 *
 * `message_id` is only unforgeable if the model had no other way to obtain it,
 * and a `read-only` Codex sandbox still permits reads: a single `cat` of the
 * temporary database or of this run's own turn-1 log would hand the model every
 * id in it. So the proof turn must have produced nothing but an answer. Any
 * command execution, tool call, or unrecognised item type fails the check.
 *
 * @param {string} text turn JSONL
 */
export function assertCodexRanNoCommands(text) {
  const offending = [];
  for (const event of parseJsonl(text)) {
    const type = event?.type;
    if (typeof type !== 'string' || !ALLOWED_CODEX_EVENT_TYPES.has(type)) {
      offending.push(`event:${typeof type === 'string' ? type : '<unknown>'}`);
      continue;
    }
    if (!type.startsWith('item.')) continue;
    const kind = event.item?.type;
    if (typeof kind !== 'string' || !ALLOWED_CODEX_ITEM_TYPES.has(kind)) {
      offending.push(`item:${typeof kind === 'string' ? kind : '<unknown>'}`);
    }
  }
  if (offending.length > 0) {
    throw new Error(
      `The Codex proof turn produced non-answer items (${[...new Set(offending)].join(', ')}). `
      + 'The reply cannot be treated as model-visible proof, because a turn that runs commands could have '
      + 'read the identifiers off disk instead of out of the envelope.',
    );
  }
}

/**
 * The model-visible half of the Codex claim.
 *
 * The prompt that produced this reply names neither the sentinel nor either id
 * — it only says "substitute the values from that envelope". Paired with
 * `assertCodexRanNoCommands`, a reply carrying the exact `message_id` is proof
 * the envelope reached the model. The sentinel alone is not: it is the only one
 * of the three a model could in principle guess, which is why the ids matter.
 *
 * @param {{jsonl: string, sentinel: string, messageId: string, deliveryId: string}} input
 */
export function assertCodexReply(input) {
  assertCodexRanNoCommands(input.jsonl);
  const messages = collectCodexAgentMessages(input.jsonl);
  if (messages.length === 0) throw new Error('Codex produced no agent message on the resume turn.');
  const joined = messages.join('\n');
  if (/\bNO_ENVELOPE\b/.test(joined)) {
    throw new Error('Codex replied NO_ENVELOPE: the queued envelope was not visible to the model.');
  }
  const token = `CODEX_RECEIVED_${input.sentinel}`;
  if (!joined.includes(token)) {
    throw new Error(`Codex reply does not contain ${token}. Reply was: ${joined}`);
  }
  if (!joined.includes(input.messageId)) {
    throw new Error(
      `Codex reply does not quote message_id ${input.messageId}; without it the sentinel proves nothing. Reply was: ${joined}`,
    );
  }
  if (!joined.includes(input.deliveryId)) {
    throw new Error(`Codex reply does not quote delivery_id ${input.deliveryId}. Reply was: ${joined}`);
  }
  return joined;
}

/**
 * `send` returning a message row is NOT delivery. Only
 * `native_delivery.status === "native_accepted"` means a host took the frame —
 * and the receipt has to describe the delivery and the session we addressed,
 * or it is a receipt for something else.
 *
 * @param {unknown} result parsed `message send` stdout
 * @param {{adapterKind: string, recipient: string}} expected
 */
export function assertNativeAccepted(result, expected) {
  if (result === null || typeof result !== 'object') throw new Error('message send returned no JSON object.');
  const record = /** @type {Record<string, unknown>} */ (result);
  const native = record.native_delivery;
  if (native === null || typeof native !== 'object') {
    throw new Error('message send returned no native_delivery block, so nothing proves a host accepted it.');
  }
  const nativeRecord = /** @type {Record<string, unknown>} */ (native);
  if (nativeRecord.status !== 'native_accepted') {
    throw new Error(`native_delivery.status is ${JSON.stringify(nativeRecord.status)}, not "native_accepted".`);
  }
  if (nativeRecord.adapter_kind !== expected.adapterKind) {
    throw new Error(
      `native_delivery.adapter_kind is ${JSON.stringify(nativeRecord.adapter_kind)}, not ${JSON.stringify(expected.adapterKind)}.`,
    );
  }
  if (typeof record.message_id !== 'string' || typeof record.delivery_id !== 'string') {
    throw new Error('message send returned no message_id/delivery_id pair.');
  }
  if (nativeRecord.delivery_id !== record.delivery_id) {
    throw new Error(
      `native_delivery.delivery_id ${JSON.stringify(nativeRecord.delivery_id)} does not match the message's `
      + `delivery_id ${JSON.stringify(record.delivery_id)}; the acceptance describes a different delivery.`,
    );
  }
  if (record.recipient !== expected.recipient) {
    throw new Error(
      `message send reports recipient ${JSON.stringify(record.recipient)}, not ${JSON.stringify(expected.recipient)}.`,
    );
  }
  const receipt = nativeRecord.receipt;
  const threadId = receipt !== null && typeof receipt === 'object'
    ? /** @type {Record<string, unknown>} */ (receipt).thread_id
    : undefined;
  if (threadId !== undefined && threadId !== expected.recipient) {
    throw new Error(
      `the host receipt names thread ${JSON.stringify(threadId)}, not the session we addressed `
      + `(${JSON.stringify(expected.recipient)}).`,
    );
  }
  return { messageId: record.message_id, deliveryId: record.delivery_id, native: nativeRecord };
}

/**
 * The failure path. `recipient_unavailable` is a SHARED failure surface: the
 * same string comes back when the sender cannot reach the router. So the caller
 * must pair this with proof that the router is still answering and the durable
 * row survived — see `Journey.provesFailClosed`, which asserts both.
 *
 * A null status means the CLI was killed (timeout, signal) rather than having
 * decided anything, and must not be read as a fail-closed result.
 *
 * @param {{status: number|null, stderr: string}} outcome
 */
export function assertRecipientUnavailable(outcome) {
  if (outcome.status === null) {
    throw new Error('The send process was killed before it produced an exit status; that is not a fail-closed result.');
  }
  if (outcome.status === 0) {
    throw new Error('Sending to the stopped session succeeded; the exact-session target did not fail closed.');
  }
  if (!/recipient_unavailable/.test(outcome.stderr)) {
    throw new Error(`Expected recipient_unavailable on stderr, got: ${outcome.stderr.trim() || '<empty>'}`);
  }
}

/**
 * @param {unknown} receipts parsed `message receipts` stdout
 * @param {{messageId: string, actor: string}} expected
 */
export function findIntakeReceipt(receipts, expected) {
  if (!Array.isArray(receipts)) return null;
  return receipts.find((fact) => (
    fact !== null && typeof fact === 'object'
    && fact.receipt_kind === 'intake'
    && fact.message_id === expected.messageId
    && fact.actor === expected.actor
  )) ?? null;
}

/**
 * @param {unknown} receipts
 * @param {{messageId: string, actor: string}} expected
 */
export function assertIntakeReceipt(receipts, expected) {
  const found = findIntakeReceipt(receipts, expected);
  if (!found) {
    throw new Error(
      `No intake receipt written by ${expected.actor} for message ${expected.messageId}. `
      + 'host_accept alone proves the channel took the frame, not that the model read it.',
    );
  }
  return found;
}

/**
 * Readback proof for the bounded automatic-registration journey. A successful
 * `send` response is not enough: the durable projection must contain the
 * host_accept written by the router and must still contain no model lifecycle
 * facts (ACK or workflow disposition).
 *
 * @param {unknown} receipts parsed `message receipts` stdout
 * @param {{messageId: string, deliveryId: string, adapterKind: string, recipient: string}} expected
 */
export function assertHostAcceptOnly(receipts, expected) {
  if (!Array.isArray(receipts)) throw new Error('message receipts returned no JSON array.');
  const matching = receipts.filter((fact) => (
    fact !== null && typeof fact === 'object' && fact.message_id === expected.messageId
  ));
  const hostAccept = matching.find((fact) => fact.receipt_kind === 'host_accept');
  if (!hostAccept) {
    throw new Error(`No durable host_accept receipt was read back for message ${expected.messageId}.`);
  }
  if (hostAccept.recipient !== expected.recipient) {
    throw new Error(`Durable host_accept names recipient ${JSON.stringify(hostAccept.recipient)}, not ${JSON.stringify(expected.recipient)}.`);
  }
  if (hostAccept.delivery_id !== expected.deliveryId) {
    throw new Error(`Durable host_accept names delivery ${JSON.stringify(hostAccept.delivery_id)}, not ${JSON.stringify(expected.deliveryId)}.`);
  }
  if (hostAccept.adapter_kind !== expected.adapterKind) {
    throw new Error(`Durable host_accept names adapter ${JSON.stringify(hostAccept.adapter_kind)}, not ${JSON.stringify(expected.adapterKind)}.`);
  }
  const lifecycle = matching.filter((fact) => fact.receipt_kind === 'ack' || fact.receipt_kind === 'disposition');
  if (lifecycle.length > 0) {
    throw new Error(
      `Durable receipts unexpectedly include ${lifecycle.map((fact) => fact.receipt_kind).join(', ')}; `
      + 'host_accept must not imply ACK or disposition.',
    );
  }
  return hostAccept;
}

/**
 * The failed exact-session send still creates a durable payload, but must not
 * create any host or model lifecycle fact when no companion is live.
 *
 * @param {unknown} receipts parsed `message receipts` stdout
 * @param {{messageId: string}} expected
 */
export function assertNoHostOutcomeReceipts(receipts, expected) {
  if (!Array.isArray(receipts)) throw new Error('message receipts returned no JSON array.');
  const matching = receipts.filter((fact) => (
    fact !== null && typeof fact === 'object' && fact.message_id === expected.messageId
  ));
  const outcomes = matching.filter((fact) => (
    fact.receipt_kind === 'host_accept' || fact.receipt_kind === 'ack' || fact.receipt_kind === 'disposition'
  ));
  if (outcomes.length > 0) {
    throw new Error(
      `Durable receipts unexpectedly include ${outcomes.map((fact) => fact.receipt_kind).join(', ')}; `
      + 'an unavailable exact-session send must have no host_accept, ACK, or disposition.',
    );
  }
  return matching;
}

/**
 * Require a one-to-one mapping between exact-session sends and native queue
 * invocations. Extra, duplicate, crossed, or rewritten envelopes all fail.
 *
 * @param {unknown[]} invocations task-owned codex queue records
 * @param {Array<{sessionId: string, messageId: string, deliveryId: string}>} messages
 */
export function assertExactCodexQueueRouting(invocations, messages) {
  if (!Array.isArray(invocations) || invocations.length !== messages.length) {
    throw new Error(`The task-owned codex queue stub recorded ${invocations?.length ?? 'invalid'} invocations for ${messages.length} sends.`);
  }
  return messages.map((message) => {
    const matching = invocations.filter((entry) => entry?.thread_id === message.sessionId);
    if (matching.length !== 1) {
      throw new Error(`The task-owned codex queue stub recorded ${matching.length} invocations for ${message.sessionId}, expected exactly one.`);
    }
    const invocation = matching[0];
    let serialized;
    try { serialized = JSON.parse(invocation.serialized_message); } catch {
      throw new Error('The task-owned codex queue stub received invalid serialized native JSON.');
    }
    const envelope = serialized?.envelope;
    if (serialized?.message_type !== 'memesh_message'
      || serialized?.delivery_id !== message.deliveryId
      || envelope?.message_id !== message.messageId
      || envelope?.recipient !== message.sessionId) {
      throw new Error(`The native queue envelope crossed exact-session boundaries: ${JSON.stringify(serialized)}.`);
    }
    return { message, invocation, envelope };
  });
}

/**
 * @param {unknown} discovered parsed `message discover` stdout
 * @param {{hostKind?: string, sessionId?: string}} filter
 */
export function findLiveCards(discovered, filter = {}) {
  const cards = discovered !== null && typeof discovered === 'object'
    ? /** @type {Record<string, unknown>} */ (discovered).cards
    : undefined;
  if (!Array.isArray(cards)) return [];
  return cards.filter((card) => (
    card !== null && typeof card === 'object'
    && (filter.hostKind === undefined || card.host_kind === filter.hostKind)
    && (filter.sessionId === undefined || card.session_id === filter.sessionId)
  ));
}

/**
 * Require an independent discover response to contain exactly the expected
 * live Codex cards. This is intentionally strict: a response from the wrong
 * project, thread, or principal is not evidence of a successful discover.
 *
 * @param {unknown} discovered parsed `message discover` response
 * @param {Array<{session_id: string, principal_id: string, project: string}>} expected
 */
export function assertMcpDiscoverCards(discovered, expected) {
  const cards = findLiveCards(discovered, { hostKind: 'codex' });
  if (cards.length !== expected.length) {
    throw new Error(`MCP discover returned ${cards.length} Codex cards, expected exactly ${expected.length}.`);
  }
  const expectedBySession = new Map(expected.map((card) => [card.session_id, card]));
  const seen = new Set();
  for (const card of cards) {
    const wanted = expectedBySession.get(card.session_id);
    if (!wanted || seen.has(card.session_id) || card.principal_id !== wanted.principal_id || card.project !== wanted.project) {
      throw new Error(`MCP discover returned an identity-mismatched live card: ${JSON.stringify(card)}.`);
    }
    seen.add(card.session_id);
  }
  if (seen.size !== expectedBySession.size) {
    throw new Error('MCP discover did not return every expected exact-session card.');
  }
  return cards;
}

/**
 * Wait for one live host session to leave the router directory.
 *
 * This is the decision that keeps a shutdown from creating an orphan, so it is
 * separated from the I/O it drives and tested on both outcomes. A host that is
 * still connected when the router dies starts a detached replacement pointing
 * at the temporary directory, so "still there after the bound" must be
 * answerable, not merely unlikely.
 *
 * @param {{
 *   sessionId: string|null,
 *   isGone: (sessionId: string) => boolean,
 *   waitMs: number,
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   announce: (text: string) => void,
 * }} input
 * @returns {Promise<boolean>} true when nothing is connected any more
 */
export async function awaitSessionDisconnect(input) {
  if (input.sessionId === null) return true;
  const deadline = input.now() + input.waitMs;
  let announced = false;
  while (!input.isGone(input.sessionId)) {
    if (input.now() >= deadline) return false;
    if (!announced) {
      input.announce(
        'Waiting for the Claude session to disconnect before stopping the router.\n'
        + 'Exit the Claude session first (Ctrl-D or /exit) — a session that outlives the router\n'
        + 'will start a detached replacement pointing at this temporary directory.',
      );
      announced = true;
    }
    await input.sleep(1_000);
  }
  return true;
}

/**
 * Deleting a directory a live host is about to recreate is worse than leaving
 * it: the recreated copy is owned by nobody and named in no report.
 *
 * @param {{keep: boolean, keptForSafety: boolean}} input
 */
export function shouldRemoveWorkingDirectories(input) {
  return !input.keep && !input.keptForSafety;
}

// ---------------------------------------------------------------------------
// Everything below performs I/O. The live run exercises it; the tests do not.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function dist(relative) {
  return path.join(repoRoot, relative);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/** Newest mtime under a directory tree, in ms. Used for the dist-staleness note. */
function newestMtimeMs(root) {
  let newest = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(root);
  return newest;
}

/** Wait for a child to exit, bounded, escalating to SIGKILL. Never throws. */
async function stopChild(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return 'already-exited';
  const exited = new Promise((resolve) => child.once('exit', () => resolve('exited')));
  try {
    child.kill('SIGTERM');
  } catch {
    return 'already-exited';
  }
  const outcome = await Promise.race([exited, sleep(timeoutMs).then(() => 'timeout')]);
  if (outcome !== 'timeout') return 'exited';
  try {
    child.kill('SIGKILL');
  } catch {
    // Nothing left to kill is the outcome we wanted.
  }
  await Promise.race([exited, sleep(2_000)]);
  return 'killed';
}

/** One live-journey run: owns the temp directories, the child processes and the report. */
class Journey {
  constructor(options) {
    this.options = options;
    this.steps = [];
    this.limitations = [];
    this.router = null;
    this.companions = [];
    this.liveSessionIds = new Set();
    this.lastDurableMessageId = null;
    this.keptForSafety = false;
    this.home = null;
    this.codexQueueLog = null;
    this.project = PROJECT;

    // Judge the temporary root on REAL paths BEFORE creating anything: a
    // symlinked TMPDIR is exactly the case a resolve-only prefix test misses.
    const tmpRoot = os.tmpdir();
    assertOutsideOwnerMemesh({
      candidates: { TMPDIR: tmpRoot },
      home: os.homedir(),
      realpath: realpathAsFarAsPossible,
    });

    // Measure the socket path BEFORE creating anything, on the real temp root
    // (os.tmpdir() may be a symlink to a longer path), so a refusal leaves no
    // empty directory behind. mkdtemp appends six characters.
    assertSocketPathFits(path.join(realpathAsFarAsPossible(tmpRoot), 'memesh-lj-XXXXXX', 'memesh', 'agent-router-v2.sock'));
    this.dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'memesh-lj-')));
    this.memeshDir = path.join(this.dir, 'memesh');
    this.dbPath = path.join(this.memeshDir, 'knowledge-graph.db');
    this.socketPath = path.join(this.memeshDir, 'agent-router-v2.sock');
    this.legacySocketPath = path.join(this.memeshDir, 'agent-router.sock');
    this.legacyServer = null;
    this.legacyConnections = new Set();
    this.legacySocketIdentity = null;
    this.legacyResponse = Object.freeze({
      version: 1,
      request_id: '',
      ok: false,
      error: Object.freeze({ code: 'unsupported_type', message: 'Unsupported router frame type.' }),
    });
    fs.mkdirSync(this.memeshDir, { recursive: true, mode: 0o700 });
    this.env = { ...process.env, MEMESH_DIR: this.memeshDir, MEMESH_DB_PATH: this.dbPath };
    if (options.mode === 'codex-session-auto-registration') {
      this.home = path.join(this.dir, 'home');
      fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
      this.env = { ...this.env, HOME: this.home, USERPROFILE: this.home };
    }

    // The Codex workspace is a SEPARATE temporary tree. Keeping it out of
    // `this.dir` means the database and this run's own logs are not sitting one
    // `..` away from the directory the model is pointed at.
    this.workspace = null;
  }

  step(name, evidence) {
    this.steps.push({ step: this.steps.length + 1, name, status: 'PASS', at: new Date().toISOString(), ...evidence });
    process.stdout.write(`  ok   ${name}\n`);
  }

  note(text) {
    this.limitations.push(text);
  }

  say(text) {
    process.stdout.write(`${text}\n`);
  }

  cli(args, options = {}) {
    return run(process.execPath, [dist('dist/transports/cli/cli.js'), ...args], { env: this.env, ...options });
  }

  cliJson(args, options = {}) {
    const outcome = this.cli(args, options);
    if (outcome.status !== 0) {
      throw new Error(`memesh ${args.join(' ')} exited ${outcome.status}: ${outcome.stderr.trim() || outcome.stdout.trim()}`);
    }
    try {
      return JSON.parse(outcome.stdout);
    } catch {
      throw new Error(`memesh ${args.join(' ')} did not print JSON: ${outcome.stdout.slice(0, 400)}`);
    }
  }

  discover() {
    return this.cliJson(['message', 'discover', '--project', this.project]);
  }

  async mcpDiscover(expected) {
    const clients = [0, 1].map((index) => new Client({ name: `live-journey-discover-${index}`, version: '1.0.0' }));
    const transports = clients.map(() => new StdioClientTransport({
      command: process.execPath,
      args: [dist('dist/mcp/server.js')],
      env: { ...this.env, MEMESH_AUTO_CAPTURE: 'false' },
    }));
    try {
      await Promise.all(clients.map((client, index) => client.connect(transports[index])));
      const results = await Promise.all(clients.map((client) => client.callTool({
        name: 'message',
        arguments: { action: 'discover', project: this.project, limit: 50 },
      })));
      return results.map((result, index) => {
        if (result?.isError) throw new Error(`Packaged MCP discover client ${index + 1} returned an error.`);
        const text = result?.content?.find((block) => block?.type === 'text')?.text;
        if (typeof text !== 'string') throw new Error(`Packaged MCP discover client ${index + 1} returned no JSON text.`);
        let discovered;
        try { discovered = JSON.parse(text); } catch { throw new Error(`Packaged MCP discover client ${index + 1} returned invalid JSON.`); }
        return assertMcpDiscoverCards(discovered, expected);
      });
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  }

  watch(recipient) {
    const outcome = this.cli([
      'message', 'watch',
      '--project', this.project,
      '--recipient', recipient,
      '--wait-ms', '0',
      '--limit', '50',
    ]);
    if (outcome.status !== 0) {
      throw new Error(`memesh message watch exited ${outcome.status}: ${outcome.stderr.trim()}`);
    }
    const events = parseJsonl(outcome.stdout);
    return events.find((event) => event.type === 'events') ?? { events: [] };
  }

  /** True when nothing is registered for `sessionId` any more. Never throws. */
  sessionGone(sessionId) {
    try {
      return findLiveCards(this.discover(), { sessionId }).length === 0;
    } catch {
      return false;
    }
  }

  trackLiveSession(sessionId) {
    this.liveSessionIds.add(sessionId);
  }

  forgetLiveSession(sessionId) {
    this.liveSessionIds.delete(sessionId);
  }

  createCodexWorkspace() {
    this.workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-lj-ws-')));
    const initialized = run('git', ['init', '--quiet', this.workspace]);
    if (initialized.status !== 0) {
      throw new Error(`Could not initialize the task-owned Codex workspace: ${initialized.stderr.trim()}`);
    }
    const identified = run('git', [
      '-C', this.workspace, 'remote', 'add', 'origin', `https://example.invalid/${PROJECT}.git`,
    ]);
    if (identified.status !== 0) {
      throw new Error(`Could not identify the task-owned Codex workspace: ${identified.stderr.trim()}`);
    }
    this.project = getProjectName(this.workspace);
    return this.workspace;
  }

  installCodexQueueStub() {
    const bin = path.join(this.dir, 'bin');
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    this.codexQueueLog = path.join(this.dir, 'codex-queue.jsonl');
    const executable = path.join(bin, 'codex');
    fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs';

if (process.argv[2] !== 'queue' || process.argv[3] !== '--thread' || process.argv[5] !== '--message') {
  process.stderr.write('task-owned codex stub only supports codex queue --thread <id> --message <json>\\n');
  process.exit(2);
}
const record = {
  command: process.argv.slice(2),
  thread_id: process.argv[4],
  serialized_message: process.argv[6],
};
fs.appendFileSync(process.env.MEMESH_FAKE_CODEX_QUEUE_LOG, JSON.stringify(record) + '\\n');
`, { mode: 0o700 });
    fs.chmodSync(executable, 0o700);
    this.env = {
      ...this.env,
      PATH: `${bin}${path.delimiter}${this.env.PATH ?? ''}`,
      MEMESH_FAKE_CODEX_QUEUE_LOG: this.codexQueueLog,
    };
    return executable;
  }

  readCodexQueueInvocations() {
    if (!this.codexQueueLog || !fs.existsSync(this.codexQueueLog)) return [];
    return fs.readFileSync(this.codexQueueLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error('The task-owned codex queue stub wrote invalid JSON.');
      }
    });
  }

  startCodexCompanion(threadId, workspace, logName, source = 'startup') {
    const log = fs.openSync(path.join(this.dir, logName), 'a');
    const companion = spawn(process.execPath, [dist('dist/host-runtime/codex-session.js')], {
      env: { ...this.env, PLUGIN_ROOT: repoRoot },
      stdio: ['pipe', log, log],
      detached: true,
    });
    this.companions.push(companion);
    companion.stdin.end(JSON.stringify({
      hook_event_name: 'SessionStart',
      source,
      session_id: threadId,
      cwd: workspace,
    }));
    return companion;
  }

  async stopCodexCompanion(companion) {
    await stopChild(companion);
    this.companions = this.companions.filter((candidate) => candidate !== companion);
  }

  startRouter() {
    const log = fs.openSync(path.join(this.dir, 'router.log'), 'a');
    // detached: the router gets its own process group, so a terminal Ctrl-C
    // reaches the harness (which unwinds in order) and not the router first —
    // a router killed while a host is still connected is what spawns an orphan.
    this.router = spawn(process.execPath, [dist('dist/host-runtime/router.js')], {
      env: this.env,
      stdio: ['ignore', log, log],
      detached: true,
    });
    return this.router;
  }

  async startLegacyRouter() {
    if (this.legacyServer) throw new Error('The task-owned legacy router listener was already started.');
    const server = net.createServer((socket) => {
      this.legacyConnections.add(socket);
      socket.once('close', () => this.legacyConnections.delete(socket));
      socket.on('data', () => socket.write(`${JSON.stringify(this.legacyResponse)}\n`));
    });
    this.legacyServer = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.legacySocketPath, () => resolve());
      });
      fs.chmodSync(this.legacySocketPath, 0o700);
      const stat = fs.lstatSync(this.legacySocketPath);
      if (!stat.isSocket()) throw new Error(`The legacy router path is not a Unix socket: ${this.legacySocketPath}`);
      this.legacySocketIdentity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      await this.stopLegacyRouter();
      throw error;
    }
  }

  async probeLegacyRouter() {
    if (!this.legacyServer?.listening) throw new Error('The task-owned legacy router listener is not listening.');
    const expected = JSON.stringify(this.legacyResponse);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.legacySocketPath);
      let data = '';
      const finish = (error, response) => {
        socket.destroy();
        if (error) reject(error);
        else resolve(response);
      };
      socket.setTimeout(2_000, () => finish(new Error('The task-owned legacy router listener did not answer its probe.')));
      socket.once('error', (error) => finish(error));
      socket.on('data', (chunk) => {
        data += chunk.toString();
        const newline = data.indexOf('\n');
        if (newline >= 0) {
          const line = data.slice(0, newline);
          if (line !== expected) {
            finish(new Error(`The legacy router returned the wrong v1 response: ${line}`));
          } else {
            try { finish(null, JSON.parse(line)); } catch { finish(new Error('The legacy router returned invalid JSON.')); }
          }
        }
      });
      socket.once('connect', () => socket.write('{"version":1,"type":"probe","request_id":"legacy-probe"}\n'));
    });
  }

  async assertLegacyRouterUntouched() {
    if (!this.legacyServer?.listening || !this.legacySocketIdentity) {
      throw new Error('The task-owned legacy router listener is no longer listening.');
    }
    let stat;
    try { stat = fs.lstatSync(this.legacySocketPath); } catch (error) {
      throw new Error(`The task-owned legacy router socket disappeared: ${error.message}`, { cause: error });
    }
    if (!stat.isSocket()
      || stat.dev !== this.legacySocketIdentity.dev
      || stat.ino !== this.legacySocketIdentity.ino) {
      throw new Error('The task-owned legacy router socket inode was replaced or modified.');
    }
    const response = await this.probeLegacyRouter();
    if (JSON.stringify(response) !== JSON.stringify(this.legacyResponse)) {
      throw new Error(`The task-owned legacy router response changed: ${JSON.stringify(response)}`);
    }
    return { path: this.legacySocketPath, dev: stat.dev, ino: stat.ino, response };
  }

  async stopLegacyRouter() {
    const server = this.legacyServer;
    if (server) {
      for (const socket of this.legacyConnections) socket.destroy();
      await new Promise((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
      this.legacyServer = null;
      this.legacyConnections.clear();
      const identity = this.legacySocketIdentity;
      this.legacySocketIdentity = null;
      if (identity) {
        try {
          const stat = fs.lstatSync(this.legacySocketPath);
          if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) fs.unlinkSync(this.legacySocketPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  async waitForRouterSocket(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(this.socketPath)) return;
      await sleep(200);
    }
    throw new Error(`The router did not create ${this.socketPath} within ${timeoutMs} ms.`);
  }

  /**
   * Poll a predicate until it holds or the bound expires. `describe` is what
   * the failure says, so it must name the thing that did not happen — never a
   * generic timeout.
   */
  async until(describe, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const outcome = await predicate();
      if (outcome) return outcome;
      await sleep(1_000);
    }
    throw new Error(`${describe} (waited ${Math.round(timeoutMs / 1000)} s)`);
  }

  send(recipient, sentinel, idempotencyKey) {
    const payload = JSON.stringify({
      qa_sentinel: sentinel,
      instruction: 'No action required. MeMesh owner-run live journey check; run no commands.',
    });
    return this.cli([
      'message', 'send',
      '--project', this.project,
      '--sender', 'memesh-live-journey-harness',
      '--recipient', recipient,
      '--target-kind', 'session',
      '--idempotency-key', idempotencyKey,
      '--payload-stdin',
      '--content-type', 'application/json',
      '--privacy', 'private',
    ], { input: payload });
  }

  sendAccepted(recipient, sentinel, idempotencyKey, adapterKind) {
    const outcome = this.send(recipient, sentinel, idempotencyKey);
    if (outcome.status !== 0) {
      throw new Error(`message send exited ${outcome.status}: ${outcome.stderr.trim()}`);
    }
    return assertNativeAccepted(JSON.parse(outcome.stdout), { adapterKind, recipient });
  }

  /**
   * The fail-closed half. `recipient_unavailable` is returned both when the
   * recipient session is gone AND when the sender cannot reach the router, so
   * proving the intended cause needs two more facts in the same breath: the
   * router still answers `discover`, and the durable payload is still fetchable.
   */
  provesFailClosed(recipient, sentinel) {
    const outcome = this.send(recipient, sentinel, `${sentinel}-after-stop`);
    assertRecipientUnavailable(outcome);
    const stillLive = this.discover();
    if (!Array.isArray(stillLive?.cards)) {
      throw new Error('The router stopped answering `discover`, so recipient_unavailable cannot be attributed to the recipient.');
    }
    let failedMessageId = null;
    for (const event of this.watch(recipient).events) {
      if (!event.message_id || event.message_id === this.lastDurableMessageId) continue;
      const durable = this.cliJson([
        'message', 'fetch', '--project', this.project, '--recipient', recipient,
        '--target-kind', 'session', '--message-id', event.message_id,
      ]);
      if (durable?.payload?.qa_sentinel === sentinel) {
        failedMessageId = event.message_id;
        break;
      }
    }
    if (!failedMessageId) throw new Error('The unavailable exact-session send was not durably fetchable by its sentinel.');
    const receipts = this.cliJson([
      'message', 'receipts', '--project', this.project,
      '--recipient', recipient, '--message-id', failedMessageId,
    ]);
    assertNoHostOutcomeReceipts(receipts, { messageId: failedMessageId });
    return {
      send_stderr: outcome.stderr.trim(),
      router_still_answering_discover: true,
      durable_message_still_fetchable_after_disconnect: failedMessageId,
      host_accept_ack_disposition: false,
    };
  }

  /**
   * Unwind in the only order that cannot leave an orphan.
   *
   * A connected host whose router socket vanishes spawns a DETACHED packaged
   * router with this run's MEMESH_DIR in its environment, and the router
   * recreates that directory on start. So: companion first, then any live
   * session, then the router, then the directory — and if a session is still
   * connected after the bounded wait, keep the directory rather than delete a
   * tree something is about to recreate. Runs on every exit path.
   */
  shutdown(waitMs = 30_000) {
    // Memoised, not guarded: a second caller (signal handler racing the main
    // path's own failure) must AWAIT the first unwind, not skip it and exit
    // while rmSync has not run yet.
    this.shutdownPromise ??= this.unwind(waitMs);
    return this.shutdownPromise;
  }

  async unwind(waitMs) {
    for (const companion of this.companions) await stopChild(companion);
    this.companions = [];

    const routerAlive = this.router !== null && this.router.exitCode === null && this.router.signalCode === null;
    const sessionIds = routerAlive ? [...this.liveSessionIds] : [];
    let disconnected = true;
    for (const sessionId of sessionIds) {
      if (!await awaitSessionDisconnect({
        sessionId,
        isGone: (id) => this.sessionGone(id),
        waitMs,
        now: Date.now,
        sleep,
        announce: (text) => this.say(`\n  ${text.split('\n').join('\n  ')}\n`),
      })) disconnected = false;
    }
    if (!disconnected) {
      this.keptForSafety = true;
      process.stderr.write(
        `\n  WARNING: ${sessionIds.join(', ')} is still connected. Keeping ${this.dir} rather than deleting a\n`
        + '  directory a live host is about to recreate. Exit that session, then remove it by hand; if a\n'
        + '  detached router was started by that host, stop it too: pkill -f dist/host-runtime/router.js\n',
      );
    }

    await stopChild(this.router);
    await this.stopLegacyRouter();

    if (!shouldRemoveWorkingDirectories({ keep: this.options.keep, keptForSafety: this.keptForSafety })) {
      process.stdout.write(`\nKept working directory: ${this.dir}\n`);
      if (this.workspace) process.stdout.write(`Kept Codex workspace:   ${this.workspace}\n`);
      return;
    }
    for (const directory of [this.dir, this.workspace]) {
      if (!directory) continue;
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`Could not remove ${directory}: ${error.message}\n`);
      }
    }
  }
}

async function runCodex(journey) {
  const version = run('codex', ['--version']);
  if (version.status !== 0) {
    throw new Error('`codex` is not on PATH. This check needs the owner\'s Codex CLI installed.');
  }
  const login = run('codex', ['login', 'status']);
  if (login.status !== 0) {
    throw new Error('`codex login status` reports the owner is not logged in. Run `codex login` first.');
  }
  journey.step('codex preconditions', {
    codex_version: version.stdout.trim(),
    login_status_exit_code: login.status,
  });

  journey.startRouter();
  await journey.waitForRouterSocket();
  journey.step('router started against the temporary MEMESH_DIR', { socket_path: journey.socketPath });

  const workspace = journey.createCodexWorkspace();
  const configPath = path.join(journey.memeshDir, 'hosts', 'codex-session.json');
  if (fs.existsSync(configPath)) {
    throw new Error('Codex journey unexpectedly found hosts/codex-session.json before startup.');
  }

  const first = run('codex', [
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config',
    '-s', 'read-only', '-C', workspace, 'Reply with exactly READY',
  ], { timeout: 180_000 });
  if (first.status !== 0) {
    throw new Error(`codex exec exited ${first.status}: ${first.stderr.trim().slice(0, 600)}`);
  }
  // Turn 1's log stays out of the workspace: it names the thread, and the
  // proof turn must have no on-disk source for anything it quotes.
  fs.writeFileSync(path.join(journey.dir, 'codex-turn1.jsonl'), first.stdout);
  const threadId = parseCodexThreadId(first.stdout);
  journey.step('real Codex thread created', {
    thread_id: threadId,
    workspace,
    first_turn_reply: collectCodexAgentMessages(first.stdout).join(' | '),
  });

  // Plugin loading under `codex exec --ignore-user-config` is not the subject
  // of this real-model journey, so registration remains harness-driven and is
  // disclosed rather than hidden. The shipped companion itself now exercises
  // the no-config automatic identity path.
  // What runs here is the SHIPPED companion — dist/host-runtime/codex-session.js
  // — fed the SessionStart payload the packaged plugin hook would have handed it.
  const companion = journey.startCodexCompanion(threadId, workspace, 'codex-session.log');
  journey.note(
    'The Codex registration half is harness-driven. This run drives the shipped '
    + 'dist/host-runtime/codex-session.js directly with the SessionStart payload the packaged plugin hook '
    + 'supplies, because a scripted `codex exec --ignore-user-config` turn does not establish plugin-hook '
    + 'loading. No codex-session.json is created: companion registration uses the automatic thread-scoped '
    + 'path. Dispatch -> `codex queue` -> model-visible reply is product-path evidence; plugin-loader '
    + 'invocation itself is not proved by this mode.',
  );
  const card = await journey.until(
    'The Codex session never registered with the router',
    () => journey.discover().cards.find((entry) => entry.session_id === threadId) ?? false,
    60_000,
  );
  journey.trackLiveSession(threadId);
  journey.step('Codex thread registered with the router', {
    session_id: card.session_id,
    principal_id: card.principal_id,
    host_kind: card.host_kind,
    generation: card.generation,
  });

  const sentinel = `codex-${randomUUID().slice(0, 8)}`;
  const sent = journey.sendAccepted(threadId, sentinel, sentinel, 'codex-cli-queue');
  journey.lastDurableMessageId = sent.messageId;
  journey.step('exact-session send accepted by the codex-cli-queue adapter', {
    sentinel,
    message_id: sent.messageId,
    delivery_id: sent.deliveryId,
    native_delivery: sent.native,
  });

  // The prompt names neither the sentinel nor either id on purpose, and the
  // reply is only accepted if the turn also ran no commands.
  const prompt = 'If a MeMesh envelope containing a qa_sentinel field was injected into this session, '
    + 'reply with exactly one line: CODEX_RECEIVED_<qa_sentinel> <message_id> <delivery_id>, substituting '
    + 'the three values from that envelope. Otherwise reply with exactly: NO_ENVELOPE. '
    + 'Do nothing else, read no files and run no commands.';
  const second = run('codex', [
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config',
    '-s', 'read-only', '-C', workspace, 'resume', threadId, prompt,
  ], { timeout: 180_000 });
  if (second.status !== 0) {
    throw new Error(`codex exec resume exited ${second.status}: ${second.stderr.trim().slice(0, 600)}`);
  }
  fs.writeFileSync(path.join(journey.dir, 'codex-turn2.jsonl'), second.stdout);
  const reply = assertCodexReply({
    jsonl: second.stdout,
    sentinel,
    messageId: sent.messageId,
    deliveryId: sent.deliveryId,
  });
  journey.step('the Codex model quoted the envelope back (model-visible proof)', {
    model_visible_evidence: reply,
    proves: 'the reply carries message_id and delivery_id, neither of which appears in the prompt, '
      + 'and the turn ran no commands, so it had no on-disk source for them',
  });

  await journey.stopCodexCompanion(companion);
  await journey.until(
    'The router still lists the Codex session as live after its companion was stopped',
    () => journey.sessionGone(threadId),
    15_000,
  );
  journey.forgetLiveSession(threadId);
  journey.step('companion stopped and the session left the router directory', { session_id: threadId });

  journey.step('a send to the stopped session fails closed and the durable row survives',
    journey.provesFailClosed(threadId, sentinel));

  journey.note(
    '`recipient_unavailable` is a shared failure surface — the same string is returned when the SENDER '
    + 'cannot reach the router. The final step therefore also records that `message discover` still '
    + 'answered and that `message fetch` still returned the payload; that pairing is what attributes the '
    + 'failure to the stopped recipient rather than to a dead router.',
  );
  journey.note(
    'One throwaway Codex thread is created in the owner\'s Codex rollout store and one message is queued '
    + 'into it. No Codex or MeMesh configuration outside the temporary directories is written, and no auth '
    + 'file is read: the login precondition is the exit code of `codex login status`.',
  );
}

/**
 * Bounded packaged-entrypoint journey for the automatic Codex SessionStart
 * path. It deliberately does not run `agent setup codex-session`: absence of
 * hosts/codex-session.json is the behavior under test. The router's shipped
 * codex-cli-queue adapter is exercised with a task-owned `codex` executable,
 * which records the exact invocation and returns success without contacting a
 * real Codex account.
 */
async function runCodexSessionAutoRegistration(journey) {
  const workspace = journey.createCodexWorkspace();
  const fakeCodex = journey.installCodexQueueStub();
  const configPath = path.join(journey.memeshDir, 'hosts', 'codex-session.json');
  if (fs.existsSync(configPath)) {
    throw new Error('Automatic-registration journey unexpectedly found hosts/codex-session.json before startup.');
  }

  await journey.startLegacyRouter();
  const legacy = await journey.assertLegacyRouterUntouched();
  journey.startRouter();
  await journey.waitForRouterSocket();
  await journey.assertLegacyRouterUntouched();
  journey.step('packaged router started against the temporary HOME/MEMESH_DIR', {
    socket_path: journey.socketPath,
    legacy_socket_path: legacy.path,
    legacy_socket_inode: { dev: legacy.dev, ino: legacy.ino },
    legacy_v1_response: legacy.response,
    home: journey.home,
    memesh_dir: journey.memeshDir,
    fake_codex: fakeCodex,
  });

  const threadId = '01a0' + randomUUID().slice(4);
  const secondThreadId = '01a0' + randomUUID().slice(4);
  journey.trackLiveSession(threadId);
  journey.trackLiveSession(secondThreadId);
  const firstCompanion = journey.startCodexCompanion(threadId, workspace, 'codex-session-auto-1.log');
  journey.startCodexCompanion(secondThreadId, workspace, 'codex-session-auto-2.log');
  journey.step('packaged codex-session received a valid startup payload', {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_ids: [threadId, secondThreadId],
    cwd: workspace,
    config_present: fs.existsSync(configPath),
  });

  const cards = await journey.until(
    'The two automatic Codex SessionStart companions never registered as distinct exact sessions',
    () => {
      const found = findLiveCards(journey.discover(), { hostKind: 'codex' });
      if (found.length < 2) return false;
      const selected = found.filter((card) => card.session_id === threadId || card.session_id === secondThreadId);
      return selected.length === 2 ? selected : false;
    },
    15_000,
  );
  for (const card of cards) {
    if (card.host_kind !== 'codex' || card.project !== journey.project || card.principal_id !== `codex-thread-${card.session_id}`) {
      throw new Error(`Automatic Codex registration returned the wrong live card: ${JSON.stringify(card)}.`);
    }
  }
  const firstCard = cards.find((card) => card.session_id === threadId);
  const secondCard = cards.find((card) => card.session_id === secondThreadId);
  if (!firstCard || !secondCard || firstCard.principal_id === secondCard.principal_id) {
    throw new Error(`Automatic Codex sessions did not keep distinct thread-scoped identities: ${JSON.stringify(cards)}.`);
  }
  journey.step('discover returned two distinct exact automatic Codex sessions/cards', {
    sessions: cards.map((card) => ({
      session_id: card.session_id,
      principal_id: card.principal_id,
      host_kind: card.host_kind,
      project: card.project,
      generation: card.generation,
    })),
  });

  const mcpDiscoveries = await journey.mcpDiscover([
    { session_id: firstCard.session_id, principal_id: firstCard.principal_id, project: firstCard.project },
    { session_id: secondCard.session_id, principal_id: secondCard.principal_id, project: secondCard.project },
  ]);
  await journey.assertLegacyRouterUntouched();
  journey.step('two independent packaged MCP clients concurrently discovered the same live cards', {
    client_results: mcpDiscoveries.map((cards) => cards.map((card) => ({
      session_id: card.session_id,
      principal_id: card.principal_id,
      generation: card.generation,
    }))),
    legacy_socket_retained: true,
  });

  const sent = [];
  for (const [sessionId, label] of [[threadId, 'first'], [secondThreadId, 'second']]) {
    const sentinel = `codex-auto-${label}-${randomUUID().slice(0, 8)}`;
    const message = journey.sendAccepted(sessionId, sentinel, sentinel, 'codex-cli-queue');
    sent.push({ sessionId, sentinel, ...message });
  }
  for (const { message, invocation } of assertExactCodexQueueRouting(
    journey.readCodexQueueInvocations(), sent,
  )) {
    const receipts = journey.cliJson([
      'message', 'receipts', '--project', journey.project,
      '--recipient', message.sessionId, '--message-id', message.messageId,
    ]);
    const hostAccept = assertHostAcceptOnly(receipts, {
      messageId: message.messageId,
      deliveryId: message.deliveryId,
      adapterKind: 'codex-cli-queue',
      recipient: message.sessionId,
    });
    journey.step(`exact-session send/readback for ${message.sessionId}`, {
      sentinel: message.sentinel,
      message_id: message.messageId,
      delivery_id: message.deliveryId,
      host_accept_id: hostAccept.host_accept_id,
      queue_thread_id: invocation.thread_id,
    });
  }
  await journey.assertLegacyRouterUntouched();

  if (firstCompanion.exitCode !== null) {
    throw new Error('The original first Codex companion exited before the resume registration was attempted.');
  }
  const resumedCompanion = journey.startCodexCompanion(threadId, workspace, 'codex-session-auto-resume.log', 'resume');
  const resumedCard = await journey.until(
    'The resumed first Codex thread never superseded its original generation',
    () => {
      const current = findLiveCards(journey.discover(), { sessionId: threadId });
      return current.length === 1 && current[0].generation > firstCard.generation ? current[0] : false;
    },
    15_000,
  );
  if (resumedCard.principal_id !== firstCard.principal_id || resumedCard.generation !== firstCard.generation + 1) {
    throw new Error(`The resumed Codex thread did not increment exactly one generation: ${JSON.stringify(resumedCard)}.`);
  }
  journey.step('resume registration superseded the old first-thread generation', {
    session_id: threadId,
    old_generation: firstCard.generation,
    new_generation: resumedCard.generation,
    old_companion_was_live_before_resume: true,
    resumed_companion_pid: resumedCompanion.pid,
  });
  await journey.assertLegacyRouterUntouched();

  for (const companion of journey.companions) await stopChild(companion);
  journey.companions = [];
  for (const sessionId of [threadId, secondThreadId]) {
    await journey.until(
      `The automatic Codex session ${sessionId} remained live after all companions stopped`,
      () => journey.sessionGone(sessionId),
      15_000,
    );
    journey.forgetLiveSession(sessionId);
  }
  const afterStopSentinel = `codex-auto-after-stop-${randomUUID().slice(0, 8)}`;
  journey.lastDurableMessageId = sent[0].messageId;
  const stopped = journey.provesFailClosed(threadId, afterStopSentinel);
  journey.step('all companions stopped; unavailable send remained durable with no host outcome', {
    session_id: threadId,
    message_id: stopped.durable_message_still_fetchable_after_disconnect,
    recipient_unavailable: true,
    payload_fetchable: true,
    host_accept_ack_disposition: stopped.host_accept_ack_disposition,
  });
  journey.note(
    'This bounded mode uses a task-owned fake `codex` executable in PATH. It proves the packaged '
    + 'router -> codex-cli-queue -> codex queue process boundary and durable host_accept readback; '
    + 'it does not claim that a real Codex model rendered or acted on the message.',
  );
  journey.note(
    'No hosts/codex-session.json was created. The packaged companion selected its automatic '
    + 'thread-scoped identity from the valid startup payload, using only this run\'s HOME/MEMESH_DIR.',
  );
  journey.note(
    'The legacy agent-router.sock is a task-owned v1 listener returning the exact unsupported_type '
    + 'response; the current packaged router uses agent-router-v2.sock. Its inode, listener, and response '
    + 'were probed before and after the concurrent packaged MCP StdioClientTransport discover boundary.',
  );
}

async function runClaude(journey, waitMs) {
  const version = run('claude', ['--version']);
  if (version.status !== 0) {
    throw new Error('`claude` is not on PATH. This check needs Claude Code installed.');
  }
  journey.step('claude precondition', { claude_version: version.stdout.trim() });

  journey.startRouter();
  await journey.waitForRouterSocket();
  journey.step('router started against the temporary MEMESH_DIR', { socket_path: journey.socketPath });

  const setup = journey.cliJson([
    'agent', 'setup', 'claude',
    '--project', journey.project,
    '--principal', 'claude-live-journey',
    '--json',
  ]);
  journey.step('agent setup claude', { config_path: setup.config_path, mode: setup.mode });

  const workspace = path.join(journey.dir, 'claude-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const mcpConfig = path.join(journey.dir, 'claude-mcp.json');
  fs.writeFileSync(mcpConfig, `${JSON.stringify({
    mcpServers: {
      memesh: {
        command: process.execPath,
        args: [dist('dist/mcp/server.js')],
        env: { MEMESH_DIR: journey.memeshDir, MEMESH_DB_PATH: journey.dbPath },
      },
      'memesh-channel': {
        command: process.execPath,
        args: [dist('dist/host-runtime/claude.js'), '--config', setup.config_path],
        env: { MEMESH_DIR: journey.memeshDir, MEMESH_DB_PATH: journey.dbPath },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });

  // `--setting-sources ""` loads no user/project/local settings file. It is
  // accepted by the CLI (an invalid source name is rejected, an empty list is
  // not), but it is NOT verified to exclude plugin-provided hooks or MCP
  // servers — hence the confirmation step below rather than a silent claim.
  const launch = `cd ${JSON.stringify(workspace)} && claude --setting-sources "" `
    + '--dangerously-load-development-channels server:memesh-channel '
    + `--mcp-config ${JSON.stringify(mcpConfig)} --strict-mcp-config`;
  journey.say([
    '',
    '  ACTION REQUIRED — in a second terminal, run exactly:',
    '',
    `    ${launch}`,
    '',
    '  Then, BEFORE anything else, confirm the session is not carrying the owner\'s',
    '  installed MeMesh plugin: run /mcp and check only `memesh` and `memesh-channel`',
    '  are listed, and run /hooks and check no MeMesh hooks are registered. A plugin',
    '  hook running there inherits no MEMESH_DIR and would write the REAL ~/.memesh.',
    '  If either shows the plugin, stop: quit the session and disable the plugin first.',
    '',
    '  Otherwise TYPE NOTHING. Leave the session sitting at its prompt. This check is',
    '  measuring what the session does on its own when an envelope arrives.',
    '',
  ].join('\n'));

  const card = await journey.until(
    'No Claude channel session registered with the router. Was the session launched with '
    + '--dangerously-load-development-channels and the local-development warning confirmed?',
    () => findLiveCards(journey.discover(), { hostKind: 'claude' })[0] ?? false,
    waitMs,
  );
  journey.trackLiveSession(card.session_id);
  journey.step('interactive Claude session registered on the channel', {
    session_id: card.session_id,
    principal_id: card.principal_id,
    host_kind: card.host_kind,
    generation: card.generation,
    launch_command: launch,
    operator_prompt: 'none-instructed',
  });

  const sentinel = `claude-${randomUUID().slice(0, 8)}`;
  const sent = journey.sendAccepted(card.session_id, sentinel, sentinel, 'claude-channel');
  journey.lastDurableMessageId = sent.messageId;
  journey.step('exact-session send accepted by the claude-channel adapter', {
    sentinel,
    message_id: sent.messageId,
    delivery_id: sent.deliveryId,
    native_delivery: sent.native,
  });

  journey.say('  Waiting for the session\'s own model to call `intake` on that message. Still type nothing.\n');
  const intake = await journey.until(
    `The Claude session never recorded an intake receipt for ${sent.messageId}. host_accept proves only that `
    + 'the channel took the frame, not that the model saw it (this is exactly the print-mode failure of issue #275).',
    () => findIntakeReceipt(journey.cliJson([
      'message', 'receipts',
      '--project', journey.project,
      '--recipient', card.session_id,
      '--message-id', sent.messageId,
    ]), { messageId: sent.messageId, actor: card.session_id }),
    waitMs,
  );
  journey.step('the Claude model called intake itself (model-visible proof)', {
    model_visible_evidence: { receipt_id: intake.receipt_id, receipt_kind: intake.receipt_kind, actor: intake.actor },
    proves: 'the intake receipt was written by the recipient session, not by this harness',
  });

  journey.say('\n  ACTION REQUIRED — exit that Claude session now (Ctrl-D or /exit).\n');
  await journey.until(
    'The Claude session is still registered with the router. Exit the interactive session to continue.',
    () => journey.sessionGone(card.session_id),
    waitMs,
  );
  journey.forgetLiveSession(card.session_id);
  journey.step('session disconnected and left the router directory', { session_id: card.session_id });

  journey.step('a send to the stopped session fails closed and the durable row survives',
    journey.provesFailClosed(card.session_id, sentinel));

  journey.note(
    'The interactive Claude session is NOT inside this check\'s isolation. The printed command passes '
    + '--setting-sources "" so no settings file loads, but that is not verified to exclude plugin-provided '
    + 'hooks or MCP servers; a MeMesh plugin hook running in that session inherits no MEMESH_DIR and would '
    + 'write the owner\'s real ~/.memesh. The operator is told to confirm with /mcp and /hooks first, and '
    + 'this check cannot observe whether they did.',
  );
  journey.note(
    'The operator is instructed to type nothing, but this check cannot observe whether anything was typed. '
    + 'The intake receipt proves the model called `intake` in that session; it does not prove it did so unprompted.',
  );
  journey.note(
    'The intake receipt is matched on its `actor`, which `intake` sets from the caller\'s `recipient`. The model '
    + 'must therefore intake under its own session id; an intake recorded against the principal id instead would '
    + 'not match and this check would report no model-visible proof.',
  );
  journey.note(
    'Print mode (`claude -p`) is not supported and is not exercised: a print-mode session does not surface '
    + 'memesh-channel notifications to the model even when the channel host reports the frame accepted '
    + '(issue #275), so it cannot produce the model-visible proof this check requires.',
  );
  journey.note(
    '`recipient_unavailable` is a shared failure surface — the same string is returned when the SENDER '
    + 'cannot reach the router. The final step therefore also records that `message discover` still '
    + 'answered and that `message fetch` still returned the payload; that pairing is what attributes the '
    + 'failure to the stopped recipient rather than to a dead router.',
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  assertSupportedPlatform(process.platform);
  assertNotCi(process.env);
  assertDistPresent(repoRoot);
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  if (revision.length === 0) throw new Error('Could not read the repository revision; the report would name no code.');
  const dirty = run('git', ['status', '--porcelain'], { cwd: repoRoot }).stdout.trim() !== '';
  const newestSrcMs = newestMtimeMs(path.join(repoRoot, 'src'));
  const oldestDistMs = Math.min(...REQUIRED_DIST.map((relative) => fs.statSync(dist(relative)).mtimeMs));
  const distStale = isDistStale({ newestSrcMs, oldestDistMs });

  const journey = new Journey(options);
  const startedAt = new Date().toISOString();
  let failure = null;

  process.stdout.write(`memesh live journey — host=${options.host} revision=${revision}${dirty ? ' (DIRTY TREE)' : ''}\n`);
  process.stdout.write(`  MEMESH_DIR=${journey.memeshDir}\n`);
  if (dirty) {
    process.stdout.write('  WARNING: the working tree is dirty, so this report does not describe the revision alone.\n');
    journey.note('The working tree was dirty when this ran: the report names a revision, but uncommitted changes were present.');
  }
  if (distStale) {
    process.stdout.write('  WARNING: dist/ predates the newest file under src/ — this ran a stale build.\n');
    journey.note('At least one dist/ artefact this check ran is older than the newest file under src/, so the built code may not correspond to the source at this revision. Run `npm run build`.');
  }
  process.stdout.write('\n');

  const emitReport = (failureText) => {
    const report = {
      schema_version: 'memesh-live-journey/v1',
      revision,
      dirty,
      dist_stale: distStale,
      host: options.host,
      mode: options.mode,
      project: journey.project,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      verdict: failureText === null ? 'PASS' : 'FAIL',
      memesh_dir: journey.memeshDir,
      steps: journey.steps,
      limitations: journey.limitations,
      ...(failureText === null ? {} : { error: failureText }),
    };
    if (options.out) {
      const target = path.resolve(options.out);
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`\nReport: ${target}\n`);
    } else {
      process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
    }
  };
  const finish = async (code) => {
    await journey.shutdown();
    process.exit(code);
  };
  const onSignal = (signal, code) => {
    process.stderr.write(`\nReceived ${signal}; shutting down cleanly.\n`);
    // The partial report is evidence too: which steps passed before the interrupt.
    try { emitReport(`interrupted by ${signal}`); } catch { /* the report is best effort here */ }
    void finish(code);
  };
  process.once('SIGINT', () => onSignal('SIGINT', 130));
  process.once('SIGTERM', () => onSignal('SIGTERM', 143));

  try {
    if (options.mode === 'codex-session-auto-registration') await runCodexSessionAutoRegistration(journey);
    else if (options.host === 'codex') await runCodex(journey);
    else await runClaude(journey, options.waitMs);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    journey.steps.push({
      step: journey.steps.length + 1,
      name: 'FAILED',
      status: 'FAIL',
      at: new Date().toISOString(),
      error: failure,
    });
    process.stderr.write(`  FAIL ${failure}\n`);
  }

  emitReport(failure);
  await finish(failure === null ? 0 : 1);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
