#!/usr/bin/env node
// Whole message delivery is independent of memory capture and project selection.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ConversationMessages } from './_generated/conversation-messages.js';
import { hookSourceHost, recordHookOutcome, SKIP_REASONS, HOOK_BUSY_TIMEOUT_MS, getDbPath, getMemeshDirFromDbPath } from './_shared.js';

const writeStdout = text => new Promise((resolve, reject) => {
  process.stdout.write(text, error => error ? reject(error) : resolve());
});

export async function deliverConversationMessages(payload, options = {}) {
  const record = (outcome, reason, entity) => recordHookOutcome(process.env,
    { hook: 'messages', outcome, reason, entity, payload });
  let store;
  try {
    const host = hookSourceHost(payload, process.env);
    const id = payload?.session_id;
    if (!['SessionStart', 'UserPromptSubmit'].includes(payload?.hook_event_name)
      || !['claude-code', 'codex'].includes(host) || typeof id !== 'string' || !id) {
      record('skipped', SKIP_REASONS.messageIdentityUnavailable);
    } else {
      // Native hooks are direct children of the host; no process-list permission is needed.
      const pid = (options.findHostPid ?? (() => process.ppid))(host);
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('conversation-host-process-unavailable');
      store = new ConversationMessages({ busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
      if (store.networkIssue) record('error', `network: ${store.networkIssue}`);
      store.register({ id, host, machine: store.machine, pid, wake: host === 'codex'
        ? { thread: id } : { socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET } });
      const batch = store.hookBatch(id);
      if (batch.ids.length === 0) {
        record('skipped', SKIP_REASONS.messageNoPending);
      } else {
        const output = JSON.stringify({ hookSpecificOutput: {
          hookEventName: payload.hook_event_name, additionalContext: batch.text,
        } });
        await (options.write ?? writeStdout)(output);
        store.recordHookDelivery(id, batch.ids, payload.hook_event_name);
        record('notified', undefined, `messages:${batch.ids.length}`);
      }
      if (payload.hook_event_name === 'SessionStart' && fs.existsSync(path.join(getMemeshDirFromDbPath(), 'network'))) {
        try {
          const moduleUrl = new URL('../../dist/network/auto-start.js', import.meta.url);
          const { bootstrapNetworkBridge } = await import(moduleUrl.href);
          const assetsDir = fileURLToPath(new URL('../../dist/network/', import.meta.url));
          const result = await bootstrapNetworkBridge({ dataDir: getMemeshDirFromDbPath(), dbPath: getDbPath(), assetsDir,
            bridgeEntry: path.join(assetsDir, 'bridge.js') }, fileURLToPath(new URL('../../dist/transports/cli/cli.js', import.meta.url)));
          record(result === 'starting' ? 'notified' : 'skipped', `network-${result}`);
        } catch (error) { record('error', `network-bootstrap: ${error.message}`); }
      }
    }
  } catch (error) {
    record('error', error instanceof Error ? error.message : String(error));
  } finally { store?.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.on('error', () => { /* write callback records failure; do not acknowledge */ });
  try {
    await deliverConversationMessages(JSON.parse(fs.readFileSync(0, 'utf8') || '{}'));
  } catch {
    recordHookOutcome(process.env, { hook: 'messages', outcome: 'error', reason: 'malformed stdin JSON' });
  }
}
