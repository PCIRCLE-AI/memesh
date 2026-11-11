import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import { claudeCodeSessionFromEnv } from '../core/host-session.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath, normalizeAgentRouterSocketPath } from '../core/paths.js';
import { requirePrivateWritableDirectory } from '../core/file-mode.js';
import { resolveMcpProject } from '../transports/mcp/project-context.js';
import { ensureRouterTokenFile } from './config.js';
import { connectRouterHost, type RouterDelivery, type RouterHostConnection } from './router-client.js';
import { createClaudeActivity, defaultClaudeDir, readClaudeRegistry } from '../core/session-activity.js';
import { projectTranscriptSlug } from '../core/transcript-source.js';
import { messageNotice } from '../host-adapters/message-notice.js';
import { ClaudeTranscriptReader, type ClaudeTranscriptMark } from './claude-transcript.js';
import type { AgentJsonObject } from '../core/agent-messaging.js';

export function readRegistrySession(): { sessionId: string; cwd: string } | undefined {
  const data = readClaudeRegistry(process.ppid);
  if (!data || typeof data.cwd !== 'string' || typeof data.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.sessionId)) return undefined;
  return { sessionId: data.sessionId, cwd: data.cwd };
}

function sendNativeNotice(socketPath: string | undefined, content: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socketPath || process.platform === 'win32') { reject(new Error('Claude native inbox is unavailable.')); return; }
    try {
      const stat = fs.lstatSync(socketPath);
      if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Claude native inbox is unavailable.');
    } catch { reject(new Error('Claude native inbox is unavailable.')); return; }
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(new Error('Claude native inbox timed out.')), timeoutMs);
    function finish(error?: Error) { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); }
    socket.once('error', () => finish(new Error('Claude native inbox is unavailable.')));
    socket.once('connect', () => socket.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`, () => finish()));
  });
}

function confirmedNotice(record: unknown, session: string, notice: ReturnType<typeof messageNotice>): 'enqueue' | 'user' | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const entry = record as Record<string, unknown>;
  if (entry.sessionId !== session) return undefined;
  let text: unknown;
  if (entry.type === 'queue-operation' && entry.operation === 'enqueue') text = entry.content;
  else if (entry.type === 'user' && entry.origin && typeof entry.origin === 'object' && 'kind' in entry.origin && entry.origin.kind === 'peer' && entry.message && typeof entry.message === 'object' && 'role' in entry.message && entry.message.role === 'user' && 'content' in entry.message && typeof entry.message.content === 'string') {
    const prefix = 'Another Claude session sent a message:\n';
    const content = entry.message.content;
    if (!content.startsWith(prefix)) return undefined;
    const boundary = content.indexOf('\n\nThis came from another Claude session ', prefix.length);
    if (boundary < 0) return undefined;
    text = content.slice(prefix.length, boundary);
  } else return undefined;
  if (typeof text !== 'string') return undefined;
  try {
    const actual = JSON.parse(text);
    const keys = Object.keys(notice);
    if (actual && typeof actual === 'object' && !Array.isArray(actual) && Object.keys(actual).length === keys.length && keys.every(key => actual[key] === notice[key as keyof typeof notice])) return entry.type === 'user' ? 'user' : 'enqueue';
  } catch { /* malformed notice cannot confirm */ }
  return undefined;
}

/**
 * The notice reached the session's socket but never showed up in its conversation, and the
 * session's transcript shows nothing else about it. One cause is Claude Code holding a peer message
 * (see `NoticeHeldError`); others are a session that is busy or stopped, or a notice it dropped.
 * MeMesh cannot tell these apart without a hold record, so it says only that nothing confirmed it.
 */
export class NoticeNotConfirmedError extends Error {
  readonly code = 'notice_not_confirmed';
  constructor() { super('Claude session notice was not confirmed.'); this.name = 'NoticeNotConfirmedError'; }
}

/**
 * Claude Code wrote its "Held peer message" line to the transcript: the notice is waiting for its
 * user to approve or deny it. Nothing readable says which they chose, so the notice stays unconfirmed.
 */
export class NoticeHeldError extends Error {
  readonly code = 'notice_held';
  constructor() { super('Claude Code is holding the notice for its user; MeMesh cannot see whether it was approved or denied.'); this.name = 'NoticeHeldError'; }
}

/** MeMesh could not read the session's conversation record, so it cannot tell whether the notice arrived. */
export class TranscriptUnreadableError extends Error {
  constructor(readonly code: 'transcript_unavailable' | 'transcript_not_found', message: string) { super(message); this.name = 'TranscriptUnreadableError'; }
}

function heldNotice(record: unknown, session: string): boolean {
  if (!record || typeof record !== 'object') return false;
  const entry = record as Record<string, unknown>;
  return entry.type === 'system' && entry.sessionId === session && typeof entry.content === 'string'
    && entry.content.startsWith('Held peer message') && entry.content.includes('memesh_message_notice');
}

/** How many held notices one MCP process remembers; the oldest is forgotten first (it would be sent again). */
const HELD_LIMIT = 500;

export function createClaudeInboxDeliver(options: { socketPath?: string; sessionId: string; reader: ClaudeTranscriptReader | (() => ClaudeTranscriptReader); timeoutMs?: number; currentSession?: () => string | undefined; heldLimit?: number }) {
  // Deliveries Claude Code held for its user, each with the place in the conversation record to read on
  // from. A host that registers again is handed them again; the notice is not sent again (a second hold
  // would replace the first prompt for nothing), the record is read on from where it stopped, and a
  // notice the user has since approved is taken as delivered. If the record can no longer be read on
  // (it grew past what one read takes, or it was replaced) the hold cannot be followed: the notice is
  // sent once more, from a fresh place in the record. A notice is never sent a third time by this process:
  // one sent again that is then neither confirmed nor held stays unconfirmed, one whose hold cannot be
  // followed a second time stays held, and a hold forgotten to stay inside HELD_LIMIT stays held, each
  // reported as it was without another send (the message waits in the inbox, where the hooks raise it).
  // Only this MCP process remembers any of this, at most HELD_LIMIT holds and four times that many
  // settled ones, the oldest forgotten first; a forgotten one is the only kind that can be sent again.
  const limit = options.heldLimit ?? HELD_LIMIT;
  const held = new Map<string, { mark: ClaudeTranscriptMark; resent: boolean }>();
  const settled = new Map<string, 'held' | 'unconfirmed'>();
  const settle = (id: string, how: 'held' | 'unconfirmed') => {
    settled.delete(id);
    settled.set(id, how);
    if (settled.size > limit * 4) settled.delete(settled.keys().next().value as string);
  };
  return async (delivery: RouterDelivery): Promise<AgentJsonObject> => {
    const timeoutMs = options.timeoutMs ?? 3000;
    const notice = messageNotice(delivery.envelope, delivery.delivery_id);
    const currentSession = options.currentSession ?? (() => options.sessionId);
    const session = currentSession();
    if (session !== options.sessionId || (delivery.envelope.target_kind === 'session' && delivery.envelope.recipient !== session)) {
      throw new Error('Claude session changed or does not match the delivery target.');
    }
    // A principal notice lands in this host's own session, so it is read back the same way:
    // accepted means "seen in the conversation", never "written to the socket".
    const reader = typeof options.reader === 'function' ? options.reader() : options.reader;
    const confirmationIn = (records: unknown[]) => {
      for (const record of records) {
        const confirmation = confirmedNotice(record, session, notice);
        if (confirmation) return confirmation;
      }
      return undefined;
    };
    const closed = settled.get(delivery.delivery_id);
    if (closed === 'held') throw new NoticeHeldError();
    if (closed === 'unconfirmed') throw new NoticeNotConfirmedError();
    const earlier = held.get(delivery.delivery_id);
    let resent = false;
    if (earlier) {
      const later = reader.readNew(session, earlier.mark);
      if (later === undefined) {
        // The hold cannot be followed any more. Say "held" if the notice was already sent a second time;
        // otherwise forget the hold and fall through to send it once more (a record that is truly
        // unreadable is then reported as such by the fresh mark below).
        if (earlier.resent) { held.delete(delivery.delivery_id); settle(delivery.delivery_id, 'held'); throw new NoticeHeldError(); }
        held.delete(delivery.delivery_id);
        resent = true;
      } else {
        const confirmation = confirmationIn(later);
        if (confirmation) { held.delete(delivery.delivery_id); return { host: 'claude-inbox', status: 'queued', content: 'notice', confirmation }; }
        throw new NoticeHeldError();
      }
    }
    const mark = session ? reader.mark(session) : undefined;
    if (!session || !mark) throw new TranscriptUnreadableError('transcript_unavailable', 'Claude session transcript is unavailable: there is no project folder to look in.');
    const until = Date.now() + timeoutMs;
    await sendNativeNotice(options.socketPath, JSON.stringify(notice), timeoutMs);
    while (Date.now() < until) {
      if (currentSession() !== session) throw new Error('Claude session changed before notice confirmation.');
      const records = reader.readNew(session, mark);
      if (!records) throw new TranscriptUnreadableError('transcript_unavailable', 'Claude session transcript is unavailable.');
      // The whole batch is searched for the notice first: a hold that was released a moment later is delivered.
      const confirmation = confirmationIn(records);
      if (confirmation) return { host: 'claude-inbox', status: 'queued', content: 'notice', confirmation };
      if (records.some((record) => heldNotice(record, session))) {
        held.set(delivery.delivery_id, { mark, resent });
        if (held.size > limit) {
          const oldest = held.keys().next().value as string;
          held.delete(oldest);
          settle(oldest, 'held');
        }
        throw new NoticeHeldError();
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // The session never wrote a transcript at all: there is nothing to say Claude Code held it.
    if (mark.ino === undefined) throw new TranscriptUnreadableError('transcript_not_found', 'Claude session transcript was not found, so the notice could not be confirmed.');
    if (resent) settle(delivery.delivery_id, 'unconfirmed');
    throw new NoticeNotConfirmedError();
  };
}

/** Ordinary Claude MCP lifecycle, not a Channel or a second notification path. */
export async function startClaudeInboxPresence(rootUris: readonly string[] | null): Promise<RouterHostConnection | undefined> {
  if (process.platform === 'win32') return undefined;
  const session = claudeCodeSessionFromEnv();
  if (!session) throw new Error('Claude online registration skipped: no valid CLAUDE_CODE_SESSION_ID.');
  const binding = resolveMcpProject(process.env.MEMESH_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR, rootUris);
  if ('error' in binding) throw new Error(`Claude online registration skipped: ${binding.reason}`);

  // Reuse exactly the hook's recipient/config validation, including explicit
  // opt-out and invalid owner config. This path is also correct in the MCP bundle.
  const hookUrl = new URL('../../scripts/hooks/_shared.js', import.meta.url).href;
  const hooks = await import(hookUrl) as {
    resolveMessageRecipient(env: NodeJS.ProcessEnv): string | undefined;
  };
  const principal = hooks.resolveMessageRecipient({ ...process.env, MEMESH_HOOK_HOST: 'claude-code' });
  if (!principal) return undefined;
  const dataDir = getMemeshDirFromDbPath();
  requirePrivateWritableDirectory(dataDir, 'the local router keeps its lifecycle state there');
  const token = ensureRouterTokenFile(path.join(dataDir, 'agent-router.token'));
  let workspace = process.env.MEMESH_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR;
  if (!workspace && rootUris?.length === 1) {
    try { workspace = fileURLToPath(rootUris[0]); } catch { /* no usable local workspace */ }
  }
  return connectRouterHost({
    socket_path: normalizeAgentRouterSocketPath(process.env.MEMESH_ROUTER_SOCKET ?? getAgentRouterSocketPath()),
    auth_token: token,
    identity: {
      project: binding.project, principal_id: principal,
      session_instance_id: session, adapter_kind: 'claude-inbox',
    },
    ...(workspace ? { work_summary: createClaudeActivity(process.ppid, workspace) } : {}),
    deliver: createClaudeInboxDeliver({
      socketPath: process.env.CLAUDE_CODE_MESSAGING_TOKEN ? process.env.CLAUDE_CODE_MESSAGING_SOCKET : undefined,
      sessionId: session,
      reader: () => new ClaudeTranscriptReader(path.join(defaultClaudeDir(), 'projects'), projectTranscriptSlug(readRegistrySession()?.cwd ?? workspace ?? '')),
      currentSession: () => readRegistrySession()?.sessionId,
    }),
    resilience: {
      start_router: () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../host-runtime/router.js', import.meta.url))], {
          detached: true, shell: false, stdio: 'ignore',
        });
        child.once('spawn', () => { child.unref(); resolve(); });
        child.once('error', reject);
      }),
    },
  });
}
