// =============================================================================
// codex-session-principal — the ONE decision behind a Codex session's identity
// =============================================================================
//
// `src/host-runtime/codex-session.ts` decides which principal id an ordinary
// Codex session registers with the router under: the automatic
// `codex-thread-<threadId>` identity, or — when an owner has run
// `memesh agent setup codex-session` for THIS workspace — the configured
// `principal_id` from `hosts/codex-session.json`. That decision used to live
// only inside `codex-session.ts`, which a hook cannot import (it depends on
// `router-client.ts` and other non-leaf modules), so the SessionStart hook
// had no way to state a Codex session's own address (#474 shipped the
// address line for Claude only, since `resolveMessageRecipient` in
// `scripts/hooks/_shared.js` could only reach the Claude-channel fallback —
// an ordinary Codex plugin session never learned its own address even
// though the router registers it as a principal).
//
// This module is the decision, factored to a runtime-leaf (node builtins
// only) so `scripts/generate-hook-core.mjs` can copy it verbatim to
// `scripts/hooks/_generated/codex-session-principal.js`. `codex-session.ts`
// calls it for router registration; the hooks call the SAME function for the
// address line and the inbox reminder, so both pick the same principal from
// the same inputs. The hook states the durable address even when the
// companion later fails to register (e.g. a missing token file), so the
// address is not proof of a live session.
//
// Deliberately narrow: this decides ONLY the principal id, not the rest of
// `configuredCodexSessionConfig`'s resolved shape (router_socket, auth_token,
// project, work_summary) — those need `router-client.ts`/`config.ts`
// (reading a token file, normalising a socket path), which are not leaf-safe
// and are not needed to answer "what does this session call itself".

import { realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';

/** The Codex thread id shape, shared by the router registration and the hooks. */
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `value` shaped like a Codex thread/session id? */
export function isValidCodexThreadId(value: unknown): value is string {
  return typeof value === 'string' && CODEX_THREAD_ID.test(value);
}

export interface CodexSessionPrincipalSession {
  /** The Codex thread id, already validated with {@link isValidCodexThreadId}. */
  threadId: string;
  /** This session's cwd, already resolved to its real path. */
  workspace: string;
}

/** The shape `hosts/codex-session.json` (`CodexSessionHostConfig` in
 *  `codex-session.ts`) carries that this decision needs — a subset, so a
 *  caller holding the fuller config type may pass it through unchanged. */
export interface CodexSessionPrincipalConfig {
  principal_id: unknown;
  workspace: unknown;
}

export type CodexSessionPrincipalResolution =
  | { source: 'automatic'; principalId: string }
  // `principalId` is UNVALIDATED here (`config.principal_id`, verbatim) —
  // the caller decides how strict to be: `codex-session.ts` requires a
  // bounded non-empty string (`requiredString`) and throws otherwise, since a
  // matching-workspace config with no usable `principal_id` is a genuine
  // setup error worth failing loudly on; a hook instead falls back to the
  // automatic principal on the exact same check, since a hook must never let
  // a malformed config file break the session (see
  // `scripts/hooks/_shared.js`'s `resolveClaudeHostFallbackRecipient` for the
  // established fail-closed pattern this mirrors).
  | { source: 'configured'; principalId: unknown };

/** The identity an ordinary, unconfigured Codex session registers under:
 *  stable for the lifetime of one thread, needs no setup. */
export function automaticCodexSessionPrincipal(session: CodexSessionPrincipalSession): string {
  return `codex-thread-${session.threadId}`;
}

/**
 * Resolve which principal id a Codex session should use — the SAME decision
 * `configuredCodexSessionConfig`/`automaticCodexSessionConfig` in
 * `codex-session.ts` make for router registration.
 *
 * `config` is `hosts/codex-session.json`'s parsed content when the file is
 * present, or `undefined` when there is no configured workspace at all (the
 * automatic path always applies, matching `codex-session.ts`'s own
 * `config === undefined` branch).
 *
 * A configured `workspace` that is not an absolute, existing directory
 * throws — exactly like `codex-session.ts`'s `resolveConfiguredWorkspace` —
 * because a malformed config genuinely blocks router registration and must
 * be surfaced, not silently swallowed. The one exception, also preserved
 * from that function, is a workspace that simply does not exist (ENOENT):
 * that resolves to `null`, which this treats the same as "does not match",
 * falling back to automatic. A configured workspace that resolves but names
 * some OTHER directory than this session's own also falls back to automatic
 * — never silently registers this session under a stranger's configured
 * identity.
 *
 * A caller that must never throw (a hook) wraps this call in try/catch and
 * falls back to {@link automaticCodexSessionPrincipal} on any error, the same
 * as every other malformed-config path in `scripts/hooks/_shared.js`.
 *
 * @param realpath - injected so tests can fake the filesystem; defaults to
 *   the real `fs.realpathSync`.
 */
export function resolveCodexSessionPrincipal(
  config: CodexSessionPrincipalConfig | undefined,
  session: CodexSessionPrincipalSession,
  realpath: (path: string) => string = realpathSync,
): CodexSessionPrincipalResolution {
  if (config !== undefined) {
    const configuredWorkspace = resolveExistingConfiguredWorkspace(config.workspace, realpath);
    if (configuredWorkspace !== null && configuredWorkspace === session.workspace) {
      return { source: 'configured', principalId: config.principal_id };
    }
  }
  return { source: 'automatic', principalId: automaticCodexSessionPrincipal(session) };
}

/** `codex-session.ts`'s `resolveConfiguredWorkspace`, duplicated here rather
 *  than imported (that module is not a leaf) — see this file's header for
 *  why the duplication is deliberate. Kept byte-for-byte equivalent: a
 *  non-absolute or oversized `value` throws, a workspace that does not exist
 *  resolves to `null`, and any other realpath/stat failure throws. */
function resolveExistingConfiguredWorkspace(
  value: unknown,
  realpath: (path: string) => string,
): string | null {
  const workspace = requiredAbsolutePath(value, 'workspace');
  try {
    const resolved = realpath(workspace);
    if (!statSync(resolved).isDirectory()) throw new Error('workspace must be a directory.');
    return resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** `codex-session.ts`'s `requiredString` + `requiredAbsolutePath`, duplicated
 *  (see the header comment) — same bound (4096 bytes) and the same "must be
 *  absolute" check, so a malformed `workspace` field fails exactly the same
 *  way through either path. */
function requiredAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096) {
    throw new Error(`${field} must be a bounded non-empty string.`);
  }
  if (!isAbsolute(value)) throw new Error(`${field} must be an absolute path.`);
  return value;
}
